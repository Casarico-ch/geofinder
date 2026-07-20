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

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
  nwr["building"]["addr:housenumber"](around:250,${at});
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
export async function fetchSwissBuildings(lat: number, lon: number): Promise<LandDigest | null> {
  if (!inSwitzerland(lat, lon)) return null;
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    layers: "all:ch.bfs.gebaeude_wohnungs_register",
    tolerance: "250",
    sr: "4326",
    returnGeometry: "true",
    geometryFormat: "geojson",
    mapExtent: `${lon - 0.006},${lat - 0.004},${lon + 0.006},${lat + 0.004}`,
    imageDisplay: "1000,667,96",
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
    const byAddress = new Map<string, { dist: number; line: string; rich: boolean }>();
    for (const r of data.results ?? []) {
      const a = r.properties ?? {};
      const coords = r.geometry?.coordinates;
      const label = typeof a.label === "string" ? a.label.replace(/\.\d+$/, "") : null;
      if (!coords || !label) continue;
      const dist = haversineMeters(lat, lon, coords[1], coords[0]);
      const dir = compassBearing(lat, lon, coords[1], coords[0]);
      const commune = typeof a.ggdename === "string" ? a.ggdename : "";
      const postcode = a.dplz4 != null ? String(a.dplz4) : "";
      const year = a.gbauj != null ? `, built ${a.gbauj}` : "";
      const floors = a.gastw != null ? `, ${a.gastw} floors` : "";
      const dwellings = a.ganzwhg != null ? `, ${a.ganzwhg} dwellings` : "";
      const rich = a.gbauj != null || a.gastw != null;
      const line = `- ${Math.round(dist)}m ${dir}: ${label}, ${[postcode, commune].filter(Boolean).join(" ")}${year}${floors}${dwellings}`;
      const prev = byAddress.get(label);
      if (!prev || (rich && !prev.rich) || dist < prev.dist) {
        byAddress.set(label, { dist, line, rich });
      }
    }
    const rows = Array.from(byAddress.values()).sort((a, b) => a.dist - b.dist);
    let digest = "";
    let count = 0;
    for (const { line } of rows) {
      if (digest.length + line.length > 9000) break;
      digest += line + "\n";
      count++;
    }
    if (count === 0) return { digest: "(no register buildings found)", count: 0 };
    return { digest: digest.trimEnd(), count };
  } catch (err) {
    console.error("[api] swiss register lookup failed:", err);
    return null;
  }
}

// Official swisstopo SWISSIMAGE orthophoto centered on the point (~600 m across),
// so the model can visually match the parcel, garden, pool, roof and shoreline
// against the actual ground. Switzerland only.
export async function fetchAerialImage(
  lat: number,
  lon: number,
): Promise<{ imageBase64: string; mediaType: "image/jpeg" } | null> {
  if (!inSwitzerland(lat, lon)) return null;
  const dLat = 0.0027; // ~600 m north-south
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
    WIDTH: "1024",
    HEIGHT: "1024",
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
    return { imageBase64: buf.toString("base64"), mediaType: "image/jpeg" };
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

const MAP_SYSTEM_PROMPT = `You are the "map the land" verification stage of a property-geolocation pipeline. A first pass deduced the AREA a listing's property is in. You now receive the listing photos, usually an official aerial orthophoto centered on the estimate, and structured map data near the estimate: nearby buildings from the Swiss building register (official address, year built, number of floors) and OpenStreetMap features (addressed and tall building footprints, shoreline, marinas and jetties, amenities) — each with distance and compass bearing FROM the estimated point.

Your job is to match the property's PHYSICAL LAND against this ground truth and pin the exact parcel or building.
- The aerial view is your strongest evidence. Find the plot whose pool, garden shape and size, driveway, roof shape and colour, the building's position on the parcel, and the shoreline and any lakeside structures (pergola, jetty, boathouse) match what the photos show. Property boundaries, pools and roofs are clearly visible from above.
- Corroborate with the register and OSM. The listing's stated facts — parcel area, habitable area, number of rooms, floors, year built — should line up with a specific building's register entry (year built, floor count) and its footprint. A building whose year and floors match, at a plausible waterfront/address position, is strong confirmation.
- Use distance and bearing to keep the geometry consistent with the photos' orientation (the sun, the direction of the lake view).
- If you can identify the exact plot, return its address (from the register or OSM) and a refined coordinate on that building, and set the confidence to "building" or "street". If the data only confirms the general area, keep the confidence where the first pass had it. If the data contradicts the estimate, downgrade it honestly.
- NEVER invent an address, a matched feature, or a register fact. Cite only the aerial you can actually see and the addresses/features in the provided lists. Set corroborated=false when the land data does not let you confirm or refine the estimate.`;

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

  const [osm, register, aerial] = await Promise.all([
    fetchOsmFeatures(lat, lon),
    fetchSwissBuildings(lat, lon),
    fetchAerialImage(lat, lon),
  ]);

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

Swiss building register near the estimate (distance & bearing FROM the point):
${register && register.count > 0 ? register.digest : "(none / not in Switzerland)"}

OpenStreetMap features near the estimate:
${osm && osm.count > 0 ? osm.digest : "(none)"}

${aerial ? "An official swisstopo aerial orthophoto centered on the estimate (~600 m across) is included above." : "No aerial view is available for this location."}

Match the property's land against this data and pin the exact parcel/building, or confirm the area.`;

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

  const verdict = resp.parsed_output;
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
      const result = await analyzeListing(client, input);

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
