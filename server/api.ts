// =============================================================================
// GeoFinder API — start / poll / list background investigations.
//
// The server holds NO geolocation logic. It accepts a listing (photos + text),
// starts a background job in which an autonomous model investigates using a
// sandboxed computer (see agent.ts / sandbox.ts), and lets the client poll the
// documented trace. Closing the browser does not stop the job.
// =============================================================================
import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import { runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { analyzeBuildPotential } from "./potential";
import {
  addStep,
  costUsd,
  createJob,
  finishJob,
  getJob,
  listJobs,
  requestCancel,
} from "./jobs";

const mediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const imagesSchema = z
  .array(z.object({ imageBase64: z.string().min(1), mediaType: mediaTypeSchema }))
  .min(1)
  .max(15);

// The create request carries only metadata so it returns instantly; the photos
// follow on /photos. `images` stays optional for the old one-shot callers.
const createSchema = z.object({
  images: imagesSchema.optional(),
  imageCount: z.number().int().min(1).max(15).optional(),
  listingText: z.string().max(20000).optional(),
  municipality: z.string().max(200).optional(),
});

const photosSchema = z.object({ images: imagesSchema });

// If the photos never arrive (e.g. the tab was closed mid-upload), don't leave
// the job "running" forever — fail it after this long.
const PHOTO_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const awaitingPhotos = new Map<string, NodeJS.Timeout>();

function foldListingText(listingText?: string, municipality?: string): string | undefined {
  const parts: string[] = [];
  if (municipality?.trim()) parts.push(`Municipality / commune: ${municipality.trim()}`);
  if (listingText?.trim()) parts.push(listingText.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}

function jobSummary(job: ReturnType<typeof listJobs>[number]) {
  const title =
    job.answer?.address ??
    job.answer?.parcel ??
    job.input.municipality ??
    job.input.listingText?.slice(0, 60) ??
    "Investigation";
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    steps: job.steps.length,
    title,
    found: job.answer?.found ?? null,
    tokens: job.tokens?.total ?? 0,
    cost: job.tokens ? costUsd(job.tokens) : 0,
  };
}

export function registerApiRoutes(app: Express) {
  app.use(express.json({ limit: "30mb" }));

  // Create an investigation. This returns a job id in milliseconds because it
  // carries no photos — the client navigates to the job immediately and uploads
  // the photos in the background via /photos, which is what actually starts the
  // run. (Old callers may still pass `images` here for the one-shot path.)
  app.post("/api/geo/investigate", async (req: Request, res: Response) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(503).json({
        error: "Not configured. Set ANTHROPIC_API_KEY on the server to enable investigations.",
      });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Expected { imageCount?, images?, listingText?, municipality? }",
      });
      return;
    }

    const listingText = foldListingText(parsed.data.listingText, parsed.data.municipality);
    const images: AgentImage[] | undefined = parsed.data.images?.map((img) => ({
      base64: img.imageBase64,
      mediaType: img.mediaType,
    }));

    try {
      const job = await createJob({
        municipality: parsed.data.municipality,
        listingText,
        imageCount: images?.length ?? parsed.data.imageCount ?? 0,
      });

      if (images && images.length > 0) {
        // One-shot path (photos included): behave as before.
        void (async () => {
          await saveListingPhotos(job.runDir, images);
          await runInvestigation(job, images, listingText);
        })().catch((err) => console.error(`[api] investigation ${job.id} crashed:`, err));
      } else {
        // Two-phase path: wait for /photos to start the run. Show that we're
        // alive, and arm a safety timeout so a never-finished upload fails.
        await addStep(job, {
          kind: "note",
          title: "Preparing — waiting for the photos to upload…",
        });
        const timer = setTimeout(() => {
          awaitingPhotos.delete(job.id);
          if (job.status === "running") {
            void finishJob(job, { status: "error", error: "The photos were not uploaded." });
          }
        }, PHOTO_UPLOAD_TIMEOUT_MS);
        awaitingPhotos.set(job.id, timer);
      }

      res.status(202).json({ jobId: job.id });
    } catch (err) {
      console.error("[api] failed to start investigation:", err);
      res.status(500).json({
        error: "Could not start the investigation on the server.",
      });
    }
  });

  // Receive the photos for a two-phase investigation and start the run. This is
  // the heavy upload, but it happens after the client has already navigated to
  // the job, so it never blocks the user.
  app.post("/api/geo/investigate/:id/photos", async (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No such investigation" });
      return;
    }
    const timer = awaitingPhotos.get(job.id);
    if (!timer || job.status !== "running") {
      res.status(409).json({ error: "This investigation is not awaiting photos." });
      return;
    }
    const parsed = photosSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { images: [{ imageBase64, mediaType }] }" });
      return;
    }

    clearTimeout(timer);
    awaitingPhotos.delete(job.id);

    const images: AgentImage[] = parsed.data.images.map((img) => ({
      base64: img.imageBase64,
      mediaType: img.mediaType,
    }));
    const listingText = job.input.listingText;

    void (async () => {
      await saveListingPhotos(job.runDir, images);
      await runInvestigation(job, images, listingText);
    })().catch((err) => console.error(`[api] investigation ${job.id} crashed:`, err));

    res.status(202).json({ jobId: job.id });
  });

  // List recent investigations (for reopening after the window was closed).
  app.get("/api/geo/investigations", (_req: Request, res: Response) => {
    res.json({ jobs: listJobs().slice(0, 50).map(jobSummary) });
  });

  // Stop a running investigation (the agent loop checks the flag each turn).
  app.post("/api/geo/investigate/:id/cancel", (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No such investigation" });
      return;
    }
    if (job.status === "running") requestCancel(job);
    res.json({ ok: true });
  });

  // Optional, manual: analyse how much MORE can be built on the found parcel.
  // Runs the focused construction-potential agent in the background; the trace
  // and result are polled via GET below (job.potential / job.potentialStatus).
  app.post("/api/geo/investigate/:id/potential", (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No such investigation" });
      return;
    }
    const { latitude, longitude } = job.answer ?? {};
    if (latitude == null || longitude == null) {
      res.status(400).json({ error: "This investigation has no located parcel to analyse." });
      return;
    }
    if (job.potentialStatus === "running") {
      res.status(409).json({ error: "A construction-potential analysis is already running." });
      return;
    }
    void analyzeBuildPotential(job).catch((err) => {
      console.error(`[api] potential ${job.id} crashed:`, err);
    });
    res.status(202).json({ ok: true });
  });

  // Poll one investigation: full documented trace + answer + status.
  app.get("/api/geo/investigate/:id", (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No such investigation" });
      return;
    }
    const { runDir: _runDir, ...pub } = job;
    res.json({ ...pub, cost: costUsd(job.tokens) });
  });
}
