// =============================================================================
// Platform API (/v1) — GeoFinder as a private service for our own platform.
//
// Every /v1 call needs `Authorization: Bearer <GEOFINDER_API_KEY>`.
//   POST /v1/properties/by-address  { address }                       → profile now
//   POST /v1/properties/by-listing  { images, listingText?, municipality? } → 202 + requestId
//   GET  /v1/requests/:id                                              → status + results
// The admin website reads the same records through /api/requests.
// =============================================================================
import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { MODELS, createJob, type ModelId } from "./jobs";
import { PROFILE_COST_CHF, PopetyError, findLandByAddress, getProfileByLandId } from "./popety";
import {
  type PlatformRequest,
  createRequest,
  getRequest,
  listRequests,
  saveRequest,
  watchListingRequest,
} from "./requests";

// The models every listing request runs on, side by side.
const LISTING_MODELS: ModelId[] = (process.env.GEOFINDER_MODELS ?? "claude-opus-4-8,claude-opus-5-5")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is ModelId => (MODELS as readonly string[]).includes(m));

const addressSchema = z.object({ address: z.string().trim().min(3).max(300) });

const listingSchema = z.object({
  images: z
    .array(
      z.object({
        imageBase64: z.string().min(1),
        mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
      }),
    )
    .min(1)
    .max(15),
  listingText: z.string().max(20000).optional(),
  municipality: z.string().max(200).optional(),
});

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = process.env.GEOFINDER_API_KEY;
  if (!key) {
    res.status(503).json({ error: "Not configured. Set GEOFINDER_API_KEY on the server." });
    return;
  }
  const given = Buffer.from(req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(key);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "Missing or wrong API key." });
    return;
  }
  next();
}

// What the platform sees: the record minus internal job ids.
function publicView(r: PlatformRequest) {
  return {
    requestId: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt ?? null,
    input: r.input,
    ...(r.kind === "address"
      ? { profile: r.profile ?? null, candidates: r.candidates }
      : {
          results: (r.results ?? []).map((m) => ({
            model: m.model,
            status: m.status,
            answer: m.answer,
            profile: m.profile,
            profileError: m.profileError,
          })),
        }),
    popetyCostChf: r.popetyCostChf,
    error: r.error,
  };
}

export function registerPlatformRoutes(app: Express) {
  app.use("/v1", requireApiKey);

  app.post("/v1/properties/by-address", async (req: Request, res: Response) => {
    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { address }" });
      return;
    }
    const { address } = parsed.data;
    const record = await createRequest("address", { address });
    try {
      const match = await findLandByAddress(address);
      if (match.kind === "ambiguous") {
        record.status = "done";
        record.candidates = match.candidates;
        record.error = "Several parcels match this address; send one of the candidate addresses.";
        await saveRequest(record);
        res.status(300).json(publicView(record));
        return;
      }
      if (match.kind === "none") {
        record.status = "error";
        record.error = "No parcel matches this address.";
        await saveRequest(record);
        res.status(404).json(publicView(record));
        return;
      }
      record.profile = await getProfileByLandId(match.landId, match.matchedAddress ?? address);
      record.popetyCostChf = PROFILE_COST_CHF;
      record.status = "done";
      await saveRequest(record);
      res.json(publicView(record));
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      await saveRequest(record);
      const status = err instanceof PopetyError && err.status === 402 ? 402 : 502;
      res.status(status).json(publicView(record));
    }
  });

  app.post("/v1/properties/by-listing", async (req: Request, res: Response) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(503).json({ error: "Not configured. Set ANTHROPIC_API_KEY on the server." });
      return;
    }
    const parsed = listingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { images: [{ imageBase64, mediaType }], listingText?, municipality? }" });
      return;
    }
    const { municipality } = parsed.data;
    const listingText = [municipality?.trim() && `Municipality / commune: ${municipality.trim()}`, parsed.data.listingText?.trim()]
      .filter(Boolean)
      .join("\n\n") || undefined;
    const images: AgentImage[] = parsed.data.images.map((i) => ({ base64: i.imageBase64, mediaType: i.mediaType }));

    try {
      const record = await createRequest("listing", {
        listingText: parsed.data.listingText,
        municipality,
        imageCount: images.length,
      });
      record.results = [];
      for (const model of LISTING_MODELS) {
        const job = await createJob({ municipality, listingText, imageCount: images.length }, model);
        record.results.push({ model, jobId: job.id, status: "running", answer: null, profile: null, aiCostUsd: 0 });
        void (async () => {
          await saveListingPhotos(job.runDir, images);
          await runInvestigation(job, images, listingText);
        })().catch((err) => console.error(`[platform] investigation ${job.id} crashed:`, err));
      }
      await saveRequest(record);
      watchListingRequest(record);
      res.status(202).json(publicView(record));
    } catch (err) {
      console.error("[platform] failed to start listing request:", err);
      res.status(500).json({ error: "Could not start the investigation." });
    }
  });

  app.get("/v1/requests/:id", (req: Request, res: Response) => {
    const record = getRequest(req.params.id);
    if (!record) {
      res.status(404).json({ error: "No such request" });
      return;
    }
    res.json(publicView(record));
  });

  // ---- admin website (same records, including the job ids for the traces) ----
  app.get("/api/requests", (_req: Request, res: Response) => {
    res.json({ requests: listRequests().slice(0, 200) });
  });

  app.get("/api/requests/:id", (req: Request, res: Response) => {
    const record = getRequest(req.params.id);
    if (!record) {
      res.status(404).json({ error: "No such request" });
      return;
    }
    res.json(record);
  });
}
