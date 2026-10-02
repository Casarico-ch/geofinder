// =============================================================================
// Platform requests — one record per call from the platform to /v1.
//
// An address request is answered on the spot with a Popety property profile.
// A listing request runs the investigation on several models side by side (one
// GeoFinder job each) and reports the address each model found — no Popety
// lookup; the platform calls /v1/property for that. The admin website lists these records
// one per row, with each model's result inside. Records are mirrored to disk
// (RUNS_ROOT/_requests/<id>.json) like jobs, so they survive restarts.
// =============================================================================
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT } from "./sandbox";
import { getJob, costUsd, type Answer, type JobStatus, type ModelId } from "./jobs";
import type { LandCandidate, PropertyProfile } from "./popety";

export type RequestStatus = "running" | "done" | "error";

export interface ModelResult {
  model: ModelId;
  jobId: string;
  status: JobStatus;
  answer: Answer | null;
  aiCostUsd: number;
}

export interface PlatformRequest {
  id: string;
  kind: "address" | "listing";
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  input: {
    address?: string;
    latitude?: number;
    longitude?: number;
    commune?: string;
    plot?: string;
    listingText?: string;
    municipality?: string;
    imageCount?: number;
  };
  // address requests
  profile?: PropertyProfile | null;
  candidates?: LandCandidate[];
  // listing requests
  results?: ModelResult[];
  popetyCostChf: number;
  error?: string;
}

const requests = new Map<string, PlatformRequest>();
const dir = () => path.join(RUNS_ROOT, "_requests");
const nowIso = () => new Date().toISOString();

export function listRequests(): PlatformRequest[] {
  return Array.from(requests.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRequest(id: string): PlatformRequest | undefined {
  return requests.get(id);
}

export async function createRequest(
  kind: PlatformRequest["kind"],
  input: PlatformRequest["input"],
): Promise<PlatformRequest> {
  const req: PlatformRequest = {
    id: randomUUID().replace(/-/g, "").slice(0, 16),
    kind,
    status: "running",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    input,
    popetyCostChf: 0,
  };
  requests.set(req.id, req);
  await saveRequest(req);
  return req;
}

export async function saveRequest(req: PlatformRequest): Promise<void> {
  req.updatedAt = nowIso();
  if (req.status !== "running" && !req.finishedAt) req.finishedAt = req.updatedAt;
  try {
    await mkdir(dir(), { recursive: true });
    await writeFile(path.join(dir(), `${req.id}.json`), JSON.stringify(req, null, 2), "utf8");
  } catch (err) {
    console.error(`[requests] failed to persist ${req.id}:`, err);
  }
}

export async function loadPersistedRequests(): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(dir());
  } catch {
    return; // none yet
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const req = JSON.parse(await readFile(path.join(dir(), f), "utf8")) as PlatformRequest;
      requests.set(req.id, req);
    } catch {
      // skip unreadable records
    }
  }
  // Listing requests still running when the process died: their jobs are
  // resumed by index.ts, so just start watching them again.
  for (const req of Array.from(requests.values())) {
    if (req.kind === "listing" && req.status === "running") watchListingRequest(req);
  }
}

const TERMINAL: JobStatus[] = ["done", "error", "cancelled"];
const POLL_MS = 5_000;

// Follow each model's job until it settles and record its answer.
export function watchListingRequest(req: PlatformRequest): void {
  // Returns true once every model has settled.
  const tick = async (): Promise<boolean> => {
    let changed = false;
    for (const r of req.results ?? []) {
      if (TERMINAL.includes(r.status)) continue;
      const job = getJob(r.jobId);
      if (!job) {
        r.status = "error";
        changed = true;
        continue;
      }
      const cost = costUsd(job.tokens, job.model);
      if (job.status !== r.status || cost !== r.aiCostUsd) changed = true;
      r.status = job.status;
      r.aiCostUsd = cost;
      if (TERMINAL.includes(job.status)) r.answer = job.answer;
    }
    const all = req.results ?? [];
    if (all.every((r) => TERMINAL.includes(r.status))) {
      req.status = all.some((r) => r.status === "done") ? "done" : "error";
      if (req.status === "error") req.error = "No model finished the investigation.";
      await saveRequest(req);
      return true;
    }
    if (changed) await saveRequest(req);
    return false;
  };

  const loop = async () => {
    let finished = false;
    try {
      finished = await tick();
    } catch (err) {
      console.error(`[requests] ${req.id}:`, err);
    }
    if (!finished) setTimeout(() => void loop(), POLL_MS);
  };
  void loop();
}
