// =============================================================================
// Popety store — every plot's paid data, bought once (Daniel, 06.10: "we don't
// call 2x the same endpoint"). A profile is three paid Popety calls on one land
// id (plot record, buildings, zoning: CHF 3.80); finding the land id is free.
// The raw answers are kept per land id under RUNS_ROOT/_popety, so a plot that
// Radar, the website or another listing already bought is read back for free,
// across deploys (RUNS_ROOT is the volume). Two requests for the same plot at
// the same time share one purchase.
// =============================================================================
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLandData, toPropertyProfile, type LandData, type PropertyProfile } from "./popety";
import { RUNS_ROOT } from "./sandbox";

interface StoredLand extends LandData {
  landId: string;
  fetchedAt: string;
}

const dir = () => path.join(RUNS_ROOT, "_popety");
const fileOf = (landId: string) => path.join(dir(), `${encodeURIComponent(landId)}.json`);
const buying = new Map<string, Promise<StoredLand>>();

async function readStored(landId: string): Promise<StoredLand | null> {
  try {
    const s = JSON.parse(await readFile(fileOf(landId), "utf8")) as StoredLand;
    return s.landId === landId && s.land && s.buildings && s.zoning ? s : null;
  } catch {
    return null; // not bought yet, or unreadable: buy it again
  }
}

// Written to a temp file and renamed, so a crash never leaves half a record.
async function store(s: StoredLand): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const tmp = `${fileOf(s.landId)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s), "utf8");
    await rename(tmp, fileOf(s.landId));
  } catch (err) {
    console.error(`[popety-store] failed to keep land ${s.landId}:`, err);
  }
}

async function buy(landId: string): Promise<StoredLand> {
  const s: StoredLand = { landId, fetchedAt: new Date().toISOString(), ...(await getLandData(landId)) };
  await store(s);
  return s;
}

/**
 * One plot's profile: from the store when it was bought before (paid: false),
 * otherwise bought from Popety now and kept (paid: true).
 */
export async function profileByLandId(
  landId: string,
  matchedAddress: string | null,
): Promise<{ profile: PropertyProfile; paid: boolean; fetchedAt: string }> {
  const kept = await readStored(landId);
  if (kept) return { profile: toPropertyProfile(matchedAddress, kept.land, kept.buildings, kept.zoning), paid: false, fetchedAt: kept.fetchedAt };
  let pending = buying.get(landId);
  const buyer = !pending;
  if (!pending) {
    pending = buy(landId).finally(() => buying.delete(landId));
    buying.set(landId, pending);
  }
  const s = await pending;
  return { profile: toPropertyProfile(matchedAddress, s.land, s.buildings, s.zoning), paid: buyer, fetchedAt: s.fetchedAt };
}
