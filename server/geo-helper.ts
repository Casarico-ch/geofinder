// =============================================================================
// geo-helper — a tested, pure-math geometry module seeded into every run's
// working directory as `geo.mjs`, so the model imports trustworthy primitives
// instead of hand-rolling the fiddly conversions each turn. Axis order (WMS
// wants lat,lon) and metre/degree scaling are exactly where the model made
// arithmetic mistakes and unreliable "distance widget" calls; this removes that
// error source. NO network, NO domain logic — the cadastre access stays the
// model's job. This is only the maths.
//
// Kept as an embedded string (not a .mjs asset) so esbuild bundles it into the
// server output; `seedGeoHelper` writes it verbatim into the run dir.
// =============================================================================
import { writeSandboxFile } from "./sandbox";

// The literal source of geo.mjs. Concatenation only — no backticks / ${} — so it
// nests safely inside this template string.
export const GEO_HELPER_JS = `// geo.mjs — tested geometry helpers (seeded into your working directory).
// Pure math, no network. Import these instead of re-deriving them by hand:
//   import { wmsBbox4326, haversine, minEdgeDistanceMetres } from './geo.mjs'
// The axis order and metre<->degree scaling below are the usual mistakes.
const M_PER_DEG_LAT = 111320;
const R_EARTH = 6371000;
export const metresPerDegLon = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// Square-in-metres bbox around a point -> {latMin, lonMin, latMax, lonMax}.
export function bboxMetres(lat, lon, spanMetres) {
  const dLat = spanMetres / 2 / M_PER_DEG_LAT;
  const dLon = spanMetres / 2 / metresPerDegLon(lat);
  return { latMin: lat - dLat, lonMin: lon - dLon, latMax: lat + dLat, lonMax: lon + dLon };
}

// BBOX string for a swisstopo WMS 1.3.0 GetMap in EPSG:4326. Axis order is
// lat,lon (this is the #1 thing to get wrong). Pass straight into &BBOX=.
export function wmsBbox4326(lat, lon, spanMetres) {
  const b = bboxMetres(lat, lon, spanMetres);
  return b.latMin + ',' + b.lonMin + ',' + b.latMax + ',' + b.lonMax;
}

// Great-circle distance in metres.
export function haversine(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Compass bearing in degrees from point 1 to point 2 (0=N, 90=E).
export function bearing(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toR) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) -
    Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lon2 - lon1) * toR);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// WGS84 -> Swiss LV95 (E,N), swisstopo approximate formula (sub-metre in CH).
// Useful to work in metres, and to line up with LV95 datasets (swissBUILDINGS3D).
export function wgs84ToLv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return { E, N };
}

// LV95 (E,N) -> WGS84 {lat, lon}, approximate inverse.
export function lv95ToWgs84(E, N) {
  const y = (E - 2600000) / 1000000;
  const x = (N - 1200000) / 1000000;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}

// Ring = array of [lon, lat]. Approximate footprint area in m^2 (local scaling).
export function polygonAreaMetres(ring) {
  if (!ring || ring.length < 3) return 0;
  let lat0 = 0;
  for (const p of ring) lat0 += p[1];
  lat0 /= ring.length;
  const kx = metresPerDegLon(lat0), ky = M_PER_DEG_LAT;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
    a += (p1[0] * kx) * (p2[1] * ky) - (p2[0] * kx) * (p1[1] * ky);
  }
  return Math.abs(a) / 2;
}

// Centroid [lon, lat] of a ring (ignores a duplicated closing vertex).
export function polygonCentroid(ring) {
  let n = ring.length;
  if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n -= 1;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}

// point = [lon, lat], ring = [[lon, lat], ...]. Ray casting.
export function pointInPolygon(point, ring) {
  const px = point[0], py = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Minimum distance in METRES between two footprint rings ([lon,lat] each).
// Roughly 0 means the two buildings share a wall -> attached (a row house).
export function minEdgeDistanceMetres(ringA, ringB) {
  const lat0 = ringA[0][1];
  const kx = metresPerDegLon(lat0), ky = M_PER_DEG_LAT;
  const A = ringA.map((p) => [p[0] * kx, p[1] * ky]);
  const B = ringB.map((p) => [p[0] * kx, p[1] * ky]);
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

export default {
  metresPerDegLon, bboxMetres, wmsBbox4326, haversine, bearing,
  wgs84ToLv95, lv95ToWgs84, polygonAreaMetres, polygonCentroid,
  pointInPolygon, minEdgeDistanceMetres,
};
`;

// Write geo.mjs into a run's working directory so the model can import it.
export async function seedGeoHelper(runDir: string): Promise<void> {
  await writeSandboxFile(runDir, "geo.mjs", GEO_HELPER_JS);
}
