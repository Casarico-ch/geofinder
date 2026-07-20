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
import { buildDossier } from "./enrich";
import { costUsd, createJob, getJob, listJobs, requestCancel, setDossier } from "./jobs";

const mediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const bodySchema = z.object({
  images: z
    .array(z.object({ imageBase64: z.string().min(1), mediaType: mediaTypeSchema }))
    .min(1)
    .max(15),
  listingText: z.string().max(20000).optional(),
  municipality: z.string().max(200).optional(),
});

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

  // Start an investigation. Returns immediately with a job id; the work runs in
  // the background and is polled via GET below.
  app.post("/api/geo/investigate", async (req: Request, res: Response) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(503).json({
        error: "Not configured. Set ANTHROPIC_API_KEY on the server to enable investigations.",
      });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Expected { images: [{ imageBase64, mediaType }], listingText?, municipality? }",
      });
      return;
    }

    const images: AgentImage[] = parsed.data.images.map((img) => ({
      base64: img.imageBase64,
      mediaType: img.mediaType,
    }));
    const listingText = foldListingText(parsed.data.listingText, parsed.data.municipality);

    try {
      const job = await createJob({
        municipality: parsed.data.municipality,
        listingText,
        imageCount: images.length,
      });

      // Respond the instant the job exists. Writing the photos to disk and the
      // whole investigation run happen in the background, so "Starting…" ends as
      // soon as the job is created instead of waiting on the volume. The model's
      // first turn gets the photos in-memory; the on-disk copies (for later
      // read_file/crop) are written here, well before any read_file can occur.
      void (async () => {
        await saveListingPhotos(job.runDir, images);
        await runInvestigation(job, images, listingText);
      })().catch((err) => {
        console.error(`[api] investigation ${job.id} crashed:`, err);
      });

      res.status(202).json({ jobId: job.id });
    } catch (err) {
      console.error("[api] failed to start investigation:", err);
      res.status(500).json({
        error: "Could not start the investigation on the server.",
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
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

  // Optional, manual enrichment: build the buyer's dossier for a found parcel
  // from authoritative public layers. Runs only after an answer with coords.
  app.post("/api/geo/investigate/:id/enrich", async (req: Request, res: Response) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No such investigation" });
      return;
    }
    const { latitude, longitude } = job.answer ?? {};
    if (latitude == null || longitude == null) {
      res.status(400).json({ error: "This investigation has no coordinates to enrich." });
      return;
    }
    try {
      const dossier = await buildDossier(latitude, longitude);
      await setDossier(job, dossier);
      res.json(dossier);
    } catch (err) {
      console.error(`[api] enrich ${job.id} failed:`, err);
      res.status(502).json({ error: "Could not build the dossier. Try again." });
    }
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
