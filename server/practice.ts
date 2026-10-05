// =============================================================================
// Practice — GeoFinder's test track. It runs real investigations on listings
// whose building is already known (radar's practice set, address hidden) and
// scores each answer against the truth, so every change to the prompt, the
// tools or the models can be measured instead of guessed.
//
// The rule the score enforces (Daniel, 05.10.2026: "find the right house fast
// and be 100% accurate"): a WRONG house reported as found is the failure that
// must stay at zero; "not sure" is allowed; then more right houses, faster.
//
// For every miss it also records WHERE the right house was lost, read off the
// run's own checklist (search.ts): wrong commune, never shortlisted, rejected,
// left possible, or matched but not proven.
//
// Radar serves the cases (GET /api/geofinder/practice-set, Bearer
// GEOFINDER_PRACTICE_SECRET); RADAR_URL says where radar is. Rounds live in
// RUNS_ROOT/_practice/<id>.json.
//
// THE ANSWER NEVER TOUCHES THE DISK IN THE CLEAR. The model's bash is not
// confined to its own run directory, so a stored truth would be one `cat` away
// from the agent being tested. The truth is kept only as HMAC fingerprints
// (of the EGID, and of street + house number) keyed by
// GEOFINDER_PRACTICE_SECRET, which the sandbox never inherits; the result
// names radar's property id, where a person can look the address up.
// =============================================================================
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resumeInvestigation, runInvestigation, saveListingPhotos, type AgentImage } from "./agent";
import { exactAddressOf, houseNumberOf, streetOf } from "./consensus";
import { createJob, deleteJob, elapsedMs, costUsd, getJob, requestPause, type Answer, type Job, type ModelId } from "./jobs";
import { RUNS_ROOT } from "./sandbox";
import { keptLessons, type Kpis } from "./lessons-store";

export interface PracticeCase {
  propertyId: number;
  split: "practice" | "test";
  municipality: string | null;
  listingText: string;
  imageUrls: string[];
  truth: { egid: number; address: string; postalCode: string | null; town: string | null };
}

export type Outcome = "right" | "wrong" | "unsure" | "over_budget" | "error" | "running";
export type LostAt = "commune" | "not_shortlisted" | "rejected" | "left_possible" | "not_proven" | "never_looked" | null;

// The truth as fingerprints only (see the header).
export interface TruthKeys {
  egid: string;
  address: string | null; // street + house number
}

function fingerprint(kind: string, value: string): string {
  return createHmac("sha256", radar().secret).update(`${kind}:${value}`).digest("hex").slice(0, 32);
}

/** "Chemin de la Croix 4 / 4a, 1233 Bernex" and "chemin de la croix 4" give the same key. */
function addressKey(address: string | null | undefined): string | null {
  if (!address) return null;
  const n = houseNumberOf(address);
  const st = streetOf(address);
  return n && st ? fingerprint("addr", `${st} ${n}`) : null;
}

export function truthKeys(t: PracticeCase["truth"]): TruthKeys {
  return { egid: fingerprint("egid", String(t.egid)), address: addressKey(t.address) };
}

export interface PracticeResult {
  propertyId: number; // radar's id: look the true address up there
  jobId: string | null;
  model: ModelId;
  truth: TruthKeys;
  outcome: Outcome;
  answer: string | null; // what it named, if anything
  lostAt: LostAt;
  minutes: number | null;
  costUsd: number | null;
  steps: number | null;
  error?: string;
}

export interface PracticeRound {
  id: string;
  createdAt: string;
  finishedAt?: string;
  paused?: boolean; // no new search starts; running ones pause at their next turn
  deleted?: boolean; // never written to disk again
  lessons?: string[]; // the practice lessons every search of the round reads
  trialOf?: string; // the lesson this round tests (lessons.ts)
  reviewed?: boolean; // the reviewer has read it (lessons.ts)
  reviewError?: string; // why the reviewer could not
  split: "practice" | "test";
  models: ModelId[];
  results: PracticeResult[];
}

const dir = () => path.join(RUNS_ROOT, "_practice");
const fileOf = (id: string) => path.join(dir(), `${id.replace(/[^\w-]/g, "")}.json`);
const CONCURRENCY = Number(process.env.PRACTICE_CONCURRENCY ?? 3);
// Each model gets CHF 1 per listing (Daniel, 05.10); a run that reaches it
// without an answer counts as a failure, whatever the model. Costs are kept in
// USD, so the cap is converted at USD_PER_CHF.
const BUDGET_CHF = Number(process.env.PRACTICE_BUDGET_CHF ?? 1);
const USD_PER_CHF = Number(process.env.USD_PER_CHF ?? 1.25);
// And 5 minutes (Daniel, 05.10): "find the right house fast".
const MAX_MINUTES = Number(process.env.PRACTICE_MAX_MINUTES ?? 5);
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

function radar(): { url: string; secret: string } {
  const url = process.env.RADAR_URL?.replace(/\/+$/, "");
  const secret = process.env.GEOFINDER_PRACTICE_SECRET?.trim();
  if (!url || !secret) throw new Error("Set RADAR_URL and GEOFINDER_PRACTICE_SECRET on GeoFinder to run the test track.");
  return { url, secret };
}

/** Every case radar holds for this split, in property-id order. */
export async function fetchCases(split: "practice" | "test", max: number): Promise<PracticeCase[]> {
  const { url, secret } = radar();
  const out: PracticeCase[] = [];
  let afterId = 0;
  for (let page = 0; page < 500 && out.length < max; page++) {
    const res = await fetch(`${url}/api/geofinder/practice-set?afterId=${afterId}&limit=200`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Radar refused the practice set: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { cases: PracticeCase[]; nextAfterId: number | null };
    out.push(...body.cases.filter((c) => c.split === split));
    if (body.nextAfterId == null) break;
    afterId = body.nextAfterId;
  }
  return out.slice(0, max);
}

/**
 * A random sample spread across the country (Daniel, 05.10): shuffled, then
 * taken one commune at a time, so no commune gets a second listing before
 * every commune in the pool has one. Radar's id order would hand over one
 * agency's batch instead.
 */
export function sampleCases(all: PracticeCase[], n: number): PracticeCase[] {
  const shuffled = [...all];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const byCommune = new Map<string, PracticeCase[]>();
  for (const c of shuffled) {
    const k = (c.municipality ?? "").toLowerCase();
    byCommune.set(k, [...(byCommune.get(k) ?? []), c]);
  }
  const piles = Array.from(byCommune.values());
  const out: PracticeCase[] = [];
  for (let round = 0; out.length < n && piles.some((p) => p.length > round); round++)
    for (const p of piles) if (p[round] && out.length < n) out.push(p[round]);
  return out;
}

const sniff = (b: Uint8Array): AgentImage["mediaType"] | null =>
  b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg"
  : b[0] === 0x89 && b[1] === 0x50 ? "image/png"
  : b[0] === 0x47 && b[1] === 0x49 ? "image/gif"
  : b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45 ? "image/webp"
  : null;

async function loadPhotos(urls: string[]): Promise<AgentImage[]> {
  const out: AgentImage[] = [];
  for (const u of urls) {
    try {
      if (!/^https:\/\//i.test(u)) continue;
      const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      const mediaType = buf.byteLength && buf.byteLength <= PHOTO_MAX_BYTES ? sniff(buf) : null;
      if (mediaType) out.push({ base64: Buffer.from(buf).toString("base64"), mediaType });
    } catch {
      /* a dead photo is skipped */
    }
  }
  return out;
}

/** What the run named, scored against the truth. */
export function score(job: Job, truth: TruthKeys): { outcome: Outcome; answer: string | null; lostAt: LostAt } {
  if (job.status === "running" || job.status === "paused") return { outcome: "running", answer: null, lostAt: null };
  if (job.status !== "done") return { outcome: "error", answer: null, lostAt: null };
  if (job.overBudget) return { outcome: "over_budget", answer: null, lostAt: lostAt(job, truth) };
  const a: Answer | null = job.answer;
  const exact = exactAddressOf(a);
  const named = a?.address ?? a?.parcel ?? null;
  if (exact) {
    const right =
      a?.proof?.egid != null
        ? fingerprint("egid", String(a.proof.egid)) === truth.egid
        : !!truth.address && addressKey(exact.address) === truth.address;
    if (right) return { outcome: "right", answer: named, lostAt: null };
    return { outcome: "wrong", answer: named, lostAt: lostAt(job, truth) };
  }
  return { outcome: "unsure", answer: named, lostAt: lostAt(job, truth) };
}

/** The right building's entry in a run's checklist, if the run ever shortlisted it. */
export function truthCandidate(job: Job, truth: TruthKeys) {
  return Object.values(job.search?.candidates ?? {}).find((x) => fingerprint("egid", String(x.egid)) === truth.egid);
}

// Where the right house dropped out, from the run's own checklist.
function lostAt(job: Job, truth: TruthKeys): LostAt {
  const s = job.search;
  if (!s) return null;
  const c = Object.values(s.candidates).find((x) => fingerprint("egid", String(x.egid)) === truth.egid);
  if (!c) return s.shortlisted.length === 0 ? "commune" : "not_shortlisted";
  if (c.verdict === "rejected") return "rejected";
  if (c.verdict === "possible") return "left_possible";
  if (c.verdict === "match") return "not_proven";
  return "never_looked";
}

const rounds = new Map<string, PracticeRound>();

async function save(round: PracticeRound): Promise<void> {
  if (round.deleted) return;
  await mkdir(dir(), { recursive: true });
  const f = fileOf(round.id);
  // Several searches finish at once: each write gets its own temp file, or
  // two renames race over one and the loser crashes the round.
  const tmp = `${f}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(round, null, 2));
  await rename(tmp, f);
}

function refresh(round: PracticeRound): boolean {
  let open = false;
  for (const r of round.results) {
    if (!r.jobId || (r.outcome !== "running" && r.outcome !== "error")) continue;
    const job = getJob(r.jobId);
    if (!job) continue;
    Object.assign(r, score(job, r.truth), {
      minutes: Math.round((elapsedMs(job) / 60_000) * 10) / 10,
      costUsd: Math.round(costUsd(job.tokens, job.model) * 100) / 100,
      steps: job.steps.length,
    });
    if (r.outcome === "running") open = true;
  }
  return open;
}

/** Start a round: `limit` cases of one split, each searched once by every model given. */
export async function startRound(
  split: "practice" | "test",
  limit: number,
  models: ModelId[],
  // A lesson's test: the same listings as the round it is compared with, and its own lessons.
  opts: { propertyIds?: number[]; pairs?: Pair[]; lessons?: string[]; trialOf?: string } = {},
): Promise<PracticeRound> {
  const all = await fetchCases(split, Infinity);
  const ids = opts.pairs ? Array.from(new Set(opts.pairs.map((p) => p.propertyId))) : opts.propertyIds;
  const cases = ids
    ? ids.map((id) => all.find((c) => c.propertyId === id)).filter((c): c is PracticeCase => !!c)
    : sampleCases(all, limit);
  if (!cases.length) throw new Error(`Radar has no ${split} cases yet.`);
  const round: PracticeRound = {
    id: `r${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
    createdAt: new Date().toISOString(),
    split,
    models,
    lessons: opts.lessons ?? (await keptLessons()),
    ...(opts.trialOf ? { trialOf: opts.trialOf } : {}),
    results: [],
  };
  for (const c of cases)
    for (const model of models)
      if (!opts.pairs || opts.pairs.some((p) => p.propertyId === c.propertyId && p.model === model))
        round.results.push({ propertyId: c.propertyId, jobId: null, model, truth: truthKeys(c.truth), outcome: "running", answer: null, lostAt: null, minutes: null, costUsd: null, steps: null });
  rounds.set(round.id, round);
  await save(round);
  void drive(round, cases).catch((err) => console.error(`[practice] round ${round.id} crashed:`, err));
  return round;
}

// Runs the round's searches, CONCURRENCY at a time, then keeps the score fresh.
const driving = new Set<string>(); // rounds with a drive() under way, so a resume never starts a second one

async function drive(round: PracticeRound, cases: PracticeCase[], only?: PracticeResult[]): Promise<void> {
  if (driving.has(round.id)) return;
  driving.add(round.id);
  try {
    await driveQueue(round, cases, only);
  } finally {
    driving.delete(round.id);
  }
}

async function driveQueue(round: PracticeRound, cases: PracticeCase[], only?: PracticeResult[]): Promise<void> {
  const byId = new Map(cases.map((c) => [c.propertyId, c]));
  const queue = (only ?? round.results).filter((r) => byId.has(r.propertyId) && !r.jobId && r.outcome === "running");
  const worker = async () => {
    for (let r = queue.shift(); r && !round.paused && !round.deleted; r = queue.shift()) {
      const c = byId.get(r.propertyId)!;
      try {
        const images = await loadPhotos(c.imageUrls);
        if (!images.length) throw new Error("no photo could be loaded");
        const job = await createJob(
          { municipality: c.municipality ?? undefined, listingText: c.listingText, imageCount: images.length, listingId: `practice-${round.id}-${c.propertyId}`, budgetUsd: BUDGET_CHF * USD_PER_CHF, maxMinutes: MAX_MINUTES, lessons: round.lessons ?? [] },
          r.model,
        );
        r.jobId = job.id;
        await save(round);
        await saveListingPhotos(job.runDir, images);
        await runInvestigation(job, images, c.listingText);
      } catch (err) {
        r.outcome = "error";
        r.error = err instanceof Error ? err.message : String(err);
      }
      refresh(round);
      await save(round);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  if (round.paused || round.deleted) return;
  refresh(round);
  round.finishedAt = new Date().toISOString();
  await save(round);
}

export interface RoundSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  paused: boolean;
  trialOf: string | null;
  lessons: number;
  accuracy: number | null; // right / (right + wrong): the goal is 100%
  split: string;
  models: string[];
  total: number;
  right: number;
  wrong: number;
  unsure: number;
  overBudget: number;
  errors: number;
  running: number;
  avgMinutes: number | null;
  avgCostUsd: number | null;
  costUsd: number; // every run of the round so far, running ones included
  lostAt: Record<string, number>;
}

export function summarize(round: PracticeRound): RoundSummary {
  refresh(round);
  const n = (o: Outcome) => round.results.filter((r) => r.outcome === o).length;
  const done = round.results.filter((r) => r.minutes != null && r.outcome !== "running");
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const lost: Record<string, number> = {};
  for (const r of round.results) if (r.lostAt) lost[r.lostAt] = (lost[r.lostAt] ?? 0) + 1;
  return {
    id: round.id,
    createdAt: round.createdAt,
    finishedAt: round.finishedAt ?? null,
    paused: !!round.paused,
    trialOf: round.trialOf ?? null,
    lessons: round.lessons?.length ?? 0,
    accuracy: n("right") + n("wrong") ? Math.round((n("right") / (n("right") + n("wrong"))) * 1000) / 10 : null,
    split: round.split,
    models: round.models,
    total: round.results.length,
    right: n("right"),
    wrong: n("wrong"),
    unsure: n("unsure"),
    overBudget: n("over_budget"),
    errors: n("error"),
    running: n("running"),
    avgMinutes: avg(done.map((r) => r.minutes!)),
    avgCostUsd: avg(done.map((r) => r.costUsd ?? 0)),
    costUsd: Math.round(round.results.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 100) / 100,
    lostAt: lost,
  };
}

export async function getRound(id: string): Promise<PracticeRound | null> {
  const hit = rounds.get(id);
  if (hit) return hit;
  try {
    const r = JSON.parse(await readFile(fileOf(id), "utf8")) as PracticeRound;
    // Read from disk, so no live drive() holds it: searches that never started
    // wait for resumeRounds (one that started resumes with its job).
    rounds.set(r.id, r);
    return r;
  } catch {
    return null;
  }
}

/**
 * After a restart (a redeploy, a changed variable), carry on every round that
 * still has searches waiting: fetch their listings from radar again and queue
 * them as before. Searches already started resume with their own job.
 */
export async function resumeRounds(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await readdir(dir())).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const round = await getRound(f.replace(/\.json$/, ""));
    if (!round || round.finishedAt) continue;
    if (round.paused) continue;
    try {
      await continueRound(round);
    } catch (err) {
      console.error(`[practice] round ${round.id} could not resume:`, err);
    }
  }
}

// Queue the round's searches that never started: their listings come from
// radar again (the round keeps only fingerprints of the truth, never the case).
async function continueRound(round: PracticeRound): Promise<void> {
  const waiting = round.results.filter((r) => !r.jobId && r.outcome === "running");
  if (!waiting.length || driving.has(round.id)) return;
  const want = new Set(waiting.map((r) => r.propertyId));
  const cases = (await fetchCases(round.split, Infinity)).filter((c) =>
    want.has(c.propertyId),
  );
  const found = new Set(cases.map((c) => c.propertyId));
  for (const r of waiting)
    if (!found.has(r.propertyId)) Object.assign(r, { outcome: "error", error: "radar no longer offers this listing" });
  await save(round);
  console.log(`[practice] round ${round.id}: queueing ${waiting.length} waiting searches`);
  void drive(round, cases, waiting).catch((err) => console.error(`[practice] round ${round.id} crashed:`, err));
}

/** Pause: no new search starts, and the running ones stop at their next turn (resumable). */
export async function pauseRound(id: string): Promise<PracticeRound | null> {
  const round = await getRound(id);
  if (!round) return null;
  round.paused = true;
  for (const r of round.results) {
    const job = r.jobId ? getJob(r.jobId) : undefined;
    if (job?.status === "running") requestPause(job);
  }
  await save(round);
  return round;
}

/** Resume: paused searches carry on from where they stopped, and the waiting ones start. */
export async function resumeRound(id: string): Promise<PracticeRound | null> {
  const round = await getRound(id);
  if (!round) return null;
  round.paused = false;
  delete round.finishedAt;
  await save(round);
  for (const r of round.results) {
    const job = r.jobId ? getJob(r.jobId) : undefined;
    if (job?.status === "paused")
      void resumeInvestigation(job).catch((err) => console.error(`[practice] resume ${job.id} failed:`, err));
  }
  await continueRound(round);
  return round;
}

/** Delete: stop every search, remove their runs and the round itself. */
export async function deleteRound(id: string): Promise<boolean> {
  const round = await getRound(id);
  if (!round) return false;
  round.deleted = true;
  for (const r of round.results) if (r.jobId) await deleteJob(r.jobId);
  rounds.delete(round.id);
  await rm(fileOf(round.id), { force: true });
  return true;
}

/** Every round on disk (deleted ones excepted), newest first. */
export async function allRounds(): Promise<PracticeRound[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PracticeRound[] = [];
  for (const f of files) {
    const r = await getRound(f.replace(/\.json$/, ""));
    if (r && !r.deleted) out.push(r);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Mark a round finished once nothing in it is left to run. drive() does this
 * when it ends, but a round whose searches resumed after a restart has no
 * drive() of its own, so the lessons loop calls this on its beat.
 */
export async function settleRound(round: PracticeRound): Promise<boolean> {
  if (round.finishedAt || round.paused || round.deleted || driving.has(round.id)) return !!round.finishedAt;
  if (refresh(round) || round.results.some((r) => !r.jobId && r.outcome === "running")) return false;
  round.finishedAt = new Date().toISOString();
  await save(round);
  return true;
}

export async function markReviewed(round: PracticeRound, error?: string): Promise<void> {
  round.reviewed = true;
  if (error) round.reviewError = error;
  else delete round.reviewError;
  await save(round);
}

/** The round's score on the goal. */
/** One listing searched by one model: the unit a lesson's test re-runs. */
export interface Pair {
  propertyId: number;
  model: ModelId;
}

/** The round's score on the goal, over all its runs or only the given pairs. */
export function kpisOf(round: PracticeRound, pairs?: Pair[]): Kpis {
  const only = pairs
    ? { ...round, results: round.results.filter((r) => pairs.some((p) => p.propertyId === r.propertyId && p.model === r.model)) }
    : round;
  const s = summarize(only);
  return {
    runs: s.total,
    right: s.right,
    wrong: s.wrong,
    notFound: s.unsure + s.overBudget,
    errors: s.errors,
    avgMinutes: s.avgMinutes,
    avgCostUsd: s.avgCostUsd,
  };
}

export async function listRounds(): Promise<RoundSummary[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: RoundSummary[] = [];
  for (const f of files) {
    const r = await getRound(f.replace(/\.json$/, ""));
    if (r) out.push(summarize(r));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
