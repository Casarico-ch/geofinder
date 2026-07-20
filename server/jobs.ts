// =============================================================================
// Jobs — background investigations that keep running after the browser closes.
//
// A POST starts a job and returns immediately with its id; the investigation
// runs server-side (fire-and-forget) and streams a documented trace of every
// step + reasoning into the job. The client polls, and can reopen a running or
// finished job at any time. Jobs are mirrored to disk (RUNS_ROOT/<id>/job.json)
// so a process restart or a reopened window recovers the full trace.
// =============================================================================
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT, ensureRunDir } from "./sandbox";
import type { BuildPotential } from "./potential";

export type PotentialStatus = "running" | "done" | "error";

export type Confidence =
  | "street"
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

export interface Answer {
  found: boolean;
  address: string | null;
  parcel: string | null;
  commune: string | null;
  confidence: Confidence;
  latitude: number | null;
  longitude: number | null;
  reasoning: string;
  candidates: AnswerCandidate[];
  links: string[];
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
}

// Per-model pricing, USD per 1M tokens: [fresh input, cache read (~0.1x),
// cache write (1.25x, 5-min TTL), output]. Fable 5 is ~2x Opus 4.8.
export const MODELS = ["claude-opus-4-8", "claude-fable-5"] as const;
export type ModelId = (typeof MODELS)[number];
export const DEFAULT_MODEL: ModelId = "claude-opus-4-8";

const PRICING: Record<ModelId, { in: number; cacheRead: number; cacheWrite: number; out: number }> = {
  "claude-opus-4-8": { in: 5, cacheRead: 0.5, cacheWrite: 6.25, out: 25 },
  "claude-fable-5": { in: 10, cacheRead: 1.0, cacheWrite: 12.5, out: 50 },
};

export function costUsd(t: TokenUsage, model?: string): number {
  const p = PRICING[(model as ModelId) in PRICING ? (model as ModelId) : DEFAULT_MODEL];
  const fresh = Math.max(0, t.input - t.cached - t.cacheWrite);
  return (fresh * p.in + t.cached * p.cacheRead + t.cacheWrite * p.cacheWrite + t.output * p.out) / 1_000_000;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  model: ModelId; // which Claude model runs this investigation
  input: { municipality?: string; listingText?: string; imageCount: number };
  steps: Step[];
  answer: Answer | null;
  error?: string;
  tokens: TokenUsage;
  potential?: BuildPotential | null;
  potentialStatus?: PotentialStatus;
  cancelRequested?: boolean;
  pauseRequested?: boolean;
  runDir: string;
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
): Promise<void> {
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
  job.updatedAt = nowIso();
  await persist(job);
}

// job.json omits runDir (server-local) and is safe to serve verbatim.
function serialize(job: Job): string {
  const { runDir: _runDir, ...rest } = job;
  return JSON.stringify(rest, null, 2);
}

async function persist(job: Job): Promise<void> {
  try {
    await mkdir(job.runDir, { recursive: true });
    await writeFile(path.join(job.runDir, "job.json"), serialize(job), "utf8");
  } catch (err) {
    console.error(`[jobs] failed to persist ${job.id}:`, err);
  }
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
        model: (MODELS as readonly string[]).includes(parsed.model) ? parsed.model : DEFAULT_MODEL,
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

function cryptoRandomId(): string {
  // URL-safe short id. Use node:crypto's randomUUID (not globalThis.crypto,
  // which isn't a global on Node < 20 — that crashed the Railway deploy).
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
