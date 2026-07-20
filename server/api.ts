import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// =============================================================================
// GeoFinder API — deduce a property's address from its listing
//
// Input is only what the caller provides: the listing text and an array of
// photos. Nothing is looked up — no web search, no map database, no geocoder,
// no EXIF or file metadata. Claude deduces the location purely by reasoning
// over the pixels and the text: legible signage, architecture and construction
// era, street furniture and sign conventions, language and typography,
// vegetation and terrain, sun direction and shadows (for orientation and
// latitude), and textual cues in the listing (commune/quarter, floor, year
// built, and proximity claims such as "station 100 m away"). Multiple photos
// are reasoned over together so the facade, the view out of the windows, the
// street and the entrance triangulate a single building.
// =============================================================================

const VISION_MODEL = "claude-opus-4-8";

// Public geodata sources for the "map the land" stage. These ground the
// deduction against real map / aerial / building-register data to pin the
// parcel. They are NOT used to look the listing up — only to match the
// physical land the caller's photos and text describe.
const OVERPASS_BASE = "https://overpass-api.de/api/interpreter";
const GEOADMIN_IDENTIFY = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify";
const SWISSIMAGE_WMS = "https://wms.geo.admin.ch/";
const GEO_USER_AGENT = "geofinder/1.0 (https://github.com/casarico-ch/geofinder)";

function inSwitzerland(lat: number, lon: number): boolean {
  return lat >= 45.8 && lat <= 47.9 && lon >= 5.9 && lon <= 10.6;
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function compassBearing(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

const mediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]);
type MediaType = z.infer<typeof mediaTypeSchema>;

export interface ImageInput {
  imageBase64: string;
  mediaType: MediaType;
}
export interface AnalyzeInput {
  images: ImageInput[];
  listingText?: string;
}

const imageInputSchema = z.object({
  imageBase64: z.string().min(1),
  mediaType: mediaTypeSchema,
});

// Accepts the property-listing shape ({ images[], listingText }) and the legacy
// single-photo shape ({ imageBase64, mediaType, hint }) so existing callers keep
// working. Up to 15 images keeps token cost and latency bounded.
export const analyzeBodySchema = z.object({
  images: z.array(imageInputSchema).min(1).max(15).optional(),
  imageBase64: z.string().min(1).optional(),
  mediaType: mediaTypeSchema.optional(),
  listingText: z.string().max(12000).optional(),
  hint: z.string().max(12000).optional(),
});

// Collapse either request shape into one normalized input, or null if no image
// was supplied.
export function normalizeInput(body: z.infer<typeof analyzeBodySchema>): AnalyzeInput | null {
  const images: ImageInput[] = [];
  if (body.images && body.images.length > 0) {
    images.push(...body.images);
  } else if (body.imageBase64 && body.mediaType) {
    images.push({ imageBase64: body.imageBase64, mediaType: body.mediaType });
  }
  if (images.length === 0) return null;
  const listingText = (body.listingText ?? body.hint)?.trim() || undefined;
  return { images, listingText };
}

const confidenceSchema = z.enum([
  "street",
  "building",
  "block",
  "neighborhood",
  "city",
  "region",
  "country",
  "unknown",
]);

// The structured verdict the model must emit; validated by the SDK against the
// schema, so the output is guaranteed to match.
const estimateSchema = z.object({
  location_found: z.boolean(),
  confidence: confidenceSchema,
  address: z.string().nullable(),
  place: z.string(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  clues: z.array(z.string()),
  text_read: z.array(z.string()),
  reasoning: z.string(),
});
export type LocationEstimate = z.infer<typeof estimateSchema>;

const SYSTEM_PROMPT = `You are an expert real-estate location analyst — a champion GeoGuessr player combined with a meticulous OSINT detective — who determines the exact address of a property from its listing. You work ONLY from the material given to you: the listing photos and the listing text. You have no tools and look nothing up; every conclusion must be deduced from the evidence in front of you plus your own knowledge of the world's geography, architecture, and conventions.

The photos are a SET, not one image — reason across them together:
- Exterior and facade shots, the views out of the windows and balconies, the street, the entrance, mailboxes, name plaques and neighbouring buildings carry almost all of the location signal. A facade PLUS the view out of its own windows PLUS a street sign pins a building far more tightly than any single photo. Interiors usually carry none — but still scan them for a window view, a reflected street, or a framed local landmark.

Deduce from concrete evidence:
- Transcribe EVERY piece of legible text across all photos — street signs, shop and business names, bus/tram stop names, house numbers, plaques, posters, license plates. Text is your highest-value evidence; a single readable street name or shop can place a building.
- Architecture and construction era, building typology, roof form, balcony/window/shutter styles, facade materials and colours, wall thickness.
- Street furniture, road markings, kerb and bollard styles, traffic-sign shapes and colours, utility poles, license-plate formats — these narrow the country and often the region.
- Language, script and typography on any signage.
- Vegetation, terrain, and skyline or mountain profiles.
- Sun direction, shadow angle and length — infer the hemisphere and rough latitude, the time of day and season, and the compass orientation the building and camera face. State the orientation you infer and use it to make the surrounding geometry consistent.

The listing text is high-value — mine it hard and treat each fact as a geometric constraint:
- Commune/town, quarter or neighbourhood, any street fragment or postcode.
- Floor number and total number of floors — this bounds the building's height.
- Building age or year built, renovation year, the listing agency.
- Proximity claims — "station 100 m away", "5 minutes from the university", "lake view", "quiet cul-de-sac", "south-facing". Each one constrains where the property can be; combine them with what the photos show (e.g. a claimed lake view plus the sun's position fixes which side of the lake).

Rules:
- Prefer a precise street address (with house number) only when the combined evidence genuinely supports it. Otherwise report the tightest area you can defend and label the confidence honestly.
- An exact address is only reachable when the material carries a locking signal — a readable sign or number, a distinctive facade or view you recognise, or an address/postcode in the text. When it does not, return a correct "neighborhood" or "city" rather than guessing a house number.
- NEVER fabricate a specific address or coordinates you cannot justify from the evidence.`;

function imageBlocks(images: ImageInput[]): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    if (images.length > 1) {
      blocks.push({ type: "text", text: `Photo ${i + 1} of ${images.length}:` });
    }
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.imageBase64 },
    });
  });
  return blocks;
}

export function buildUserContent(
  images: ImageInput[],
  listingText?: string,
): Anthropic.Messages.ContentBlockParam[] {
  const many = images.length > 1;
  const instruction =
    `${many ? `These ${images.length} photos are` : "This photo is"} from a property listing. Using ONLY these ${many ? "photos" : "photo"} and the listing text — deduce nothing from anything else and look nothing up — work out where the property is, as precisely as the evidence allows. Read every legible sign, reason about the architecture, the orientation from sun and shadows, the terrain, and the textual cues (proximity claims, floor, year, quarter). Combine the exterior, any window or balcony view, the street and the entrance to converge on a single building.` +
    (listingText
      ? `\n\nListing text (treat as reliable ground truth; mine it for the commune, quarter, any street fragment or postcode, the floor and total floors, building age, agency, and every proximity claim):\n"${listingText}"`
      : "");

  return [...imageBlocks(images), { type: "text", text: instruction }];
}

async function geolocate(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<LocationEstimate | { refusal: true }> {
  // Single reasoning pass — no tools, no external calls. Adaptive thinking lets
  // the model reason through the clues; structured outputs guarantee the shape.
  const resp = await client.messages.parse({
    model: VISION_MODEL,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserContent(input.images, input.listingText) }],
    output_config: { format: zodOutputFormat(estimateSchema) },
  });

  if (resp.stop_reason === "refusal") {
    return { refusal: true };
  }
  if (!resp.parsed_output) {
    throw new Error("Model did not return a usable location estimate");
  }
  return resp.parsed_output;
}

// =============================================================================
// "Map the land" — ground the deduction against real geodata to pin the parcel
//
// Vision + text narrow the property to an area; matching its physical land —
// the parcel and garden shape, the pool, the shoreline and lakeside structures,
// the building height and roof, and its year built / floor count — against an
// official aerial view, the Swiss building register, and OpenStreetMap is what
// upgrades that area to a specific building. No listing lookup is involved.
// =============================================================================

interface LandDigest {
  digest: string;
  count: number;
}

const OSM_TAG_WHITELIST = [
  "name",
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "historic",
  "man_made",
  "natural",
  "waterway",
  "railway",
  "public_transport",
  "highway",
  "building",
  "building:levels",
  "building:colour",
  "roof:shape",
  "height",
  "surface",
  "operator",
  "brand",
  "addr:street",
  "addr:housenumber",
];

// OpenStreetMap features near the point: addressed and tall building footprints,
// named amenities, shoreline / marina / jetty features (for lakefront matching),
// and transit stops — each returned with distance and bearing from the point.
export async function fetchOsmFeatures(lat: number, lon: number): Promise<LandDigest | null> {
  const at = `${lat.toFixed(7)},${lon.toFixed(7)}`;
  const query = `[out:json][timeout:12];
(
  nwr["leisure"](around:350,${at});
  nwr["amenity"]["name"](around:350,${at});
  nwr["shop"](around:300,${at});
  nwr["tourism"](around:350,${at});
  nwr["historic"](around:350,${at});
  nwr["man_made"~"^(pier|jetty|breakwater|tower)$"](around:450,${at});
  nwr["leisure"="marina"](around:700,${at});
  nwr["natural"="water"]["name"](around:900,${at});
  nwr["building"]["addr:housenumber"](around:600,${at});
  nwr["building:levels"~"^([4-9]|[1-9][0-9])$"](around:600,${at});
  nwr["railway"~"^(station|halt|tram_stop)$"](around:500,${at});
  nwr["highway"="bus_stop"](around:300,${at});
);
out center tags 400;`;

  try {
    const res = await fetch(OVERPASS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": GEO_USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      elements?: Array<{
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
        tags?: Record<string, string>;
      }>;
    };
    const rows: { dist: number; line: string }[] = [];
    for (const el of data.elements ?? []) {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      const tags = el.tags ?? {};
      const kept = OSM_TAG_WHITELIST.filter((k) => tags[k]).map((k) => `${k}=${tags[k]}`);
      if (elLat === undefined || elLon === undefined || kept.length === 0) continue;
      const dist = haversineMeters(lat, lon, elLat, elLon);
      rows.push({
        dist,
        line: `- ${Math.round(dist)}m ${compassBearing(lat, lon, elLat, elLon)}: ${kept.join(", ")}`,
      });
    }
    rows.sort((a, b) => a.dist - b.dist);
    let digest = "";
    let count = 0;
    for (const { line } of rows) {
      if (digest.length + line.length > 9000) break;
      digest += line + "\n";
      count++;
    }
    return { digest: digest.trimEnd() || "(no mapped features found)", count };
  } catch (err) {
    console.error("[api] overpass lookup failed:", err);
    return null;
  }
}

// Swiss Federal Register of Buildings and Dwellings (GWR) near the point: the
// official address, commune, postcode, year built, and above-ground floor count
// of each nearby building — the structured facts a listing's year/floors/rooms
// can be matched against. Switzerland only.
interface RegisterEntry {
  label: string;
  lat: number;
  lon: number;
}
export interface RegisterResult {
  digest: string;
  count: number;
  entries: RegisterEntry[];
}

export async function fetchSwissBuildings(lat: number, lon: number): Promise<RegisterResult | null> {
  if (!inSwitzerland(lat, lon)) return null;
  // Wide search (~700 m radius) so shore buildings are found even when the
  // first-pass coordinate lands just offshore of a waterfront property.
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    layers: "all:ch.bfs.gebaeude_wohnungs_register",
    tolerance: "450",
    sr: "4326",
    returnGeometry: "true",
    geometryFormat: "geojson",
    mapExtent: `${lon - 0.01},${lat - 0.007},${lon + 0.01},${lat + 0.007}`,
    imageDisplay: "1000,700,96",
  });
  try {
    const res = await fetch(`${GEOADMIN_IDENTIFY}?${params.toString()}`, {
      headers: { "User-Agent": GEO_USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        // With geometryFormat=geojson each result is a GeoJSON Feature: the
        // attributes are under `properties` (not `attributes`).
        properties?: Record<string, unknown>;
        geometry?: { coordinates?: [number, number] };
      }>;
    };
    // GWR returns one row per building entrance ("Rue X 9", "9.1", "9.2"); keep
    // one line per street address, preferring the row that carries year/floors.
    const byAddress = new Map<
      string,
      { label: string; dist: number; line: string; rich: boolean; lat: number; lon: number }
    >();
    for (const r of data.results ?? []) {
      const a = r.properties ?? {};
      const coords = r.geometry?.coordinates;
      const label = typeof a.label === "string" ? a.label.replace(/\.\d+$/, "") : null;
      if (!coords || !label) continue;
      const bLat = coords[1];
      const bLon = coords[0];
      const dist = haversineMeters(lat, lon, bLat, bLon);
      const dir = compassBearing(lat, lon, bLat, bLon);
      const commune = typeof a.ggdename === "string" ? a.ggdename : "";
      const postcode = a.dplz4 != null ? String(a.dplz4) : "";
      const year = a.gbauj != null ? `, built ${a.gbauj}` : "";
      const floors = a.gastw != null ? `, ${a.gastw} floors` : "";
      const dwellings = a.ganzwhg != null ? `, ${a.ganzwhg} dwellings` : "";
      const rich = a.gbauj != null || a.gastw != null;
      const line = `- ${Math.round(dist)}m ${dir}: ${label}, ${[postcode, commune].filter(Boolean).join(" ")}${year}${floors}${dwellings}`;
      const prev = byAddress.get(label);
      if (!prev || (rich && !prev.rich) || dist < prev.dist) {
        byAddress.set(label, { label, dist, line, rich, lat: bLat, lon: bLon });
      }
    }
    const rows = Array.from(byAddress.values()).sort((a, b) => a.dist - b.dist);
    let digest = "";
    const entries: RegisterEntry[] = [];
    for (const row of rows) {
      if (digest.length + row.line.length > 9000) break;
      digest += row.line + "\n";
      entries.push({ label: row.label, lat: row.lat, lon: row.lon });
    }
    if (entries.length === 0) return { digest: "(no register buildings found)", count: 0, entries };
    return { digest: digest.trimEnd(), count: entries.length, entries };
  } catch (err) {
    console.error("[api] swiss register lookup failed:", err);
    return null;
  }
}

// Official swisstopo SWISSIMAGE orthophoto centered on the point, wide enough
// (~1.4 km across, north up) that the property's plot is in frame even when the
// first-pass coordinate is a few hundred metres off — the model then locates the
// building by matching its pool, roof, garden and shoreline. Switzerland only.
const AERIAL_SPAN_METERS = 1400;
export async function fetchAerialImage(
  lat: number,
  lon: number,
  spanMeters: number = AERIAL_SPAN_METERS,
): Promise<{ imageBase64: string; mediaType: "image/jpeg"; spanMeters: number } | null> {
  if (!inSwitzerland(lat, lon)) return null;
  const dLat = spanMeters / 2 / 111320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180); // equal metres east-west (square ground)
  // WMS 1.3.0 with EPSG:4326 uses lat,lon axis order.
  const bbox = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: "ch.swisstopo.swissimage",
    STYLES: "",
    CRS: "EPSG:4326",
    BBOX: bbox,
    WIDTH: "1500",
    HEIGHT: "1500",
    FORMAT: "image/jpeg",
  });
  try {
    const res = await fetch(`${SWISSIMAGE_WMS}?${params.toString()}`, {
      headers: { "User-Agent": GEO_USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("image")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) return null; // near-empty tile (e.g. open water / no data)
    return { imageBase64: buf.toString("base64"), mediaType: "image/jpeg", spanMeters };
  } catch (err) {
    console.error("[api] aerial fetch failed:", err);
    return null;
  }
}

const mapVerdictSchema = z.object({
  corroborated: z.boolean(),
  matched_address: z.string().nullable(),
  confidence: confidenceSchema,
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  matches: z.array(z.object({ evidence: z.string(), source: z.string() })),
  mismatches: z.array(z.string()),
  notes: z.string(),
});
export type MapVerdict = z.infer<typeof mapVerdictSchema>;

export interface LandVerification {
  status: "pinned" | "corroborated" | "inconclusive" | "unavailable" | "skipped";
  matched_address: string | null;
  matches: { evidence: string; source: string }[];
  mismatches: string[];
  notes: string | null;
  aerialUsed: boolean;
  sources: string[];
}

const MAP_SYSTEM_PROMPT = `You are the "map the land" detective stage of a property-geolocation pipeline. A first pass deduced the rough AREA a listing's property is in. Your job is to find the EXACT building by matching the listing photos against an official aerial view, then read off its address.

You receive:
- The listing photos.
- An official swisstopo aerial orthophoto (NORTH IS UP) covering the area, centered on the built-up area nearest the estimate.
- A list of nearby buildings from the Swiss building register (official address, year built, floor count) and OpenStreetMap features (addressed and tall footprints, shoreline, marinas, jetties, amenities), each with distance and compass bearing from the first-pass coordinate.

Do real detective work:
1. From the photos, list the property's distinctive, top-visible signatures: roof shape / colour / size, the pool (note an infinity edge, its shape and position), the driveway, the garden's shape and size, notable trees, the building footprint and where it sits on the plot, and any shoreline structures — a private jetty or pontoon, a boathouse, a lakeside pergola. Note landmarks that appear in BOTH the photos and the aerial: a church or steeple, a marina, the exact curve of the shoreline.
2. Scan the aerial and find the ONE plot whose pool + roof + garden + shoreline structures match the photos. Pools, jetties, roofs and parcel boundaries are clearly visible from above; use the landmarks and the sun / lake-view orientation from the photos to narrow it down.
3. Identify that building's address: associate the matched plot with the nearest register/OSM address using the distances and bearings. Copy that address VERBATIM from the provided lists into matched_address so it can be resolved to coordinates — never paraphrase or invent one.
4. Cross-check the listing's stated facts (parcel area, living area, rooms, floors, year built) against the register entry for that building.

Rules:
- The first-pass coordinate can be imprecise — even in the water for a waterfront property. Trust the photos and the aerial to find the actual building; do not just echo the first-pass point.
- If you identify the plot: set matched_address to its register/OSM address, confidence to "building" (or "street"), and report which clue matched which feature.
- If the aerial only confirms the general area but you cannot isolate the plot: corroborated=true, matched_address=null, keep the first-pass confidence.
- If nothing matches, or the aerial contradicts the estimate: corroborated=false, and say why.
- NEVER invent an address, a matched feature, or a register fact. Cite only the aerial you can actually see and the addresses/features in the provided lists.`;

async function mapTheLand(
  client: Anthropic,
  images: ImageInput[],
  listingText: string | undefined,
  estimate: LocationEstimate,
): Promise<{ verification: LandVerification; verdict: MapVerdict | null }> {
  const skipped: LandVerification = {
    status: "skipped",
    matched_address: null,
    matches: [],
    mismatches: [],
    notes: null,
    aerialUsed: false,
    sources: [],
  };
  const worthMapping = ["street", "building", "block", "neighborhood"].includes(estimate.confidence);
  if (!worthMapping || estimate.latitude === null || estimate.longitude === null) {
    return { verification: skipped, verdict: null };
  }
  const { latitude: lat, longitude: lon } = estimate;

  // Register + OSM are quick JSON; fetch them first so the aerial can be
  // centered on the nearest real building (guarantees land, not open water).
  const [register, osm] = await Promise.all([
    fetchSwissBuildings(lat, lon),
    fetchOsmFeatures(lat, lon),
  ]);
  let center = { lat, lon };
  if (register && register.entries.length > 0) {
    let best = register.entries[0];
    let bestD = Infinity;
    for (const e of register.entries) {
      const d = haversineMeters(lat, lon, e.lat, e.lon);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    center = { lat: best.lat, lon: best.lon };
  }
  const aerial = await fetchAerialImage(center.lat, center.lon);

  const sources: string[] = [];
  if (aerial) sources.push("swisstopo SWISSIMAGE aerial");
  if (register && register.count > 0) sources.push("Swiss building register (GWR)");
  if (osm && osm.count > 0) sources.push("OpenStreetMap");
  if (sources.length === 0) {
    return { verification: { ...skipped, status: "unavailable" }, verdict: null };
  }

  const briefing = `First-pass estimate:
${JSON.stringify(
    {
      confidence: estimate.confidence,
      place: estimate.place,
      address: estimate.address,
      city: estimate.city,
      country: estimate.country,
      latitude: lat,
      longitude: lon,
      clues: estimate.clues,
    },
    null,
    2,
  )}

Listing facts to match (from the listing text; may name parcel/living area, rooms, floors, year built):
${listingText ? `"${listingText}"` : "(none provided)"}

Swiss building register near the estimate (distance & bearing FROM the first-pass point):
${register && register.count > 0 ? register.digest : "(none / not in Switzerland)"}

OpenStreetMap features near the estimate:
${osm && osm.count > 0 ? osm.digest : "(none)"}

${
    aerial
      ? `The aerial orthophoto above is north-up, ~${aerial.spanMeters} m across, centered on the built-up area nearest the estimate. The first-pass coordinate may be imprecise (possibly offshore for a waterfront property) — use the photos and the aerial to find the actual building.`
      : "No aerial view is available for this location."
  }

Find the property's plot in the aerial and read off its address from the lists above.`;

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: "Listing photos:" },
    ...imageBlocks(images),
  ];
  if (aerial) {
    content.push({ type: "text", text: "Official aerial view centered on the first-pass estimate:" });
    content.push({
      type: "image",
      source: { type: "base64", media_type: aerial.mediaType, data: aerial.imageBase64 },
    });
  }
  content.push({ type: "text", text: briefing });

  const resp = await client.messages.parse({
    model: VISION_MODEL,
    max_tokens: 10000,
    thinking: { type: "adaptive" },
    system: MAP_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(mapVerdictSchema) },
  });

  if (resp.stop_reason === "refusal" || !resp.parsed_output) {
    return { verification: { ...skipped, status: "unavailable" }, verdict: null };
  }

  const raw = resp.parsed_output;
  // Resolve the matched address back to its exact register coordinate — the
  // model picks WHICH building; the register gives the precise location.
  let latitude = raw.latitude;
  let longitude = raw.longitude;
  let confidence = raw.confidence;
  if (raw.matched_address && register) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const target = norm(raw.matched_address);
    const hit = register.entries.find((e) => {
      const l = norm(e.label);
      return l === target || target.includes(l) || l.includes(target);
    });
    if (hit) {
      latitude = hit.lat;
      longitude = hit.lon;
      if (!["street", "building"].includes(confidence)) confidence = "building";
    }
  }
  const verdict: MapVerdict = { ...raw, latitude, longitude, confidence };

  const movedOrNamed =
    verdict.matched_address !== null ||
    verdict.confidence !== estimate.confidence ||
    verdict.latitude !== estimate.latitude ||
    verdict.longitude !== estimate.longitude;
  const status: LandVerification["status"] = !verdict.corroborated
    ? "inconclusive"
    : movedOrNamed
      ? "pinned"
      : "corroborated";

  return {
    verification: {
      status,
      matched_address: verdict.matched_address,
      matches: verdict.matches,
      mismatches: verdict.mismatches,
      notes: verdict.notes || null,
      aerialUsed: aerial !== null,
      sources,
    },
    verdict,
  };
}

export interface AnalyzeResult {
  estimate: LocationEstimate;
  landVerification: LandVerification;
}

// Full pipeline: deduce the area from the images + text, then map the land to
// pin the parcel. Shared by the HTTP route and the CLI test harness.
export async function analyzeListing(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<AnalyzeResult | { refusal: true }> {
  const result = await geolocate(client, input);
  if ("refusal" in result) return { refusal: true };

  let estimate = result;
  let landVerification: LandVerification = {
    status: "unavailable",
    matched_address: null,
    matches: [],
    mismatches: [],
    notes: null,
    aerialUsed: false,
    sources: [],
  };
  try {
    const { verification, verdict } = await mapTheLand(
      client,
      input.images,
      input.listingText,
      estimate,
    );
    landVerification = verification;
    if (verdict && verdict.corroborated) {
      estimate = {
        ...estimate,
        confidence: verdict.confidence,
        address: verdict.matched_address ?? estimate.address,
        latitude: verdict.latitude ?? estimate.latitude,
        longitude: verdict.longitude ?? estimate.longitude,
      };
    }
  } catch (err) {
    console.error("[api] map-the-land stage failed:", err);
  }
  return { estimate, landVerification };
}

// =============================================================================
// Agent — the same investigation a human/LLM does by hand, driven by the model
// with tools it decides to call and iterate on (cadastre-by-area is the key
// deterministic lever; aerial + register confirm; no listing lookup).
// =============================================================================

const SITG_PARCELLE =
  "https://vector.sitg.ge.ch/arcgis/rest/services/CAD_PARCELLE_MENSU/MapServer/0/query";

interface CadastreParcel {
  parcel: number;
  surface: number;
  lat: number;
  lon: number;
  url: string;
}

// Geneva cadastre (SITG): parcels in a commune within an area band. This is the
// backbone — the listing's terrain area is a near-unique key. Geneva only for now.
async function searchCadastreByArea(
  commune: string,
  minM2: number,
  maxM2: number,
): Promise<CadastreParcel[]> {
  const where = `COMMUNE='${commune.replace(/'/g, "''")}' AND SURFACE>=${Math.round(minM2)} AND SURFACE<=${Math.round(maxM2)}`;
  const params = new URLSearchParams({
    where,
    outFields: "NO_PARCELLE,SURFACE,LIEN_WWW",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultRecordCount: "80",
  });
  try {
    const res = await fetch(`${SITG_PARCELLE}?${params.toString()}`, {
      headers: { "User-Agent": GEO_USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      features?: Array<{ attributes: Record<string, unknown>; geometry?: { rings?: number[][][] } }>;
    };
    const out: CadastreParcel[] = [];
    for (const f of data.features ?? []) {
      const ring = f.geometry?.rings?.[0];
      if (!ring || ring.length === 0) continue;
      const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      out.push({
        parcel: Number(f.attributes.NO_PARCELLE),
        surface: Number(f.attributes.SURFACE),
        lat,
        lon,
        url: String(f.attributes.LIEN_WWW ?? ""),
      });
    }
    const mid = (minM2 + maxM2) / 2;
    out.sort((a, b) => Math.abs(a.surface - mid) - Math.abs(b.surface - mid));
    return out;
  } catch (err) {
    console.error("[api] cadastre query failed:", err);
    return [];
  }
}

async function geocodePlace(query: string): Promise<{ lat: number; lon: number; name: string } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { "User-Agent": GEO_USER_AGENT }, signal: AbortSignal.timeout(12000) },
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (arr.length === 0) return null;
    return { lat: Number(arr[0].lat), lon: Number(arr[0].lon), name: arr[0].display_name };
  } catch {
    return null;
  }
}

const agentAnswerSchema = z.object({
  found: z.boolean(),
  address: z.string().nullable(),
  parcel: z.string().nullable(),
  commune: z.string().nullable(),
  confidence: confidenceSchema,
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  reasoning: z.string(),
  candidates: z.array(
    z.object({
      parcel: z.string(),
      address: z.string().nullable(),
      surface_m2: z.number().nullable(),
      note: z.string(),
    }),
  ),
  cadastre_url: z.string().nullable(),
});
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

export interface InvestigateResult {
  answer: AgentAnswer;
  steps: string[];
}

const AGENT_TOOLS = [
  {
    name: "geocode",
    description: "Look up approximate WGS84 coordinates for a place name (commune, quarter, landmark). Uses OpenStreetMap; not the listing.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "e.g. 'Corsier-Port, Geneva, Switzerland'" } },
      required: ["query"],
    },
  },
  {
    name: "cadastre_parcels_by_area",
    description:
      "PRIMARY TOOL. Return official cadastral parcels in a commune whose surface (terrain area, m²) falls in [target-tolerance, target+tolerance], nearest to target first. The listing's 'surface du terrain' is a near-unique key. Canton of Geneva only.",
    input_schema: {
      type: "object",
      properties: {
        commune: { type: "string", description: "Commune name as in the cadastre, e.g. 'Corsier'" },
        target_area_m2: { type: "number", description: "The listing's terrain area in m²" },
        tolerance_m2: { type: "number", description: "Band half-width in m² (default 100). Start at 20, then widen to 50, then 100." },
      },
      required: ["commune", "target_area_m2"],
    },
  },
  {
    name: "aerial_view",
    description:
      "Fetch an official swisstopo aerial orthophoto (north up) centered on a point, returned as an image you can inspect. Use a small span (120-250 m) to study one parcel, larger (600-1200 m) to scan a shoreline. Switzerland only.",
    input_schema: {
      type: "object",
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
        span_meters: { type: "number", description: "Width of the view in metres (80-1500, default 200)" },
      },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "buildings_here",
    description:
      "Official Swiss building register near a point: addresses with year built and floor count, each with distance and bearing. Use to read a candidate parcel's address and check floors/year against the listing.",
    input_schema: {
      type: "object",
      properties: { latitude: { type: "number" }, longitude: { type: "number" } },
      required: ["latitude", "longitude"],
    },
  },
  {
    name: "submit_answer",
    description: "Call once when done to report the identified address (or found=false).",
    input_schema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        address: { type: ["string", "null"] },
        parcel: { type: ["string", "null"], description: "e.g. 'Corsier 3690'" },
        commune: { type: ["string", "null"] },
        confidence: {
          type: "string",
          enum: ["street", "building", "block", "neighborhood", "city", "region", "country", "unknown"],
        },
        latitude: { type: ["number", "null"] },
        longitude: { type: ["number", "null"] },
        reasoning: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              parcel: { type: "string" },
              address: { type: ["string", "null"] },
              surface_m2: { type: ["number", "null"] },
              note: { type: "string" },
            },
            required: ["parcel", "note"],
          },
        },
        cadastre_url: { type: ["string", "null"] },
      },
      required: ["found", "confidence", "reasoning", "candidates"],
    },
  },
] as unknown as Anthropic.Messages.ToolUnion[];

const AGENT_SYSTEM = `You are a property-address detective. Given a real-estate listing (photos + text), find the property's EXACT address and cadastral parcel by investigating with your tools — the same way a careful human would. You have no web access and must NOT try to look the listing up; work from the photos, the text, and the map/cadastre tools.

Your strongest lever is the CADASTRE, not vision. Method:
1. Read the listing text: extract the commune and, crucially, the TERRAIN AREA ("surface du terrain", m²). Also note living area, rooms, floors, year built, and whether it claims direct water access / "bord du lac".
2. Call cadastre_parcels_by_area(commune, target_area_m2) — the terrain area is a near-unique key. Start with a tolerance of 20 m²; if that yields no viable match, widen to 50, then to 100. This narrows a whole commune to a handful of parcels.
3. For the candidate parcels, use aerial_view (zoom in, ~150-250 m) and buildings_here to check each against the photos and the listing facts: does the plot's pool / garden / roof / shoreline match the photos? Do the register's floors and year built match? Rule out parcels that contradict (e.g. no water access when the listing claims a private pontoon, or wrong floor count).
4. When one parcel matches, call submit_answer with its address, parcel ("Commune NNNN"), coordinates, confidence, your reasoning, the ranked candidates, and cadastre_url (the LIEN_WWW the cadastre tool returned for that parcel).

Notes:
- The cadastre currently covers the canton of GENEVA only. If the commune is elsewhere, say so, fall back to aerial_view + reasoning from the photos, and report found=false with your best area estimate and confidence.
- Prefer the exact-area parcel corroborated by the photos and register. Be honest about confidence: "building"/"street" only when a parcel genuinely matches; otherwise "neighborhood"/"city".
- Don't fabricate. Every address must come from the register/cadastre tools.`;

const AGENT_TASK = `These photos and text are a property listing. Find the property's exact street address and cadastral parcel using your tools. Investigate step by step: extract the commune and terrain area from the text, query the cadastre by area, then confirm the matching parcel with aerial views and the building register. Call submit_answer when done.`;

async function runAgentTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: Anthropic.Messages.ToolResultBlockParam["content"]; step: string }> {
  if (name === "geocode") {
    const q = String(input.query ?? "");
    const g = await geocodePlace(q);
    return g
      ? { content: `${g.lat},${g.lon} — ${g.name}`, step: `geocode "${q}" → ${g.lat.toFixed(4)},${g.lon.toFixed(4)}` }
      : { content: "No geocoding result.", step: `geocode "${q}" → none` };
  }
  if (name === "cadastre_parcels_by_area") {
    const commune = String(input.commune ?? "");
    const target = Number(input.target_area_m2);
    const tol = Number(input.tolerance_m2 ?? 100);
    const parcels = await searchCadastreByArea(commune, target - tol, target + tol);
    const step = `cadastre ${commune} ${Math.round(target)}±${Math.round(tol)}m² → ${parcels.length}`;
    if (parcels.length === 0) {
      return {
        content: `No Geneva parcels in '${commune}' with surface ${Math.round(target - tol)}-${Math.round(target + tol)} m². The cadastre covers canton Geneva only; if this commune is elsewhere, fall back to aerial reasoning.`,
        step,
      };
    }
    const lines = parcels
      .slice(0, 40)
      .map((p) => `parcel ${p.parcel}: ${p.surface} m² at ${p.lat.toFixed(5)},${p.lon.toFixed(5)}${p.url ? ` · ${p.url}` : ""}`)
      .join("\n");
    return {
      content: `${parcels.length} parcel(s) in ${commune}, ${Math.round(target - tol)}-${Math.round(target + tol)} m² (nearest to ${Math.round(target)} first):\n${lines}`,
      step,
    };
  }
  if (name === "aerial_view") {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    const span = Math.min(1500, Math.max(80, Number(input.span_meters ?? 200)));
    const a = await fetchAerialImage(lat, lon, span);
    if (!a) {
      return { content: "No aerial available (outside Switzerland or fetch failed).", step: `aerial ${lat.toFixed(5)},${lon.toFixed(5)} ${span}m → none` };
    }
    return {
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: a.imageBase64 } },
        { type: "text", text: `Aerial (north up), ~${span} m across, centered ${lat.toFixed(5)},${lon.toFixed(5)}.` },
      ],
      step: `aerial ${lat.toFixed(5)},${lon.toFixed(5)} ${span}m`,
    };
  }
  if (name === "buildings_here") {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    const r = await fetchSwissBuildings(lat, lon);
    return {
      content:
        r && r.count > 0
          ? `Register buildings near ${lat.toFixed(5)},${lon.toFixed(5)} (distance & bearing from the point):\n${r.digest}`
          : "No register buildings found near this point.",
      step: `buildings ${lat.toFixed(5)},${lon.toFixed(5)} → ${r?.count ?? 0}`,
    };
  }
  return { content: `Unknown tool: ${name}`, step: `unknown ${name}` };
}

// The agent loop: the model calls tools and iterates until it submits an answer.
export async function investigateListing(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<InvestigateResult | { refusal: true }> {
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        ...imageBlocks(input.images),
        { type: "text", text: `${AGENT_TASK}\n\nListing text:\n${input.listingText ? `"${input.listingText}"` : "(none provided)"}` },
      ],
    },
  ];
  const steps: string[] = [];
  let answer: AgentAnswer | null = null;

  for (let i = 0; i < 18 && !answer; i++) {
    const resp = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: AGENT_SYSTEM,
      tools: AGENT_TOOLS,
      messages,
    });
    if (resp.stop_reason === "refusal") return { refusal: true };
    messages.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break; // model stopped without submitting

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      if (tu.name === "submit_answer") {
        const parsed = agentAnswerSchema.safeParse(tu.input);
        if (parsed.success) {
          answer = parsed.data;
          steps.push(`answer → ${parsed.data.address ?? parsed.data.parcel ?? "not found"}`);
        }
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: parsed.success ? "recorded" : "submit_answer fields were invalid; correct them and resubmit.",
          is_error: !parsed.success,
        });
      } else {
        const { content, step } = await runAgentTool(tu.name, tu.input as Record<string, unknown>);
        steps.push(step);
        results.push({ type: "tool_result", tool_use_id: tu.id, content });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (!answer) {
    answer = {
      found: false,
      address: null,
      parcel: null,
      commune: null,
      confidence: "unknown",
      latitude: null,
      longitude: null,
      reasoning: "The investigation did not converge on a parcel within the step budget.",
      candidates: [],
      cadastre_url: null,
    };
  }
  return { answer, steps };
}

export function registerApiRoutes(app: Express) {
  app.use(express.json({ limit: "25mb" }));

  app.post("/api/geo/analyze-photo", async (req: Request, res: Response) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(503).json({
        error:
          "Vision analysis is not configured. Set ANTHROPIC_API_KEY on the server to enable it.",
      });
      return;
    }

    const parsed = analyzeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Expected { images: [{ imageBase64, mediaType }], listingText? } (or the legacy { imageBase64, mediaType, hint? }) in the request body",
      });
      return;
    }
    const input = normalizeInput(parsed.data);
    if (!input) {
      res.status(400).json({ error: "Provide at least one image via images[] or imageBase64" });
      return;
    }

    try {
      const client = new Anthropic();
      const result = await investigateListing(client, input);

      if ("refusal" in result) {
        res.status(422).json({ error: "The model declined to analyze this listing." });
        return;
      }

      res.json(result);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        res.status(503).json({ error: "The configured Anthropic API key was rejected." });
        return;
      }
      if (err instanceof Anthropic.RateLimitError) {
        res.status(429).json({ error: "Vision analysis is rate limited right now. Try again shortly." });
        return;
      }
      console.error("[api] listing analysis failed:", err);
      res.status(502).json({ error: "Vision analysis failed. Please try again." });
    }
  });
}
