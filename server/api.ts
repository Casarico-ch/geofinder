import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";

// =============================================================================
// Address Finder API — vision-only geolocation
//
// The address is derived purely from the *pixels* of the submitted photo plus
// any free-text context the user chooses to add. No EXIF, no device location,
// no file metadata of any kind is read. To push accuracy as far as vision
// allows, Claude is given the web-search tool so it can verify identifiable
// clues it reads in the image (shop names, bus-stop names, street signs,
// distinctive buildings) and resolve them to a real address + coordinates.
// =============================================================================

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT =
  "manus-github-test-address-finder/2.0 (https://github.com/ImmoRessource/manus-github-test)";

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

// The structured verdict we ask the model to emit and then validate.
const estimateSchema = z.object({
  location_found: z.boolean(),
  confidence: z.enum([
    "street",
    "building",
    "block",
    "neighborhood",
    "city",
    "region",
    "country",
    "unknown",
  ]),
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

const analyzeBodySchema = z.object({
  imageBase64: z.string().min(1),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  hint: z.string().max(2000).optional(),
});

const SYSTEM_PROMPT = `You are an expert visual geolocation analyst — a champion GeoGuessr player combined with a meticulous OSINT researcher. You determine where a photograph was taken using ONLY the visual content of the image and any text context the user provides.

Reason from concrete visual evidence:
- Read and transcribe EVERY piece of legible text in the image (street signs, shop and business names, bus/tram stop names, house numbers, posters, license plates, phone numbers). Text is your highest-value evidence.
- Architecture and construction era, street furniture, road markings and traffic-sign conventions, bollards, utility poles.
- Language and typography, vegetation, terrain, mountain skyline profiles, sun direction and shadows.

Use the web_search tool aggressively to VERIFY identifiable clues — a business name, a bus-stop name, a distinctive building, a street name plus town — and to resolve them to a precise street address and WGS84 coordinates. Search in the local language when useful.

Rules:
- Prefer a precise street address (with house number) when the evidence genuinely supports it. Otherwise report the tightest area you can defend and label the confidence honestly.
- NEVER fabricate a specific address or coordinates you cannot justify from the evidence. It is better to return "neighborhood" confidence than a confident wrong street number.
- Treat any user-provided context as reliable ground truth and combine it with what you see.`;

function buildUserContent(imageBase64: string, mediaType: string, hint?: string) {
  const instruction =
    `Determine where this photo was taken. Work through the visual clues and any legible text, verifying with web search where a clue is specific enough to look up.` +
    (hint && hint.trim()
      ? `\n\nContext the user submitted (treat as reliable): "${hint.trim()}"`
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
  "clues": string[],               // the visual clues you used
  "text_read": string[],           // text you read from the image
  "reasoning": string,             // 2-4 sentences on how you pinned it
  "sources": string[]              // URLs you verified against, if any
}`;

  return [
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: imageBase64,
      },
    },
    { type: "text" as const, text: instruction },
  ];
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

interface GeolocateResult {
  estimate: LocationEstimate;
  searchUsed: boolean;
}

async function geolocate(
  client: Anthropic,
  input: { imageBase64: string; mediaType: string; hint?: string },
): Promise<GeolocateResult | { refusal: true }> {
  // Web search is a server-side tool; cast to keep this resilient across SDK minor versions.
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }] as unknown as Anthropic.Messages.ToolUnion[];

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildUserContent(input.imageBase64, input.mediaType, input.hint) },
  ];

  let searchUsed = false;
  let finalText = "";

  // The web-search server loop can emit `pause_turn`; re-send to resume (no extra user message).
  for (let i = 0; i < 6; i++) {
    const resp = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 6000,
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
      res.status(400).json({ error: "Expected { imageBase64, mediaType, hint? } in the request body" });
      return;
    }

    try {
      const client = new Anthropic();
      const result = await geolocate(client, parsed.data);

      if ("refusal" in result) {
        res.status(422).json({ error: "The model declined to analyze this image." });
        return;
      }

      const { estimate, searchUsed } = result;

      // If the model produced coordinates, format them into a canonical street
      // address for display (formatting the vision estimate — not a file lookup).
      let resolvedAddress: FormattedAddress | null = null;
      if (estimate.latitude !== null && estimate.longitude !== null) {
        try {
          resolvedAddress = await reverseGeocode(estimate.latitude, estimate.longitude);
        } catch (err) {
          console.error("[api] reverse geocode of estimate failed:", err);
        }
      }

      res.json({ estimate, resolvedAddress, searchUsed });
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
