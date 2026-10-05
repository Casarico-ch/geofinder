// =============================================================================
// neighbours — find the house by the houses around it.
//
// A house alone is hard to tell from its look-alikes; the buildings next to it
// are not. The photos often show them: a long flat-roofed block on one side, a
// small pitched-roof house behind, an open field on the other. swissBUILDINGS3D
// holds every building in Switzerland with its real outline, height and roof,
// so each candidate's neighbourhood can be compared with what the photos show.
//
// The photos rarely say north, so a clue may give its side relative to the
// house as photographed ("left", "behind"); the pattern is then tried in all 8
// orientations and the best kept. Like every location clue, this only ORDERS
// the shortlist: a misread photo costs places, never the house.
// =============================================================================
import { findDxfHref, getTileBuildings, wgs84ToLv95, type Building } from "./roofs";
import { DIRECTIONS, angleDiff, type ClueConfidence, type Direction } from "./locate";

export type Side = Direction | "left" | "right" | "behind" | "front";

/** One building (or its absence) the photos show next to the house. */
export interface NeighbourClue {
  side?: Side; // where it stands from the house: a compass point, or as seen in the photo
  distanceM?: number; // the gap between the two buildings, roughly
  size?: "smaller" | "similar" | "bigger"; // its footprint against the house's
  height?: "lower" | "similar" | "taller";
  roof?: "flat" | "pitched";
  ridge?: "parallel" | "perpendicular"; // its ridge against the house's ridge
  none?: boolean; // true: NO building on that side (open field, road, lake)
  confidence: ClueConfidence;
}

/** A building as the neighbourhood check reads it (LV95 metres). */
export interface Shape {
  x: number;
  y: number;
  areaM2: number; // footprint (convex hull)
  heightM: number;
  flat: boolean; // roof slopes under ~10°
  axisDeg: number; // the long axis (0-180, from north): the ridge of a pitched roof
}

const WEIGHT: Record<ClueConfidence, number> = { sure: 1, likely: 0.6, guess: 0.3 };
const DEG: Record<Direction, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const RADIUS = 90; // metres around a house that count as its neighbourhood

// ---- shapes from swissBUILDINGS3D ----

function hull(points: number[][]): number[][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [], upper: number[][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function shapeOf(b: Building): Shape | null {
  const all = b.faces.flat();
  if (all.length < 3) return null;
  const zs = all.map((v) => v[2]);
  const zmin = Math.min(...zs), zmax = Math.max(...zs);
  const h = hull(all.map((v) => [v[0], v[1]]));
  let area = 0;
  for (let i = 0; i < h.length; i++) {
    const [x1, y1] = h[i], [x2, y2] = h[(i + 1) % h.length];
    area += x1 * y2 - x2 * y1;
  }
  area = Math.abs(area) / 2;
  if (area < 15) return null; // garden sheds and the like
  // The long axis: the hull edge direction that the outline is longest along.
  let axisDeg = 0, best = -1;
  for (let i = 0; i < h.length; i++) {
    const [x1, y1] = h[i], [x2, y2] = h[(i + 1) % h.length];
    const ang = ((Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI + 180) % 180;
    const rad = (ang * Math.PI) / 180;
    const proj = h.map(([x, y]) => x * Math.sin(rad) + y * Math.cos(rad));
    const len = Math.max(...proj) - Math.min(...proj);
    if (len > best) {
      best = len;
      axisDeg = ang;
    }
  }
  // A roof face: not a wall, above the ground. Flat when none slopes over ~10°.
  let steepest = 0;
  for (const f of b.faces) {
    if (f.length < 3) continue;
    const [a, c, d] = f;
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len) continue;
    const nz = Math.abs(n[2]) / len;
    const zAvg = f.reduce((s, p) => s + p[2], 0) / f.length;
    if (nz < 0.2 || zAvg < zmin + 2) continue; // walls, ground
    steepest = Math.max(steepest, (Math.acos(Math.min(1, nz)) * 180) / Math.PI);
  }
  return { x: b.cx, y: b.cy, areaM2: area, heightM: zmax - zmin, flat: steepest < 10, axisDeg };
}

// Tiles cover ~4×3 km; each is fetched once per process (roofs.ts caches it).
const hrefCache = new Map<string, Promise<string | null>>();
function tileFor(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let p = hrefCache.get(key);
  if (!p) {
    p = findDxfHref(lat, lon).catch(() => null);
    hrefCache.set(key, p);
  }
  return p;
}
const shapeCache = new Map<string, Promise<Shape[]>>();
function shapesOf(href: string): Promise<Shape[]> {
  let p = shapeCache.get(href);
  if (!p) {
    p = getTileBuildings(href)
      .then((bs) => bs.map(shapeOf).filter((s): s is Shape => !!s))
      .catch(() => []);
    shapeCache.set(href, p);
  }
  return p;
}

/** The house at a point and the buildings within RADIUS of it (null when the 3D data has no building there). */
export async function neighbourhoodAt(lat: number, lon: number): Promise<{ house: Shape; around: Shape[] } | null> {
  const href = await tileFor(lat, lon);
  if (!href) return null;
  const shapes = await shapesOf(href);
  const { E, N } = wgs84ToLv95(lat, lon);
  let house: Shape | null = null, d0 = 25;
  for (const s of shapes) {
    const d = Math.hypot(s.x - E, s.y - N);
    if (d < d0) {
      d0 = d;
      house = s;
    }
  }
  if (!house) return null;
  const h = house;
  const around = shapes.filter((s) => s !== h && Math.hypot(s.x - h.x, s.y - h.y) <= RADIUS);
  return { house: h, around };
}

// ---- matching ----

const bearingOf = (from: Shape, to: Shape) => ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360;
// The gap between two buildings, roughly: centre distance minus their half sizes.
const gapOf = (a: Shape, b: Shape) => Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - Math.sqrt(a.areaM2) / 2 - Math.sqrt(b.areaM2) / 2);

// The side's compass bearing when the photographed front faces `front`.
function sideBearing(side: Side, front: number): number {
  if ((DIRECTIONS as readonly string[]).includes(side)) return DEG[side as Direction];
  // The viewer stands in front looking at the house: their left is the front turned +90°.
  const turn = { front: 0, behind: 180, left: 90, right: 270 }[side as "front" | "behind" | "left" | "right"];
  return (front + turn) % 360;
}

function fitOne(c: NeighbourClue, house: Shape, around: Shape[], front: number): number {
  const dir = c.side ? sideBearing(c.side, front) : null;
  const near = around.filter((n) => (dir == null || angleDiff(bearingOf(house, n), dir) <= 50) && gapOf(house, n) <= Math.max(40, (c.distanceM ?? 25) * 2));
  if (c.none) return near.length === 0 ? 1 : 0;
  let best = 0;
  for (const n of near) {
    let got = 0, of = 0;
    if (c.distanceM != null) {
      of++;
      const err = Math.abs(gapOf(house, n) - c.distanceM);
      got += err <= Math.max(5, c.distanceM * 0.4) ? 1 : err <= Math.max(10, c.distanceM) ? 0.5 : 0;
    }
    if (c.size) {
      of++;
      const r = n.areaM2 / house.areaM2;
      // One-sided: "smaller" is anything clearly smaller, however much; near
      // the boundary a misjudged size still earns half.
      got +=
        c.size === "smaller" ? (r < 0.8 ? 1 : r < 1.05 ? 0.5 : 0)
        : c.size === "bigger" ? (r > 1.25 ? 1 : r > 0.95 ? 0.5 : 0)
        : r >= 0.7 && r <= 1.4 ? 1 : r >= 0.5 && r <= 2 ? 0.5 : 0;
    }
    if (c.height) {
      of++;
      const d = n.heightM - house.heightM;
      got +=
        c.height === "lower" ? (d < -1.5 ? 1 : d < 0.5 ? 0.5 : 0)
        : c.height === "taller" ? (d > 1.5 ? 1 : d > -0.5 ? 0.5 : 0)
        : Math.abs(d) <= 2.5 ? 1 : Math.abs(d) <= 5 ? 0.5 : 0;
    }
    if (c.roof) { of++; if ((c.roof === "flat") === n.flat) got++; }
    if (c.ridge && !house.flat && !n.flat) {
      of++;
      const a = angleDiff(n.axisDeg, house.axisDeg) % 180;
      const diff = Math.min(a, 180 - a);
      if ((c.ridge === "parallel" && diff <= 25) || (c.ridge === "perpendicular" && diff >= 65)) got++;
    }
    best = Math.max(best, of ? got / of : 1);
  }
  return best;
}

/**
 * How well a house's surroundings fit the neighbours the photos show, 0..1
 * (null without usable clues or 3D data). Relative sides are tried in all 8
 * orientations of the photographed front; compass sides are fixed.
 */
export function neighbourFit(
  clues: NeighbourClue[],
  nb: { house: Shape; around: Shape[] },
): { score: number; why: string } | null {
  if (!clues.length) return null;
  const relative = clues.some((c) => c.side && !(DIRECTIONS as readonly string[]).includes(c.side));
  const fronts = relative ? [0, 45, 90, 135, 180, 225, 270, 315] : [0];
  let best = { score: -1, parts: [] as number[] };
  for (const f of fronts) {
    const parts = clues.map((c) => fitOne(c, nb.house, nb.around, f));
    const total = clues.reduce((s, c) => s + WEIGHT[c.confidence], 0);
    const score = clues.reduce((s, c, i) => s + WEIGHT[c.confidence] * parts[i], 0) / total;
    if (score > best.score) best = { score, parts };
  }
  const seen = best.parts.filter((p) => p >= 0.75).length;
  return { score: best.score, why: `neighbours ${seen}/${clues.length} fit` };
}

/** The model's neighbour clues, from record_signature's location.neighbours. */
export function coerceNeighbours(v: unknown): NeighbourClue[] {
  if (!Array.isArray(v)) return [];
  const sides = [...DIRECTIONS, "left", "right", "behind", "front"];
  const pick = <T extends string>(x: unknown, opts: readonly T[]): T | undefined =>
    opts.includes(String(x ?? "").trim() as T) ? (String(x).trim() as T) : undefined;
  return v
    .map((x) => (x ?? {}) as Record<string, unknown>)
    .map((x): NeighbourClue => ({
      side: pick(String(x.side ?? "").toUpperCase().length <= 2 ? String(x.side ?? "").toUpperCase() : String(x.side ?? "").toLowerCase(), sides as readonly Side[]),
      distanceM: typeof x.distance_m === "number" && x.distance_m >= 0 ? x.distance_m : undefined,
      size: pick(x.size, ["smaller", "similar", "bigger"] as const),
      height: pick(x.height, ["lower", "similar", "taller"] as const),
      roof: pick(x.roof, ["flat", "pitched"] as const),
      ridge: pick(x.ridge, ["parallel", "perpendicular"] as const),
      none: x.none === true,
      confidence: pick(x.confidence, ["sure", "likely", "guess"] as const) ?? "guess",
    }))
    .filter((c) => c.none || c.size || c.height || c.roof || c.ridge || c.distanceM != null)
    .slice(0, 6);
}
