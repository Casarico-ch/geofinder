// =============================================================================
// roofs — server-side "same-view" roof rendering from swissBUILDINGS3D.
//
// The sandbox has no image library, so the finder can't render 3D itself. This
// module does it server-side and hands the pictures back for the model to LOOK
// at (the eyeball stays the matcher — this is only plumbing). Given a shortlist
// of candidate buildings (lat/lon), it fetches swisstopo's national 3D building
// models (swissBUILDINGS3D 2.0, DXF), extracts each candidate's real roof, and
// renders it from two oblique angles so the model can compare roof SHAPE (hip vs
// gable, ridge direction, the low-wing step) against the listing photos.
//
// Pure Node: zlib does both the .zip inflate and the PNG encode — no native
// deps, nothing to break on deploy. swissBUILDINGS3D covers all of Switzerland,
// so this is not Geneva-specific.
// =============================================================================
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

interface Building {
  faces: number[][][]; // each face: array of [x,y,z] in LV95 metres
  cx: number;
  cy: number;
}
export interface RoofRender {
  label: string;
  relPath?: string; // roof_<label>.png in the run dir, if rendered
  faces?: number; // roof face count (a rough "was there real geometry" signal)
  note?: string; // set when nothing could be rendered
}

// WGS84 -> Swiss LV95 (E,N), swisstopo approximate formula (sub-metre in CH).
function wgs84ToLv95(lat: number, lon: number): { E: number; N: number } {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return { E, N };
}

async function fetchWithTimeout(url: string, ms = 40_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } });
  } finally {
    clearTimeout(t);
  }
}

// Find the swissBUILDINGS3D 2.0 DXF tile covering a point (latest year).
async function findDxfHref(lat: number, lon: number): Promise<string | null> {
  const d = 0.0004;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url =
    `https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissbuildings3d_2/items?bbox=${bbox}&limit=20`;
  const j = (await (await fetchWithTimeout(url)).json()) as {
    features?: { id: string; assets: Record<string, { href: string }> }[];
  };
  let href: string | null = null;
  let best = 0;
  for (const it of j.features ?? []) {
    for (const [k, a] of Object.entries(it.assets)) {
      if (!k.includes("dxf")) continue;
      const year = Number((it.id.match(/(20\d\d)/) ?? [])[1] ?? 0);
      if (year >= best) {
        best = year;
        href = a.href;
      }
    }
  }
  return href;
}

// ---- DXF polyface-mesh parse (swissBUILDINGS3D 2.0 stores each building as a
// POLYLINE polyface: coordinate VERTEXes then face-record VERTEXes with 71..74
// indices into them). ----
function parseDxf(text: string): Building[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1]]);
  const bldgs: Building[] = [];
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "POLYLINE") {
      i++;
      const verts: number[][] = [];
      const faceIdx: number[][] = [];
      while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === "SEQEND")) {
        if (pairs[i][0] === 0 && pairs[i][1].trim() === "VERTEX") {
          i++;
          let x: number | undefined, y: number | undefined, z = 0;
          const idx: number[] = [];
          while (i < pairs.length && pairs[i][0] !== 0) {
            const c = pairs[i][0];
            const v = pairs[i][1];
            if (c === 10) x = parseFloat(v);
            else if (c === 20) y = parseFloat(v);
            else if (c === 30) z = parseFloat(v);
            else if (c >= 71 && c <= 74) {
              const n = parseInt(v, 10);
              if (n) idx.push(Math.abs(n));
            }
            i++;
          }
          if (idx.length) faceIdx.push(idx);
          else if (x !== undefined && y !== undefined) verts.push([x, y, z]);
        } else i++;
      }
      const faces: number[][][] = [];
      for (const f of faceIdx) {
        const pts = f.map((k) => verts[k - 1]).filter(Boolean);
        if (pts.length >= 3) faces.push(pts);
      }
      if (faces.length) {
        const all = faces.flat();
        bldgs.push({
          faces,
          cx: all.reduce((s, v) => s + v[0], 0) / all.length,
          cy: all.reduce((s, v) => s + v[1], 0) / all.length,
        });
      }
    } else i++;
  }
  return bldgs;
}

// Process-lifetime cache: a run renders many candidates from the same tile.
const tileCache = new Map<string, Promise<Building[]>>();
function getTileBuildings(href: string): Promise<Building[]> {
  let p = tileCache.get(href);
  if (!p) {
    p = (async () => {
      const zbuf = Buffer.from(await (await fetchWithTimeout(href, 90_000)).arrayBuffer());
      if (zbuf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
      const method = zbuf.readUInt16LE(8);
      const compSize = zbuf.readUInt32LE(18);
      const nameLen = zbuf.readUInt16LE(26);
      const extraLen = zbuf.readUInt16LE(28);
      const start = 30 + nameLen + extraLen;
      const comp = zbuf.subarray(start, start + compSize);
      const dxf = (method === 8 ? zlib.inflateRawSync(comp) : comp).toString("latin1");
      return parseDxf(dxf);
    })();
    tileCache.set(href, p);
  }
  return p;
}

// ---- render an oblique 3D view of a building cluster to an RGB buffer ----
const LIGHT = [-0.4, 0.5, 0.75];
function renderCluster(cluster: Building[], size: number, azDeg: number): Buffer {
  const AZ = (azDeg * Math.PI) / 180;
  const PITCH = (34 * Math.PI) / 180;
  const allv = cluster.flatMap((b) => b.faces.flat());
  const cx = allv.reduce((s, v) => s + v[0], 0) / allv.length;
  const cy = allv.reduce((s, v) => s + v[1], 0) / allv.length;
  const cz = Math.min(...allv.map((v) => v[2]));
  const proj = (v: number[]): number[] => {
    const x = v[0] - cx, y = v[1] - cy, z = v[2] - cz;
    const xr = x * Math.cos(AZ) - y * Math.sin(AZ);
    const yr = x * Math.sin(AZ) + y * Math.cos(AZ);
    return [xr, yr * Math.sin(PITCH) - z * Math.cos(PITCH), yr * Math.cos(PITCH) + z * Math.sin(PITCH)];
  };
  const faces = cluster.flatMap((b) => b.faces);
  const projected = faces.flat().map(proj);
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const SC = (size * 0.8) / span;
  const ox = size / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * SC;
  const oy = size / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * SC;
  const polys = faces.map((f) => {
    const pj = f.map(proj);
    const a = [f[1][0] - f[0][0], f[1][1] - f[0][1], f[1][2] - f[0][2]];
    const b = [f[2][0] - f[0][0], f[2][1] - f[0][1], f[2][2] - f[0][2]];
    let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const m = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((c) => c / m);
    const lit = Math.max(0.15, Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]));
    const depth = pj.reduce((s, p) => s + p[2], 0) / pj.length;
    const scr = pj.map((p) => [ox + p[0] * SC, oy + p[1] * SC]);
    const col = [200, 150, 120].map((c) => Math.min(255, Math.round(c * (0.35 + 0.75 * lit))));
    return { depth, scr, col };
  });
  polys.sort((p, q) => q.depth - p.depth);
  const rgb = Buffer.alloc(size * size * 3).fill(26);
  for (const p of polys) fillPoly(rgb, size, size, p.scr, p.col);
  return rgb;
}

function fillPoly(rgb: Buffer, W: number, H: number, pts: number[][], col: number[]): void {
  const ymin = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
  const ymax = Math.min(H - 1, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  for (let y = ymin; y <= ymax; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) {
        const o = (y * W + x) * 3;
        rgb[o] = col[0];
        rgb[o + 1] = col[1];
        rgb[o + 2] = col[2];
      }
    }
  }
}

// ---- PNG encode (RGB) via zlib, no dependency ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w: number, h: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

// Two angles side by side into one sheet, so it's one image per candidate.
function renderSheet(cluster: Building[]): Buffer {
  const s = 300;
  const a = renderCluster(cluster, s, 50);
  const b = renderCluster(cluster, s, 140);
  const W = s * 2;
  const rgb = Buffer.alloc(W * s * 3);
  for (let y = 0; y < s; y++) {
    a.copy(rgb, (y * W) * 3, y * s * 3, (y + 1) * s * 3);
    b.copy(rgb, (y * W + s) * 3, y * s * 3, (y + 1) * s * 3);
  }
  return encodePNG(W, s, rgb);
}

// Render each candidate's real roof to roof_<label>.png in the run dir.
export async function renderCandidateRoofs(
  runDir: string,
  candidates: { label: string; lat: number; lon: number }[],
): Promise<RoofRender[]> {
  const out: RoofRender[] = [];
  for (const c of candidates) {
    const safe = c.label.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "cand";
    try {
      const href = await findDxfHref(c.lat, c.lon);
      if (!href) {
        out.push({ label: c.label, note: "no swissBUILDINGS3D tile covers this point" });
        continue;
      }
      const buildings = await getTileBuildings(href);
      const { E, N } = wgs84ToLv95(c.lat, c.lon);
      const cluster = buildings.filter((b) => Math.hypot(b.cx - E, b.cy - N) < 14);
      if (cluster.length === 0) {
        out.push({ label: c.label, note: "no 3D building within 14 m of this point" });
        continue;
      }
      const png = renderSheet(cluster);
      const rel = `roof_${safe}.png`;
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, rel), png);
      out.push({ label: c.label, relPath: rel, faces: cluster.reduce((s, b) => s + b.faces.length, 0) });
    } catch (err) {
      out.push({ label: c.label, note: `render failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}

// Read a rendered roof PNG back as base64 (for the tool result image block).
export async function readRoofPng(runDir: string, relPath: string): Promise<string> {
  const buf = await readFile(path.join(runDir, relPath));
  return buf.toString("base64");
}
