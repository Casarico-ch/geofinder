// =============================================================================
// export-shrink — make one picture lighter for the HTML export, never for the
// model. Contact sheets and roofs are lossless PNGs (a sheet is ~0.84 MB) and
// listing photos arrive at 2048 px, while the model API itself scales every
// image to at most 1568 px. So: scale anything larger down to 1568 px, re-encode
// PNG and oversized JPEG as JPEG, and keep whichever version is smaller.
// A JPEG already within 1568 px is left alone: re-encoding it saves nothing.
// Pure JS (jpeg-js + the PNG decoder in sheet.ts), like roofs.ts — no native deps.
// =============================================================================
import jpeg from "jpeg-js";
import { decodePNG } from "./sheet";

export const MAX_EDGE = 1568;
const QUALITY = 75;

export interface Picture {
  media: string;
  data: Buffer;
}

// Box-filter downscale of an RGBA image so its long edge is at most `max`.
function downscale(rgba: Buffer, w: number, h: number, max: number): { rgba: Buffer; w: number; h: number } {
  const scale = max / Math.max(w, h);
  if (scale >= 1) return { rgba, w, h };
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * h) / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * w) / W), x1 = Math.max(x0 + 1, Math.floor(((X + 1) * w) / W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, p = (y * w + x0) * 4; x < x1; x++, p += 4) {
          r += rgba[p];
          g += rgba[p + 1];
          b += rgba[p + 2];
          n++;
        }
      }
      const o = (Y * W + X) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { rgba: out, w: W, h: H };
}

function rgbToRgba(rgb: Buffer): Buffer {
  const out = Buffer.alloc((rgb.length / 3) * 4, 255);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
  }
  return out;
}

/** The lighter of the original and a ≤1568 px JPEG; the original on any failure. */
export function shrink(pic: Picture): Picture {
  try {
    let img: { rgba: Buffer; w: number; h: number };
    if (pic.media === "image/png") {
      const p = decodePNG(pic.data);
      img = { rgba: rgbToRgba(p.rgb), w: p.w, h: p.h };
    } else if (pic.media === "image/jpeg") {
      const d = jpeg.decode(pic.data, { useTArray: true, maxMemoryUsageInMB: 1024 });
      if (Math.max(d.width, d.height) <= MAX_EDGE) return pic;
      img = { rgba: Buffer.from(d.data.buffer, d.data.byteOffset, d.data.byteLength), w: d.width, h: d.height };
    } else {
      return pic; // webp / gif: no encoder here, keep as is
    }
    const small = downscale(img.rgba, img.w, img.h, MAX_EDGE);
    const out = jpeg.encode({ data: small.rgba, width: small.w, height: small.h }, QUALITY).data;
    return out.length < pic.data.length ? { media: "image/jpeg", data: Buffer.from(out) } : pic;
  } catch {
    return pic;
  }
}
