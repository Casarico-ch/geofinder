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
import { claudeConfigured } from "./claude-pool";
import { loadLessons } from "./lessons-store";
import { forgetRound, learningOf, setLesson } from "./lessons";
import { type RoundSummary, deleteRound, getRound, listRounds, pauseRound, resumeRound, startRound, summarize } from "./practice";
import { geminiConfigured, isGemini } from "./gemini";
import { loadListingPhotos, runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { type Candidate, type Check, exactAddressOf, planChecks, sameAddress } from "./consensus";
import { MODELS, costUsd, createJob, runnableModel, elapsedMs, getJob, listJobs, type Answer, type KnownModel, type ModelId } from "./jobs";
import { type LedgerEntry, type SearchState, claimedEntry } from "./search";
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
  type PlatformRequest,
  createRequest,
  createRequestFromJobs,
  deleteRows,
  getRequest,
  CHECK_MARK,
  isCheckText,
  listRequests,
  listRequestsWithLooseJobs,
  onListingSettled,
  saveRequest,
  watchListingRequest,
} from "./requests";

// The models every listing request runs on, side by side; the listing counts
// as Found only when they all land on one address (Requests page). Gemini is
// left out while GEMINI_API_KEY is unset, so a missing key never blocks Radar.
const LISTING_MODELS: ModelId[] = (
  process.env.GEOFINDER_MODELS ?? "claude-sonnet-5-5,claude-opus-5-5,gemini-3.1-pro-preview,gemini-3.8-flash"
)
  .split(",")
  .map((m) => m.trim())
  .filter((m): m is ModelId => (MODELS as readonly string[]).includes(m));
const listingModels = (): ModelId[] => LISTING_MODELS.filter((m) => !isGemini(m) || geminiConfigured());

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
  source: PlatformRequest["source"] = "platform",
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
  record.source = source;
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

const modelLabel = (m: KnownModel) =>
  m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());

// How many alternatives a cross-check re-opens besides the claimed house.
const REOPEN = 8;

/**
 * The checklist a cross-check starts from: the search's own, with its verdicts
 * kept, except the claimed house and the strongest alternatives it set aside
 * (strong fits first, then "possible" ones, nearest to the claim first), which
 * are open again. The proof rules (agent.ts proveAnswer) then mean the checker
 * can only confirm the claim after a close look at it AND a visible reason
 * against each re-opened alternative.
 */
export function seedForCheck(
  search: Pick<SearchState, "shortlisted" | "candidates"> | undefined,
  candidate: Candidate,
): { seed: Pick<SearchState, "shortlisted" | "candidates">; claim: LedgerEntry | null; reopened: LedgerEntry[] } {
  const seed = { shortlisted: [...(search?.shortlisted ?? [])], candidates: structuredClone(search?.candidates ?? {}) };
  const claim = claimedEntry(seed as SearchState, { lat: candidate.latitude, lon: candidate.longitude, address: candidate.address });
  const near = (c: LedgerEntry) =>
    claim ? Math.hypot((c.lon - claim.lon) * 78_000, (c.lat - claim.lat) * 111_320) : c.order;
  const reopened = Object.values(seed.candidates)
    .filter((c) => c !== claim && (c.strongFit || c.verdict === "possible" || c.verdict === "match"))
    .sort((a, b) => Number(!!b.strongFit) - Number(!!a.strongFit) || near(a) - near(b))
    .slice(0, REOPEN);
  const before = reopened.map((c) => ({ ...c }));
  for (const c of [claim, ...reopened]) {
    if (!c) continue;
    Object.assign(c, { verdict: "unchecked", viewed: false, closeLook: false, reason: undefined });
  }
  return { seed, claim, reopened: before };
}

/**
 * The listing text with a prove-this-address-wrong task appended. The checker
 * builds on the other model's search instead of starting over, but its job is
 * to break the answer: "can you confirm it?" got a yes in 4 checks out of 4,
 * including Riedweg 89, Zermatt (2 dwellings and a 427 m² plot for a single
 * chalet on 331 m²).
 */
export function verifyText(
  listing: string,
  candidate: Candidate,
  from: KnownModel,
  claim: LedgerEntry | null = null,
  reopened: LedgerEntry[] = [],
): string {
  const pin =
    candidate.latitude != null && candidate.longitude != null ? ` (around ${candidate.latitude}, ${candidate.longitude})` : "";
  const alt = reopened.map(
    (c) => `- ${c.egid} | ${c.address ?? "?"}${c.strongFit ? " | STRONG FIT" : ""} | earlier: ${c.verdict}${c.reason ? ` — "${c.reason}"` : ""}`,
  );
  return [
    listing,
    "",
    CHECK_MARK,
    `Another investigator (${modelLabel(from)}) concluded that this property is at: ${candidate.address}${candidate.parcel ? `, plot ${candidate.parcel}` : ""}${pin}${claim ? ` — EGID ${claim.egid} on your checklist` : ""}.`,
    "Your job is to PROVE THAT ANSWER WRONG. Do not search from scratch: you start from that investigator's checklist. Its verdicts are kept, except the claimed house" +
      (alt.length ? " and these alternatives it set aside, which are open again:" : ", which is open again."),
    ...alt,
    `1. inspect_candidate the claimed house. Every ✗ in its fact sheet (homes, living area, plot area) is a reason it is wrong; then compare its roof, its aerial and its neighbours with the photos. One clear mismatch rejects it — never explain one away ("the register may be wrong").`,
    "2. inspect_candidate every re-opened alternative and settle it: rejected with the difference you see, or match. If one fits better than the claim, that one is the answer.",
    "3. Any candidate the checklist still leaves unchecked must be viewed and marked too.",
    "The claim is confirmed only if it survives step 1 and every alternative is rejected with a visible difference — the code checks this before it records a street/building answer. Otherwise report found=false at block confidence with your ranked candidates and the mismatch you found.",
  ].join("\n");
}

const CHECKS_ACROSS_RUNS = 2;

// After the searches of a listing settle, the other model tries to break each
// address they disagree on (consensus.ts), and every exact address an earlier
// run of the same listing gave and this one does not is checked too, so three
// runs cannot end with three "sure" answers side by side. This covers Radar's
// searches as well: Radar no longer sends checks of its own.
async function crossCheckIfSplit(req: PlatformRequest): Promise<boolean> {
  const results = req.results ?? [];
  if (req.kind !== "listing" || results.some((m) => m.check)) return false;
  const searches = results.filter((m) => m.status === "done");
  const checks: (Check & { fromJob?: string })[] = planChecks(searches).map((c) => ({
    ...c,
    fromJob: searches.find((m) => m.model === c.candidateFrom)?.jobId,
  }));
  checks.push(...earlierClaims(req, searches));
  if (checks.length === 0) return false;
  const src = getJob(searches[0].jobId);
  const images = src ? await loadListingPhotos(src.runDir) : [];
  if (!src || images.length === 0) return false;
  for (const c of checks) {
    const from = c.fromJob ? getJob(c.fromJob) : undefined;
    const { seed, claim, reopened } = seedForCheck(from?.search, c.candidate);
    const listingText = verifyText(src.input.listingText ?? "", c.candidate, c.candidateFrom, claim, reopened);
    const job = await createJob({ ...src.input, listingText }, c.verifier);
    results.push({ model: c.verifier, jobId: job.id, status: "running", answer: null, aiCostUsd: 0, check: true });
    void (async () => {
      await saveListingPhotos(job.runDir, images);
      await runInvestigation(job, images, listingText, seed.shortlisted.length ? seed : undefined);
    })().catch((err) => console.error(`[platform] cross-check ${job.id} crashed:`, err));
  }
  req.status = "running";
  return true;
}

// Exact addresses earlier runs of this listing gave that no search of this run
// agrees with, each checked by one of this run's models.
function earlierClaims(
  req: PlatformRequest,
  searches: { model: KnownModel; jobId: string; answer: Answer | null }[],
): (Check & { fromJob?: string })[] {
  const id = req.input.listingId;
  if (!id || searches.length === 0) return [];
  const now = searches.map((m) => ({ model: m.model, at: exactAddressOf(m.answer) }));
  const seen = now.flatMap((n) => (n.at ? [n.at] : []));
  const out: (Check & { fromJob?: string })[] = [];
  const earlier = listRequests()
    .filter((r) => r.id !== req.id && r.kind === "listing" && r.input.listingId === id && r.createdAt < req.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of earlier) {
    for (const m of r.results ?? []) {
      if (out.length >= CHECKS_ACROSS_RUNS) return out;
      const at = m.status === "done" ? exactAddressOf(m.answer) : null;
      if (!at || seen.some((s) => sameAddress(s, at))) continue;
      seen.push(at);
      // The model of this run that did not already land on it checks it.
      const verifier = (now.find((n) => n.at == null) ?? now.find((n) => n.model !== m.model) ?? now[0]).model;
      const verifierModel = runnableModel(verifier);
      out.push({ verifier: verifierModel, candidate: at, candidateFrom: m.model, fromJob: m.jobId });
    }
  }
  return out;
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

  // The test track (practice.ts): rounds of real searches on radar's practice
  // set, scored against the known building. /v1 takes the API key; /api is the
  // admin page's own door, behind the website's ADMIN_PASSWORD.
  const roundSchema = z.object({
    split: z.enum(["practice", "test"]).default("practice"),
    // The first rounds run every model a real search runs, so the scoreboard
    // compares their approaches on the same listings.
    limit: z.number().int().min(1).max(200).default(20),
    models: z.array(z.enum(MODELS)).min(1).max(MODELS.length).optional(),
  });
  for (const base of ["/v1/practice", "/api/practice"]) {
    app.post(`${base}/rounds`, async (req: Request, res: Response) => {
      const parsed = roundSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: `Expected { split?: "practice"|"test", limit?: 1-200, models?: [${MODELS.join(", ")}] }` });
        return;
      }
      try {
        const round = await startRound(parsed.data.split, parsed.data.limit, parsed.data.models ?? listingModels());
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
      const listings: Record<number, { title: string | null; place: string | null; kind: string | null; rooms: string | null; price: string | null }> = {};
      for (const r of round.results) {
        const text = (r.jobId ? getJob(r.jobId)?.input.listingText : undefined) ?? "";
        if (listings[r.propertyId] || !text) continue;
        const line = (k: string) => text.match(new RegExp(`^${k}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
        listings[r.propertyId] = {
          title: line("Title"),
          place: line("Municipality") ?? line("Town"),
          kind: line("Subtype") ?? line("Category") ?? line("Type"),
          rooms: line("Rooms"),
          price: line("Price"),
        };
      }
      res.json({ summary: await roundView(summarize(round), await listRounds()), results: round.results, listings });
    });
    app.post(`${base}/rounds/:id/pause`, async (req: Request, res: Response) => {
      const round = await pauseRound(req.params.id);
      if (!round) res.status(404).json({ error: "No such round" });
      else res.json(summarize(round));
    });
    app.post(`${base}/rounds/:id/resume`, async (req: Request, res: Response) => {
      try {
        const round = await resumeRound(req.params.id);
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
    const models = parsed.data.models ? Array.from(new Set(parsed.data.models)) : listingModels();
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
    const models = Array.from(new Set((searches.length ? searches : jobs).map((j) => runnableModel(j.model))));
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

  app.get("/api/requests/:id", (req: Request, res: Response) => {
    const record = getRequest(req.params.id);
    if (!record) {
      res.status(404).json({ error: "No such request" });
      return;
    }
    res.json(record);
  });
}
