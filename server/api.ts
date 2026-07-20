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

      res.json({ estimate: result });
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
