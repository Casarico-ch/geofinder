// =============================================================================
// Export — one investigation's ENTIRE thread as a single, self-contained HTML
// file: every listing photo, all the text we sent, the system prompt, every
// step on the page, and the model's full conversation (its reasoning, every
// tool call with its complete input, every tool result with its images),
// nothing clipped. Images are embedded, so the file opens offline.
// =============================================================================
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type Anthropic from "@anthropic-ai/sdk";
import { loadConversation, loadListingPhotos } from "./agent";
import { costUsd, elapsedMs, type Job } from "./jobs";
import { RUNS_ROOT } from "./sandbox";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pre = (s: unknown) => `<pre>${esc(s)}</pre>`;

const MEDIA: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

// The same picture recurs across the thread (a listing photo is sent to the
// model and shown in the photo grid; a step's screenshot is also its tool
// result), so each distinct image is embedded once and every <img> points at it.
class Images {
  private index = new Map<string, number>();
  private data: { media: string; base64: string }[] = [];
  // Keyed on the bytes alone: a step reads its file by extension, the tool
  // result may have sniffed it, and the same picture must still match.
  tag(media: string, base64: string): string {
    const key = createHash("sha1").update(base64).digest("hex");
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.data.push({ media, base64 }) - 1;
      this.index.set(key, i);
    }
    return `<img data-i="${i}" alt="">`;
  }
  // Shrink every embedded picture (see export-shrink.ts) in a worker thread,
  // caching each result in the run dir so a second export is instant. Any
  // failure keeps the original: a heavy export beats a broken one.
  async shrink(runDir: string): Promise<void> {
    const cacheDir = path.join(runDir, ".export-cache");
    await mkdir(cacheDir, { recursive: true }).catch(() => {});
    let worker: Worker | null = null;
    let dead = false;
    const pending = new Map<number, (r: { changed: boolean; data: Uint8Array } | null) => void>();
    const giveUp = (why: unknown) => {
      if (!dead) console.error("[export] shrink worker stopped; keeping the remaining pictures as they are:", why);
      dead = true;
      pending.forEach((r) => r(null));
      pending.clear();
    };
    const viaWorker = (id: number, media: string, data: Buffer) =>
      new Promise<{ changed: boolean; data: Uint8Array } | null>((resolve) => {
        if (dead) return resolve(null);
        try {
          if (!worker) {
            // Bundled: dist/export-worker.js beside dist/index.js. Dev (tsx): the .ts
            // source, through tsx's loader, which a worker does not inherit.
            if (import.meta.url.endsWith(".ts")) {
              const tsx = JSON.stringify(import.meta.resolve("tsx/esm/api"));
              const src = JSON.stringify(new URL("./export-worker.ts", import.meta.url).href);
              worker = new Worker(`import(${tsx}).then((m) => { m.register(); return import(${src}); })`, { eval: true });
            } else {
              worker = new Worker(new URL("./export-worker.js", import.meta.url));
            }
            worker.on("message", (m: { id: number; changed: boolean; data: Uint8Array }) => {
              pending.get(m.id)?.(m);
              pending.delete(m.id);
            });
            worker.on("error", giveUp);
            worker.on("exit", (code) => giveUp(`exit ${code}`));
          }
          pending.set(id, resolve);
          worker.postMessage({ id, media, data });
        } catch (err) {
          giveUp(err);
          resolve(null);
        }
      });
    try {
      for (let i = 0; i < this.data.length; i++) {
        const d = this.data[i];
        if (d.media !== "image/png" && d.media !== "image/jpeg") continue;
        const key = createHash("sha1").update(d.base64).digest("hex");
        const cached = path.join(cacheDir, `${key}.jpg`);
        const kept = path.join(cacheDir, `${key}.orig`);
        try {
          this.data[i] = { media: "image/jpeg", base64: (await readFile(cached)).toString("base64") };
          continue;
        } catch {
          /* not cached as a smaller JPEG */
        }
        if (await readFile(kept).then(() => true, () => false)) continue;
        const out = await viaWorker(i, d.media, Buffer.from(d.base64, "base64"));
        if (!out) continue;
        if (!out.changed) {
          await writeFile(kept, "").catch(() => {});
        } else {
          await writeFile(cached, out.data).catch(() => {});
          this.data[i] = { media: "image/jpeg", base64: Buffer.from(out.data).toString("base64") };
        }
      }
    } finally {
      dead = true; // our own terminate is not a failure worth logging
      await (worker as Worker | null)?.terminate();
    }
  }
  script(): string {
    const uris = this.data.map((d) => `data:${d.media};base64,${d.base64}`);
    return `<script>const I=${JSON.stringify(uris)};document.querySelectorAll("img[data-i]").forEach(e=>{e.src=I[+e.dataset.i]})</script>`;
  }
}

// A step's image lives under /runs/<id>/…; embed it so the file stands alone.
async function stepImage(src: string): Promise<{ media: string; base64: string } | null> {
  const rel = src.replace(/^\/runs\//, "");
  const abs = path.resolve(RUNS_ROOT, rel);
  if (!abs.startsWith(path.resolve(RUNS_ROOT) + path.sep)) return null;
  try {
    const buf = await readFile(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    return { media: MEDIA[ext] ?? "image/png", base64: buf.toString("base64") };
  } catch {
    return null;
  }
}

type Block = Record<string, unknown> & { type?: string };

function imageBlock(b: Block, images: Images): string {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (src?.type === "base64" && src.data) return images.tag(esc(src.media_type), src.data);
  if (src?.type === "url" && src.url) return `<img src="${esc(src.url)}" alt="">`;
  return `<p class="muted">[image]</p>`;
}

function renderBlocks(content: Anthropic.Messages.MessageParam["content"], images: Images): string {
  if (typeof content === "string") return pre(content);
  return (content as unknown as Block[])
    .map((b) => {
      switch (b.type) {
        case "text":
          return pre(b.text);
        case "image":
          return imageBlock(b, images);
        case "thinking":
          return `<details open><summary>Reasoning</summary>${pre(b.thinking)}</details>`;
        case "redacted_thinking":
          return `<p class="muted">[reasoning withheld by the model]</p>`;
        case "tool_use":
          return `<div class="tool"><b>Tool call · ${esc(b.name)}</b>${pre(JSON.stringify(b.input, null, 2))}</div>`;
        case "tool_result": {
          const inner = b.content as Anthropic.Messages.ToolResultBlockParam["content"];
          const body =
            typeof inner === "string" ? pre(inner) : renderBlocks((inner ?? []) as Anthropic.Messages.MessageParam["content"], images);
          return `<div class="result"><b>Tool result${b.is_error ? " (error)" : ""}</b>${body}</div>`;
        }
        default:
          return pre(JSON.stringify(b, null, 2));
      }
    })
    .join("\n");
}

export async function exportJobHtml(job: Job): Promise<string> {
  const [photos, prompt, conversation] = await Promise.all([
    loadListingPhotos(job.runDir),
    readFile(path.join(job.runDir, "prompt.txt"), "utf8").catch(() => null),
    loadConversation(job.runDir),
  ]);

  const images = new Images();
  const steps: string[] = [];
  for (const s of job.steps) {
    const img = s.image ? await stepImage(s.image) : null;
    steps.push(`<div class="step">
  <p class="muted">#${s.n} · ${esc(s.kind)} · ${esc(s.at)}</p>
  <p><b>${esc(s.title)}</b></p>
  ${s.reasoning ? `<details open><summary>Reasoning</summary>${pre(s.reasoning)}</details>` : ""}
  ${s.detail ? pre(s.detail) : ""}
  ${img ? images.tag(img.media, img.base64) : ""}
</div>`);
  }

  const conversationHtml = conversation
    ? conversation
        .map((m, i) => `<div class="msg"><p class="muted">${i + 1} · ${m.role === "user" ? "Sent to the model" : "Model"}</p>${renderBlocks(m.content, images)}</div>`)
        .join("\n")
    : `<p class="muted">This run finished before full conversations were kept; the steps above are everything recorded.</p>`;
  const photosHtml = photos.map((p) => images.tag(p.mediaType, p.base64)).join("");
  await images.shrink(job.runDir);

  const a = job.answer;
  const meta: Array<[string, unknown]> = [
    ["Investigation", job.id],
    ["Model", job.model],
    ["Status", job.status],
    ["Started", job.startedAt ?? job.createdAt],
    ["Finished", job.finishedAt ?? "—"],
    ["Duration", `${Math.round(elapsedMs(job) / 1000)} s`],
    ["Tokens", `${job.tokens.total} (${job.tokens.input} in, ${job.tokens.output} out, ${job.tokens.cached} cached)`],
    ["Cost", `$${costUsd(job.tokens, job.model).toFixed(2)}`],
    ["Prompt version", job.promptVersion ?? "—"],
    ["Listing id", job.input.listingId ?? "—"],
  ];
  const link = (u?: string) => (u ? `<a href="${esc(u)}">${esc(u)}</a>` : "—");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoFinder ${esc(job.id)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#111;background:#fff}
h1{font-size:22px}h2{font-size:17px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:4px}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:8px 10px;border-radius:6px;font-size:12.5px}
img{max-width:100%;border-radius:6px;margin:6px 0;display:block}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.step,.msg{border:1px solid #e3e3e3;border-radius:8px;padding:10px 12px;margin:10px 0}
.tool{border-left:3px solid #4b6bfb;padding-left:8px;margin:8px 0}.result{border-left:3px solid #2ea44f;padding-left:8px;margin:8px 0}
.muted{color:#777;font-size:12px}td{padding:2px 12px 2px 0;vertical-align:top}
</style></head><body>
<h1>GeoFinder investigation ${esc(job.id)}</h1>
<table>${meta.map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
<tr><td class="muted">Listing</td><td>${link(job.input.listingUrl)}</td></tr>
<tr><td class="muted">Radar</td><td>${link(job.input.radarUrl)}</td></tr></table>

<h2>Answer</h2>
${a ? `<p><b>${esc(a.address ?? a.parcel ?? (a.found ? "Found" : "Not found"))}</b> · confidence ${esc(a.confidence)}${a.parcel ? ` · plot ${esc(a.parcel)}` : ""}${a.latitude != null ? ` · ${esc(a.latitude)}, ${esc(a.longitude)}` : ""}</p>${pre(a.reasoning)}${a.candidates?.length ? `<p><b>Candidates</b></p>${pre(JSON.stringify(a.candidates, null, 2))}` : ""}` : `<p class="muted">No answer yet.</p>`}
${job.error ? `<p><b>Error</b></p>${pre(job.error)}` : ""}

<h2>What we sent: photos (${photos.length})</h2>
<div class="photos">${photosHtml}</div>

<h2>What we sent: listing text</h2>
${pre(job.input.listingText ?? "(none)")}

<h2>System prompt</h2>
${prompt ? pre(prompt) : `<p class="muted">Not recorded for this run.</p>`}

<h2>Steps (${job.steps.length})</h2>
${steps.join("\n")}

<h2>Full conversation with the model</h2>
${conversationHtml}
${images.script()}
</body></html>`;
}
