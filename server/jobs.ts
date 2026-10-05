// =============================================================================
// Jobs — background investigations that keep running after the browser closes.
//
// A POST starts a job and returns immediately with its id; the investigation
// runs server-side (fire-and-forget) and streams a documented trace of every
// step + reasoning into the job. The client polls, and can reopen a running or
// finished job at any time. Jobs are mirrored to disk (RUNS_ROOT/<id>/job.json)
// so a process restart or a reopened window recovers the full trace.
// =============================================================================
import type { LocationClues } from "./locate";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT, ensureRunDir } from "./sandbox";
import type { BuildPotential } from "./potential";
import type { SearchState } from "./search";

export type PotentialStatus = "running" | "done" | "error";

export type Confidence =
  | "street"
  | "parcel" // the exact plot(s) are pinned, but there is no street address (e.g. building land)
  | "building"
  | "block"
  | "neighborhood"
  | "city"
  | "region"
  | "country"
  | "unknown";

export interface AnswerCandidate {
  parcel: string | null;
  address: string | null;
  note: string;
}

export interface ParcelRef {
  commune: string;
  plot: string; // cadastral plot number as the land register writes it, e.g. "HN12522"
  egrid?: string | null;
}

export interface Answer {
  found: boolean;
  address: string | null;
  parcel: string | null;
  // The exact plot(s) the property covers. A valid result on its own: building
  // land has plots but no address. Pass straight to /v1/property { plots }.
  parcels: ParcelRef[];
  commune: string | null;
  confidence: Confidence;
  latitude: number | null;
  longitude: number | null;
  reasoning: string;
  candidates: AnswerCandidate[];
  links: string[];
  // Why an exact answer counts as proven (proof.ts): the listing's facts
  // against the building's, and how much of the checklist was ruled out.
  proof?: AnswerProof;
}

export interface AnswerProof {
  egid: string | null;
  facts: { fact: string; listing: string; building: string; verdict: "match" | "mismatch" | "unknown" }[];
  ruledOut: number; // candidates rejected with a reason
  total: number; // candidates on the checklist
}

// One documented moment in the investigation. `reasoning` carries the model's
// own thinking for that turn; tool steps carry the command and a result digest;
// `image` points at an aerial/crop the model actually looked at (served under
// /runs) so the trace shows what it saw.
export type StepKind = "reasoning" | "bash" | "write" | "read" | "answer" | "note" | "error";

export interface Step {
  n: number;
  at: string;
  kind: StepKind;
  title: string;
  detail?: string;
  reasoning?: string;
  image?: string;
}

export type JobStatus = "running" | "done" | "error" | "cancelled" | "paused";

export interface TokenUsage {
  input: number;
  output: number;
  cached: number; // subset of input served from the prompt cache (cheap reads)
  cacheWrite: number; // input tokens written to the cache (1.25x price)
  total: number;
  fastTurns?: number; // model turns served in fast mode (2x price)
  fastPremiumUsd?: number; // what fast mode added on top of the standard price
}

// Per-model pricing, USD per 1M tokens: [fresh input, cache read (~0.1x),
// cache write (1.25x, 5-min TTL), output]. Fable is ~2.5x Opus 5.5.
// MODELS are the ones a new run can pick.
export const MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5",
  "claude-fable-5-1",
] as const;
export type ModelId = (typeof MODELS)[number];
export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";
// Models no longer offered, kept so past runs still show and price correctly.
const RETIRED_MODELS = ["claude-opus-4-8"] as const;
export type KnownModel = ModelId | (typeof RETIRED_MODELS)[number];
const KNOWN_MODELS: readonly string[] = [...MODELS, ...RETIRED_MODELS];
// A re-run of a past run uses the same model, or the default if it is retired.
export function runnableModel(m: KnownModel): ModelId {
  return (MODELS as readonly string[]).includes(m) ? (m as ModelId) : DEFAULT_MODEL;
}

const PRICING: Record<KnownModel, { in: number; cacheRead: number; cacheWrite: number; out: number }> = {
  "claude-opus-4-8": { in: 5, cacheRead: 0.5, cacheWrite: 6.25, out: 25 },
  "claude-opus-5-5": { in: 4, cacheRead: 0.2, cacheWrite: 5, out: 20 },
  "claude-sonnet-5-5": { in: 2, cacheRead: 0.2, cacheWrite: 2.5, out: 10 },
  "claude-fable-5": { in: 10, cacheRead: 1.0, cacheWrite: 12.5, out: 50 },
  "claude-fable-5-1": { in: 10, cacheRead: 0.25, cacheWrite: 12.5, out: 50 },
};

export function costUsd(t: TokenUsage, model?: string): number {
  const p = PRICING[(model as KnownModel) in PRICING ? (model as KnownModel) : DEFAULT_MODEL];
  const fresh = Math.max(0, t.input - t.cached - t.cacheWrite);
  const base = (fresh * p.in + t.cached * p.cacheRead + t.cacheWrite * p.cacheWrite + t.output * p.out) / 1_000_000;
  return base + (t.fastPremiumUsd ?? 0);
}

// The target's "visual signature" — what the property should look like from
// above, as an ordered list of aerial-detectable clues, biggest discriminator
// first (topology/context → plot → arrangement → fine detail). The finder
// records this before searching; we keep it on the job so a post-mortem can
// see what it was hunting for and how well the clue list matched the truth.
export interface Signature {
  clues: string[]; // ordered, biggest filter first
  schematicSvg?: string; // optional top-down sketch of the target
  location?: LocationClues; // where the photos place it: slope side, landmarks — orders the shortlist
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string; // when the investigation actually began running
  activeMs?: number; // time the agent loop has actually been running (pauses excluded)
  finishedAt?: string; // when it reached a terminal state (done/error/cancelled)
  updatedAt: string;
  model: KnownModel; // which Claude model runs this investigation
  account?: string | null; // the Claude subscription login it runs on (claude-pool.ts); the name, never the token
  promptVersion?: string; // fingerprint of the SYSTEM+TASK prompt this run used
  signature?: Signature; // the target's aerial signature (recorded up front)
  // Where to look (commune confidence + neighbour ring) and the candidate ledger:
  // what was shortlisted, viewed, and the verdict on each. See search.ts.
  search?: SearchState;
  input: {
    municipality?: string;
    listingText?: string;
    imageCount: number;
    // The caller's own reference for the listing: runs with the same listingId
    // are shown together as one request on the main table.
    listingId?: string;
    listingUrl?: string;
    radarUrl?: string; // the listing's page in Radar, the platform that sent it
  };
  steps: Step[];
  answer: Answer | null;
  error?: string;
  tokens: TokenUsage;
  potential?: BuildPotential | null;
  potentialStatus?: PotentialStatus;
  cancelRequested?: boolean;
  deleted?: boolean; // removed by the admin; never written to disk again
  pauseRequested?: boolean;
  runDir: string;
}

// Wall-clock time the investigation has taken, in ms: start → finish, or
// start → now while it is still running (frozen at updatedAt while paused).
// Answers saved before parcels[] existed: read the plots back out of the
// free-text parcel ("Horgen HN12522 + HN12523", "Plan-les-Ouates 10917").
export function withParcels(answer: Answer | null): Answer | null {
  if (!answer || (Array.isArray(answer.parcels) && answer.parcels.length)) return answer;
  const m = answer.parcel?.trim().match(/^(.+?)\s+([A-Z]{0,4}\d[\w./-]*(?:\s*[+,&]\s*[A-Z]{0,4}\d[\w./-]*)*)$/);
  const parcels = m
    ? m[2].split(/\s*[+,&]\s*/).map((plot) => ({ commune: answer.commune ?? m[1], plot }))
    : [];
  // A found answer that named exact plots but no address pinned the plots
  // themselves, which is what "parcel" confidence now records.
  const confidence =
    parcels.length && answer.found && !answer.address && ["block", "neighborhood"].includes(answer.confidence)
      ? "parcel"
      : answer.confidence;
  return { ...answer, parcels, confidence };
}

export function elapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? (job.status === "running" ? nowIso() : job.updatedAt);
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

const jobs = new Map<string, Job>();

function nowIso(): string {
  return new Date().toISOString();
}

export function listJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export async function createJob(input: Job["input"], model: ModelId = DEFAULT_MODEL): Promise<Job> {
  const id = cryptoRandomId();
  const runDir = await ensureRunDir(id);
  const job: Job = {
    id,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    model,
    input,
    steps: [],
    answer: null,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 },
    runDir,
  };
  jobs.set(id, job);
  await persist(job);
  return job;
}

// Accumulate token usage across the investigation's model turns. `cached` is the
// portion of `input` read from the cache; `cacheWrite` is the portion written.
export async function addUsage(
  job: Job,
  input: number,
  output: number,
  cached: number,
  cacheWrite: number,
  fast = false,
): Promise<void> {
  if (fast) {
    // Fast mode bills every token class at 2x, so the premium equals this
    // turn's standard price.
    const turn = { input, output, cached, cacheWrite, total: input + output };
    job.tokens.fastTurns = (job.tokens.fastTurns ?? 0) + 1;
    job.tokens.fastPremiumUsd = (job.tokens.fastPremiumUsd ?? 0) + costUsd(turn, job.model);
  }
  job.tokens.input += input;
  job.tokens.output += output;
  job.tokens.cached += cached;
  job.tokens.cacheWrite += cacheWrite;
  job.tokens.total = job.tokens.input + job.tokens.output;
  job.updatedAt = nowIso();
  await persist(job);
}

export async function addStep(job: Job, step: Omit<Step, "n" | "at">): Promise<Step> {
  const full: Step = { ...step, n: job.steps.length + 1, at: nowIso() };
  job.steps.push(full);
  job.updatedAt = full.at;
  await persist(job);
  return full;
}

// Flag a running investigation to stop; the agent loop checks this each turn.
export function requestCancel(job: Job): void {
  job.cancelRequested = true;
}

// Flag a running investigation to PAUSE at the next turn boundary. Unlike cancel
// (terminal), a paused job keeps its saved conversation and can be resumed.
export function requestPause(job: Job): void {
  job.pauseRequested = true;
}

// Record which prompt version governed this run (see agent.ts stampPrompt).
export async function setPromptVersion(job: Job, version: string): Promise<void> {
  job.promptVersion = version;
  job.updatedAt = nowIso();
  await persist(job);
}

// Stamp the moment the investigation actually starts running (once; a resume
// must not reset it, so the elapsed clock reflects total time from the start).
export async function markStarted(job: Job): Promise<void> {
  if (job.startedAt) return;
  job.startedAt = nowIso();
  job.updatedAt = job.startedAt;
  await persist(job);
}

// Record which subscription login the run is on (its Railway variable's name).
export async function setAccount(job: Job, account: string | null): Promise<void> {
  job.account = account;
  job.updatedAt = nowIso();
  await persist(job);
}

// Store the target's aerial signature (the ordered clue list) — see agent.ts.
export async function setSignature(job: Job, signature: Signature): Promise<void> {
  job.signature = signature;
  job.updatedAt = nowIso();
  await persist(job);
}

// Persist the search plan / candidate ledger after the agent changed it.
export async function saveSearch(job: Job, search: SearchState): Promise<void> {
  job.search = search;
  job.updatedAt = nowIso();
  await persist(job);
}

export async function setPotentialStatus(job: Job, status: PotentialStatus): Promise<void> {
  job.potentialStatus = status;
  job.updatedAt = nowIso();
  await persist(job);
}

export async function setPotential(job: Job, potential: BuildPotential): Promise<void> {
  job.potential = potential;
  job.potentialStatus = "done";
  job.updatedAt = nowIso();
  await persist(job);
}

export async function finishJob(
  job: Job,
  patch: { status: JobStatus; answer?: Answer | null; error?: string },
): Promise<void> {
  job.status = patch.status;
  if (patch.answer !== undefined) job.answer = patch.answer;
  if (patch.error !== undefined) job.error = patch.error;
  // Stamp the finish time on terminal states only — a pause is not the end, so
  // the elapsed clock resumes counting when the run is picked back up.
  if (patch.status === "done" || patch.status === "error" || patch.status === "cancelled") {
    job.finishedAt = nowIso();
  }
  job.updatedAt = nowIso();
  await persist(job);
}

// job.json omits runDir (server-local) and is safe to serve verbatim.
function serialize(job: Job): string {
  const { runDir: _runDir, ...rest } = job;
  return JSON.stringify(rest, null, 2);
}

// Writes of one job are chained: tools run in parallel each add steps, and two
// overlapping writeFile calls on job.json could interleave into a corrupt file.
const persistQueue = new Map<string, Promise<void>>();

function persist(job: Job): Promise<void> {
  const prev = persistQueue.get(job.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    if (job.deleted) return;
    try {
      await mkdir(job.runDir, { recursive: true });
      await writeFile(path.join(job.runDir, "job.json"), serialize(job), "utf8");
    } catch (err) {
      console.error(`[jobs] failed to persist ${job.id}:`, err);
    }
  });
  persistQueue.set(job.id, next);
  void next.then(() => {
    if (persistQueue.get(job.id) === next) persistQueue.delete(job.id);
  });
  return next;
}

// On boot, reload persisted jobs so reopened windows see history. Any job left
// "running" when the process died is returned so the caller can resume it from
// its saved conversation (see resumeInvestigation) — a restart no longer kills
// an in-flight investigation. Returns the jobs to resume.
export async function loadPersistedJobs(): Promise<Job[]> {
  const resumable: Job[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(RUNS_ROOT);
  } catch {
    return resumable; // no runs yet
  }
  for (const id of entries) {
    try {
      const raw = await readFile(path.join(RUNS_ROOT, id, "job.json"), "utf8");
      const parsed = JSON.parse(raw) as Omit<Job, "runDir">;
      const job: Job = {
        ...parsed,
        answer: withParcels(parsed.answer),
        model: KNOWN_MODELS.includes(parsed.model) ? parsed.model : DEFAULT_MODEL,
        tokens: {
          input: parsed.tokens?.input ?? 0,
          output: parsed.tokens?.output ?? 0,
          cached: parsed.tokens?.cached ?? 0,
          cacheWrite: parsed.tokens?.cacheWrite ?? 0,
          total: parsed.tokens?.total ?? 0,
        },
        runDir: path.join(RUNS_ROOT, id),
      };
      // A construction-potential analysis is short and not resumable; if it was
      // mid-flight when the process died, mark it errored so the UI can offer a
      // retry instead of spinning forever.
      if (job.potentialStatus === "running") job.potentialStatus = "error";
      jobs.set(job.id, job);
      // Still "running" means the previous process died mid-flight; hand it back
      // to be resumed. A pending cancel (persisted on the job) is preserved, so
      // the resumed run stops on its first turn as the user intended.
      if (job.status === "running") resumable.push(job);
    } catch {
      // skip unreadable run dirs
    }
  }
  return resumable;
}

// Delete an investigation and its files. A running one is told to stop first;
// its folder is removed again a minute later in case the run wrote into it
// while stopping.
export async function deleteJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "running") requestCancel(job);
  job.deleted = true;
  jobs.delete(id);
  const remove = () => rm(job.runDir, { recursive: true, force: true }).catch(() => {});
  await remove();
  setTimeout(() => void remove(), 60_000);
  return true;
}

function cryptoRandomId(): string {
  // URL-safe short id. Use node:crypto's randomUUID (not globalThis.crypto,
  // which isn't a global on Node < 20 — that crashed the Railway deploy).
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
