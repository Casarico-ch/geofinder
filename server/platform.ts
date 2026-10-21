// =============================================================================
// Platform API (/v1) — GeoFinder as a private service for our own platform.
//
// Every /v1 call needs `Authorization: Bearer <GEOFINDER_API_KEY>`.
//   POST /v1/address   { images, listingText?, municipality? } → 202 + requestId (finds the address)
//   GET  /v1/requests/:id                                     → status + each model's address
//   POST /v1/property  { address } | { latitude, longitude } | { commune, plot } → Popety property data (CHF 3.80)
//                      or { plots: [ ...2-10 of those ] } → each plot + the plots combined (CHF 3.80 per plot)
//                      A plot bought once is kept and served free after (popety-store.ts).
// The admin website reads the same records through /api/requests.
// =============================================================================
import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { claudeConfigured } from "./claude-pool";
import { loadLessons } from "./lessons-store";
import { forgetRound, learningOf, pauseLearning, requestLessons, setLesson } from "./lessons";
import { missReasonNow } from "./miss";
import { firstModels, foundPair, listingVerdict, nextSteps, startSearch, type Role, type Step, type RoundSummary, allRounds, deleteRound, getRound, listRounds, pauseRound, resumeRound, startRound, summarize } from "./practice";
import { geminiConfigured, isGemini } from "./gemini";
import { loadListingPhotos, type AgentImage } from "./agent";
import { isParkingListing } from "./proof";
import { reviewRound } from "./review";
import { startChallenge, viewChallenge } from "./challenge";
import { MODELS, costUsd, elapsedMs, getJob, listJobs, type ModelId } from "./jobs";
import { profileByLandId } from "./popety-store";
import { genevaAnswer, genevaEgridAt, genevaEgridAtAddress, genevaEgridsByPlot, genevaPlotOfEgrid, isGenevaEgrid } from "./geneva";
import {
  PROFILE_COST_CHF,
  PopetyError,
  combineProfiles,
  findLandByAddress,
  findLandByCoordinates,
  findLandByEgrid,
  findLandByPlot,
} from "./popety";
import {
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

// Every listing request runs the practice track's search, the same code
// (practice.ts firstModels, nextSteps, startSearch, foundPair; Daniel, 11.10:
// "practice is the single source of truth").
// The models a listing starts with: practice.ts firstModels, as practice runs it.
export const listingModels = firstModels;

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

// A Geneva plot is answered from geneva/data, never from Popety (geneva.ts).
// null: not in Geneva (or not found there) — the Popety path decides.
const resolveGeneva = async (p: PlotInput): Promise<string | null> => {
  if ("egrid" in p && p.egrid && isGenevaEgrid(p.egrid)) return p.egrid;
  // A Geneva building right (DDP) has its own EGRID: answer for the plot under it.
  if ("egrid" in p && p.egrid && !("plot" in p)) {
    const plot = await genevaPlotOfEgrid(p.egrid);
    if (plot) return plot;
  }
  if ("plot" in p) {
    const hits = genevaEgridsByPlot(p.commune, p.plot);
    return hits.length === 1 ? hits[0] : null;
  }
  if ("latitude" in p) return genevaEgridAt(p.latitude, p.longitude);
  if ("address" in p) return (await genevaEgridAtAddress(p.address))?.egrid ?? null;
  return null;
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

// What the platform sees: the record minus internal job ids. agrees: the two
// runs that name the listing's house (practice.ts foundPair), the one rule
// that says it was found; Radar reads it instead of deciding on its own.
function publicView(r: PlatformRequest) {
  const pair = foundPair((r.results ?? []).map((m) => ({ m, done: m.status === "done", answer: m.answer })));
  return {
    requestId: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt ?? null,
    input: r.input,
    ...(r.kind === "address"
      ? {
          ...(r.combined
            ? { profiles: r.profiles ?? [], combined: r.combined, plotErrors: r.plotErrors }
            : { profile: r.profile ?? null, candidates: r.candidates, plotErrors: r.plotErrors }),
          ...(r.geneva?.length ? { geneva: r.geneva } : {}),
        }
      : {
          results: (r.results ?? []).map((m) => ({
            model: m.model,
            status: m.status,
            answer: m.answer,
            ...(m.check ? { check: true } : {}),
            agrees: !!pair && pair.some((p) => p.m === m),
          })),
          ...(r.skipped ? { skipped: r.skipped } : {}),
        }),
    popetyCostChf: r.popetyCostChf,
    error: r.error,
  };
}

/**
 * Start a listing request: the practice track's search of the listing
 * (practice.ts), one first search per model, grouped as one request. Shared
 * by /v1/address and the admin's "Run again".
 */
export async function startListingRequest(
  input: { listingText?: string; municipality?: string; listingId?: string; listingUrl?: string; radarUrl?: string },
  images: AgentImage[],
  models: ModelId[],
  source: PlatformRequest["source"] = "platform",
) {
  const { listingText, municipality, listingId, listingUrl, radarUrl } = input;
  const record = await createRequest("listing", { listingText, municipality, imageCount: images.length, listingId, listingUrl, radarUrl });
  record.source = source;
  record.results = [];
  // A parking space or garage has no building to find (Daniel, 21.10: "skip
  // the parking, not the land"): answered at once, no model runs.
  if (isParkingListing(listingText)) {
    record.status = "done";
    record.skipped = "Parking listing: a garage or parking space has no building to find, so it was not searched.";
    await saveRequest(record);
    return record;
  }
  for (const model of models) await addRun(record, images, model, { role: "search" });
  await saveRequest(record);
  watchListingRequest(record);
  return record;
}

/** One search of the request's listing (practice.ts startSearch); a follow-up is marked check: true. */
async function addRun(req: PlatformRequest, images: AgentImage[], model: ModelId, step: Omit<Step, "model">) {
  const { listingText, municipality, listingId, listingUrl, radarUrl } = req.input;
  const { job, finished } = await startSearch({ listingText, municipality, listingId, listingUrl, radarUrl }, images, model, step);
  (req.results ??= []).push({
    model,
    jobId: job.id,
    status: "running",
    answer: null,
    aiCostUsd: 0,
    ...(step.role !== "search" ? { check: true } : {}),
    ...(step.role === "confirm" ? { confirm: true } : {}),
  });
  finished.catch((err) => console.error(`[platform] investigation ${job.id} crashed:`, err));
}

const roleOf = (m: { check?: boolean; confirm?: boolean }): Role => (m.confirm ? "confirm" : m.check ? "recheck" : "search");
const SETTLED = ["done", "error", "cancelled"];

/** Each time one of the request's runs settles: start what practice.ts nextSteps says comes next. */
async function afterSettled(req: PlatformRequest): Promise<boolean> {
  if (req.kind !== "listing") return false;
  const results = req.results ?? [];
  const steps = nextSteps(
    results.map((m) => ({ role: roleOf(m), jobId: m.jobId, settled: SETTLED.includes(m.status), done: m.status === "done", answer: m.answer })),
  );
  if (!steps.length) return false;
  const src = results.length ? getJob(results[0].jobId) : undefined;
  const images = src ? await loadListingPhotos(src.runDir) : [];
  if (!images.length) return false;
  for (const step of steps) await addRun(req, images, step.model, step);
  req.status = "running";
  return true;
}

export function registerPlatformRoutes(app: Express) {
  onListingSettled(afterSettled);
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
      // Geneva plots first: answered from our own data, free (geneva.ts).
      const genevaHits = await Promise.all(plots.map((p) => resolveGeneva(p).catch(() => null)));
      const answers = genevaHits.flatMap((e) => (e ? [genevaAnswer(e)].filter((a) => a != null) : []));
      if (answers.length) record.geneva = answers;
      const rest = plots.filter((_, i) => !genevaHits[i]);
      if (!rest.length) {
        record.status = "done";
        await saveRequest(record);
        res.json(publicView(record));
        return;
      }
      // Finding the parcels is free; only fetch (and pay for) data once every plot is pinned.
      const matches = await Promise.all(rest.map(resolvePlot));
      const problems = matches.flatMap((m, i) =>
        m.kind === "match" ? [] : [{ input: rest[i], kind: m.kind, match: m }],
      );
      if (problems.length) {
        if (rest.length === 1) {
          const m = matches[0];
          if (m.kind === "ambiguous") {
            record.candidates = m.candidates;
            await fail(300, "Several parcels match this address; send one of the candidate addresses.");
          } else await fail(404, notFoundMessage(rest[0]));
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

      const pinned = matches.map((m, i) => ({ ...(m as Extract<typeof m, { kind: "match" }>), plot: rest[i] }));
      const unique = pinned.filter((m, i) => pinned.findIndex((o) => o.landId === m.landId) === i);
      // A plot bought before comes from the store for free (popety-store.ts).
      const looked = await Promise.all(
        unique.map((m) => profileByLandId(m.landId, m.matchedAddress ?? ("address" in m.plot ? m.plot.address : null))),
      );
      const profiles = looked.map((l) => l.profile);
      record.popetyCostChf = Math.round(looked.filter((l) => l.paid).length * PROFILE_COST_CHF * 100) / 100;
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

  // The test track (practice.ts): rounds of real searches on radar's practice
  // set, scored against the known building. /v1 takes the API key; /api is the
  // admin page's own door, behind the website's ADMIN_PASSWORD.
  const roundSchema = z.object({
    split: z.enum(["practice", "test"]).default("practice"),
    // The first rounds run every model a real search runs, so the scoreboard
    // compares their approaches on the same listings.
    limit: z.number().int().min(1).max(200).default(20),
    models: z.array(z.enum(MODELS)).min(1).max(MODELS.length).optional(),
    // Houses whose listing states no land area (practice.ts startRound).
    noLand: z.boolean().default(false),
  });
  for (const base of ["/v1/practice", "/api/practice"]) {
    app.post(`${base}/rounds`, async (req: Request, res: Response) => {
      const parsed = roundSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: `Expected { split?: "practice"|"test", limit?: 1-200, models?: [${MODELS.join(", ")}], noLand?: boolean }` });
        return;
      }
      try {
        // No models given: each listing starts with what a real request for it gets (firstModels).
        const models = parsed.data.models ?? null;
        if (models?.some(isGemini) && !geminiConfigured()) {
          res.status(503).json({ error: "Gemini 3.8 Flash is one of the practice investigators: set GEMINI_API_KEY on GeoFinder in Railway." });
          return;
        }
        const round = await startRound(parsed.data.split, parsed.data.limit, models, { noLand: parsed.data.noLand });
        res.status(202).json(summarize(round));
      } catch (err) {
        res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    // A round as the page shows it: its summary, where its learning stands, and
    // its total cost — its own runs plus the tests of its lessons.
    const roundView = async (r: RoundSummary, all: RoundSummary[]) => {
      const lessons = await loadLessons();
      const tests =
        Math.round(
          all
            .filter((t) => t.trialOf && lessons.some((l) => l.id === t.trialOf && l.fromRound === r.id))
            .reduce((a, t) => a + t.costUsd, 0) * 100,
        ) / 100;
      const round = await getRound(r.id);
      return {
        ...r,
        testsCostUsd: tests,
        totalCostUsd: Math.round((r.costUsd + tests) * 100) / 100,
        learning: round ? await learningOf(round) : null,
      };
    };
    app.get(`${base}/rounds`, async (_req: Request, res: Response) => {
      const all = await listRounds();
      res.json({ rounds: await Promise.all(all.map((r) => roundView(r, all))) });
    });
    app.get(`${base}/rounds/:id`, async (req: Request, res: Response) => {
      const round = await getRound(req.params.id);
      if (!round) {
        res.status(404).json({ error: "No such round" });
        return;
      }
      // What each listing is, from the text its searches were given (address hidden).
      type Info = { title: string | null; place: string | null; kind: string | null; rooms: string | null; price: string | null; radarUrl: string; sourceUrl: string | null };
      const listings: Record<number, Info> = {};
      const radarBase = (process.env.RADAR_PUBLIC_URL || "https://app.casarico.ch").replace(/\/+$/, "");
      for (const r of round.results) {
        const text = (r.jobId ? getJob(r.jobId)?.input.listingText : undefined) ?? "";
        const links = { radarUrl: `${radarBase}/properties?property=${r.propertyId}`, sourceUrl: r.sourceUrl ?? null };
        if (listings[r.propertyId]) {
          listings[r.propertyId].sourceUrl ??= links.sourceUrl;
          continue;
        }
        if (!text) {
          listings[r.propertyId] = { title: null, place: null, kind: null, rooms: null, price: null, ...links };
          continue;
        }
        const line = (k: string) => text.match(new RegExp(`^${k}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
        listings[r.propertyId] = {
          title: line("Title"),
          place: line("Municipality") ?? line("Town"),
          kind: line("Subtype") ?? line("Category") ?? line("Type"),
          rooms: line("Rooms"),
          price: line("Price"),
          ...links,
        };
      }
      // Why each miss never had the right house on its checklist — withheld while
      // any practice run is still searching that listing (it names the house's facts).
      const searching = new Set(
        (await allRounds()).flatMap((x) => x.results.filter((r) => r.outcome === "running").map((r) => r.propertyId)),
      );
      const results = round.results.map((r) => ({ ...r, why: searching.has(r.propertyId) ? null : missReasonNow(r) }));
      // What Radar would show for each listing: a house only when two runs name it.
      const verdicts = Object.fromEntries(Array.from(new Set(round.results.map((r) => r.propertyId)), (pid) => [pid, listingVerdict(round, pid)]));
      // Why each miss happened, grouped by cause, with a task to paste (review.ts).
      const review = reviewRound(round, Object.fromEntries(Object.entries(listings).map(([id, i]) => [Number(id), i.place])), searching);
      res.json({ summary: await roundView(summarize(round), await listRounds()), results, listings, verdicts, review });
    });
    // The same listings again, under today's code, lessons and investigators
    // (firstModels): a before/after on exactly the same houses.
    app.post(`${base}/rounds/:id/rerun`, async (req: Request, res: Response) => {
      const src = await getRound(req.params.id);
      if (!src) {
        res.status(404).json({ error: "No such round" });
        return;
      }
      try {
        // ?failed=1: only the listings Radar would not show as rightly found (listingVerdict).
        const failed = req.query.failed === "1";
        const found = new Set(src.results.map((r) => r.propertyId).filter((p) => listingVerdict(src, p) === "confirmed_right"));
        const ids = Array.from(new Set(src.results.map((r) => r.propertyId))).filter((p) => !failed || (!found.has(p) && src.results.some((r) => r.propertyId === p && r.outcome !== "running")));
        if (!ids.length) {
          res.status(400).json({ error: "No failed listing to run again." });
          return;
        }
        const round = await startRound(src.split, ids.length, null, { propertyIds: ids, rerunOf: src.id, noLand: src.noLand });
        res.status(202).json(summarize(round));
      } catch (err) {
        res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.post(`${base}/rounds/:id/learn`, async (req: Request, res: Response) => {
      const round = await requestLessons(req.params.id);
      if (!round) res.status(404).json({ error: "No such round" });
      else res.json(summarize(round));
    });
    app.post(`${base}/rounds/:id/pause`, async (req: Request, res: Response) => {
      const round = await pauseRound(req.params.id);
      if (round) await pauseLearning(round.id, true);
      if (!round) res.status(404).json({ error: "No such round" });
      else res.json(summarize(round));
    });
    app.post(`${base}/rounds/:id/resume`, async (req: Request, res: Response) => {
      try {
        const round = await resumeRound(req.params.id);
        if (round) await pauseLearning(round.id, false);
        if (!round) res.status(404).json({ error: "No such round" });
        else res.json(summarize(round));
      } catch (err) {
        res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
    app.delete(`${base}/rounds/:id`, async (req: Request, res: Response) => {
      await forgetRound(req.params.id);
      if (await deleteRound(req.params.id)) res.json({ ok: true });
      else res.status(404).json({ error: "No such round" });
    });
    // The lessons the test track has proposed, tested, kept or dropped (lessons.ts).
    app.get(`${base}/lessons`, async (_req: Request, res: Response) => {
      res.json({ lessons: [...(await loadLessons())].reverse() });
    });
    app.post(`${base}/lessons/:id/:action`, async (req: Request, res: Response) => {
      if (!["keep", "drop", "test", "delete"].includes(req.params.action)) {
        res.status(404).json({ error: "Unknown action" });
        return;
      }
      try {
        const l = await setLesson(req.params.id, req.params.action as "keep" | "drop" | "test" | "delete");
        if (!l) res.status(404).json({ error: "No such lesson" });
        else res.json(l);
      } catch (err) {
        res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  app.post("/v1/address", async (req: Request, res: Response) => {
    if (!claudeConfigured()) {
      res.status(503).json({ error: "Not configured. Set ANTHROPIC_API_KEY on the server." });
      return;
    }
    const parsed = listingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Expected { images: [{ imageBase64, mediaType }], listingText?, municipality?, listingId?, listingUrl?, radarUrl?, models? } (models: ${MODELS.join(", ")})` });
      return;
    }
    const { municipality, listingId, listingUrl, radarUrl } = parsed.data;
    const models = parsed.data.models ? Array.from(new Set(parsed.data.models)) : listingModels(parsed.data.listingText);
    if (models.some(isGemini) && !geminiConfigured()) {
      res.status(503).json({ error: "Gemini is not configured. Set GEMINI_API_KEY on the server." });
      return;
    }
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
    // The models a new request for this listing would get (listingModels), as practice runs it.
    const models = listingModels(listingText);
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
        "website",
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

  // The website's search page: the request a run belongs to, and its recheck
  // (recheckIfDoubtful), whose answer is the one that counts.
  app.get("/api/requests/for-job/:jobId", (req: Request, res: Response) => {
    const record = listRequests().find((r) => (r.results ?? []).some((m) => m.jobId === req.params.jobId));
    const check = record?.results?.find((m) => m.check);
    res.json({
      requestId: record?.id ?? null,
      requestStatus: record?.status ?? null,
      recheck: check ? { jobId: check.jobId, model: check.model, status: check.status, answer: check.answer } : null,
    });
  });

  // A person challenges the result with another house: weighed in full depth
  // against every house the searches named (challenge.ts). Opus, a few dollars.
  app.post("/api/requests/:id/challenge", async (req: Request, res: Response) => {
    const parsed = z.object({ address: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Expected { address }" });
      return;
    }
    const record = getRequest(req.params.id);
    if (!record || record.kind !== "listing") {
      res.status(404).json({ error: "Only a listing request can be challenged (re-run an older search first)." });
      return;
    }
    const src = (record.results ?? []).map((m) => getJob(m.jobId)).find((j) => !!j);
    const images = src ? await loadListingPhotos(src.runDir) : [];
    try {
      const c = await startChallenge(record, parsed.data.address, images);
      (record.challenges ??= []).push(c);
      await saveRequest(record);
      res.status(202).json(viewChallenge(c));
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/requests/:id/challenges", (req: Request, res: Response) => {
    const record = getRequest(req.params.id);
    res.json({ challenges: (record?.challenges ?? []).map(viewChallenge).reverse() });
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
