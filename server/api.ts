import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// =============================================================================
// GeoFinder API — identify a property's address from its listing
//
// Given the photos and text of a real-estate listing, derive the property's
// street address from the *pixels* and the *listing text* alone — no EXIF, no
// device location, no file metadata of any kind is read (portal listings have
// it stripped anyway). Multiple photos are analysed together so the exterior,
// the view out of the windows, the street and the entrance can triangulate a
// single building. Claude is given the web-search tool to verify the clues it
// reads (shop and street-sign names, distinctive buildings) AND to try to
// match the listing itself against real-estate portals, resolving everything
// to a real address + coordinates.
// =============================================================================

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  "geofinder/1.0 (https://github.com/casarico-ch/geofinder)";
const OVERPASS_BASE = "https://overpass-api.de/api/interpreter";

const VISION_MODEL = "claude-opus-4-8";

interface FormattedAddress {
  formatted: string;
  displayName: string;
  city: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
}

interface NominatimReverseResponse {
  lat: string;
  lon: string;
  display_name?: string;
  error?: string;
  address?: Record<string, string>;
}

// Turn AI-estimated coordinates into a clean street address for display.
// This formats the vision estimate — it is not a metadata lookup on the file.
async function reverseGeocode(lat: number, lon: number): Promise<FormattedAddress | null> {
  const url = new URL(`${NOMINATIM_BASE}/reverse`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");

  const res = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT, "Accept-Language": "en" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as NominatimReverseResponse;
  if (data.error) return null;

  const a = data.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? null;
  const road = a.road ?? a.pedestrian ?? a.footway ?? null;
  const street = [road, a.house_number].filter(Boolean).join(" ");
  const formatted =
    [street, [a.postcode, city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") ||
    data.display_name ||
    "Unknown location";

  return {
    formatted,
    displayName: data.display_name ?? formatted,
    city,
    postcode: a.postcode ?? null,
    country: a.country ?? null,
    latitude: Number(data.lat),
    longitude: Number(data.lon),
  };
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

// The structured verdict we ask the model to emit and then validate.
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
  sources: z.array(z.string()),
});
export type LocationEstimate = z.infer<typeof estimateSchema>;

const mediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]);
type MediaType = z.infer<typeof mediaTypeSchema>;

interface ImageInput {
  imageBase64: string;
  mediaType: MediaType;
}
interface AnalyzeInput {
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

const SYSTEM_PROMPT = `You are an expert real-estate location analyst — a champion GeoGuessr player combined with a meticulous OSINT researcher who specializes in pinning down the exact address of a property from its listing. You are given the photos from a property listing plus (usually) the listing text, and you determine where the property is — ideally to the exact street address and house number.

The photos are a SET, not one image — triangulate across them:
- Exterior and facade shots, views out of windows and balconies, the street, the entrance, mailboxes, building name plaques, and neighbouring buildings carry almost all of the geolocation signal. A facade PLUS the view out of its own windows PLUS a street sign pins a building far more tightly than any single photo.
- Interior shots (kitchens, bedrooms, bathrooms) usually carry no location signal — but still scan them for a window view, a framed local landmark, a visible street, or reflections.

Reason from concrete evidence:
- Transcribe EVERY piece of legible text across all photos (street signs, shop and business names, bus/tram stop names, house numbers, building plaques, posters, license plates). Text is your highest-value visual evidence.
- Architecture and construction era, balcony and window styles, street furniture, road markings and sign conventions, vegetation, terrain, skyline profiles, sun direction and shadows.

The listing text is high-value — mine it hard: commune/town, quarter or neighbourhood, any street fragment or postcode, floor number and total number of floors, building age or year built, the listing agency, and proximity claims ("5 minutes from the university", "near the station", "quiet cul-de-sac"). Combine it with what you see in the photos.

Use the web_search tool aggressively, for two distinct jobs:
1. MATCH THE LISTING. A portal listing is published somewhere — search distinctive phrases from the listing text, the price together with the room count and commune, the agency plus a distinctive feature, or a rare detail. A cross-post of the same listing on another portal (Homegate, ImmoScout24, Comparis, Newhome, agency sites) sometimes exposes the exact address that this copy withholds.
2. RESOLVE CLUES. Turn a commune + quarter + distinctive features, or a verified street name plus town, into a specific street, house number, and WGS84 coordinates. Search in the local language (German/French/Italian for Switzerland).

Rules:
- Prefer a precise street address (with house number) when the evidence genuinely supports it. Otherwise report the tightest area you can defend and label the confidence honestly.
- The exact address is only reachable when the material carries a locking signal (a readable sign/number, a distinctive facade or view you can find online, or an address/postcode in the text). When it does not, say so with an honest lower confidence rather than guessing a house number.
- NEVER fabricate a specific address or coordinates you cannot justify from the evidence. A correct "neighborhood" beats a confident wrong street number.
- Treat the listing text as reliable ground truth and combine it with what you see.`;

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
    `These ${many ? `${images.length} photos are` : "photo and text are"} from a real property listing. Determine the exact street address of the property. Work across ${many ? "ALL the photos" : "the photo"} and the listing text together — the exterior, any view out of the windows or balcony, the street, and the entrance — verifying distinctive clues and trying to match the listing itself with web search.` +
    (listingText
      ? `\n\nListing text (treat as reliable ground truth; mine it for the commune, quarter, any street fragment or postcode, the floor and total floors, building age, agency, and proximity claims):\n"${listingText}"`
      : "") +
    `\n\nWhen you have finished researching, reply with ONLY a single JSON object inside a \`\`\`json code block, matching exactly:
{
  "location_found": boolean,
  "confidence": "street" | "building" | "block" | "neighborhood" | "city" | "region" | "country" | "unknown",
  "address": string | null,        // best full street address if defensible, else null
  "place": string,                 // short human summary, e.g. "Route du Jura, Fribourg"
  "city": string | null,
  "country": string | null,
  "latitude": number | null,       // WGS84 decimal degrees
  "longitude": number | null,
  "clues": string[],               // the visual clues you used, across all photos
  "text_read": string[],           // text you read from the photos
  "reasoning": string,             // 2-4 sentences on how you pinned it
  "sources": string[]              // URLs you verified against, incl. any matched listing
}`;

  return [...imageBlocks(images), { type: "text", text: instruction }];
}

function extractJson(text: string): unknown | null {
  // Prefer a fenced ```json block; fall back to the last {...} span.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) fence = m;
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* try next */
    }
  }
  return null;
}

// =============================================================================
// OSM verification — cross-check the vision estimate against OpenStreetMap
// ground truth (Overpass API). Vision narrows to a neighborhood; matching
// pixel features (a playground's surface, a shopfront, tower positions)
// against mapped features is what upgrades that to a specific building.
// =============================================================================

interface OsmFeatureDigest {
  digest: string;
  featureCount: number;
}

const OSM_TAG_WHITELIST = [
  "name",
  "amenity",
  "shop",
  "leisure",
  "tourism",
  "historic",
  "man_made",
  "railway",
  "public_transport",
  "highway",
  "building",
  "building:levels",
  "building:colour",
  "height",
  "surface",
  "operator",
  "brand",
  "religion",
  "addr:street",
  "addr:housenumber",
];

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
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Pull mapped features near the estimated point: named/addressed buildings,
// shops, playgrounds, transit stops close in; tall buildings a bit further out
// (they show on skylines). Returns null if Overpass is unreachable — the
// caller degrades to the unverified estimate.
export async function fetchNearbyOsmFeatures(lat: number, lon: number): Promise<OsmFeatureDigest | null> {
  const at = `${lat.toFixed(7)},${lon.toFixed(7)}`;
  // Named amenities only — unnamed street furniture (benches, waste baskets)
  // drowns out the features that can actually be matched against a photo.
  const query = `[out:json][timeout:12];
(
  nwr["leisure"](around:300,${at});
  nwr["amenity"]["name"](around:300,${at});
  nwr["shop"](around:300,${at});
  nwr["tourism"](around:300,${at});
  nwr["historic"](around:300,${at});
  nwr["building"]["addr:housenumber"](around:220,${at});
  nwr["building:levels"~"^([6-9]|[1-9][0-9])$"](around:600,${at});
  nwr["railway"~"^(station|halt|tram_stop)$"](around:450,${at});
  nwr["highway"="bus_stop"](around:300,${at});
);
out center tags 400;`;

  try {
    const res = await fetch(OVERPASS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": NOMINATIM_USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { elements?: OverpassElement[] };
    const elements = data.elements ?? [];

    const lines: { dist: number; line: string }[] = [];
    for (const el of elements) {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      const tags = el.tags ?? {};
      const kept = OSM_TAG_WHITELIST.filter((k) => tags[k]).map((k) => `${k}=${tags[k]}`);
      if (elLat === undefined || elLon === undefined || kept.length === 0) continue;
      const dist = haversineMeters(lat, lon, elLat, elLon);
      const dir = compassBearing(lat, lon, elLat, elLon);
      lines.push({ dist, line: `- ${Math.round(dist)}m ${dir}: ${kept.join(", ")}` });
    }
    lines.sort((a, b) => a.dist - b.dist);

    let digest = "";
    let count = 0;
    for (const { line } of lines) {
      if (digest.length + line.length > 12000) break;
      digest += line + "\n";
      count++;
    }
    if (count === 0) return { digest: "(no mapped features found near this point)", featureCount: 0 };
    return { digest: digest.trimEnd(), featureCount: count };
  } catch (err) {
    console.error("[api] overpass lookup failed:", err);
    return null;
  }
}

const osmVerdictSchema = z.object({
  corroborated: z.boolean(),
  matches: z.array(
    z.object({
      feature: z.string(),
      clue: z.string(),
    }),
  ),
  mismatches: z.array(z.string()),
  confidence: confidenceSchema,
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  notes: z.string(),
});
export type OsmVerdict = z.infer<typeof osmVerdictSchema>;

export interface OsmVerification {
  status: "verified" | "unverified" | "skipped" | "unavailable";
  matches: { feature: string; clue: string }[];
  mismatches: string[];
  notes: string | null;
  refined: boolean;
}

const VERIFY_SYSTEM_PROMPT = `You are the map-verification stage of a property-geolocation pipeline. A first pass estimated where a listing's property is. You receive the same listing photos, that estimate, and a list of real OpenStreetMap features mapped near the estimated point (each with its distance and compass bearing FROM the estimated point).

Your job: test the estimate against this ground truth.
- Match concrete features visible in the photos (playgrounds and their surface, shopfronts, building heights and colours, addresses, transit stops, towers on the skyline, the property's own facade against an addressed building footprint) against the mapped features.
- Use distances and bearings: if a photo shows tall buildings in the background and the map lists high-rises 300m NE, the camera likely faces NE — check that the rest of the scene is consistent with that.
- A distinctive feature that appears in BOTH the photos and the map data (e.g. a rubber-surfaced playground, a specific shop brand, a building height that matches an addressed footprint) is strong corroboration. Features the photos clearly show but the map does not list nearby are weak evidence against — OSM coverage is incomplete, so weigh mismatches carefully.
- Refine when justified: if the matches pin the property to a specific building or address, return the tighter position, address, and confidence. If the map data contradicts the estimate, downgrade the confidence honestly.
- NEVER invent map features or matches. Only cite features from the provided list.`;

async function verifyWithOsm(
  client: Anthropic,
  images: ImageInput[],
  estimate: LocationEstimate,
): Promise<{ verification: OsmVerification; verdict: OsmVerdict | null }> {
  const skipped: OsmVerification = {
    status: "skipped",
    matches: [],
    mismatches: [],
    notes: null,
    refined: false,
  };
  const verifiable = ["street", "building", "block", "neighborhood"].includes(estimate.confidence);
  if (!verifiable || estimate.latitude === null || estimate.longitude === null) {
    return { verification: skipped, verdict: null };
  }

  const features = await fetchNearbyOsmFeatures(estimate.latitude, estimate.longitude);
  if (features === null) {
    return { verification: { ...skipped, status: "unavailable" }, verdict: null };
  }

  const briefing = `First-pass estimate:
${JSON.stringify(
    {
      confidence: estimate.confidence,
      address: estimate.address,
      place: estimate.place,
      latitude: estimate.latitude,
      longitude: estimate.longitude,
      clues: estimate.clues,
      text_read: estimate.text_read,
    },
    null,
    2,
  )}

OpenStreetMap features near the estimated point (distance and bearing are FROM that point):
${features.digest}

Verify the estimate against the photos and this map data, then refine or downgrade it as the evidence dictates.`;

  const resp = await client.messages.parse({
    model: VISION_MODEL,
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    system: VERIFY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [...imageBlocks(images), { type: "text", text: briefing }],
      },
    ],
    output_config: { format: zodOutputFormat(osmVerdictSchema) },
  });

  if (resp.stop_reason === "refusal" || !resp.parsed_output) {
    return { verification: { ...skipped, status: "unavailable" }, verdict: null };
  }

  const verdict = resp.parsed_output;
  const refined =
    verdict.corroborated &&
    (verdict.latitude !== estimate.latitude ||
      verdict.longitude !== estimate.longitude ||
      verdict.confidence !== estimate.confidence ||
      verdict.address !== estimate.address);

  return {
    verification: {
      status: verdict.corroborated ? "verified" : "unverified",
      matches: verdict.matches,
      mismatches: verdict.mismatches,
      notes: verdict.notes || null,
      refined,
    },
    verdict,
  };
}

interface GeolocateResult {
  estimate: LocationEstimate;
  searchUsed: boolean;
}

async function geolocate(
  client: Anthropic,
  input: AnalyzeInput,
): Promise<GeolocateResult | { refusal: true }> {
  // Web search is a server-side tool; cast to keep this resilient across SDK minor versions.
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }] as unknown as Anthropic.Messages.ToolUnion[];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildUserContent(input.images, input.listingText) },
  ];

  let searchUsed = false;
  let finalText = "";

  // The web-search server loop can emit `pause_turn`; re-send to resume (no extra user message).
  for (let i = 0; i < 6; i++) {
    const resp = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 12000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (resp.content.some((b) => (b as { type: string }).type === "web_search_tool_result")) {
      searchUsed = true;
    }
    if (resp.stop_reason === "refusal") {
      return { refusal: true };
    }
    if (resp.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    finalText = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    break;
  }

  const parsed = extractJson(finalText);
  const validated = estimateSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("Model did not return a usable location estimate");
  }
  return { estimate: validated.data, searchUsed };
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
      const result = await geolocate(client, input);

      if ("refusal" in result) {
        res.status(422).json({ error: "The model declined to analyze this listing." });
        return;
      }

      const { searchUsed } = result;
      let { estimate } = result;

      // Second pass: cross-check the estimate against OpenStreetMap ground
      // truth. Must never break the endpoint — degrades to the raw estimate.
      let osmVerification: OsmVerification = {
        status: "unavailable",
        matches: [],
        mismatches: [],
        notes: null,
        refined: false,
      };
      try {
        const { verification, verdict } = await verifyWithOsm(client, input.images, estimate);
        osmVerification = verification;
        if (verdict && verification.status === "verified") {
          estimate = {
            ...estimate,
            confidence: verdict.confidence,
            address: verdict.address ?? estimate.address,
            latitude: verdict.latitude ?? estimate.latitude,
            longitude: verdict.longitude ?? estimate.longitude,
          };
        } else if (verdict && verification.status === "unverified") {
          estimate = { ...estimate, confidence: verdict.confidence };
        }
      } catch (err) {
        console.error("[api] OSM verification failed:", err);
      }

      // Format the (possibly refined) coordinates into a canonical street
      // address for display (formatting the vision estimate — not a file lookup).
      let resolvedAddress: FormattedAddress | null = null;
      if (estimate.latitude !== null && estimate.longitude !== null) {
        try {
          resolvedAddress = await reverseGeocode(estimate.latitude, estimate.longitude);
        } catch (err) {
          console.error("[api] reverse geocode of estimate failed:", err);
        }
      }

      res.json({ estimate, resolvedAddress, searchUsed, osmVerification });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        res.status(503).json({ error: "The configured Anthropic API key was rejected." });
        return;
      }
      if (err instanceof Anthropic.RateLimitError) {
        res.status(429).json({ error: "Vision analysis is rate limited right now. Try again shortly." });
        return;
      }
      console.error("[api] photo analysis failed:", err);
      res.status(502).json({ error: "Vision analysis failed. Please try again." });
    }
  });
}
