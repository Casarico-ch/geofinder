// =============================================================================
// proof — what makes an exact address EARNED, checked in code.
//
// Zermatt (radar-6664063) got three different "building"-sure answers in three
// runs. The house that fits every fact (Gryfelblatte 58: 1 dwelling, 3 floors,
// plot 330.8 m² for a listing of 331 m²) was rejected at a glance as "no" or
// "small" in four runs, while Riedweg 89 (2 dwellings, plot 427 m²) was claimed
// and then "confirmed" by a cross-check. The prompt already said that building
// confidence is earned; nothing checked it. This module is that check:
//   - listingFacts: the hard numbers the listing itself states,
//   - plotAt / plotByEgrid: the cadastral plot and its area (geo.admin.ch),
//   - factRows: listing vs building, each row match / mismatch / unknown,
//   - strongFit: a candidate whose register facts all fit, which therefore may
//     not be rejected from a contact-sheet glance.
// =============================================================================

import type { Flat } from "./gwr";

const API = "https://api3.geo.admin.ch/rest/services/api/MapServer";
const PLOT_LAYER = "ch.kantone.cadastralwebmap-farbe";

export interface ListingFacts {
  landM2: number | null; // "Land area m²: 331"
  /**
   * Other plot sizes the description gives: a plot being divided is sold "on
   * 400 m²" while the register still holds the whole "parcelle de plus de
   * 1'300 m²" (Vallamand, 05.10: all three runs found the house and the 400 m²
   * check refused it).
   */
  landAltM2: number[];
  livingM2: number | null; // "Living area m²: 236"
  /** 1 for a single house; null when the listing does not pin it (flats, multi-family). */
  dwellings: number | null;
  /** Condominium (PPE / STWE): the stated land is a share, so it is not a plot area. */
  sharedLand: boolean;
  rooms: number | null; // "Rooms: 3.5"
  /** The flat's storey, 0 = ground floor ("im 5. Obergeschoss" = 5); flats only. */
  floor: number | null;
  /** What is for sale: one house, one flat, or a whole building (its living area is the building's). */
  kind: "house" | "flat" | "building" | null;
  year: number | null; // "Year built: 1985"
  units: number | null; // "Units in building: 8"
  postcode: number | null; // "Postcode: 1991" — within a merged commune it names the village
  /** Sold before it is built or just finished: renderings, "Neubau", "neuf", a move-in date. */
  newBuild: boolean;
}

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/['’\s]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The numbers a listing states about itself (Radar's structured lines first). */
export function listingFacts(text: string | undefined): ListingFacts {
  const t = text ?? "";
  const line = (re: RegExp) => t.match(re)?.[1];
  const landM2 = num(line(/^Land area m²:\s*([\d'’.,\s]+)$/im));
  const livingM2 = num(line(/^Living area m²:\s*([\d'’.,\s]+)$/im));
  const landAltM2 = Array.from(
    t.matchAll(
      /\b(?:parcelle|terrain|Grundstück\w*|Parzelle|Landfläche|plot|land|lot|fondo|terreno)\b[^.\n\d]{0,40}?(\d{1,3}(?:['’ ,]\d{3})+|\d{3,6})\s*m(?:²|2)(?!\w)/gi,
    ),
    (m) => num(m[1].replace(/[',’ ]/g, "")),
  ).filter((n): n is number => n != null && n >= 100 && n !== landM2);
  const type = `${line(/^Type:\s*(.+)$/im) ?? ""} ${line(/^Category:\s*(.+)$/im) ?? ""} ${line(/^Subtype:\s*(.+)$/im) ?? ""}`.toLowerCase().replace(/_/g, " "); // "semi_detached_house"
  const sharedLand = /\b(?:PPE|copropri[ée]t[ée]|Stockwerkeigentum|STWE|condominio)\b/i.test(t);
  const multi =
    /multi|immeuble|mehrfamilien|rendite|investment|apartment building|plurifamiliale/.test(type) ||
    /\b(?:deux|trois|quatre|2|3|4)\s+(?:logements|appartements|Wohnungen|unités)\b/i.test(t);
  const house = /\bhouse\b|maison|villa|chalet|einfamilienhaus|\bhaus\b/.test(type);
  const rooms = num(line(/^Rooms:\s*([\d.,]+)$/im));
  const building = /\bbuilding\b|multi[ -]family|immeuble|mehrfamilien|rendite|investment|plurifamiliale/.test(type);
  const flat = /apartment|appartement|wohnung|duplex|attique|attika|penthouse|loft|maisonette/.test(type);
  const kind = building ? "building" : house && !multi ? "house" : flat ? "flat" : null;
  const year = num(line(/^Year built:\s*(\d{4})/im));
  const units = num(line(/^Units in (?:the )?building:\s*(\d+)/im));
  const postcode = num(line(/^Postcode:\s*(\d{4})\b/im));
  const thisYear = new Date().getFullYear();
  const newBuild =
    (year != null && year >= thisYear - 1) ||
    /^Condition:\s*new\b/im.test(t) ||
    // Phrases, not words: "un coup de neuf" (a fresh coat) is not a new build.
    /\b(?:neubau|neubauprojekt|erstbezug|im bau|ab plan|bezug (?:ab|per|im)|bezugsbereit|construction neuve|nouvelle construction|projet résidentiel|en construction|sur plan|livraison prévue|new[- ]build|under construction|off[- ]plan|renderings?|visualisierungen?|nuova costruzione)\b/i.test(t);
  return {
    landM2,
    landAltM2: Array.from(new Set(landAltM2)),
    livingM2,
    dwellings: house && !multi ? 1 : null,
    sharedLand,
    rooms,
    floor: house ? null : flatFloor(t),
    kind,
    year,
    units,
    postcode,
    newBuild,
  };
}

// "im 5. Obergeschoss", "5. OG", "5th floor", "5e étage", or Radar's "Floor: 5".
function flatFloor(t: string): number | null {
  const m =
    t.match(/^Floor:\s*(-?\d{1,2})\s*(?:e|er|re|ère|ème|e étage|\.|st|nd|rd|th|\.\s*OG|\.\s*Stock)?\s*$/im) ??
    t.match(/\b(\d{1,2})\.\s*(?:Obergeschoss|OG|Stock|Etage)\b/i) ??
    t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+floor\b/i) ??
    t.match(/\b(\d{1,2})(?:e|er|ème)\s+étage\b/i);
  return m ? Number(m[1]) : null;
}

export interface Plot {
  number: string;
  egrid: string | null;
  areaM2: number;
  bbox?: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

// Area of a [lon,lat] polygon in m², projected locally (exact enough for a plot).
function ringArea(ring: number[][]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring[0][1];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 111_320;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(s) / 2;
}

export function polygonAreaM2(geometry: { type: string; coordinates: any }): number {
  const polys: number[][][][] = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  return polys.reduce((sum, rings) => sum + ringArea(rings[0] ?? []) - rings.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);
}

async function getJson(url: string, ms = 20_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function toPlot(r: any): Plot | null {
  const p = r?.properties ?? r?.attributes ?? {};
  if (!p.number || !r.geometry) return null;
  return {
    number: String(p.number),
    egrid: p.egris_egrid ?? null,
    areaM2: Math.round(polygonAreaM2(r.geometry) * 10) / 10,
    bbox: bboxOf(r.geometry),
  };
}

function bboxOf(geometry: any): Plot["bbox"] {
  const pts: number[][] = [];
  const walk = (c: any) => (typeof c?.[0] === "number" ? pts.push(c) : (c ?? []).forEach(walk));
  walk(geometry?.coordinates);
  if (!pts.length) return undefined;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const samePlot = (a: Plot, b: Plot) => (a.egrid && b.egrid ? a.egrid === b.egrid : a.number === b.number && a.areaM2 === b.areaM2);

/** The plots around one (its bounding box, widened by about 5 m): its neighbours. */
export async function neighbourPlots(plot: Plot): Promise<Plot[]> {
  if (!plot.bbox) return [];
  const pad = 0.00005;
  const [x0, y0, x1, y1] = [plot.bbox[0] - pad, plot.bbox[1] - pad, plot.bbox[2] + pad, plot.bbox[3] + pad];
  try {
    const j = await getJson(
      `${API}/identify?geometry=${x0},${y0},${x1},${y1}&geometryType=esriGeometryEnvelope&layers=all:${PLOT_LAYER}&tolerance=0&sr=4326` +
        `&returnGeometry=true&geometryFormat=geojson&mapExtent=${x0},${y0},${x1},${y1}&imageDisplay=800,600,96&limit=30`,
    );
    return ((j.results ?? []) as unknown[]).map(toPlot).filter((p): p is Plot => !!p && !samePlot(p, plot));
  } catch {
    return [];
  }
}

/**
 * A property can be several plots: when the building's own plot is smaller
 * than the listing's land, try it with one neighbouring plot and keep
 * the sum closest to the listing. A group must match within 2% (a single plot
 * within 5%): with many neighbours, some sum lands near any number by chance.
 * Null when nothing fits.
 */
export async function plotGroupFor(own: Plot, landM2: number): Promise<Plot[] | null> {
  if (Math.abs(own.areaM2 - landM2) / landM2 <= PLOT_MATCH) return [own];
  if (own.areaM2 > landM2) return null;
  const near = (await neighbourPlots(own)).filter((p) => p.areaM2 < landM2).slice(0, 15);
  let best: { plots: Plot[]; off: number } | null = null;
  const consider = (plots: Plot[]) => {
    const off = Math.abs(plots.reduce((s, p) => s + p.areaM2, 0) - landM2) / landM2;
    if (off <= PLOT_DECISIVE && (!best || off < best.off)) best = { plots, off };
  };
  // Own plot plus ONE neighbour: with two, three small plots summed to a listed
  // 430 m² by chance in Sion (159 + 162 + 176) and drew a run away from the house.
  for (let i = 0; i < near.length; i++) consider([own, near[i]]);
  return best ? (best as { plots: Plot[] }).plots : null;
}

/**
 * Decisive: the listing's land matches these plots almost exactly (within 2%)
 * and no fact the register holds contradicts the building. Such an answer is
 * proven without settling every other candidate on the checklist: in a
 * 5-minute search that is what kept nine right picks from being answers.
 */
export function decisive(rows: FactRow[], plots: Plot[], landM2: number | null, landAltM2: number[] = []): boolean {
  // One plot only: several that add up are a lead, never proof on their own.
  if (landM2 == null || plots.length !== 1 || rows.some((r) => r.verdict === "mismatch")) return false;
  const total = plots.reduce((s, p) => s + p.areaM2, 0);
  return [landM2, ...landAltM2].some((a) => Math.abs(total - a) / a <= PLOT_DECISIVE);
}

const plotCache = new Map<string, Promise<Plot | null>>();
function cached(key: string, load: () => Promise<Plot | null>): Promise<Plot | null> {
  let hit = plotCache.get(key);
  if (!hit) {
    hit = load().catch(() => null);
    plotCache.set(key, hit);
    void hit.then((p) => { if (!p) plotCache.delete(key); });
  }
  return hit;
}

/** The plot under a point (a building's register point sits on its plot). */
export function plotAt(lat: number, lon: number): Promise<Plot | null> {
  return cached(`${lat.toFixed(6)},${lon.toFixed(6)}`, async () => {
    const d = 0.001;
    const j = await getJson(
      `${API}/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&layers=all:${PLOT_LAYER}&tolerance=0&sr=4326` +
        `&returnGeometry=true&geometryFormat=geojson&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=800,600,96`,
    );
    // A point on a boundary can hit two plots; the first is the one it lies in.
    return toPlot((j.results ?? [])[0]);
  });
}

/** A plot by its EGRID. */
export function plotByEgrid(egrid: string): Promise<Plot | null> {
  return cached(`egrid:${egrid}`, async () => {
    const j = await getJson(
      `${API}/find?layer=${PLOT_LAYER}&searchText=${encodeURIComponent(egrid)}&searchField=egris_egrid&returnGeometry=true&geometryFormat=geojson&sr=4326`,
    );
    return toPlot((j.results ?? [])[0]);
  });
}

export type FactVerdict = "match" | "mismatch" | "unknown";
export interface FactRow {
  fact: string; // "Plot area", "Homes in the building", "Living area"
  listing: string;
  building: string;
  verdict: FactVerdict;
  /** A mismatch that blocks an exact answer (not just one to explain). */
  hard?: boolean;
}

export interface BuildingFacts {
  floors: number | null;
  dwellings: number | null;
  footprintM2: number | null;
  /** Total area of the plot(s) the answer covers, with their numbers. */
  plots?: Plot[];
  /** The register's flats in this building (looked up for a close look and an answer only). */
  flats?: Flat[];
}

// Bands, wide on purpose: a register footprint is gross and outside the walls,
// a listed living area is net and counts an attic the register may not.
// 0.35: a 140 m² house the register gives 106 m² × 3 floors (basement and attic
// counted) is 0.44 and was refused (Vallamand, 05.10).
const LIVING_MIN = 0.35, LIVING_MAX = 1.35;
const PLOT_MATCH = 0.05, PLOT_CLOSE = 0.15, PLOT_DECISIVE = 0.02;
// A flat's register area is the same survey number the listing usually quotes;
// near-identical entrances differ by a few m² (Ruopigenring 85: 96 m², 89: 99 m²).
const FLAT_MATCH_M2 = 2, FLAT_CLOSE = 0.1;

/** Listing vs building, one row per fact both sides state. */
export function factRows(l: ListingFacts, b: BuildingFacts): FactRow[] {
  const rows: FactRow[] = [];
  if (l.dwellings != null) {
    rows.push({
      fact: "Homes in the building",
      listing: `${l.dwellings} (a single house)`,
      building: b.dwellings == null ? "not in the register" : String(b.dwellings),
      // The register often counts a granny flat or studio as a home of its own:
      // a single house listed with 2 or 3 homes is unclear, not a mismatch
      // (Dietlikonerstrasse 11, a detached house the register gives 3 homes).
      verdict:
        b.dwellings == null
          ? "unknown"
          : b.dwellings === l.dwellings
            ? "match"
            : l.dwellings === 1 && b.dwellings <= 3
              ? "unknown"
              : "mismatch",
    });
  }
  // Footprint × floors is the whole building: it stands for one home's living
  // area only in a single house, never for a flat in a block.
  if (l.livingM2 != null && l.dwellings === 1) {
    const gross = b.footprintM2 != null && b.floors != null ? b.footprintM2 * b.floors : null;
    const ratio = gross ? l.livingM2 / gross : null;
    rows.push({
      fact: "Living area",
      listing: `${l.livingM2} m²`,
      building: gross ? `${b.footprintM2} m² × ${b.floors} floors = ${gross} m²` : "footprint or floors not in the register",
      verdict: ratio == null ? "unknown" : ratio >= LIVING_MIN && ratio <= LIVING_MAX ? "match" : "mismatch",
    });
  }
  // A whole building for sale states the building's living area, not a flat's.
  if (l.livingM2 != null && l.dwellings !== 1 && l.kind !== "building" && b.flats) rows.push(flatRow(l, l.livingM2, b.flats));
  if (l.landM2 != null && !l.sharedLand) {
    const plots = b.plots ?? [];
    const total = plots.reduce((s, p) => s + p.areaM2, 0);
    // The closest of the land sizes the listing gives (the stated one, or one from the description).
    const off = plots.length ? Math.min(...[l.landM2, ...(l.landAltM2 ?? [])].map((a) => Math.abs(total - a) / a)) : null;
    // Several plots that add up are a lead, never a match on their own (shortlist.ts).
    const several = plots.length > 1;
    rows.push({
      fact: "Plot area",
      listing: `${l.landM2} m²${l.landAltM2?.length ? ` (description: ${l.landAltM2.join(" / ")} m²)` : ""}`,
      building: plots.length
        ? `${plots.map((p) => p.number).join(" + ")}: ${Math.round(total)} m²${several && off != null && off <= PLOT_MATCH ? " (two plots: possible, not proof; confirm the house in the photos)" : ""}`
        : "plot not found",
      verdict: off == null ? "unknown" : off <= PLOT_MATCH ? (several ? "unknown" : "match") : off <= PLOT_CLOSE ? "unknown" : "mismatch",
      hard: off != null && off > PLOT_CLOSE,
    });
  }
  return rows;
}

// Is the listed flat in this building? The register lists every flat with its
// storey, rooms (whole rooms: a listed 3.5 is 3) and area. Ruopigenring 81–91,
// six identical-looking entrances: only 81, 85 and 87 hold a 96 m² flat on the
// 5th floor, so a view match alone could not tell them apart and 89 was claimed.
function flatRow(l: ListingFacts, living: number, flats: Flat[]): FactRow {
  const storey = (f: number | null) => (f == null ? "?" : f === 0 ? "ground floor" : f < 0 ? `basement ${-f}` : `floor ${f}`);
  const roomsFit = (r: number | null) => l.rooms == null || r == null || r === Math.floor(l.rooms) || r === Math.ceil(l.rooms);
  const onFloor = flats.filter((f) => l.floor == null || f.floor == null || f.floor === l.floor);
  const off = (f: Flat) => (f.areaM2 == null ? Infinity : Math.abs(f.areaM2 - living));
  const exact = onFloor.filter((f) => roomsFit(f.rooms) && off(f) <= FLAT_MATCH_M2);
  const close = onFloor.filter((f) => roomsFit(f.rooms) && off(f) <= living * FLAT_CLOSE);
  const listing = [`${living} m²`, l.rooms != null ? `${l.rooms} rooms` : "", l.floor != null ? storey(l.floor) : ""].filter(Boolean).join(", ");
  const show = (fs: Flat[]) =>
    fs.slice(0, 6).map((f) => `${storey(f.floor)} ${f.areaM2 ?? "?"} m² ${f.rooms ?? "?"} rooms`).join("; ");
  const where = l.floor != null ? ` on ${storey(l.floor)}` : "";
  if (!flats.length) return { fact: "The flat", listing, building: "no flats in the register", verdict: "unknown" };
  if (exact.length) return { fact: "The flat", listing, building: `${exact.length} of ${flats.length} flats fit: ${show(exact)}`, verdict: "match" };
  return {
    fact: "The flat",
    listing,
    building: `no flat of ${living} m²${where} (of ${flats.length}): ${show(onFloor.length ? onFloor : flats) || "none there"}`,
    verdict: close.length ? "unknown" : "mismatch",
    // A flat for sale whose size no flat in the building comes within 10% of is
    // another building: 3 of the first 5 wrong practice answers had exactly this
    // mismatch and went through after one warning.
    hard: !close.length && l.kind === "flat",
  };
}

/**
 * Every fact the register can speak to fits, and at least one does: such a
 * candidate may not be dismissed from a 90 m contact-sheet tile.
 */
export function strongFit(rows: FactRow[]): boolean {
  return rows.some((r) => r.verdict === "match") && !rows.some((r) => r.verdict === "mismatch");
}

/** One line for the model: "fits: homes 1 ✓, living ✓, plot 1681 331 m² ✓". */
export function fitText(rows: FactRow[]): string {
  if (!rows.length) return "";
  const mark = (v: FactVerdict) => (v === "match" ? "✓" : v === "mismatch" ? "✗" : "?");
  return rows.map((r) => `${r.fact.toLowerCase()} ${r.building} ${mark(r.verdict)}`).join("; ");
}

/**
 * Fit facts for a shortlist page. The register facts are free; the plot (one
 * cadastre call each) is looked up only for candidates the register already
 * fits, at most `maxPlots` of them (Zermatt: 305 candidates, ~10 s).
 */
export async function annotateFit<
  T extends { lat: number; lon: number; floors: number | null; dwellings?: number | null; footprintM2: number | null },
>(l: ListingFacts, cands: T[], maxPlots = 100): Promise<(T & { strongFit: boolean; fit: string; plot?: Plot; plotGroup?: Plot[] })[]> {
  const out = cands.map((c) => {
    const rows = factRows(l, { floors: c.floors, dwellings: c.dwellings ?? null, footprintM2: c.footprintM2 });
    return { ...c, strongFit: strongFit(rows), fit: fitText(rows), plot: undefined as Plot | undefined, plotGroup: undefined as Plot[] | undefined };
  });
  if (l.landM2 == null || l.sharedLand) return out;
  const wanted = out.filter((c) => c.strongFit || !c.fit).slice(0, maxPlots);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const c = wanted[next++];
      const plot = await plotAt(c.lat, c.lon);
      if (!plot) continue;
      // Several plots can make one property: a smaller plot is tried with its neighbours.
      const group = await plotGroupFor(plot, l.landM2!);
      const rows = factRows(l, { floors: c.floors, dwellings: c.dwellings ?? null, footprintM2: c.footprintM2, plots: group ?? [plot] });
      Object.assign(c, { plot, plotGroup: group && group.length > 1 ? group : undefined, strongFit: strongFit(rows), fit: fitText(rows) });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
