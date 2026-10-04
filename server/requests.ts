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
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT } from "./sandbox";
import { deleteJob, getJob, costUsd, listJobs, type Answer, type Job, type JobStatus, type ModelId } from "./jobs";
import type { CombinedSite, LandCandidate, PropertyProfile } from "./popety";

// "paused" is display-only: a request whose unfinished runs are all paused.
export type RequestStatus = "running" | "paused" | "done" | "error";

export interface ModelResult {
  model: ModelId;
  jobId: string;
  status: JobStatus;
  answer: Answer | null;
  aiCostUsd: number;
  tokens?: number; // total tokens of the run, filled in when listing
  startedAt?: string; // when the run was created, filled in when listing
  check?: boolean; // a cross-check of another model's answer, not a search of its own
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
    egrid?: string | null;
    plots?: Record<string, unknown>[];
    listingText?: string;
    municipality?: string;
    imageCount?: number;
    listingId?: string;
    listingUrl?: string;
    radarUrl?: string;
  };
  // address requests
  profile?: PropertyProfile | null;
  candidates?: LandCandidate[];
  // multi-plot property requests
  profiles?: PropertyProfile[];
  combined?: CombinedSite;
  plotErrors?: { plot: string; error: string; candidates?: LandCandidate[] }[];
  // listing requests
  results?: ModelResult[];
  popetyCostChf: number;
  error?: string;
  source?: "platform" | "website";
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
    source: "platform",
  };
  requests.set(req.id, req);
  await saveRequest(req);
  return req;
}

export async function saveRequest(req: PlatformRequest): Promise<void> {
  if (!requests.has(req.id)) return; // deleted
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

// A website search: the jobs started together from the New search form (one
// per chosen model) grouped into one request, like a platform call.
export async function createRequestFromJobs(jobs: Job[]): Promise<PlatformRequest> {
  const first = jobs[0];
  const req = await createRequest("listing", {
    listingText: first.input.listingText,
    municipality: first.input.municipality,
    imageCount: first.input.imageCount,
    listingId: first.input.listingId,
    listingUrl: first.input.listingUrl,
    radarUrl: first.input.radarUrl,
  });
  req.source = "website";
  req.createdAt = jobs.map((j) => j.createdAt).sort()[0];
  req.results = jobs.map((j) => ({
    model: j.model,
    jobId: j.id,
    status: j.status,
    answer: j.answer,
    aiCostUsd: costUsd(j.tokens, j.model),
  }));
  await saveRequest(req);
  watchListingRequest(req);
  return req;
}

// Delete rows from the admin table: the requests themselves, every run listed
// in them, and any other request that held one of those runs.
export async function deleteRows(requestIds: string[], jobIds: string[]): Promise<number> {
  const jobSet = new Set(jobIds);
  for (const id of requestIds) for (const m of requests.get(id)?.results ?? []) jobSet.add(m.jobId);
  const reqSet = new Set(requestIds.filter((id) => requests.has(id)));
  for (const r of Array.from(requests.values())) if ((r.results ?? []).some((m) => jobSet.has(m.jobId))) reqSet.add(r.id);
  for (const id of Array.from(reqSet)) {
    requests.delete(id);
    await rm(path.join(dir(), `${id}.json`), { force: true }).catch(() => {});
  }
  for (const id of Array.from(jobSet)) await deleteJob(id);
  return reqSet.size + jobSet.size;
}

const GROUP_WINDOW_MS = 10 * 60_000;

// A cross-check run is the same listing with a verification task appended
// ("--- VERIFICATION TASK --- Another investigator concluded …"). It belongs on
// the listing's row, so grouping compares the listing text without that task.
const CHECK_MARK = "--- VERIFICATION TASK ---";
export const isCheckText = (t?: string): boolean => (t ?? "").includes(CHECK_MARK);
const withoutCheck = (t?: string): string => {
  const text = t ?? "";
  const at = text.indexOf(CHECK_MARK);
  return (at >= 0 ? text.slice(0, at) : text).trim();
};

// Requests plus every investigation that belongs to none (older website
// searches, relaunches, other apps), one row per listing: everything sent with
// the same listingId is one row. Loose runs without one are grouped when they
// carry the same listing and started within a few minutes of each other.
export function listRequestsWithLooseJobs(): PlatformRequest[] {
  const all = listRequests();
  const claimed = new Set(all.flatMap((r) => (r.results ?? []).map((m) => m.jobId)));
  const loose = listJobs()
    .filter((j) => !claimed.has(j.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const groups: Job[][] = [];
  const keyOf = (j: Job) =>
    j.input.listingId
      ? `id:${j.input.listingId}`
      : JSON.stringify([withoutCheck(j.input.listingText), j.input.municipality ?? "", j.input.imageCount]);
  for (const j of loose) {
    const g = groups.find(
      (g) =>
        keyOf(g[0]) === keyOf(j) &&
        (j.input.listingId || Date.parse(j.createdAt) - Date.parse(g[0].createdAt) <= GROUP_WINDOW_MS),
    );
    if (g) g.push(j);
    else groups.push([j]);
  }

  const looseRequests: PlatformRequest[] = groups.map((g) => {
    const results: ModelResult[] = g.map((j) => ({
      model: j.model,
      jobId: j.id,
      status: j.status,
      answer: j.answer,
      aiCostUsd: costUsd(j.tokens, j.model),
      tokens: j.tokens.total,
      startedAt: j.createdAt,
      check: isCheckText(j.input.listingText),
    }));
    // The row shows the listing as searched, not a cross-check's extra task.
    const first = g.find((j) => !isCheckText(j.input.listingText)) ?? g[0];
    return {
      id: `job-${first.id}`,
      kind: "listing",
      source: "website",
      status: overallStatus(results),
      createdAt: g[0].createdAt,
      updatedAt: g.map((j) => j.updatedAt).sort().at(-1)!,
      input: {
        listingText: withoutCheck(first.input.listingText) || undefined,
        municipality: first.input.municipality,
        imageCount: first.input.imageCount,
        listingId: first.input.listingId,
        listingUrl: g.find((j) => j.input.listingUrl)?.input.listingUrl,
        radarUrl: g.find((j) => j.input.radarUrl)?.input.radarUrl,
      },
      results,
      popetyCostChf: 0,
    };
  });

  // Listing rows read each run's live status, answer and cost from its job.
  const shown = all.map((r) => {
    if (r.kind !== "listing") return r;
    const results = (r.results ?? []).map((m) => {
      const j = getJob(m.jobId);
      return j
        ? {
            ...m,
            status: j.status,
            answer: j.answer ?? m.answer,
            aiCostUsd: costUsd(j.tokens, j.model),
            tokens: j.tokens.total,
            startedAt: j.createdAt,
            check: isCheckText(j.input.listingText),
          }
        : m;
    });
    return { ...r, results, status: r.status === "running" ? overallStatus(results) : r.status };
  });
  return mergeByListing([...shown, ...looseRequests]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Address searches (platform calls or loose runs) of the same listing become
// one row holding every model's search: same listingId, or, without one, the
// same listing text and commune (a re-run of the same listing).
function listingKey(r: PlatformRequest): string | undefined {
  if (r.kind !== "listing") return undefined;
  if (r.input.listingId) return `id:${r.input.listingId}`;
  const text = withoutCheck(r.input.listingText)
    .replace(/^Municipality \/ commune: [^\n]*\n*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return text ? `text:${(r.input.municipality ?? "").trim().toLowerCase()}|${text}` : undefined;
}

function mergeByListing(rows: PlatformRequest[]): PlatformRequest[] {
  const byId = new Map<string, PlatformRequest>();
  const out: PlatformRequest[] = [];
  for (const r of rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const id = listingKey(r);
    const into = id ? byId.get(id) : undefined;
    if (!id) {
      out.push(r);
    } else if (!into) {
      const copy = { ...r, input: { ...r.input }, results: [...(r.results ?? [])] };
      byId.set(id, copy);
      out.push(copy);
    } else {
      into.results = [...(into.results ?? []), ...(r.results ?? [])].sort((a, b) =>
        (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
      );
      into.input.listingUrl ??= r.input.listingUrl;
      into.input.radarUrl ??= r.input.radarUrl;
      if (r.updatedAt > into.updatedAt) into.updatedAt = r.updatedAt;
      if (r.source === "platform") into.source = "platform";
      into.status = overallStatus(into.results);
    }
  }
  return out;
}

// Running while any run still works; paused when the unfinished ones are all paused.
function overallStatus(results: ModelResult[]): RequestStatus {
  const live = results.map((r) => getJob(r.jobId)?.status ?? r.status);
  if (live.some((s) => s === "running")) return "running";
  if (live.some((s) => s === "paused")) return "paused";
  return live.some((s) => s === "done") ? "done" : "error";
}

const TERMINAL: JobStatus[] = ["done", "error", "cancelled"];
const POLL_MS = 5_000;

// Called once every run of a listing request has settled. Returns true when it
// added a run (a cross-check), so the request keeps running until that settles.
type SettleHook = (req: PlatformRequest) => Promise<boolean>;
let settleHook: SettleHook | null = null;
export function onListingSettled(fn: SettleHook): void {
  settleHook = fn;
}

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
      if (settleHook && (await settleHook(req))) {
        await saveRequest(req);
        return false;
      }
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
