// =============================================================================
// locate — put the houses whose surroundings fit the photos first.
//
// The shortlist filters on the building alone (floors, footprint, dwellings),
// so in a big commune the right house can sit anywhere in a list of hundreds,
// and contact sheets show it 16 at a time. The photos usually also say WHERE
// the house is: which way the ground falls away (the view side), a church or a
// peak in a known direction. Measured on Zermatt (307 survivors): the slope
// direction alone leaves 57; "sees the Matterhorn" leaves 278, so a view check
// barely helps in the mountains and is not done here.
//
// This only ORDERS. Every survivor stays on the list and still needs a verdict,
// so a misread clue costs time, never the house.
// =============================================================================
import type { GwrBuilding } from "./gwr";

import { coerceNeighbours, type NeighbourClue } from "./neighbours";

const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";
const PROFILE = "https://api3.geo.admin.ch/rest/services/profile.json";
const UA = { "User-Agent": "geofinder" };

export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type ClueConfidence = "sure" | "likely" | "guess";

export interface LandmarkClue {
  kind: "church" | "peak" | "lake" | "place" | "other";
  name?: string; // "Matterhorn", "Église de Saint-Sulpice" — omit for an unnamed church
  // Where it is, seen FROM the house. Omitted for a place the description names
  // near the house ("à proximité du centre sportif", "5 min from the station"):
  // then only the distance is scored (Daniel, 09.10).
  direction?: Direction;
  distanceM?: number; // rough distance from the house, if the photos allow it
  confidence: ClueConfidence;
}

export interface LocationClues {
  slope?: { faces: Direction | "flat"; confidence: ClueConfidence }; // the way the ground falls away
  landmarks?: LandmarkClue[];
  neighbours?: NeighbourClue[]; // the buildings next to the house in the photos (neighbours.ts)
}

export interface LocationScore {
  score: number; // 0..1, how well the surroundings fit the clues
  why: string; // e.g. "slope W ✓; church 140 m NE ✓"
}

const WEIGHT: Record<ClueConfidence, number> = { sure: 1, likely: 0.6, guess: 0.3 };
const DEG: Record<Direction, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

export function hasClues(c: LocationClues | undefined): c is LocationClues {
  return !!c && (!!c.slope || (c.landmarks?.length ?? 0) > 0);
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

export function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const dx = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  const dy = to.lat - from.lat;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

export function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 111_320);
}

export function compass(deg: number): Direction {
  return DIRECTIONS[Math.round(deg / 45) % 8];
}

// How well an observed direction fits the stated one (8-point compass, so ±22°
// is the reading's own resolution).
function directionFit(observed: number, stated: Direction): number {
  const d = angleDiff(observed, DEG[stated]);
  return d <= 30 ? 1 : d <= 60 ? 0.5 : d <= 90 ? 0.15 : 0;
}

function distanceFit(actual: number, stated: number | undefined): number {
  if (!stated || stated <= 0) return 1;
  const r = actual / stated;
  return r >= 0.5 && r <= 2 ? 1 : r >= 0.33 && r <= 3 ? 0.6 : 0.2;
}

// Terrain at a house: the direction the ground falls away, from four swisstopo
// height-model points 25 m around it. Null when it is flat (no direction).
export interface Terrain {
  downhill: number | null;
  grade: number;
}

export function slopeFit(t: Terrain | null | undefined, stated: Direction | "flat"): number | null {
  if (!t) return null; // not measured
  if (stated === "flat") return t.grade < 0.06 ? 1 : t.grade < 0.12 ? 0.4 : 0.1;
  if (t.downhill == null || t.grade < 0.03) return 0.2; // flat ground has no view side
  return directionFit(t.downhill, stated);
}

// One house: the weighted mean over the clues that could be checked.
export function scoreHouse(
  house: { lat: number; lon: number },
  clues: LocationClues,
  terrain: Terrain | null | undefined,
  landmarks: ResolvedLandmark[],
): LocationScore | null {
  let sum = 0, weight = 0;
  const why: string[] = [];
  if (clues.slope) {
    const fit = slopeFit(terrain, clues.slope.faces);
    if (fit != null) {
      const w = WEIGHT[clues.slope.confidence];
      sum += w * fit;
      weight += w;
      const seen = terrain?.downhill == null || (terrain?.grade ?? 0) < 0.03 ? "flat" : compass(terrain.downhill);
      why.push(`slope ${seen} ${fit >= 0.5 ? "✓" : "✗"}`);
    }
  }
  for (const lm of landmarks) {
    if (!lm.points.length) continue;
    let best = 0, bestAt: { lat: number; lon: number } | null = null;
    for (const p of lm.points) {
      const d = metres(house, p);
      if (lm.clue.kind === "church" && !lm.clue.name && d > 3_000) continue; // an unnamed church is a local one
      const fit = (lm.clue.direction ? directionFit(bearing(house, p), lm.clue.direction) : 1) * distanceFit(d, lm.clue.distanceM);
      if (fit > best || !bestAt) [best, bestAt] = [fit, p];
    }
    const w = WEIGHT[lm.clue.confidence];
    sum += w * best;
    weight += w;
    const label = lm.clue.name ?? lm.clue.kind;
    why.push(
      bestAt
        ? `${label} ${Math.round(metres(house, bestAt))} m ${compass(bearing(house, bestAt))} ${best >= 0.5 ? "✓" : "✗"}`
        : `${label} ✗`,
    );
  }
  if (weight === 0) return null;
  return { score: sum / weight, why: why.join("; ") };
}

// ---------------------------------------------------------------------------
// Landmarks: where each clue's landmark actually is.
// ---------------------------------------------------------------------------
export interface ResolvedLandmark {
  clue: LandmarkClue;
  points: { lat: number; lon: number; label: string }[];
  note: string; // what it was resolved to, or why not
}

async function getJson(url: string, ms = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

interface Hit { lat: number; lon: number; label: string; cls: string; named: boolean; exact: boolean }

// swissNAMES3D classes a landmark kind may resolve to ("Matterhorn" also names
// three gondolas and a golf course).
const CLASSES: Partial<Record<LandmarkClue["kind"], string[]>> = {
  peak: ["TLM_NAME_PKT", "TLM_GELAENDENAME"],
  place: ["TLM_SIEDLUNGSNAME"],
};

function classRank(kind: LandmarkClue["kind"], cls: string): number {
  const order = CLASSES[kind];
  return order ? order.indexOf(cls) : 0;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Churches come from the building register (class 1272) of the commune; named
// landmarks from the swisstopo place-name search, the nearest hit within 40 km.
export async function resolveLandmarks(
  clues: LandmarkClue[],
  centre: { lat: number; lon: number },
  buildings: GwrBuilding[],
): Promise<ResolvedLandmark[]> {
  const churches = buildings
    .filter((b) => b.klass === 1272)
    .map((b) => ({ lat: b.lat, lon: b.lon, label: b.address ?? `EGID ${b.egid}` }));
  return Promise.all(
    clues.map(async (clue): Promise<ResolvedLandmark> => {
      if (clue.kind === "church" && !clue.name) {
        return {
          clue,
          points: churches,
          note: churches.length ? `${churches.length} church(es) in the register` : "no church in the register here",
        };
      }
      // A lake spans kilometres: the direction to its centre says little, and a
      // wrong direction would mislead, so lakes are not scored.
      if (clue.kind === "lake") return { clue, points: [], note: "lakes are too large to place by one point; not scored" };
      if (!clue.name) return { clue, points: [], note: "no name, cannot be placed" };
      try {
        const j = await getJson(
          `${SEARCH}?searchText=${encodeURIComponent(clue.name)}&type=locations&origins=gazetteer&sr=4326&limit=30`,
        );
        const want = fold(clue.name);
        const hits = (j.results ?? [])
          .map((r: any) => {
            const label = String(r.attrs?.label ?? "");
            const names = (label.match(/<b>([^<]*)<\/b>/)?.[1] ?? "").split("|").map(fold);
            return {
              lat: Number(r.attrs?.lat),
              lon: Number(r.attrs?.lon),
              label: label.replace(/<[^>]+>/g, "").trim(),
              cls: String(r.attrs?.objectclass ?? ""),
              named: names.some((n) => n === want || n.includes(want) || (n.length > 3 && want.includes(n))),
              exact: names.includes(want),
            };
          })
          .filter((h: Hit) => Number.isFinite(h.lat) && Number.isFinite(h.lon) && h.named)
          .filter((h: Hit) => !CLASSES[clue.kind] || CLASSES[clue.kind]!.includes(h.cls))
          .filter((h: Hit) => metres(centre, h) <= 40_000)
          // The exact name first ("Matterhorn", not "Matterhorngletscher"), then the
          // kind's main class (a summit before a glacier), then the nearest.
          .sort(
            (a: Hit, b: Hit) =>
              Number(b.exact) - Number(a.exact) ||
              classRank(clue.kind, a.cls) - classRank(clue.kind, b.cls) ||
              metres(centre, a) - metres(centre, b),
          );
        // A named church the search does not know: fall back to the register's churches.
        if (!hits.length && clue.kind === "church" && churches.length) {
          return { clue, points: churches, note: `"${clue.name}" not found; using the ${churches.length} church(es) in the register` };
        }
        return hits.length
          ? { clue, points: [hits[0]], note: `"${clue.name}" → ${hits[0].label}` }
          : { clue, points: [], note: `"${clue.name}" not found within 40 km` };
      } catch (err) {
        return { clue, points: [], note: `"${clue.name}" lookup failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Terrain: swisstopo profile service, two 50 m cross-sections per house.
// ---------------------------------------------------------------------------
function lv95(lat: number, lon: number): [number, number] {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3,
  ];
}

async function ends(a: [number, number], b: [number, number]): Promise<[number, number]> {
  const geom = JSON.stringify({ type: "LineString", coordinates: [a, b] });
  const j = await getJson(`${PROFILE}?geom=${encodeURIComponent(geom)}&sr=2056&nb_points=3`);
  const z = (q: any) => Number(q?.alts?.COMB ?? q?.alts?.DTM2 ?? q?.alts?.DTM25);
  const first = z(j[0]), last = z(j[j.length - 1]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) throw new Error("no height");
  return [first, last];
}

const terrainCache = new Map<string, Promise<Terrain | null>>();

export function terrainAt(lat: number, lon: number): Promise<Terrain | null> {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  let hit = terrainCache.get(key);
  if (!hit) {
    hit = (async () => {
      const [e, n] = lv95(lat, lon);
      const [w, east] = await ends([e - 25, n], [e + 25, n]);
      const [s, north] = await ends([e, n - 25], [e, n + 25]);
      const dzdx = (east - w) / 50, dzdy = (north - s) / 50;
      const grade = Math.hypot(dzdx, dzdy);
      // Downhill is against the gradient; 0° = north, clockwise.
      const downhill = grade > 0 ? ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360 : null;
      return { downhill, grade };
    })().catch(() => null);
    terrainCache.set(key, hit);
    void hit.then((t) => { if (!t) terrainCache.delete(key); });
  }
  return hit;
}

// Every house's score. Terrain is fetched in the order given (the caller's best
// guess first) until the time budget runs out; a house whose terrain is still
// missing is scored on its landmarks alone, or left unscored.
export async function scoreLocations<T extends { lat: number; lon: number }>(
  houses: T[],
  clues: LocationClues,
  landmarks: ResolvedLandmark[],
  budgetMs = 45_000,
): Promise<{ scores: Map<T, LocationScore>; terrainMeasured: number }> {
  const terrain = new Map<T, Terrain | null>();
  if (clues.slope) {
    const deadline = Date.now() + budgetMs;
    let next = 0;
    const worker = async () => {
      while (next < houses.length && Date.now() < deadline) {
        const h = houses[next++];
        terrain.set(h, await terrainAt(h.lat, h.lon));
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }
  const scores = new Map<T, LocationScore>();
  for (const h of houses) {
    const s = scoreHouse(h, clues, terrain.get(h), landmarks);
    if (s) scores.set(h, s);
  }
  return { scores, terrainMeasured: Array.from(terrain.values()).filter(Boolean).length };
}

// Ordering key: a better location first, in steps of 0.1 so that within a step
// the caller's own order (footprint closeness) still decides. Unscored houses
// sit at 0.5, between a fit and a misfit.
export function locationRank(s: LocationScore | undefined): number {
  return -Math.round((s?.score ?? 0.5) * 10);
}

// The model's clues, from record_signature's `location` field.
export function coerceLocation(v: unknown): LocationClues | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const conf = (x: unknown): ClueConfidence => (x === "sure" || x === "likely" || x === "guess" ? x : "guess");
  const dir = (x: unknown): Direction | undefined => {
    const d = String(x ?? "").trim().toUpperCase();
    return (DIRECTIONS as readonly string[]).includes(d) ? (d as Direction) : undefined;
  };
  const out: LocationClues = {};
  const sl = o.slope as Record<string, unknown> | undefined;
  if (sl && typeof sl === "object") {
    const faces = String(sl.faces ?? "").trim().toLowerCase() === "flat" ? "flat" : dir(sl.faces);
    if (faces) out.slope = { faces, confidence: conf(sl.confidence) };
  }
  if (Array.isArray(o.landmarks)) {
    const kinds = ["church", "peak", "lake", "place", "other"] as const;
    out.landmarks = o.landmarks
      .map((x) => (x ?? {}) as Record<string, unknown>)
      .flatMap((x): LandmarkClue[] => {
        const direction = dir(x.direction);
        const kind = (kinds as readonly string[]).includes(String(x.kind)) ? (x.kind as LandmarkClue["kind"]) : "other";
        const name = typeof x.name === "string" && x.name.trim() ? x.name.trim() : undefined;
        const distanceM = typeof x.distance_m === "number" && x.distance_m > 0 ? x.distance_m : undefined;
        // Without a direction, only a named place at a stated distance says anything.
        if (!direction && !(name && distanceM)) return [];
        return [{ kind, name, direction, distanceM, confidence: conf(x.confidence) }];
      })
      .slice(0, 8);
    if (!out.landmarks.length) delete out.landmarks;
  }
  const nb = coerceNeighbours(o.neighbours);
  if (nb.length) out.neighbours = nb;
  return out.slope || out.landmarks?.length || out.neighbours?.length ? out : undefined;
}

export function cluesText(c: LocationClues): string {
  const parts: string[] = [];
  if (c.slope) parts.push(`slope falls ${c.slope.faces === "flat" ? "nowhere (flat)" : `to the ${c.slope.faces}`} (${c.slope.confidence})`);
  for (const l of c.landmarks ?? [])
    parts.push(`${l.name ?? l.kind}${l.direction ? ` to the ${l.direction}` : ""}${l.distanceM ? ` ~${l.distanceM} m` : ""} (${l.confidence})`);
  return parts.join("; ");
}
