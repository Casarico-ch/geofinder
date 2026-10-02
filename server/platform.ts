// =============================================================================
// Platform API (/v1) — GeoFinder as a private service for our own platform.
//
// Every /v1 call needs `Authorization: Bearer <GEOFINDER_API_KEY>`.
//   POST /v1/address   { images, listingText?, municipality? } → 202 + requestId (finds the address)
//   GET  /v1/requests/:id                                     → status + each model's address
//   POST /v1/property  { address } | { latitude, longitude } | { commune, plot } → Popety property data (CHF 3.80)
//                      or { plots: [ ...2-10 of those ] } → each plot + the plots combined (CHF 3.80 per plot)
// The admin website reads the same records through /api/requests.
// =============================================================================
import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { MODELS, createJob, getJob, type ModelId } from "./jobs";
import {
  PROFILE_COST_CHF,
  PopetyError,
  combineProfiles,
  findLandByAddress,
  findLandByCoordinates,
  findLandByPlot,
  getProfileByLandId,
} from "./popety";
import {
  type PlatformRequest,
  createRequest,
  createRequestFromJobs,
  getRequest,
  listRequestsWithLooseJobs,
  saveRequest,
  watchListingRequest,
} from "./requests";

// The models every listing request runs on, side by side.
const LISTING_MODELS: ModelId[] = (process.env.GEOFINDER_MODELS ?? "claude-opus-4-8,claude-opus-5-5")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is ModelId => (MODELS as readonly string[]).includes(m));

// An address, coordinates (WGS84) or a commune + plot number. The last two
// also find plots with no building and so no address.
const plotSchema = z.union([
  z.object({ address: z.string().trim().min(3).max(300) }).strict(),
  z.object({ latitude: z.number().min(45.7).max(47.9), longitude: z.number().min(5.9).max(10.6) }).strict(),
  z.object({ commune: z.string().trim().min(2).max(100), plot: z.string().trim().min(1).max(40) }).strict(),
]);
type PlotInput = z.infer<typeof plotSchema>;
// One plot, or { plots: [...] } to look at several together as one site.
const propertySchema = z.union([plotSchema, z.object({ plots: z.array(plotSchema).min(2).max(10) }).strict()]);

const resolvePlot = (p: PlotInput) =>
  "address" in p
    ? findLandByAddress(p.address)
    : "plot" in p
      ? findLandByPlot(p.commune, p.plot)
      : findLandByCoordinates(p.latitude, p.longitude);

const describePlot = (p: PlotInput) =>
  "address" in p ? p.address : "plot" in p ? `${p.commune} ${p.plot}` : `${p.latitude}, ${p.longitude}`;

const notFoundMessage = (p: PlotInput) =>
  "address" in p
    ? "No parcel matches this address."
    : "plot" in p
      ? "No parcel with this plot number in this commune (accents count, e.g. Genève)."
      : "No parcel at these coordinates.";

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
  listingId: z.string().trim().min(1).max(200).optional(),
  listingUrl: z.string().trim().url().max(2000).optional(),
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
      ? r.combined
        ? { profiles: r.profiles ?? [], combined: r.combined, plotErrors: r.plotErrors }
        : { profile: r.profile ?? null, candidates: r.candidates, plotErrors: r.plotErrors }
      : {
          results: (r.results ?? []).map((m) => ({
            model: m.model,
            status: m.status,
            answer: m.answer,
          })),
        }),
    popetyCostChf: r.popetyCostChf,
    error: r.error,
  };
}

export function registerPlatformRoutes(app: Express) {
  app.use("/v1", requireApiKey);

  app.post("/v1/property", async (req: Request, res: Response) => {
    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Expected one of { address }, { latitude, longitude } (a point in Switzerland) or { commune, plot }, " +
          "or { plots: [...] } with 2 to 10 of those",
      });
      return;
    }
    const input = parsed.data;
    const plots = "plots" in input ? input.plots : [input];
    const record = await createRequest("address", input);
    const fail = async (status: number, error: string) => {
      record.status = status === 300 ? "done" : "error";
      record.error = error;
      await saveRequest(record);
      res.status(status).json(publicView(record));
    };
    try {
      // Finding the parcels is free; only fetch (and pay for) data once every plot is pinned.
      const matches = await Promise.all(plots.map(resolvePlot));
      const problems = matches.flatMap((m, i) =>
        m.kind === "match" ? [] : [{ input: plots[i], kind: m.kind, match: m }],
      );
      if (problems.length) {
        if (plots.length === 1) {
          const m = matches[0];
          if (m.kind === "ambiguous") {
            record.candidates = m.candidates;
            await fail(300, "Several parcels match this address; send one of the candidate addresses.");
          } else await fail(404, notFoundMessage(plots[0]));
          return;
        }
        record.plotErrors = problems.map((p) => ({
          plot: describePlot(p.input),
          error: p.kind === "ambiguous" ? "Several parcels match; be more precise." : notFoundMessage(p.input),
          candidates: p.match.kind === "ambiguous" ? p.match.candidates : undefined,
        }));
        await fail(problems.some((p) => p.kind === "ambiguous") ? 300 : 404, "Not every plot could be found; nothing was charged.");
        return;
      }

      const pinned = matches.map((m, i) => ({ ...(m as Extract<typeof m, { kind: "match" }>), plot: plots[i] }));
      const unique = pinned.filter((m, i) => pinned.findIndex((o) => o.landId === m.landId) === i);
      const profiles = await Promise.all(
        unique.map((m) => getProfileByLandId(m.landId, m.matchedAddress ?? ("address" in m.plot ? m.plot.address : null))),
      );
      record.popetyCostChf = Math.round(profiles.length * PROFILE_COST_CHF * 100) / 100;
      if ("plots" in input) {
        record.profiles = profiles;
        record.combined = combineProfiles(profiles);
      } else {
        record.profile = profiles[0];
      }
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

  app.post("/v1/address", async (req: Request, res: Response) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      res.status(503).json({ error: "Not configured. Set ANTHROPIC_API_KEY on the server." });
      return;
    }
    const parsed = listingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { images: [{ imageBase64, mediaType }], listingText?, municipality?, listingId?, listingUrl? }" });
      return;
    }
    const { municipality, listingId, listingUrl } = parsed.data;
    const listingText = [municipality?.trim() && `Municipality / commune: ${municipality.trim()}`, parsed.data.listingText?.trim()]
      .filter(Boolean)
      .join("\n\n") || undefined;
    const images: AgentImage[] = parsed.data.images.map((i) => ({ base64: i.imageBase64, mediaType: i.mediaType }));

    try {
      const record = await createRequest("listing", {
        listingText: parsed.data.listingText,
        municipality,
        imageCount: images.length,
        listingId,
        listingUrl,
      });
      record.results = [];
      for (const model of LISTING_MODELS) {
        const job = await createJob({ municipality, listingText, imageCount: images.length, listingId, listingUrl }, model);
        record.results.push({ model, jobId: job.id, status: "running", answer: null, aiCostUsd: 0 });
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
    res.json({ requests: listRequestsWithLooseJobs().slice(0, 200) });
  });

  // The website's New search form starts one job per chosen model, then calls
  // this to group them into one request on the main table.
  app.post("/api/requests/group", async (req: Request, res: Response) => {
    const parsed = z.object({ jobIds: z.array(z.string()).min(1).max(10) }).safeParse(req.body);
    const jobs = parsed.success ? parsed.data.jobIds.map((id) => getJob(id)) : [];
    if (!parsed.success || jobs.some((j) => !j)) {
      res.status(400).json({ error: "Expected { jobIds } of existing investigations" });
      return;
    }
    const record = await createRequestFromJobs(jobs as NonNullable<(typeof jobs)[number]>[]);
    res.status(201).json({ requestId: record.id });
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
