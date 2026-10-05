// =============================================================================
// Disk cleanup — the runs volume filled up on 05.10 ("ENOSPC: no space left on
// device" killed a practice run): every run kept its listing photos, roof
// renders, aerial tiles and contact sheets, and its conversation with every
// image inlined as base64, for ever.
//
// An hour after a run finishes (Daniel, 05.10: "delete 1h after the job is
// done"), its pictures are deleted and the images are taken out of its kept
// conversation; the answer, the steps, the search checklist and the text of
// the conversation stay, so results, lessons and exports still read. A request's
// own listing photos (photo1.jpg …) stay too: "Run again" reuses them. A
// practice run fetches its photos from radar again, so it keeps none.
// =============================================================================
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listJobs, type Job } from "./jobs";
import { CONVERSATION_FILE } from "./agent";

const AFTER_MS = Number(process.env.CLEANUP_AFTER_MINUTES ?? 60) * 60_000;
const EVERY_MS = 10 * 60_000;
const MARK = ".cleaned";
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const LISTING_PHOTO = /^photo\d+\.(png|jpe?g|webp|gif)$/i;

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Every picture under the run dir, removed (the listing photos only when asked); returns the bytes freed. */
async function dropImages(dir: string, keepPhotos: boolean, top = true): Promise<number> {
  let freed = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) freed += await dropImages(p, keepPhotos, false);
    else if (IMAGE.test(e.name) && !(keepPhotos && top && LISTING_PHOTO.test(e.name))) {
      freed += (await stat(p).catch(() => null))?.size ?? 0;
      await rm(p, { force: true });
    }
  }
  return freed;
}

// Image blocks, also inside tool results, become a short text block.
function stripImages(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripImages);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "image") return { type: "text", text: "[image removed after the run]" };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, stripImages(x)]));
  }
  return v;
}

export async function cleanRun(job: Job): Promise<number> {
  const dir = job.runDir;
  if (!dir || (await exists(path.join(dir, MARK)))) return 0;
  const practice = (job.input.listingId ?? "").startsWith("practice-");
  let freed = await dropImages(dir, !practice);
  const conv = path.join(dir, CONVERSATION_FILE);
  const raw = await readFile(conv, "utf8").catch(() => null);
  if (raw) {
    const slim = JSON.stringify(stripImages(JSON.parse(raw)));
    freed += raw.length - slim.length;
    await writeFile(conv, slim);
  }
  await writeFile(path.join(dir, MARK), new Date().toISOString());
  return freed;
}

async function sweep(): Promise<void> {
  const cutoff = Date.now() - AFTER_MS;
  let runs = 0, freed = 0;
  for (const job of listJobs()) {
    if (job.status === "running" || job.status === "paused") continue;
    // Runs from before finishedAt was kept: their last update.
    if (Date.parse(job.finishedAt ?? job.updatedAt) > cutoff) continue;
    try {
      const n = await cleanRun(job);
      if (n) (runs++, (freed += n));
    } catch (err) {
      console.error(`[cleanup] run ${job.id}:`, err);
    }
  }
  if (runs) console.log(`[cleanup] ${runs} finished runs cleaned, ${Math.round(freed / 1e6)} MB freed`);
}

export function startCleanupLoop(): void {
  const beat = () => void sweep().catch((err) => console.error("[cleanup] sweep failed:", err));
  beat();
  setInterval(beat, EVERY_MS);
}
