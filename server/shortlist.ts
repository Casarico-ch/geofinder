// =============================================================================
// shortlist — code-enforced, RECALL-FIRST candidate generation.
//
// The finder kept dropping the truth at the filter step: it matched floors
// EXACTLY (2, when the register counts the attic as a 3rd level) and filtered
// on construction ERA (it read "16th century" and excluded a house the register
// dates 1961-70). The prompt told it not to — it did anyway. So the safe
// filtering lives here, in code, where it can't be rationalised away:
//   - floors are a ±1 RANGE around the estimate, never exact,
//   - footprint is a WIDE band,
//   - era is NOT a parameter at all,
//   - attached/detached is decided by shared-wall geometry, not eyeballing.
// The result is a shortlist that still contains the target; view_candidates,
// render_roofs + the eyeball then narrow it. Geneva comes from SITG (footprint
// polygons, so attached/detached is measured); every other canton from the
// federal building register (gwr.ts) — no footprint geometry there, so
// `attached` is unknown, but floors/dwellings/footprint follow the same rules.
// =============================================================================
import { fetchCommuneBuildings, resolveCommune, type Commune, type GwrBuilding } from "./gwr";
import {
  cluesText,
  hasClues,
  locationRank,
  resolveLandmarks,
  scoreLocations,
  type LocationClues,
  type LocationScore,
} from "./locate";

interface RawBuilding {
  egid: number;
  niv: number | null;
  surf: number | null;
  dest: string;
  rings: number[][][]; // [ring][vertex][lon,lat]
  lon: number;
  lat: number;
}
export interface Candidate {
  egid: number;
  lat: number;
  lon: number;
  footprintM2: number | null;
  floors: number | null;
  attached: boolean | null; // null: unknown (the register has no footprint geometry)
  dwellings?: number | null;
  address?: string | null;
  loc?: LocationScore; // how well its surroundings fit the photos' location clues
}
export interface ShortlistResult {
  commune: string;
  bfs?: number;
  supported: boolean;
  enumerated: number;
  residential: number;
  survivors: number;
  truncatedTo?: number;
  candidates: Candidate[];
  note: string;
}

async function fetchJson(url: string, ms = 60_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await (await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } })).json();
  } finally {
    clearTimeout(t);
  }
}

function centroid(rings: number[][][]): [number, number] {
  const pts = rings[0] ?? [];
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / (pts.length || 1), y / (pts.length || 1)];
}

function pointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Minimum edge distance in metres between two footprints (~0 ⇒ shared wall).
function minEdgeMetres(a: number[][], b: number[][]): number {
  if (!a.length || !b.length) return Infinity;
  const kx = 111320 * Math.cos((a[0][1] * Math.PI) / 180), ky = 111320;
  const A = a.map((p) => [p[0] * kx, p[1] * ky]);
  const B = b.map((p) => [p[0] * kx, p[1] * ky]);
  let min = Infinity;
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length];
      const d = Math.min(
        pointSeg(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]),
        pointSeg(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]),
        pointSeg(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]),
        pointSeg(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1]),
      );
      if (d < min) min = d;
    }
  }
  return min;
}

// Pull every building in a Geneva commune from SITG (returns [] if not GE).
async function fetchGenevaBuildings(commune: string): Promise<RawBuilding[]> {
  const base = "https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/MapServer/0/query";
  const where = encodeURIComponent(`UPPER(COMMUNE)='${commune.toUpperCase().replace(/'/g, "''")}'`);
  const url =
    `${base}?where=${where}&outFields=EGID,NIVEAUX_HORSOL,SURFACE,DESTINATION&returnGeometry=true&outSR=4326&f=json&resultRecordCount=3000`;
  const j = await fetchJson(url);
  const out: RawBuilding[] = [];
  for (const f of j.features ?? []) {
    const g = f.geometry;
    if (!g?.rings) continue;
    const [lon, lat] = centroid(g.rings);
    out.push({
      egid: f.attributes.EGID,
      niv: f.attributes.NIVEAUX_HORSOL ?? null,
      surf: f.attributes.SURFACE ?? null,
      dest: f.attributes.DESTINATION ?? "",
      rings: g.rings,
      lon,
      lat,
    });
  }
  return out;
}

export interface ShortlistOptions {
  commune: string;
  floors?: number;
  footprintM2?: number;
  attached?: boolean;
  dwellings?: number;
  maxResults?: number;
  // Rank survivors by distance from this point instead of by footprint.
  near?: { lat: number; lon: number };
  // EGIDs already on the run's checklist; only consulted past the cap.
  known?: ReadonlySet<string>;
  // The photos' location clues (record_signature): survivors whose slope and
  // landmarks fit come first. Ordering only; `near`, when given, wins.
  location?: LocationClues;
}

// Floors and dwellings are matched as a ±1 RANGE (unknown passes); the
// footprint as a wide band. Era is never a parameter.
export function inRange(v: number | null, est: number | undefined, lo: number, hi: number): boolean {
  if (v == null || typeof est !== "number") return true;
  return v >= est - lo && v <= est + hi;
}
export function inBand(v: number | null, est: number | undefined): boolean {
  if (v == null || typeof est !== "number" || est <= 0) return true;
  return v >= est * 0.55 && v <= est * 1.7;
}

// Closeness of a footprint to the estimate, for ranking. An unknown footprint
// ranks last: the old comparator returned 0 for it ("equal to everything"),
// which is not a consistent order, and the sort scattered the list — Zermatt's
// house, 3rd by footprint, came out 196th of 307, outside the first batch.
export function footprintKey(v: number | null, est: number | undefined): number {
  if (typeof est !== "number" || est <= 0) return 0;
  return v == null ? 1e9 : Math.abs(v - est);
}

// The survivors one call returns. Within the cap: all of them, in rank order,
// exactly as before. Past it (Zermatt: 580 survivors, 150 per call) every call
// used to return the same closest-by-footprint slice, so re-shortlisting
// re-listed houses already on the checklist and the rest were never seen.
// Now the ones not on the checklist come first, so repeated calls page
// through every survivor; nothing is dropped.
function pickPage<T>(
  ranked: T[],
  max: number,
  egidOf: (t: T) => string,
  known: ReadonlySet<string> | undefined,
): { page: T[]; again: boolean; unseenLeft: number } {
  if (ranked.length <= max) return { page: ranked, again: false, unseenLeft: 0 };
  const isNew = (t: T) => !known?.has(egidOf(t));
  const fresh = ranked.filter(isNew);
  const page = [...fresh, ...ranked.filter((t) => !isNew(t))].slice(0, max);
  return { page, again: fresh.length < ranked.length, unseenLeft: Math.max(0, fresh.length - max) };
}

function metresBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return Math.hypot((a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (a.lat - b.lat) * 111320);
}

// Most first calls overflow the cap (120 by default, 40 in Geneva) and runs
// that find their house usually do it from that first batch, so the first call
// keeps its old wording. Paging and `near` are offered only when the run comes
// back for more of a commune it already has on its checklist.
function capNote(max: number, again: boolean, unseenLeft: number, near?: { lat: number; lon: number }): string {
  if (!again && !near) return ` (showing the ${max} closest by footprint)`;
  const order = near ? `closest to ${near.lat.toFixed(5)},${near.lon.toFixed(5)}` : "closest by footprint";
  return (
    ` (showing ${max}, ${order}, the ones not yet on your checklist first). ` +
    (unseenLeft > 0
      ? `${unseenLeft} more survivors are not on your checklist yet: call again with the same estimates for the next batch — nothing is dropped. `
      : `Every survivor of these estimates is now on your checklist. `) +
    `To check the likeliest area first, pass near: {lat, lon} — the point your LOCATIONAL clues put the house near (which way the slope and the view face, the bearing of a landmark in the photos, distances to amenities) — and survivors come back closest to it first`
  );
}

export async function shortlistBuildings(opts: ShortlistOptions): Promise<ShortlistResult> {
  const commune = opts.commune.trim();
  const resolved = await resolveCommune(commune);
  if (resolved && resolved.canton !== "GE") return shortlistFromRegister(resolved, opts);
  const geneva = await shortlistGeneva({ ...opts, commune: resolved?.name ?? commune });
  if (resolved) geneva.bfs = resolved.bfs;
  return geneva;
}

// Every canton but Geneva: the federal building register.
async function shortlistFromRegister(c: Commune, opts: ShortlistOptions): Promise<ShortlistResult> {
  const max = Math.min(150, Math.max(5, opts.maxResults ?? 120));
  const all = await fetchCommuneBuildings(c);
  const residential = all.filter(
    (b) => (b.status == null || b.status === 1004) && (b.category == null || (b.category >= 1020 && b.category < 1060)),
  );
  const survivors = residential
    .filter((b) => inRange(b.floors, opts.floors, 1, 1))
    .filter((b) => inRange(b.dwellings, opts.dwellings, 1, 1))
    .filter((b) => inBand(b.footprintM2, opts.footprintM2))
    .sort((x, y) => {
      if (opts.near) return metresBetween(x, opts.near) - metresBetween(y, opts.near);
      return footprintKey(x.footprintM2, opts.footprintM2) - footprintKey(y.footprintM2, opts.footprintM2);
    });
  const located = await orderByLocation(survivors, (b) => b, opts, all);
  const { page: top, again, unseenLeft } = pickPage(located.ranked, max, (b) => String(Number(b.egid)), opts.known);
  return {
    commune: c.name,
    bfs: c.bfs,
    supported: true,
    enumerated: all.length,
    residential: residential.length,
    survivors: survivors.length,
    truncatedTo: survivors.length > max ? max : undefined,
    candidates: top.map((b) => ({
      egid: Number(b.egid),
      lat: b.lat,
      lon: b.lon,
      footprintM2: b.footprintM2,
      floors: b.floors,
      attached: null,
      dwellings: b.dwellings,
      address: b.address,
      loc: located.scores.get(b),
    })),
    note:
      `${c.name}: enumerated ${all.length} buildings from the federal register, ${residential.length} residential, ${survivors.length} passed the recall-first filters` +
      (survivors.length > max ? capNote(max, again, unseenLeft, opts.near) : "") +
      located.note +
      `. Floors${typeof opts.dwellings === "number" ? " and dwellings" : ""} matched as a ±1 range, footprint as a wide band, era NOT filtered.` +
      (typeof opts.attached === "boolean" ? " attached/detached is not in the register here — ignored; judge it on the aerial." : "") +
      ` Now look at them with view_candidates and record each verdict with mark_candidates — do NOT re-filter them by era or exact floors.`,
  };
}

// Geneva: SITG footprints (with attached/detached from shared walls).
async function shortlistGeneva(opts: ShortlistOptions): Promise<ShortlistResult> {
  const commune = opts.commune.trim();
  const max = Math.min(60, Math.max(5, opts.maxResults ?? 40));
  const all = await fetchGenevaBuildings(commune);
  if (all.length === 0) {
    return {
      commune,
      supported: false,
      enumerated: 0,
      residential: 0,
      survivors: 0,
      candidates: [],
      note: `No commune "${commune}" was found — not in the Swiss commune register, and no buildings in the Geneva (SITG) cadastre. Check the spelling (the official name, e.g. "Saint-Sulpice (VD)") and call again.`,
    };
  }
  const residential = all.filter((b) => b.dest.startsWith("Habitation"));
  // Soft, recall-first filters. Floors are a RANGE; era is never touched.
  let survivors = residential;
  if (typeof opts.floors === "number") {
    survivors = survivors.filter((b) => b.niv == null || (b.niv >= opts.floors! - 1 && b.niv <= opts.floors! + 1));
  }
  if (typeof opts.footprintM2 === "number" && opts.footprintM2 > 0) {
    const lo = opts.footprintM2 * 0.55, hi = opts.footprintM2 * 1.7;
    survivors = survivors.filter((b) => b.surf == null || (b.surf >= lo && b.surf <= hi));
  }
  // Attached test needs neighbours; compute against the full residential set.
  const withAttach = survivors.map((b) => {
    let attached = false;
    for (const o of residential) {
      if (o.egid === b.egid) continue;
      if (Math.hypot((o.lon - b.lon) * 78000, (o.lat - b.lat) * 111320) > 40) continue; // cheap prefilter
      if (minEdgeMetres(b.rings[0], o.rings[0]) < 1.5) { attached = true; break; }
    }
    return { b, attached };
  });
  let filtered = withAttach;
  if (typeof opts.attached === "boolean") {
    filtered = withAttach.filter((x) => x.attached === opts.attached);
  }
  // Rank by footprint closeness (the most reliable signal) so the best matches
  // come first, but do NOT hard-drop — recall over precision.
  const sorted = filtered.sort((x, y) => {
    if (opts.near) return metresBetween(x.b, opts.near) - metresBetween(y.b, opts.near);
    return footprintKey(x.b.surf, opts.footprintM2) - footprintKey(y.b.surf, opts.footprintM2);
  });
  // Churches for the location clues come from the federal register (SITG has no building class).
  const register = async () => {
    const c = await resolveCommune(commune);
    return c ? fetchCommuneBuildings(c) : [];
  };
  const located = await orderByLocation(sorted, (x) => x.b, opts, register);
  const ranked = located.ranked;
  const survivorsCount = ranked.length;
  const { page: top, again, unseenLeft } = pickPage(ranked, max, (x) => String(x.b.egid), opts.known);
  const candidates: Candidate[] = top.map((x) => ({
    egid: x.b.egid,
    lat: x.b.lat,
    lon: x.b.lon,
    footprintM2: x.b.surf,
    floors: x.b.niv,
    attached: x.attached,
    loc: located.scores.get(x),
  }));
  return {
    commune,
    supported: true,
    enumerated: all.length,
    residential: residential.length,
    survivors: survivorsCount,
    truncatedTo: survivorsCount > max ? max : undefined,
    candidates,
    note:
      `Enumerated ${all.length} buildings, ${residential.length} residential, ${survivorsCount} passed the recall-first filters` +
      (survivorsCount > max ? capNote(max, again, unseenLeft, opts.near) : "") +
      located.note +
      `. Floors matched as a ±1 range; era was NOT filtered. Now look at them with view_candidates (and render_roofs for roof shape), record each verdict with mark_candidates — do NOT re-filter these by era or exact floors.`,
  };
}

// Survivors re-ordered by the photos' location clues: the location order (best
// fit first, footprint closeness within a fit step) merged with the footprint
// order, see interleave. Nothing is dropped. `near` and missing clues leave the
// order untouched.
async function orderByLocation<T>(
  survivors: T[],
  point: (t: T) => { lat: number; lon: number },
  opts: ShortlistOptions,
  buildings: GwrBuilding[] | (() => Promise<GwrBuilding[]>),
): Promise<{ ranked: T[]; scores: Map<T, LocationScore>; note: string }> {
  const scores = new Map<T, LocationScore>();
  if (opts.near || !hasClues(opts.location) || survivors.length === 0) return { ranked: survivors, scores, note: "" };
  const clues = opts.location;
  try {
    const pts = survivors.map(point);
    const centre = {
      lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
      lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
    };
    const needsRegister = (clues.landmarks ?? []).some((l) => l.kind === "church");
    const all = Array.isArray(buildings) ? buildings : needsRegister ? await buildings() : [];
    const landmarks = await resolveLandmarks(clues.landmarks ?? [], centre, all);
    const wrapped = survivors.map((t) => ({ t, ...point(t) }));
    const { scores: byHouse, terrainMeasured } = await scoreLocations(wrapped, clues, landmarks);
    for (const w of wrapped) {
      const sc = byHouse.get(w);
      if (sc) scores.set(w.t, sc);
    }
    const index = new Map(survivors.map((t, i) => [t, i]));
    const byLocation = [...survivors].sort(
      (a, b) => locationRank(scores.get(a)) - locationRank(scores.get(b)) || index.get(a)! - index.get(b)!,
    );
    const ranked = interleave(byLocation, survivors, mergeRatio(clues));
    const resolved = landmarks.map((l) => l.note).join("; ");
    const terrainNote = clues.slope ? ` Terrain measured for ${terrainMeasured}/${survivors.length}.` : "";
    return {
      ranked,
      scores,
      note:
        `. Ordered by your location clues (${cluesText(clues)}) mixed with footprint order — ordering only, every survivor is still on the list.` +
        terrainNote +
        (resolved ? ` Landmarks: ${resolved}.` : ""),
    };
  } catch (err) {
    return { ranked: survivors, scores, note: `. Location clues could not be applied (${err instanceof Error ? err.message : String(err)}); footprint order kept` };
  }
}

// A misread clue must not bury the house. The two orders are merged in turns —
// `take[0]` houses from the location order, then `take[1]` from the footprint
// order — so a house's place is at most about (take[0] + take[1]) / take[1]
// times its place in the footprint order, whatever the clues say, while a right
// clue still brings it well forward. Zermatt with rough estimates (~300
// survivors), the answer's place: footprint order #108; right slope clue #27
// with the location order alone, #40 merged; a wrong one off the first 150
// alone, within about 2x merged (scripts/try-locate.ts).
export function interleave<T>(primary: T[], fallback: T[], take: [number, number]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  let i = 0, j = 0;
  const next = (list: T[], at: number): number => {
    while (at < list.length && seen.has(list[at])) at++;
    return at;
  };
  while (out.length < primary.length) {
    for (let k = 0; k < take[0] && (i = next(primary, i)) < primary.length; k++) { seen.add(primary[i]); out.push(primary[i]); }
    for (let k = 0; k < take[1] && (j = next(fallback, j)) < fallback.length; k++) { seen.add(fallback[j]); out.push(fallback[j]); }
    if (next(primary, i) >= primary.length && next(fallback, j) >= fallback.length) break;
  }
  return out;
}

// How far the clues may reorder, by the strongest clue's confidence: a sure
// clue at most triples a house's place, a likely one doubles it, a guess 1.5×.
function mergeRatio(c: LocationClues): [number, number] {
  const all = [c.slope?.confidence, ...(c.landmarks ?? []).map((l) => l.confidence)];
  return all.includes("sure") ? [2, 1] : all.includes("likely") ? [1, 1] : [1, 2];
}
