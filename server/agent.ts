// =============================================================================
// Agent — an autonomous investigator with a computer, not a toolbox.
//
// There is no cadastre function, no aerial function, no triangulation logic in
// this codebase. The model is given bash / write_file / read_file (and one
// submit_answer terminator) and it writes its OWN access to public data —
// SITG, swisstopo, Overpass, the GWR register — reasoning and iterating exactly
// like a human analyst. Every turn's thinking and every command is recorded as
// the documented trace the user asked for.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runBash,
  writeSandboxFile,
  readSandboxFile,
} from "./sandbox";
import {
  type Answer,
  type Confidence,
  type Job,
  addStep,
  addUsage,
  finishJob,
  setPromptVersion,
} from "./jobs";

export const MODEL = "claude-opus-4-8";
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 150);
export const MAX_TOOL_TEXT = 16_000; // chars of command output fed back to the model

export interface AgentImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

// The "computer" — the only tools both the finder and the build-potential
// analyst share. No domain logic; the model writes its own access.
export const COMPUTER_TOOLS = [
  {
    name: "bash",
    description:
      "Run a shell command in your working directory and get stdout+stderr back. Node.js (>=18, with global fetch) is available; curl and python3 may be. Use it to fetch public data (cadastre/aerial/register/OSM), run scripts you wrote, compute distances, inspect files. Long output is truncated.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a text file (a script, a note) in your working directory. Prefer this over shell here-docs for code — it avoids escaping mistakes. Then run it with bash (e.g. `node fetch.mjs`).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "relative path inside the working dir, e.g. 'fetch.mjs'" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file back. If it is an image (jpg/png/webp/gif) you SEE it — this is how you look at aerial photos you downloaded, crops of the listing photos, or maps you rendered. Otherwise you get its text.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
] as unknown as Anthropic.Messages.ToolUnion[];

const TOOLS = [
  ...COMPUTER_TOOLS,
  {
    name: "submit_answer",
    description: "Call once, when you are confident, to report the final result (or found=false).",
    input_schema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        address: { type: ["string", "null"] },
        parcel: { type: ["string", "null"], description: "e.g. 'Plan-les-Ouates 10917'" },
        commune: { type: ["string", "null"] },
        confidence: {
          type: "string",
          enum: ["street", "building", "block", "neighborhood", "city", "region", "country", "unknown"],
        },
        latitude: { type: ["number", "null"] },
        longitude: { type: ["number", "null"] },
        reasoning: { type: "string" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              parcel: { type: ["string", "null"] },
              address: { type: ["string", "null"] },
              note: { type: "string" },
            },
            required: ["note"],
          },
        },
        links: {
          type: "array",
          items: { type: "string" },
          description: "Direct links: cadastre extract, Google/swisstopo satellite, OSM — the exact URLs.",
        },
      },
      required: ["found", "confidence", "reasoning"],
    },
  },
] as unknown as Anthropic.Messages.ToolUnion[];

const SYSTEM = `You are GeoFinder — an autonomous investigator that finds the exact street address and cadastral parcel of a Swiss property from its listing (photos + text + municipality).

You have no geo tools. You have a real Linux computer (Node ≥18 with global fetch, network access) and you build your own access to public data by writing and running code, like a human analyst. The method is entirely yours — reason it out, invent and switch approaches freely, and verify however you see fit.

PRIMITIVES
- bash(command): run a shell command, get stdout+stderr (truncated).
- write_file(path, content) / read_file(path): read_file on an image lets you SEE it (vision) — that's how you look at aerials you download.
- submit_answer(...): call once, when confident.

ENVIRONMENT
- Each bash call is a fresh process: no cd, use paths relative to the working directory. The photos are already there as photo1.jpg, photo2.jpg, … (also shown inline). Save what you fetch there and read images back to look at them.
- No Python/pip, no image libraries. To zoom, re-fetch a WMS aerial with a tighter bbox centred on the point — never crop or compute GPS→pixels.

GROUNDING ONLY
Never web-search, and never look up the listing, the agency, or the property online. Deduce everything from the given photos + text, grounded only against neutral geodata (cadastre, aerials, building register, OSM). Nominatim is fine solely to turn a place NAME into coordinates.

ANSWER HONESTLY
Submit your best-supported answer at a confidence that reflects the evidence (building / block / neighborhood…), name what's still uncertain and any runner-up candidates, and never fabricate a precise number or address to seem more certain than you are.

SOURCES (starting points, not limits; set a User-Agent header)
- Geneva cadastre (SITG, ArcGIS REST, f=json&outSR=4326). Parcels: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_PARCELLE_MENSU/MapServer/0/query — NO_PARCELLE, SURFACE, COMMUNE; filter by where=COMMUNE='X' AND SURFACE BETWEEN a AND b, or geometry=lon,lat&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects; returnGeometry=true → geometry.rings. Buildings: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/MapServer/0/query — EPOQUE_CONSTRUCTION, NIVEAUX_HORSOL, SURFACE (footprint), EGID.
- Other cantons (ZH etc.) — official cadastre on geodienste.ch, WFS 2.0, bbox axis order lat,lon: https://geodienste.ch/db/av_0/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:RESF&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX={latmin},{lonmin},{latmax},{lonmax},urn:ogc:def:crs:EPSG::4326&COUNT=30 — ms:RESF = parcel (ms:Flaeche = area, the villa key; ms:Nummer, ms:EGRIS_EGRID). ms:HADR = address (ms:Strassenname, ms:Hausnummer, ms:GWR_EGID). ms:LCSF = building footprints. Geometry is gml:posList (lat lon). av_0 is ZH; other cantons' free WFS: https://www.geodienste.ch/info/services.csv?base_topics=av&language=de.
- Aerial (swisstopo SWISSIMAGE) — download the JPEG then read_file: https://wms.geo.admin.ch/?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ch.swisstopo.swissimage&CRS=EPSG:4326&BBOX={latmin},{lonmin},{latmax},{lonmax}&WIDTH=1200&HEIGHT=1200&FORMAT=image/jpeg (lat,lon order; square bbox in metres: dLat=span/2/111320, dLon=dLat/cos(lat)).
- Building register (GWR, nationwide): https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry={lon},{lat}&geometryType=esriGeometryPoint&layers=all:ch.bfs.gebaeude_wohnungs_register&tolerance=15&sr=4326&geometryFormat=geojson&mapExtent={lon-0.002},{lat-0.0015},{lon+0.002},{lat+0.0015}&imageDisplay=800,600,96 — strname_deinr (street+no.), gbauj (year), gastw (floors), ganzwhg (dwellings), egid.
- OSM amenities: Overpass POST https://overpass-api.de/api/interpreter (body 'data='+urlencoded QL). Geocoding: https://nominatim.openstreetmap.org/search?q=...&format=json. Compute haversine/bearing yourself.

Reason explicitly about why you run each command — your thinking is the saved trace of the investigation.`;

const TASK = `The images above and the text below are a property listing. Find the property's exact street address and cadastral parcel with your computer. Work step by step, verify visually against the aerials, and call submit_answer when you are confident.`;

// A content fingerprint of the exact prompt (SYSTEM + TASK) a run is governed
// by. Stamped onto every job at start and saved to prompt.txt, so a past run's
// cost and reasoning are always attributable to the precise prompt that
// produced them — otherwise a prompt edit + redeploy leaves the history in the
// dark about what was actually in force. Short hex of sha256 is enough to tell
// two prompt versions apart at a glance.
export const PROMPT_VERSION = createHash("sha256")
  .update(`${SYSTEM}\n---TASK---\n${TASK}`)
  .digest("hex")
  .slice(0, 12);

function initialContent(
  images: AgentImage[],
  listingText: string | undefined,
): Anthropic.Messages.ContentBlockParam[] {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    blocks.push({ type: "text", text: `Listing photo ${i + 1} (saved as photo${i + 1}.jpg):` });
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  });
  blocks.push({
    type: "text",
    text:
      `${TASK}\n\nYou are already in your working directory; ${images.length} listing photo(s) are saved there as photo1.jpg … photo${images.length}.jpg. Read them with read_file, and save everything you fetch there too (relative paths only — do not cd).` +
      `\n\nListing text:\n${listingText ? `"""${listingText}"""` : "(none provided)"}`,
  });
  return blocks;
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s;
}

// Periodic anti-over-search nudge. Escalates as the step budget runs down so the
// model reviews its best candidate and commits instead of scanning forever.
function convergeReminder(step: number, max: number): string | null {
  if (step >= max - 15)
    return `[system-reminder] You are near the ${max}-step limit. Reach a conclusion now — an HONEST one. If the evidence has converged on one property, submit_answer with it. If it has not, submit your tightest defensible area with found=false and your ranked candidates. Do NOT fabricate a precise address just to finish, and do not open new searches.`;
  if (step >= 24 && (step - 24) % 12 === 0)
    return `[system-reminder] ${step} steps in. Stop and assess your strongest candidate: does it match EVERY hard signal in the listing (area/footprint, era, floors, orientation, background landmarks, amenity distances)? If the signals CONVERGE, that is confirmation — submit_answer now and do not reopen the search (re-searching after convergence is how the right property gets discarded). If they do NOT converge, name the single check that would resolve it and do only that — or conclude honestly (found=false + candidates). Do not keep scanning the same way, and do not commit just because a candidate is the "best" of a weak field.`;
  return null;
}

// The model sometimes addresses files as if from the repo root ("runs/<id>/x")
// even though it is already inside the run dir. Strip that redundant prefix so
// the read/write resolves instead of ENOENT-ing on a doubled path.
function normalizePath(jobId: string, p: string): string {
  return p.replace(new RegExp(`^\\.?/?(runs/)?${jobId}/`), "");
}

// Pull the model's own reasoning (thinking + any visible text) out of a turn.
export function extractReasoning(content: Anthropic.Messages.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "thinking" && b.thinking) parts.push(b.thinking);
    else if (b.type === "text" && b.text) parts.push(b.text);
  }
  return clip(parts.join("\n\n").trim(), 20_000);
}

function coerceAnswer(input: Record<string, unknown>): Answer {
  const conf = String(input.confidence ?? "unknown") as Confidence;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const candsRaw = Array.isArray(input.candidates) ? input.candidates : [];
  return {
    found: Boolean(input.found),
    address: str(input.address),
    parcel: str(input.parcel),
    commune: str(input.commune),
    confidence: conf,
    latitude: num(input.latitude),
    longitude: num(input.longitude),
    reasoning: String(input.reasoning ?? ""),
    candidates: candsRaw.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return { parcel: str(o.parcel), address: str(o.address), note: String(o.note ?? "") };
    }),
    links: Array.isArray(input.links) ? input.links.filter((l): l is string => typeof l === "string") : [],
  };
}

// Start a fresh investigation. The whole conversation is persisted every turn
// (see runLoop) so the run survives a process restart.
export async function runInvestigation(
  job: Job,
  images: AgentImage[],
  listingText: string | undefined,
): Promise<void> {
  // Attribute this run to the exact prompt it will use: stamp the version and
  // save the full prompt text next to the trace. This is what lets a later
  // post-mortem know which prompt produced these costs and this reasoning.
  await stampPrompt(job);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initialContent(images, listingText) },
  ];
  await saveState(job, 0, messages);
  await runLoop(job, messages, 0);
}

// Record which prompt governs a run: the version hash on the job (persisted in
// job.json) and the verbatim prompt in prompt.txt (served via /:id/prompt).
async function stampPrompt(job: Job): Promise<void> {
  try {
    await writeFile(
      path.join(job.runDir, "prompt.txt"),
      `# SYSTEM (version ${PROMPT_VERSION})\n\n${SYSTEM}\n\n# TASK\n\n${TASK}\n`,
      "utf8",
    );
  } catch (err) {
    console.error(`[agent] failed to save prompt for ${job.id}:`, err);
  }
  await setPromptVersion(job, PROMPT_VERSION);
}

// Continue an investigation from its saved conversation — used both to recover a
// run that was mid-flight when the process died (a redeploy or crash) and to
// resume a run the user paused. The next process reloads the state and picks up
// exactly where it left off.
export async function resumeInvestigation(job: Job): Promise<void> {
  const state = await loadState(job.runDir);
  if (!state) {
    await finishJob(job, {
      status: "error",
      error: "Could not resume — no saved state was found.",
    });
    return;
  }
  // A paused job is not "running" until now; clear any stale flags and mark it
  // running so the client starts polling again.
  job.pauseRequested = false;
  job.cancelRequested = false;
  await finishJob(job, { status: "running" });
  // The prompt is read live each turn, so a run resumed after a redeploy will
  // finish under whatever prompt is now deployed. If that differs from the one
  // it started under, record the switch in the trace and re-stamp, so the
  // post-mortem isn't misled about which prompt governed the later turns.
  const changed = job.promptVersion && job.promptVersion !== PROMPT_VERSION;
  await addStep(job, {
    kind: "note",
    title: "Resumed",
    detail: changed
      ? `Continuing from turn ${state.turn}. Prompt changed since start (${job.promptVersion} → ${PROMPT_VERSION}); remaining turns run under the new prompt.`
      : `Continuing from turn ${state.turn}.`,
  });
  if (changed) await stampPrompt(job);
  await runLoop(job, state.messages, state.turn);
}

// The investigation loop, shared by fresh and resumed runs. `startTurn` is the
// number of model turns already completed, so the step budget and the
// convergence nudges stay consistent across a restart.
async function runLoop(
  job: Job,
  messages: Anthropic.Messages.MessageParam[],
  startTurn: number,
): Promise<void> {
  const client = new Anthropic();

  try {
    for (let i = startTurn; i < MAX_STEPS; i++) {
      if (job.cancelRequested) {
        await addStep(job, { kind: "note", title: "Stopped by the user" });
        await finishJob(job, {
          status: "cancelled",
          answer: coerceAnswer({ found: false, confidence: "unknown", reasoning: `Stopped by the user after ${i} steps.` }),
        });
        return;
      }
      // Pause boundary: `messages` currently ends on a user turn (a clean resume
      // point) and state.json is up to date, so the run can continue later. Keep
      // the saved state (the finally only clears it on a TERMINAL status).
      if (job.pauseRequested) {
        job.pauseRequested = false;
        await addStep(job, { kind: "note", title: "Paused by the user" });
        await finishJob(job, { status: "paused" });
        return;
      }

      const resp = await client.messages.create({
        model: job.model ?? MODEL,
        max_tokens: 16_000,
        // display: "summarized" so the model's reasoning is actually returned
        // (Opus 4.8 / Fable 5 omit thinking text by default) — that's the trace.
        // adaptive thinking is valid on both models (Fable rejects only
        // disabled/budget_tokens, which we never send).
        thinking: { type: "adaptive", display: "summarized" },
        // Cache the static tools + system prompt (re-sent every turn). The
        // breakpoint on the system block covers tools + system together.
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        // Top-level auto-caching rolls a second breakpoint over the growing
        // conversation — so the re-sent listing photos and the aerials the
        // model has already downloaded are read from cache, not reprocessed.
        cache_control: { type: "ephemeral" },
        messages,
      });

      // Record token usage for this turn (input includes cache traffic so the
      // total reflects what actually moved through the model).
      const u = resp.usage;
      if (u) {
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const inTok = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
        await addUsage(job, inTok, u.output_tokens ?? 0, cacheRead, cacheWrite);
      }

      if (resp.stop_reason === "refusal") {
        await finishJob(job, { status: "error", error: "The model declined to analyze this listing." });
        return;
      }

      const reasoning = extractReasoning(resp.content);
      if (reasoning) await addStep(job, { kind: "reasoning", title: "Reasoning", reasoning });

      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );
      if (toolUses.length === 0) {
        // Model stopped without a tool call — treat its text as the conclusion.
        await finishJob(job, {
          status: "done",
          answer: coerceAnswer({ found: false, confidence: "unknown", reasoning }),
        });
        return;
      }

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.name === "submit_answer") {
          const answer = coerceAnswer(tu.input as Record<string, unknown>);
          await addStep(job, {
            kind: "answer",
            title: answer.address ?? answer.parcel ?? (answer.found ? "Answer" : "No confident match"),
            detail: answer.reasoning,
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          await finishJob(job, { status: "done", answer });
          return;
        }
        const out = await dispatchTool(job, tu.name, tu.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      const content: Anthropic.Messages.ContentBlockParam[] = [...results];
      const nudge = convergeReminder(i + 1, MAX_STEPS);
      if (nudge) content.push({ type: "text", text: nudge });
      messages.push({ role: "user", content });
      // Checkpoint: the conversation now ends on a user turn — a clean point to
      // resume from if the process dies before the next model turn.
      await saveState(job, i + 1, messages);
    }

    await finishJob(job, {
      status: "done",
      answer: coerceAnswer({
        found: false,
        confidence: "unknown",
        reasoning: `Did not converge within ${MAX_STEPS} steps.`,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addStep(job, { kind: "error", title: "Investigation error", detail: message });
    await finishJob(job, { status: "error", error: message });
  } finally {
    // Drop the saved conversation only on a TERMINAL status. A "paused" job keeps
    // its state so it can be resumed; "running" would be a live loop.
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      await clearState(job);
    }
  }
}

// ---------------------------------------------------------------------------
// Resume state — the full conversation, persisted so a running investigation
// outlives the process. Written atomically (tmp + rename) so a crash mid-write
// can never leave a half-written, unparseable state file.
// ---------------------------------------------------------------------------
const STATE_FILE = "state.json";

interface ResumeState {
  turn: number;
  messages: Anthropic.Messages.MessageParam[];
}

async function saveState(
  job: Job,
  turn: number,
  messages: Anthropic.Messages.MessageParam[],
): Promise<void> {
  try {
    const abs = path.join(job.runDir, STATE_FILE);
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, JSON.stringify({ turn, messages } satisfies ResumeState));
    await rename(tmp, abs);
  } catch (err) {
    console.error(`[agent] could not save resume state for ${job.id}:`, err);
  }
}

async function loadState(runDir: string): Promise<ResumeState | null> {
  try {
    const raw = await readFile(path.join(runDir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as ResumeState;
    if (!Array.isArray(parsed.messages) || typeof parsed.turn !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearState(job: Job): Promise<void> {
  try {
    await rm(path.join(job.runDir, STATE_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

export async function dispatchTool(
  job: Job,
  name: string,
  input: Record<string, unknown>,
): Promise<Anthropic.Messages.ToolResultBlockParam["content"]> {
  if (name === "bash") {
    const command = String(input.command ?? "");
    const res = await runBash(job.runDir, command);
    const body =
      (res.stdout ? res.stdout : "") +
      (res.stderr ? `\n[stderr]\n${res.stderr}` : "") +
      (res.timedOut ? "\n[timed out]" : "") +
      (res.code !== 0 && res.code !== null ? `\n[exit ${res.code}]` : "");
    const trimmed = body.trim() || "(no output)";
    await addStep(job, {
      kind: "bash",
      title: clip(command, 200),
      detail: clip(trimmed, 4_000),
    });
    return clip(trimmed, MAX_TOOL_TEXT);
  }

  if (name === "write_file") {
    const p = normalizePath(job.id, String(input.path ?? ""));
    const content = String(input.content ?? "");
    try {
      const w = await writeSandboxFile(job.runDir, p, content);
      await addStep(job, { kind: "write", title: `wrote ${p}`, detail: `${w.bytes} bytes` });
      return `wrote ${p} (${w.bytes} bytes)`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await addStep(job, { kind: "error", title: `write ${p} failed`, detail: message });
      return `error: ${message}`;
    }
  }

  if (name === "read_file") {
    const p = normalizePath(job.id, String(input.path ?? ""));
    try {
      const r = await readSandboxFile(job.runDir, p);
      if (r.kind === "image") {
        await addStep(job, {
          kind: "read",
          title: `viewed ${r.relPath}`,
          detail: `${r.mediaType}, ${r.bytes} bytes`,
          image: `/runs/${job.id}/${r.relPath}`,
        });
        return [
          { type: "image", source: { type: "base64", media_type: r.mediaType, data: r.base64 } },
          { type: "text", text: `(viewed ${r.relPath}, ${r.bytes} bytes)` },
        ];
      }
      await addStep(job, { kind: "read", title: `read ${r.relPath}`, detail: `${r.bytes} bytes` });
      return clip(r.text, MAX_TOOL_TEXT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await addStep(job, { kind: "error", title: `read ${p} failed`, detail: message });
      return `error: ${message}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// Persist the listing photos into the run dir so the model can crop/inspect
// them as files (photo1.jpg, …), matching what it's shown inline.
export async function saveListingPhotos(runDir: string, images: AgentImage[]): Promise<void> {
  await Promise.all(
    images.map((img, i) => {
      const ext = img.mediaType.split("/")[1].replace("jpeg", "jpg");
      return writeFile(path.join(runDir, `photo${i + 1}.${ext}`), Buffer.from(img.base64, "base64"));
    }),
  );
}

const EXT_MEDIA: Record<string, AgentImage["mediaType"]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

// Read the saved listing photos (photo1.jpg, …) back out of a run dir, in order.
// Used to relaunch a past investigation from its original photos.
export async function loadListingPhotos(runDir: string): Promise<AgentImage[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch {
    return [];
  }
  const photos = names
    .map((n) => n.match(/^photo(\d+)\.(jpe?g|png|webp|gif)$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const images: AgentImage[] = [];
  for (const m of photos) {
    const buf = await readFile(path.join(runDir, m[0]));
    images.push({ base64: buf.toString("base64"), mediaType: EXT_MEDIA[m[2].toLowerCase()] ?? "image/jpeg" });
  }
  return images;
}
