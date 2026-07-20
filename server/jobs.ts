// =============================================================================
// Jobs — background investigations that keep running after the browser closes.
//
// A POST starts a job and returns immediately with its id; the investigation
// runs server-side (fire-and-forget) and streams a documented trace of every
// step + reasoning into the job. The client polls, and can reopen a running or
// finished job at any time. Jobs are mirrored to disk (RUNS_ROOT/<id>/job.json)
// so a process restart or a reopened window recovers the full trace.
// =============================================================================
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT, ensureRunDir } from "./sandbox";

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

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  input: { municipality?: string; listingText?: string; imageCount: number };
  steps: Step[];
  answer: Answer | null;
  error?: string;
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

export async function createJob(input: Job["input"]): Promise<Job> {
  const id = cryptoRandomId();
  const runDir = await ensureRunDir(id);
  const job: Job = {
    id,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    input,
    steps: [],
    answer: null,
    runDir,
  };
  jobs.set(id, job);
  await persist(job);
  return job;
}

export async function addStep(job: Job, step: Omit<Step, "n" | "at">): Promise<Step> {
  const full: Step = { ...step, n: job.steps.length + 1, at: nowIso() };
  job.steps.push(full);
  job.updatedAt = full.at;
  await persist(job);
  return full;
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
// "running" when the process died is marked interrupted — it cannot resume.
export async function loadPersistedJobs(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(RUNS_ROOT);
  } catch {
    return; // no runs yet
  }
  for (const id of entries) {
    try {
      const raw = await readFile(path.join(RUNS_ROOT, id, "job.json"), "utf8");
      const parsed = JSON.parse(raw) as Omit<Job, "runDir">;
      const job: Job = { ...parsed, runDir: path.join(RUNS_ROOT, id) };
      if (job.status === "running") {
        job.status = "error";
        job.error = "Interrupted by a server restart.";
      }
      jobs.set(job.id, job);
    } catch {
      // skip unreadable run dirs
    }
  }
}

function cryptoRandomId(): string {
  // URL-safe short id; crypto.randomUUID is available on Node 18+.
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
