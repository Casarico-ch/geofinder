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
import { loadListingPhotos, runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { MODELS, costUsd, createJob, elapsedMs, getJob, listJobs, type Answer, type ModelId } from "./jobs";
import {
  PROFILE_COST_CHF,
  PopetyError,
  combineProfiles,
  findLandByAddress,
  findLandByCoordinates,
  findLandByEgrid,
  findLandByPlot,
  getProfileByLandId,
} from "./popety";
import {
  type ModelResult,
  type PlatformRequest,
  createRequest,
  createRequestFromJobs,
  deleteRows,
  getRequest,
  isCheckText,
  listRequests,
  listRequestsWithLooseJobs,
  onListingSettled,
  saveRequest,
  watchListingRequest,
} from "./requests";

// The models every listing request runs on, side by side.
const LISTING_MODELS: ModelId[] = (process.env.GEOFINDER_MODELS ?? "claude-sonnet-5-5,claude-opus-5-5")
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is ModelId => (MODELS as readonly string[]).includes(m));

// An address, coordinates (WGS84) or a commune + plot number. The last two
// also find plots with no building and so no address.
const plotSchema = z.union([
  z.object({ address: z.string().trim().min(3).max(300) }).strict(),
  z.object({ latitude: z.number().min(45.7).max(47.9), longitude: z.number().min(5.9).max(10.6) }).strict(),
  // A plot as /v1/address returns it in parcels[]; the EGRID, when given, is used first.
  z
    .object({
      commune: z.string().trim().min(2).max(100),
      plot: z.string().trim().min(1).max(40),
      egrid: z.string().trim().max(40).nullish(),
    })
    .strict(),
  z.object({ egrid: z.string().trim().min(6).max(40) }).strict(),
]);
type PlotInput = z.infer<typeof plotSchema>;
// One plot, or { plots: [...] } (several looked at together as one site; the
// parcels[] that /v1/address returns can be sent as is).
const propertySchema = z.union([plotSchema, z.object({ plots: z.array(plotSchema).min(1).max(10) }).strict()]);

const resolvePlot = async (p: PlotInput) => {
  if ("address" in p) return findLandByAddress(p.address);
  if ("egrid" in p && p.egrid) {
    const byEgrid = await findLandByEgrid(p.egrid);
    if (byEgrid.kind === "match" || !("plot" in p)) return byEgrid;
  }
  if ("plot" in p) return findLandByPlot(p.commune, p.plot);
  if ("latitude" in p) return findLandByCoordinates(p.latitude, p.longitude);
  return { kind: "none" } as const;
};

const describePlot = (p: PlotInput) =>
  "address" in p
    ? p.address
    : "plot" in p
      ? `${p.commune} ${p.plot}`
      : "latitude" in p
        ? `${p.latitude}, ${p.longitude}`
        : `EGRID ${p.egrid}`;

const notFoundMessage = (p: PlotInput) =>
  "address" in p
    ? "No parcel matches this address."
    : "plot" in p
      ? "No parcel with this plot number in this commune (accents count, e.g. Genève)."
      : "latitude" in p
        ? "No parcel at these coordinates."
        : "No parcel with this EGRID.";

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
  radarUrl: z.string().trim().url().max(2000).optional(),
  // Run on these models instead of the default (GEOFINDER_MODELS) for this request only.
  models: z.array(z.enum(MODELS)).min(1).max(MODELS.length).optional(),
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
            ...(m.check ? { check: true } : {}),
          })),
        }),
    popetyCostChf: r.popetyCostChf,
    error: r.error,
  };
}

/**
 * Start a listing request: one investigation per model, side by side, grouped
 * as one request. Shared by /v1/address and the admin's "Run again".
 */
export async function startListingRequest(
  input: { listingText?: string; municipality?: string; listingId?: string; listingUrl?: string; radarUrl?: string },
  images: AgentImage[],
  models: ModelId[],
) {
  const { municipality, listingId, listingUrl, radarUrl } = input;
  const listingText =
    [municipality?.trim() && `Municipality / commune: ${municipality.trim()}`, input.listingText?.trim()]
      .filter(Boolean)
      .join("\n\n") || undefined;
  const record = await createRequest("listing", {
    listingText: input.listingText,
    municipality,
    imageCount: images.length,
    listingId,
    listingUrl,
    radarUrl,
  });
  record.results = [];
  for (const model of models) {
    const job = await createJob({ municipality, listingText, imageCount: images.length, listingId, listingUrl, radarUrl }, model);
    record.results.push({ model, jobId: job.id, status: "running", answer: null, aiCostUsd: 0 });
    void (async () => {
      await saveListingPhotos(job.runDir, images);
      await runInvestigation(job, images, listingText);
    })().catch((err) => console.error(`[platform] investigation ${job.id} crashed:`, err));
  }
  await saveRequest(record);
  watchListingRequest(record);
  return record;
}

// The model that settles a split: cheap, since it checks given places rather
// than searching the commune.
const CHECK_MODEL: ModelId = (MODELS as readonly string[]).includes(process.env.GEOFINDER_CHECK_MODEL ?? "")
  ? (process.env.GEOFINDER_CHECK_MODEL as ModelId)
  : "claude-sonnet-5-5";

// Pinned to one property: an address or plot at street, building or parcel confidence.
const pinned = (a: Answer | null): a is Answer =>
  !!a?.found && (!!a.address || a.parcels.length > 0 || !!a.parcel) && ["street", "building", "parcel"].includes(a.confidence);

const placeKey = (a: Answer): string =>
  a.parcels.length
    ? a.parcels.map((p) => `${p.commune} ${p.plot}`.toLowerCase()).sort().join("+")
    : (a.parcel ?? a.address ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const describeAnswer = (a: Answer): string => {
  const plots = a.parcels.length ? a.parcels.map((p) => `${p.commune} ${p.plot}`).join(" + ") : a.parcel;
  const where = [a.address, plots && `plot ${plots}`].filter(Boolean).join(", ");
  const at = a.latitude != null && a.longitude != null ? ` (around ${a.latitude.toFixed(6)}, ${a.longitude.toFixed(6)})` : "";
  return `${where || "an unnamed place"}${at}`;
};

const modelLabel = (m: ModelId) =>
  m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());

// The verification task for a listing whose models settled on different places
// (or where only one pinned it), else null: they agree, nobody pinned a place,
// fewer than two finished, or it was already cross-checked.
export function splitTask(results: ModelResult[]): string | null {
  if (results.some((m) => m.check)) return null;
  const searches = results.filter((m) => m.status === "done" && m.answer);
  const claims = searches.filter((m) => pinned(m.answer));
  if (searches.length < 2 || claims.length === 0) return null;
  if (claims.length === searches.length && new Set(claims.map((m) => placeKey(m.answer!))).size === 1) return null;
  const lines = searches.map((m) => {
    const a = m.answer!;
    return a.found && (a.address || a.parcel || a.parcels.length)
      ? `- ${modelLabel(m.model)}: ${describeAnswer(a)} — confidence ${a.confidence}`
      : `- ${modelLabel(m.model)}: did not find it`;
  });
  return [
    "--- VERIFICATION TASK ---",
    "Other investigators disagree on where this property is:",
    ...lines,
    "Do NOT take any of them on trust. Check each place against the photos, the listing text and the map evidence yourself.",
    "If, and only if, you are highly confident that one of these exact locations (street AND house number, or the cadastral plot number) is the property, report found=true with that address and/or plot at street or building confidence.",
    "If none is right, or you cannot confirm one with high confidence, report found=false — or the address you are highly confident is correct instead.",
  ].join("\n");
}

// When the models split, one more run checks their places against the listing
// and decides. It is the verification task the platform used to send on its
// own, so it shows on the request as a Cross-check card, even on a re-run.
async function crossCheckIfSplit(req: PlatformRequest): Promise<boolean> {
  const results = req.results ?? [];
  const task = req.kind === "listing" ? splitTask(results) : null;
  if (!task) return false;
  const first = results.find((m) => m.status === "done" && m.answer);
  const src = first && getJob(first.jobId);
  const images = src ? await loadListingPhotos(src.runDir) : [];
  if (!src || images.length === 0) return false;
  const listingText = `${src.input.listingText ?? ""}\n\n${task}`;
  const job = await createJob({ ...src.input, listingText }, CHECK_MODEL);
  results.push({ model: CHECK_MODEL, jobId: job.id, status: "running", answer: null, aiCostUsd: 0, check: true });
  req.status = "running";
  void (async () => {
    await saveListingPhotos(job.runDir, images);
    await runInvestigation(job, images, listingText);
  })().catch((err) => console.error(`[platform] cross-check ${job.id} crashed:`, err));
  return true;
}

export function registerPlatformRoutes(app: Express) {
  onListingSettled(crossCheckIfSplit);
  app.use("/v1", requireApiKey);

  app.post("/v1/property", async (req: Request, res: Response) => {
    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Expected one of { address }, { latitude, longitude } (a point in Switzerland), { commune, plot, egrid? } " +
          "or { egrid }, or { plots: [...] } with 1 to 10 of those (e.g. the parcels[] /v1/address returns)",
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
      res.status(400).json({ error: `Expected { images: [{ imageBase64, mediaType }], listingText?, municipality?, listingId?, listingUrl?, radarUrl?, models? } (models: ${MODELS.join(", ")})` });
      return;
    }
    const { municipality, listingId, listingUrl, radarUrl } = parsed.data;
    const models = parsed.data.models ? Array.from(new Set(parsed.data.models)) : LISTING_MODELS;
    const images: AgentImage[] = parsed.data.images.map((i) => ({ base64: i.imageBase64, mediaType: i.mediaType }));

    try {
      const record = await startListingRequest(
        { listingText: parsed.data.listingText, municipality, listingId, listingUrl, radarUrl },
        images,
        models,
      );
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

  // Run a whole request again from the overview: same photos, same listing
  // text, same listing id/links, on the same models it ran on — as one new
  // request. A cross-check run (its text carries a verification task) is not
  // a source and does not add a model of its own.
  app.post("/api/requests/rerun", async (req: Request, res: Response) => {
    const parsed = z.object({ jobIds: z.array(z.string()).min(1).max(20) }).safeParse(req.body);
    const jobs = parsed.success ? parsed.data.jobIds.map((id) => getJob(id)).filter((j): j is NonNullable<typeof j> => !!j) : [];
    if (jobs.length === 0) {
      res.status(400).json({ error: "Expected { jobIds } of existing investigations" });
      return;
    }
    const searches = jobs.filter((j) => !isCheckText(j.input.listingText));
    const src = (searches.length ? searches : jobs).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const images = await loadListingPhotos(src.runDir);
    if (images.length === 0) {
      res.status(400).json({ error: "The original photos are no longer available." });
      return;
    }
    // A job keeps the commune folded into its text; unfold it so it is not added twice.
    const prefix = src.input.municipality?.trim() ? `Municipality / commune: ${src.input.municipality.trim()}\n\n` : "";
    const text = src.input.listingText ?? "";
    const listingText = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const models = Array.from(new Set((searches.length ? searches : jobs).map((j) => j.model)));
    try {
      const record = await startListingRequest(
        {
          listingText: listingText || undefined,
          municipality: src.input.municipality,
          listingId: src.input.listingId,
          listingUrl: src.input.listingUrl,
          radarUrl: src.input.radarUrl,
        },
        images,
        models,
      );
      res.status(202).json({ requestId: record.id });
    } catch (err) {
      console.error("[platform] rerun failed:", err);
      res.status(500).json({ error: "Could not run the request again." });
    }
  });

  // Delete rows from the admin table (bulk). Row ids are request ids; runs
  // that belong to no request come as job ids.
  app.post("/api/requests/delete", async (req: Request, res: Response) => {
    const parsed = z
      .object({ requestIds: z.array(z.string()).max(500).default([]), jobIds: z.array(z.string()).max(2000).default([]) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { requestIds?, jobIds? }" });
      return;
    }
    const deleted = await deleteRows(parsed.data.requestIds, parsed.data.jobIds);
    res.json({ deleted });
  });

  // Everything the Usage page needs: one line per AI run and one per Popety
  // charge. The page filters by date and aggregates in the browser.
  app.get("/api/usage", (_req: Request, res: Response) => {
    const runs = listJobs().map((j) => ({
      id: j.id,
      model: j.model,
      createdAt: j.createdAt,
      status: j.status,
      found: j.answer?.found ?? null,
      confidence: j.answer?.confidence ?? null,
      tokens: j.tokens,
      costUsd: costUsd(j.tokens, j.model),
      elapsedMs: elapsedMs(j),
      steps: j.steps.length,
      title: j.input.municipality ?? j.input.listingText?.replace(/^Municipality \/ commune: [^\n]*\n*/, "").slice(0, 80) ?? null,
    }));
    const popety = listRequests()
      .filter((r) => r.popetyCostChf > 0)
      .map((r) => ({ id: r.id, createdAt: r.createdAt, costChf: r.popetyCostChf, plots: r.profiles?.length ?? 1 }));
    // Address searches as the main table groups them (one row per listing):
    // a request succeeds when any of its runs found the address or the plots.
    const TERMINAL = ["done", "error", "cancelled"];
    const searches = listRequestsWithLooseJobs()
      .filter((r) => r.kind === "listing")
      .map((r) => {
        const results = r.results ?? [];
        return {
          id: r.id,
          createdAt: r.createdAt,
          runs: results.length,
          found: results.some((m) => m.status === "done" && m.answer?.found),
          settled: results.every((m) => TERMINAL.includes(m.status)),
        };
      });
    res.json({ runs, popety, searches });
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
