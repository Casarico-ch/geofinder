// =============================================================================
// Platform requests — one record per call from the platform to /v1.
//
// An address request is answered on the spot with a Popety property profile.
// A listing request runs the investigation on several models side by side (one
// GeoFinder job each); as each model settles, the parcel it found is looked up
// on Popety and its profile attached. The admin website lists these records
// one per row, with each model's result inside. Records are mirrored to disk
// (RUNS_ROOT/_requests/<id>.json) like jobs, so they survive restarts.
// =============================================================================
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT } from "./sandbox";
import { getJob, costUsd, type Answer, type JobStatus, type ModelId } from "./jobs";
import {
  PROFILE_COST_CHF,
  findLandByCoordinates,
  getProfileByLandId,
  type LandCandidate,
  type PropertyProfile,
} from "./popety";

export type RequestStatus = "running" | "done" | "error";

export interface ModelResult {
  model: ModelId;
  jobId: string;
  status: JobStatus;
  answer: Answer | null;
  profile: PropertyProfile | null;
  profileError?: string;
  aiCostUsd: number;
}

export interface PlatformRequest {
  id: string;
  kind: "address" | "listing";
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  input: { address?: string; listingText?: string; municipality?: string; imageCount?: number };
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

// Follow each model's job until it settles, then fetch the Popety profile for
// the parcel it found. Two models landing on the same parcel share one lookup
// (and one CHF 3.80 charge).
export function watchListingRequest(req: PlatformRequest): void {
  const profiles = new Map<string, Promise<PropertyProfile>>();

  const profileFor = (landId: string, address: string | null) => {
    let p = profiles.get(landId);
    if (!p) {
      p = getProfileByLandId(landId, address);
      profiles.set(landId, p);
      p.then(
        async () => {
          req.popetyCostChf = Math.round((req.popetyCostChf + PROFILE_COST_CHF) * 100) / 100;
          await saveRequest(req);
        },
        () => {},
      );
    }
    return p;
  };

  const settle = async (r: ModelResult) => {
    const answer = r.answer;
    if (r.status !== "done" || !answer?.found || answer.latitude == null || answer.longitude == null) return;
    try {
      const match = await findLandByCoordinates(answer.latitude, answer.longitude);
      if (match.kind !== "match") {
        r.profileError = "Popety has no parcel at the location this model found.";
        return;
      }
      r.profile = await profileFor(match.landId, match.matchedAddress ?? answer.address);
    } catch (err) {
      r.profileError = err instanceof Error ? err.message : String(err);
    }
  };

  // Returns true once every model has settled.
  const tick = async (): Promise<boolean> => {
    let changed = false;
    const settling: Promise<void>[] = [];
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
      if (TERMINAL.includes(job.status)) {
        r.answer = job.answer;
        settling.push(settle(r));
      }
    }
    await Promise.all(settling);
    const all = req.results ?? [];
    if (all.every((r) => TERMINAL.includes(r.status))) {
      req.status = all.some((r) => r.status === "done") ? "done" : "error";
      if (req.status === "error") req.error = "No model finished the investigation.";
      await saveRequest(req);
      return true;
    }
    if (changed || settling.length) await saveRequest(req);
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
