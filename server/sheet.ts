// =============================================================================
// sheet — a contact sheet of candidate aerials, server-side.
//
// Viewing candidates one read_file at a time cost a model turn and an image per
// house, so run c5bc3cfd fell back to cheap pool-colour heuristics that missed
// the house by 200 m. This composes up to 16 north-up SWISSIMAGE tiles (each
// centred on one candidate, numbered) into ONE image, so a whole shortlist is
// looked at in a few turns. Pure Node, like roofs.ts: the WMS is asked for PNG,
// zlib inflates it, and the sheet is re-encoded with the same PNG writer.
// =============================================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { encodePNG } from "./roofs";

export interface SheetItem {
  label: string; // printed on the tile (its number)
  lat: number;
  lon: number;
}

const TILE = 224; // px per tile
const SPAN_M = 90; // metres across one tile: the house plus its garden and neighbours
const COLS = 4;

async function fetchBuffer(url: string, ms = 30_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

// Decode an 8-bit, non-interlaced PNG (RGB, RGBA, grey or palette) to RGB.
export function decodePNG(buf: Buffer): { w: number; h: number; rgb: Buffer } {
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "PLTE") palette = Buffer.from(data);
    else if (kind === "IDAT") idat.push(Buffer.from(data));
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const bpp = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!bpp) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (type === 2 || type === 6) {
        rgb[o] = cur[x * bpp];
        rgb[o + 1] = cur[x * bpp + 1];
        rgb[o + 2] = cur[x * bpp + 2];
      } else if (type === 3 && palette) {
        const k = cur[x] * 3;
        rgb[o] = palette[k];
        rgb[o + 1] = palette[k + 1];
        rgb[o + 2] = palette[k + 2];
      } else {
        rgb[o] = rgb[o + 1] = rgb[o + 2] = cur[x * bpp];
      }
    }
    cur.copy(prev);
  }
  return { w, h, rgb };
}

// 3x5 pixel digits, drawn scaled for the tile numbers.
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function fillRect(rgb: Buffer, W: number, x0: number, y0: number, w: number, h: number, col: number[]): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const o = (y * W + x) * 3;
    rgb[o] = col[0];
    rgb[o + 1] = col[1];
    rgb[o + 2] = col[2];
  }
}

function drawLabel(rgb: Buffer, W: number, x0: number, y0: number, text: string): void {
  const s = 4; // scale
  const chars = text.split("").filter((ch) => DIGITS[ch]);
  fillRect(rgb, W, x0, y0, chars.length * 4 * s + s, 7 * s, [0, 0, 0]);
  chars.forEach((ch, i) => {
    DIGITS[ch].forEach((row, ry) =>
      row.split("").forEach((bit, rx) => {
        if (bit === "1") fillRect(rgb, W, x0 + s + i * 4 * s + rx * s, y0 + s + ry * s, s, s, [255, 220, 0]);
      }),
    );
  });
}

function tileUrl(lat: number, lon: number): string {
  const dLat = SPAN_M / 2 / 111_320;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  return (
    "https://wms.geo.admin.ch/?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ch.swisstopo.swissimage&CRS=EPSG:4326" +
    `&BBOX=${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}&WIDTH=${TILE}&HEIGHT=${TILE}&FORMAT=image/png`
  );
}

// Render up to 16 items into one sheet PNG in the run dir. A small cross marks
// each tile's centre (the register point of the candidate building).
export async function renderContactSheet(
  runDir: string,
  fileName: string,
  items: SheetItem[],
): Promise<{ relPath: string; png: Buffer; failed: string[] }> {
  const list = items.slice(0, COLS * COLS);
  const rows = Math.ceil(list.length / COLS);
  const W = COLS * TILE, H = rows * TILE;
  const rgb = Buffer.alloc(W * H * 3, 255);
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const it = list[i];
      const ox = (i % COLS) * TILE, oy = Math.floor(i / COLS) * TILE;
      try {
        const img = decodePNG(await fetchBuffer(tileUrl(it.lat, it.lon)));
        for (let y = 0; y < Math.min(TILE, img.h); y++) {
          img.rgb.copy(rgb, ((oy + y) * W + ox) * 3, y * img.w * 3, (y * img.w + Math.min(TILE, img.w)) * 3);
        }
      } catch {
        failed.push(it.label);
        fillRect(rgb, W, ox, oy, TILE, TILE, [60, 60, 60]);
      }
      const cx = ox + TILE / 2, cy = oy + TILE / 2;
      fillRect(rgb, W, cx - 6, cy - 1, 13, 3, [255, 0, 0]);
      fillRect(rgb, W, cx - 1, cy - 6, 3, 13, [255, 0, 0]);
      fillRect(rgb, W, ox, oy, TILE, 1, [255, 255, 255]);
      fillRect(rgb, W, ox, oy, 1, TILE, [255, 255, 255]);
      drawLabel(rgb, W, ox + 2, oy + 2, it.label);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  // Drop the 3 lowest bits: invisible at this size, and it roughly halves the
  // PNG (aerial noise is what deflate can't compress).
  for (let i = 0; i < rgb.length; i++) rgb[i] &= 0xf8;
  const png = encodePNG(W, H, rgb);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, fileName), png);
  return { relPath: fileName, png, failed };
}
