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

const API = "https://api3.geo.admin.ch/rest/services/api/MapServer";
const PLOT_LAYER = "ch.kantone.cadastralwebmap-farbe";

export interface ListingFacts {
  landM2: number | null; // "Land area m²: 331"
  livingM2: number | null; // "Living area m²: 236"
  /** 1 for a single house; null when the listing does not pin it (flats, multi-family). */
  dwellings: number | null;
  /** Condominium (PPE / STWE): the stated land is a share, so it is not a plot area. */
  sharedLand: boolean;
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
  const type = `${line(/^Type:\s*(.+)$/im) ?? ""} ${line(/^Category:\s*(.+)$/im) ?? ""} ${line(/^Subtype:\s*(.+)$/im) ?? ""}`.toLowerCase();
  const sharedLand = /\b(?:PPE|copropri[ée]t[ée]|Stockwerkeigentum|STWE|condominio)\b/i.test(t);
  const multi =
    /multi|immeuble|mehrfamilien|rendite|investment|apartment building|plurifamiliale/.test(type) ||
    /\b(?:deux|trois|quatre|2|3|4)\s+(?:logements|appartements|Wohnungen|unités)\b/i.test(t);
  const house = /\bhouse\b|maison|villa|chalet|einfamilienhaus|\bhaus\b/.test(type);
  return { landM2, livingM2, dwellings: house && !multi ? 1 : null, sharedLand };
}

export interface Plot {
  number: string;
  egrid: string | null;
  areaM2: number;
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
  return { number: String(p.number), egrid: p.egris_egrid ?? null, areaM2: Math.round(polygonAreaM2(r.geometry) * 10) / 10 };
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
}

// Bands, wide on purpose: a register footprint is gross and outside the walls,
// a listed living area is net and counts an attic the register may not.
const LIVING_MIN = 0.45, LIVING_MAX = 1.35;
const PLOT_MATCH = 0.05, PLOT_CLOSE = 0.15;

/** Listing vs building, one row per fact both sides state. */
export function factRows(l: ListingFacts, b: BuildingFacts): FactRow[] {
  const rows: FactRow[] = [];
  if (l.dwellings != null) {
    rows.push({
      fact: "Homes in the building",
      listing: `${l.dwellings} (a single house)`,
      building: b.dwellings == null ? "not in the register" : String(b.dwellings),
      verdict: b.dwellings == null ? "unknown" : b.dwellings === l.dwellings ? "match" : "mismatch",
    });
  }
  if (l.livingM2 != null) {
    const gross = b.footprintM2 != null && b.floors != null ? b.footprintM2 * b.floors : null;
    const ratio = gross ? l.livingM2 / gross : null;
    rows.push({
      fact: "Living area",
      listing: `${l.livingM2} m²`,
      building: gross ? `${b.footprintM2} m² × ${b.floors} floors = ${gross} m²` : "footprint or floors not in the register",
      verdict: ratio == null ? "unknown" : ratio >= LIVING_MIN && ratio <= LIVING_MAX ? "match" : "mismatch",
    });
  }
  if (l.landM2 != null && !l.sharedLand) {
    const plots = b.plots ?? [];
    const total = plots.reduce((s, p) => s + p.areaM2, 0);
    const off = plots.length ? Math.abs(total - l.landM2) / l.landM2 : null;
    rows.push({
      fact: "Plot area",
      listing: `${l.landM2} m²`,
      building: plots.length ? `${plots.map((p) => p.number).join(" + ")}: ${Math.round(total)} m²` : "plot not found",
      verdict: off == null ? "unknown" : off <= PLOT_MATCH ? "match" : off <= PLOT_CLOSE ? "unknown" : "mismatch",
      hard: off != null && off > PLOT_CLOSE,
    });
  }
  return rows;
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
>(l: ListingFacts, cands: T[], maxPlots = 100): Promise<(T & { strongFit: boolean; fit: string; plot?: Plot })[]> {
  const out = cands.map((c) => {
    const rows = factRows(l, { floors: c.floors, dwellings: c.dwellings ?? null, footprintM2: c.footprintM2 });
    return { ...c, strongFit: strongFit(rows), fit: fitText(rows), plot: undefined as Plot | undefined };
  });
  if (l.landM2 == null || l.sharedLand) return out;
  const wanted = out.filter((c) => c.strongFit || !c.fit).slice(0, maxPlots);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const c = wanted[next++];
      const plot = await plotAt(c.lat, c.lon);
      if (!plot) continue;
      const rows = factRows(l, { floors: c.floors, dwellings: c.dwellings ?? null, footprintM2: c.footprintM2, plots: [plot] });
      Object.assign(c, { plot, strongFit: strongFit(rows), fit: fitText(rows) });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
