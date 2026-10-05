// =============================================================================
// gwr — nationwide building enumeration from the federal building register.
//
// shortlist_buildings used to enumerate Geneva only (SITG); everywhere else the
// model hand-wrote its own register filter, and that hand-written filter is
// where the truth got dropped (run c5bc3cfd: "floors 2–3" against a house the
// register counts as 4). This module gives the shortlist the same code-enforced
// enumeration for every commune in Switzerland:
//   - resolveCommune: a commune name ("St-Sulpice VD", "Saint-Sulpice (VD)") →
//     its BFS number, canton, outline and bbox (swissBOUNDARIES3D, current year),
//   - neighbourCommunes: the communes around it, nearest first,
//   - fetchCommuneBuildings: every GWR building of that commune (tiled identify,
//     paged with offset — one identify call returns at most ~200 results).
// =============================================================================

const API = "https://api3.geo.admin.ch/rest/services/api/MapServer";
const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";
const UA = { "User-Agent": "geofinder" };

export interface Commune {
  name: string; // as the register writes it, e.g. "Saint-Sulpice (VD)"
  bfs: number;
  canton: string;
  bbox: [number, number, number, number]; // lonMin, latMin, lonMax, latMax
  rings: number[][][]; // outline, [ring][vertex][lon,lat]
}

export interface GwrBuilding {
  egid: string;
  address: string | null;
  commune: string;
  bfs: number;
  lat: number;
  lon: number;
  floors: number | null; // gastw
  dwellings: number | null; // ganzwhg
  footprintM2: number | null; // garea
  category: number | null; // gkat
  klass: number | null; // gklas (1272 = church or other religious building)
  status: number | null; // gstat (1004 = existing)
  year: number | null; // gbauj
  postcode: number | null; // dplz4
}

async function getJson(url: string, ms = 60_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: UA });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.slice(0, 120)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// "St-Sulpice VD" / "Saint-Sulpice (VD)" / "saint sulpice" → "saint-sulpice".
export function normalizeCommune(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\((?:[a-z]{2})\)/g, " ")
    .replace(/\b(?:ag|ai|ar|be|bl|bs|fr|ge|gl|gr|ju|lu|ne|nw|ow|sg|sh|so|sz|tg|ti|ur|vd|vs|zg|zh)\s*$/, " ")
    .replace(/\b(ste?)(?:[.-]|\s)+(?=[a-z])/g, (_m, st: string) => (st === "ste" ? "sainte-" : "saint-"))
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cantonHint(s: string): string | null {
  const m = s.match(/\(([A-Z]{2})\)|\b([A-Z]{2})\s*$/);
  return m ? (m[1] ?? m[2]) : null;
}

function attrs(r: any): Record<string, any> {
  return r.properties ?? r.attributes ?? {};
}

function ringsOf(geometry: any): number[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

function bboxOf(rings: number[][][]): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < a) a = x;
    if (y < b) b = y;
    if (x > c) c = x;
    if (y > d) d = y;
  }
  return [a, b, c, d];
}

function toCommune(r: any): Commune | null {
  const p = attrs(r);
  const rings = ringsOf(r.geometry);
  if (!p.gemname || typeof p.gde_nr !== "number" || p.gde_nr >= 9000 || rings.length === 0) return null; // 9xxx = lakes
  return { name: p.gemname, bfs: p.gde_nr, canton: p.kanton ?? "", bbox: bboxOf(rings), rings };
}

const communeCache = new Map<string, Promise<Commune | null>>();

// Resolve a free-text commune name to the current commune. Exact (normalised)
// name first, then a canton hint ("(VD)", "VD") to break ties between homonyms.
export function resolveCommune(name: string): Promise<Commune | null> {
  const key = name.trim().toLowerCase();
  let hit = communeCache.get(key);
  if (!hit) {
    hit = doResolve(name).catch(() => null);
    communeCache.set(key, hit);
    void hit.then((c) => { if (!c) communeCache.delete(key); });
  }
  return hit;
}

async function doResolve(name: string): Promise<Commune | null> {
  const want = normalizeCommune(name);
  if (!want) return null;
  const canton = cantonHint(name.trim());
  // The location search knows today's communes and their spellings ("St-Sulpice"
  // finds "Saint-Sulpice (VD)"); the boundary layer itself is full of history.
  const s = await getJson(
    `${SEARCH}?searchText=${encodeURIComponent(name.trim())}&type=locations&origins=gg25&sr=4326&limit=20`,
  );
  const hits = (s.results ?? [])
    .map((r: any) => ({
      label: String(r.attrs?.label ?? "").replace(/<[^>]+>/g, "").trim(),
      bfs: Number(r.attrs?.featureId),
      box: String(r.attrs?.geom_st_box2d ?? ""),
    }))
    .filter((h: { label: string; bfs: number }) => h.label && Number.isFinite(h.bfs) && h.bfs < 9000);
  const exact = hits.filter((h: { label: string }) => normalizeCommune(h.label) === want);
  const pool = exact.length ? exact : hits.filter((h: { label: string }) => normalizeCommune(h.label).startsWith(want));
  if (pool.length === 0) return null;
  const pick =
    pool.find((h: { label: string }) => canton && h.label.endsWith(`(${canton})`)) ?? pool[0];
  return communeOutline(pick.bfs, pick.box);
}

// The current outline of commune `bfs`: identify on the boundary layer at this
// year (last year as a fallback while a new year is not published yet).
async function communeOutline(bfs: number, box: string): Promise<Commune | null> {
  const year = new Date().getFullYear();
  // Identify over the commune's own search box ("BOX(lon lat,lon lat)").
  const m = box.match(/BOX\(([\d.]+) ([\d.]+),([\d.]+) ([\d.]+)\)/);
  if (!m) return null;
  const env = [m[1], m[2], m[3], m[4]].join(",");
  for (const y of [year, year - 1]) {
    const j = await getJson(
      `${API}/identify?geometry=${env}&geometryType=esriGeometryEnvelope&layers=all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill` +
        `&tolerance=0&sr=4326&returnGeometry=true&geometryFormat=geojson&limit=200&timeInstant=${y}`,
    );
    for (const r of j.results ?? []) {
      const c = toCommune(r);
      if (c && c.bfs === bfs) return c;
    }
  }
  return null;
}

const M_LAT = 111_320;
function metres(lat0: number) {
  const kx = M_LAT * Math.cos((lat0 * Math.PI) / 180);
  return (lon: number, lat: number): [number, number] => [lon * kx, lat * M_LAT];
}

function pointInRings(lon: number, lat: number, rings: number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Metres from a point to a commune outline (0 inside it).
export function distanceToCommune(lat: number, lon: number, c: Commune): number {
  if (pointInRings(lon, lat, c.rings)) return 0;
  const m = metres(lat);
  const [px, py] = m(lon, lat);
  let best = Infinity;
  for (const ring of c.rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = m(ring[i][0], ring[i][1]);
      const [bx, by] = m(ring[i + 1][0], ring[i + 1][1]);
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
  }
  return best;
}

// The communes around `c`, nearest first, measured from `anchor` (the commune's
// built-up centre — its bbox centre can sit in a lake). Within `radiusM` only.
export async function neighbourCommunes(
  c: Commune,
  anchor: { lat: number; lon: number },
  radiusM = 5_000,
  max = 10,
): Promise<{ commune: Commune; distanceM: number }[]> {
  const dLat = radiusM / M_LAT, dLon = radiusM / (M_LAT * Math.cos((anchor.lat * Math.PI) / 180));
  const env = [anchor.lon - dLon, anchor.lat - dLat, anchor.lon + dLon, anchor.lat + dLat].map((v) => v.toFixed(5)).join(",");
  const year = new Date().getFullYear();
  let results: any[] = [];
  for (const y of [year, year - 1]) {
    const j = await getJson(
      `${API}/identify?geometry=${env}&geometryType=esriGeometryEnvelope&layers=all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill` +
        `&tolerance=0&sr=4326&returnGeometry=true&geometryFormat=geojson&limit=200&timeInstant=${y}`,
    );
    results = j.results ?? [];
    if (results.length) break;
  }
  const seen = new Set<number>([c.bfs]);
  const out: { commune: Commune; distanceM: number }[] = [];
  for (const r of results) {
    const n = toCommune(r);
    if (!n || seen.has(n.bfs)) continue;
    seen.add(n.bfs);
    const d = distanceToCommune(anchor.lat, anchor.lon, n);
    if (d <= radiusM) out.push({ commune: n, distanceM: Math.round(d) });
  }
  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, max);
}

function toBuilding(f: any): GwrBuilding | null {
  const p = f.properties ?? f.attributes ?? {};
  const coords = f.geometry?.coordinates;
  if (!p.egid || !Array.isArray(coords)) return null;
  const pt = typeof coords[0] === "number" ? coords : coords[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    egid: String(p.egid),
    address: p.strname_deinr || null,
    commune: p.ggdename ?? "",
    bfs: Number(p.ggdenr),
    lon: Number(pt[0]),
    lat: Number(pt[1]),
    floors: num(p.gastw),
    dwellings: num(p.ganzwhg),
    footprintM2: num(p.garea),
    category: num(p.gkat),
    klass: num(p.gklas),
    status: num(p.gstat),
    year: num(p.gbauj),
    postcode: num(p.dplz4),
  };
}

/** One register building by its EGID (null when the register has no such building). */
export async function buildingByEgid(egid: string | number): Promise<GwrBuilding | null> {
  const j = await getJson(
    `${API}/find?layer=ch.bfs.gebaeude_wohnungs_register&searchText=${Number(egid)}&searchField=egid&returnGeometry=true&geometryFormat=geojson&sr=4326&contains=false`,
    20_000,
  );
  return toBuilding((j.results ?? [])[0]);
}

const PAGE = 200; // the most one identify call returns

function identifyPage(env: number[], offset = 0): Promise<any> {
  return getJson(
    `${API}/identify?geometry=${env.map((v) => v.toFixed(5)).join(",")}&geometryType=esriGeometryEnvelope` +
      `&layers=all:ch.bfs.gebaeude_wohnungs_register&tolerance=0&sr=4326&geometryFormat=geojson&returnGeometry=true` +
      `&limit=${PAGE}&offset=${offset}`,
  );
}

// Every register feature in one tile. Paging with offset is NOT reliable: the
// service returns the pages of a full tile in a different order on each call,
// so they overlap and some buildings never come back (Zermatt's busiest tile,
// 925 features: 822, 900 and 865 distinct buildings on three calls). So a tile
// whose first page is full is split in four, down to single pages. Only a tile
// under ~50 m that still overflows is paged, and reported.
async function identifyAll(env: number[]): Promise<any[]> {
  const first = (await identifyPage(env)).results ?? [];
  if (first.length < PAGE) return first;
  const [x0, y0, x1, y1] = env;
  if (x1 - x0 > 0.0005 || y1 - y0 > 0.0005) {
    const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    const quads = [[x0, y0, xm, ym], [xm, y0, x1, ym], [x0, ym, xm, y1], [xm, ym, x1, y1]];
    return (await Promise.all(quads.map(identifyAll))).flat();
  }
  console.warn(`[gwr] ${PAGE}+ features in a ~50 m tile at ${env.join(",")}: paged, may be incomplete`);
  const out = [...first];
  for (let offset = PAGE; offset < 5_000; offset += PAGE) {
    const page = (await identifyPage(env, offset)).results ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const buildingCache = new Map<number, { at: number; p: Promise<GwrBuilding[]> }>();
const BUILDING_TTL_MS = 30 * 60_000;

// Every GWR building of a commune: the commune's bbox is tiled (0.01°), a full
// tile split until each fits one page, then kept to the commune's own BFS number.
export function fetchCommuneBuildings(c: Commune): Promise<GwrBuilding[]> {
  const hit = buildingCache.get(c.bfs);
  if (hit && Date.now() - hit.at < BUILDING_TTL_MS) return hit.p;
  const p = doFetchBuildings(c);
  buildingCache.set(c.bfs, { at: Date.now(), p });
  p.catch(() => buildingCache.delete(c.bfs));
  return p;
}

async function doFetchBuildings(c: Commune): Promise<GwrBuilding[]> {
  const step = 0.01;
  const [x0, y0, x1, y1] = c.bbox;
  const tiles: number[][] = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    tiles.push([x, y, Math.min(x + step, x1), Math.min(y + step, y1)]);
  }
  const byEgid = new Map<string, GwrBuilding>();
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const env = tiles[next++];
      for (const f of await identifyAll(env)) {
        const b = toBuilding(f);
        if (b && b.bfs === c.bfs) byEgid.set(b.egid, b);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return Array.from(byEgid.values());
}

// The built-up centre of a commune: the mean of its existing residential buildings.
export function builtCentre(buildings: GwrBuilding[]): { lat: number; lon: number } | null {
  const res = buildings.filter((b) => b.status === 1004 && b.category != null && b.category >= 1020 && b.category < 1060);
  const use = res.length ? res : buildings;
  if (!use.length) return null;
  return {
    lat: use.reduce((s, b) => s + b.lat, 0) / use.length,
    lon: use.reduce((s, b) => s + b.lon, 0) / use.length,
  };
}

// The register building at a point (an answer's pin), or null.
export interface Flat {
  floor: number | null; // 0 = ground floor, 5 = 5th upper floor, -1 = first basement (wstwk)
  rooms: number | null; // wazim: whole rooms, kitchen not counted, so a listed 3.5 is 3 here
  areaM2: number | null; // warea
}

// wstwk: 3100 ground floor, 3101–3199 upper floors, 3401–3419 basements.
function floorOf(code: unknown): number | null {
  const n = Number(code);
  if (n >= 3100 && n <= 3199) return n - 3100;
  if (n >= 3401 && n <= 3419) return -(n - 3400);
  return null;
}

// Every flat the register lists in a building (one find call, by EGID).
// Cached; an empty list on failure, so the check just reads "unknown".
const flatCache = new Map<string, Promise<Flat[]>>();
export function flatsOf(egid: string | number): Promise<Flat[]> {
  const key = String(Number(egid));
  let hit = flatCache.get(key);
  if (!hit) {
    hit = loadFlats(key).catch(() => {
      flatCache.delete(key);
      return [];
    });
    flatCache.set(key, hit);
  }
  return hit;
}

async function loadFlats(egid: string): Promise<Flat[]> {
  const j = await getJson(
    `${API}/find?layer=ch.bfs.gebaeude_wohnungs_register&searchText=${egid}&searchField=egid&returnGeometry=false&contains=false`,
    20_000,
  );
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  const seen = new Set<string>();
  const out: Flat[] = [];
  for (const r of j.results ?? []) {
    const a = r.attributes ?? {};
    const ewid: unknown[] = Array.isArray(a.ewid) ? a.ewid : [];
    ewid.forEach((id, i) => {
      // 3004 = existing; 3001-3003 = planned, approved, being built: a new
      // development's flats are for sale before they exist.
      const st = a.wstat?.[i] != null ? Number(a.wstat[i]) : null;
      if (seen.has(String(id)) || (st != null && (st < 3001 || st > 3004))) return;
      seen.add(String(id));
      out.push({ floor: floorOf(a.wstwk?.[i]), rooms: num(a.wazim?.[i]), areaM2: num(a.warea?.[i]) });
    });
  }
  return out;
}

export async function buildingAt(lat: number, lon: number): Promise<GwrBuilding | null> {
  const d = 0.002;
  const j = await getJson(
    `${API}/identify?geometry=${lon},${lat}&geometryType=esriGeometryPoint&layers=all:ch.bfs.gebaeude_wohnungs_register` +
      `&tolerance=10&sr=4326&geometryFormat=geojson&returnGeometry=true&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=800,600,96`,
  );
  const all = (j.results ?? []).map(toBuilding).filter((b: GwrBuilding | null): b is GwrBuilding => !!b);
  const dist = (b: GwrBuilding) => Math.hypot((b.lon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180), (b.lat - lat) * 111_320);
  return all.sort((a: GwrBuilding, b: GwrBuilding) => dist(a) - dist(b))[0] ?? null;
}
