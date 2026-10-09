// =============================================================================
// view — what a candidate house can actually see, from the terrain model.
//
// The photos through a window or from a terrace show a view: a lake below to
// the south, mountains far away, a slope rising right in front, the village
// down in the valley. Look-alike houses a few hundred metres apart see very
// different things. For each direction asked, this walks the swisstopo height
// model out to 25 km from the house and reports what is in sight: the skyline
// (how high and how far), whether the ground falls away in front (a view down),
// a slope blocking the view close by, and a dead-flat stretch below the house
// that is in view (a lake, or a valley floor). Daniel, 09.10: "whatever view we
// see through the window".
// =============================================================================
import { DIRECTIONS, type Direction } from "./locate";

const PROFILE = "https://api3.geo.admin.ch/rest/services/profile.json";
const DEG: Record<Direction, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const FAR_M = 25_000, FAR_POINTS = 250; // every 100 m
const NEAR_M = 1_500, NEAR_POINTS = 76; // every 20 m
const EYE_M = 6; // a first-floor window

function lv95(lat: number, lon: number): [number, number] {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3,
  ];
}

type Point = { d: number; z: number };

async function profile(from: [number, number], deg: number, lengthM: number, points: number): Promise<Point[]> {
  const rad = (deg * Math.PI) / 180;
  const to: [number, number] = [from[0] + Math.sin(rad) * lengthM, from[1] + Math.cos(rad) * lengthM];
  const geom = JSON.stringify({ type: "LineString", coordinates: [from, to] });
  const res = await fetch(`${PROFILE}?geom=${encodeURIComponent(geom)}&sr=2056&nb_points=${points}`, {
    headers: { "User-Agent": "geofinder" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`profile ${res.status}`);
  const j = (await res.json()) as { dist: number; alts: { COMB?: number; DTM2?: number; DTM25?: number } }[];
  return j
    .map((q) => ({ d: q.dist, z: Number(q.alts.COMB ?? q.alts.DTM2 ?? q.alts.DTM25) }))
    .filter((q) => Number.isFinite(q.z));
}

const angle = (dz: number, d: number) => (Math.atan2(dz, d) * 180) / Math.PI;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** One direction, in words: skyline, view down, a slope blocking it, a flat stretch in view. */
async function oneDirection(from: [number, number], dir: Direction): Promise<string> {
  const [near, far] = await Promise.all([profile(from, DEG[dir], NEAR_M, NEAR_POINTS), profile(from, DEG[dir], FAR_M, FAR_POINTS)]);
  if (!near.length || !far.length) return `${dir}: no terrain data`;
  const eye = near[0].z + EYE_M;
  const all = [...near.filter((p) => p.d > 0), ...far.filter((p) => p.d > NEAR_M)];
  // The skyline: the highest angle seen; what lies beyond it is hidden.
  let sky = { a: -90, d: 0, z: 0 };
  for (const p of all) {
    const a = angle(p.z - eye, p.d);
    if (a > sky.a) sky = { a, d: p.d, z: p.z };
  }
  const parts: string[] = [];
  const blockedClose = sky.d <= 300 && sky.a > 8;
  parts.push(
    blockedClose
      ? `blocked close by: the ground rises ${Math.round(sky.z - near[0].z)} m within ${km(sky.d)} (no open view)`
      : `skyline ${sky.a >= 0 ? "+" : ""}${sky.a.toFixed(1)}° at ${km(sky.d)} (${Math.round(sky.z)} m a.s.l.)`,
  );
  // A view down: the lowest ground in front, within 1.5 km.
  const low = near.reduce((m, p) => (p.z < m.z ? p : m), near[0]);
  if (near[0].z - low.z >= 20) parts.push(`the ground falls ${Math.round(near[0].z - low.z)} m within ${km(low.d)} (a view down)`);
  else if (low.z >= near[0].z - 5 && !blockedClose) parts.push("level ground in front");
  // A dead-flat stretch below the house that is in sight: a lake (or a valley floor).
  let run: Point[] = [];
  let maxA = -90;
  let flat: { from: number; to: number; z: number } | null = null;
  for (const p of all) {
    const a = angle(p.z - eye, p.d);
    const seen = a >= maxA - 0.05;
    maxA = Math.max(maxA, a);
    if (run.length && Math.abs(p.z - run[0].z) < 0.6 && p.z < near[0].z - 15 && seen) run.push(p);
    else {
      if (run.length >= 2 && run[run.length - 1].d - run[0].d >= 800 && !flat)
        flat = { from: run[0].d, to: run[run.length - 1].d, z: run[0].z };
      run = p.z < near[0].z - 15 && seen ? [p] : [];
    }
  }
  if (!flat && run.length >= 2 && run[run.length - 1].d - run[0].d >= 800) flat = { from: run[0].d, to: run[run.length - 1].d, z: run[0].z };
  if (flat) parts.push(`a dead-flat surface in view at ${Math.round(flat.z)} m from ${km(flat.from)} to ${km(flat.to)} (a lake, or a valley floor)`);
  return `${dir}: ${parts.join("; ")}`;
}

/** What the house at lat/lon sees in each direction asked (all 8 when none). */
export async function viewFrom(lat: number, lon: number, dirs: Direction[] = [...DIRECTIONS]): Promise<string> {
  const from = lv95(lat, lon);
  const lines = await Promise.all(
    dirs.map((d) => oneDirection(from, d).catch((err) => `${d}: failed (${err instanceof Error ? err.message : String(err)})`)),
  );
  return lines.join("\n");
}
