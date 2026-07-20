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
} from "./jobs";

const MODEL = "claude-opus-4-8";
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 150);
const MAX_TOOL_TEXT = 16_000; // chars of command output fed back to the model

export interface AgentImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

const TOOLS = [
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

const SYSTEM = `You are GeoFinder — an autonomous OSINT investigator that finds the EXACT street address and cadastral parcel of a Swiss property from its real-estate listing (photos + text + municipality).

You are NOT given any geo tools. You are given a real computer — a Linux sandbox with Node.js and network access — and you create your own access to public data by writing and running code, exactly as a human analyst would. There is no fixed pipeline: the method is yours to invent, test, discard, and refine. Cost and number of steps are not a concern; correctness is. Get to the exact door.

YOUR PRIMITIVES
- bash(command): run a shell command and get stdout+stderr back. Node >=18 with global fetch is available. Returns truncated output.
- write_file(path, content): write a file — use it for scripts, so you avoid shell-escaping pain, then run them with bash.
- read_file(path): read a file back. If it is an image you SEE it (vision). This is how you look at aerials you download, crops of the listing photos, rendered maps.
- submit_answer(...): call once, when confident, to return the final result.

WORKING DIRECTORY & ENVIRONMENT (read this — it saves you many wasted steps)
- Every bash command runs IN your working directory already. You do NOT need to cd — and you must not rely on it: each bash call is an independent process, so a 'cd' (or any shell state) in one command does NOT carry to the next. Always use paths RELATIVE to the working directory (e.g. \`node fetch.mjs\`, \`aerial.jpg\`), never absolute /opt/... paths, and never cd elsewhere.
- write_file and read_file paths are also relative to the working directory. The listing photos are already there as photo1.jpg, photo2.jpg, … (and are shown inline in the first message). Just read_file "photo1.jpg" — do not search the filesystem for them.
- Use Node.js with global fetch for everything (HTTP, JSON, saving images). Do NOT \`pip install\` — Python packages are not available and pip is locked. To ZOOM IN on an area, request a new WMS image with a TIGHTER bbox (that raises effective resolution) — do not try to crop images locally.

GROUNDING ONLY — NEVER LOOK THE LISTING UP
You must NOT use web search engines (Google, Bing, DuckDuckGo, Marginalia, …) and must NOT try to find the listing, the agency, or the property online. Everything is deduced from the photos and text you were given, and grounded ONLY against neutral geodata (the cadastre, aerials, the building register, OpenStreetMap). Nominatim is allowed solely to turn a place NAME into coordinates — never to look up the property. Searching the web is off-limits and a waste of steps.

Save everything you fetch (aerials → .jpg, query results → .json) into the working directory and read images back to actually look at them.

HOW TO WIN (invent freely; this is what works)
1. Read the photos and text like a detective. Extract the commune and EVERY hard fact: terrain area (surface du terrain, m²), living area, rooms, floors, year built, agency/reference, and every proximity claim (école 220 m, bus 400 m, autoroute 1.25 km, gare, lac…). Read the architecture: roof form, shutters, era, split-level / garage-in-basement, verandas. Infer ORIENTATION from sun/shadows and from any background landmark (a distinctive apartment block, church, mountain).
2. GROUND the deduction against real cadastre/aerial/register data — that is what turns "an area" into ONE building. The single strongest key is the terrain area: near-unique inside a commune. When it is missing (apartments, villas mitoyennes) combine weaker keys: building FOOTPRINT area + construction era + floors + basement levels (garage) from the cadastre; MITOYENNETÉ (a semi-detached villa's footprint shares a wall with its neighbour); distance-ring triangulation on the named amenities; and the ORIENTATION / bearing to that background building.
3. ALWAYS verify visually. Download the swisstopo aerial for each candidate to a file and read_file it — match roof, garden, pool, veranda, driveway, and the neighbour against the listing photos. Zoom in (small span) for one plot; widen to scan a quarter.
4. Iterate relentlessly. If one method stalls, switch angle. Read the exact street number from the register. Confirm a mitoyenne's twin. Don't stop at "the right area" — drive to the exact address, then re-check it against every photo.
5. submit_answer with the address, parcel, coordinates, honest confidence, your full reasoning, the ranked candidates, and DIRECT links (cadastre extract + satellite + map). Never fabricate — every address must come from real data you fetched. If you truly cannot pin it, return the tightest honest area with found=false.

WHEN TO COMMIT — do not over-search (this is a real failure mode)
The goal is the CORRECT answer, not certainty. The moment ONE candidate satisfies the listing's primary key (terrain area — or footprint + era + floors + mitoyenneté for a villa/apartment) AND a single aerial or register check corroborates it, call submit_answer. Do NOT keep scanning for a marginally "better" match: agents that keep exploring after finding the right property waste steps and, worse, talk themselves out of the correct answer and move on to the wrong one.
- Keep a running shortlist of your best candidates and why each fits. Never discard a strong match just to look further.
- Before fetching yet another area, ask yourself: "does my current best candidate already satisfy the hard keys?" If yes — verify it once, then submit. Don't reopen the search.
- If you're genuinely torn between two adjacent units (e.g. a mitoyenne pair, or a twin address), submit the more likely one at "building" confidence and list the other as a candidate. That IS the correct outcome — not a reason to keep searching.
- A confirmed match you can defend beats an endless hunt for perfection.

FIELD NOTES — useful keyless public sources (starting points, not limits; set a User-Agent header on every request)
- Geneva cadastre (SITG), ArcGIS REST, params f=json&outSR=4326:
  · Parcels: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_PARCELLE_MENSU/MapServer/0/query — fields NO_PARCELLE, SURFACE, LIEN_WWW, COMMUNE. Filter with where=COMMUNE='X' AND SURFACE>=a AND SURFACE<=b, or spatially (geometry=lon,lat & geometryType=esriGeometryPoint, or an esriGeometryEnvelope 'lonmin,latmin,lonmax,latmax', inSR=4326, spatialRel=esriSpatialRelIntersects). returnGeometry=true → geometry.rings → centroid = average of the outer ring vertices.
  · Buildings: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/MapServer/0/query — fields COMMUNE, DESTINATION, EPOQUE_CONSTRUCTION, ANNEE_CONSTRUCTION, NIVEAUX_HORSOL (above-ground floors), NIVEAUX_SSOL (basement levels), SURFACE (footprint m²), EGID. (ANNEE_CONSTRUCTION is often empty — EPOQUE_CONSTRUCTION like 'Période de 1971 à 1980' is more reliable.)
- swisstopo aerial (SWISSIMAGE) WMS GetMap → a JPEG you download then read_file: https://wms.geo.admin.ch/?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ch.swisstopo.swissimage&STYLES=&CRS=EPSG:4326&BBOX={latmin},{lonmin},{latmax},{lonmax}&WIDTH=1200&HEIGHT=1200&FORMAT=image/jpeg  (WMS 1.3.0 + EPSG:4326 uses lat,lon axis order; make the bbox square in metres: dLat=span/2/111320, dLon=dLat/cos(lat)). Switzerland only.
- Swiss building register (GWR) via geo.admin identify: https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry={lon},{lat}&geometryType=esriGeometryPoint&layers=all:ch.bfs.gebaeude_wohnungs_register&tolerance=15&sr=4326&geometryFormat=geojson&mapExtent={lon-0.002},{lat-0.0015},{lon+0.002},{lat+0.0015}&imageDisplay=800,600,96 — each result's properties has strname_deinr (street + number), gbauj (year), gastw (floors), ganzwhg (dwellings), ggdename (commune), egid.
- Overpass (OSM) for schools/bus/motorway/POIs: POST https://overpass-api.de/api/interpreter with body 'data=' + urlencoded Overpass-QL and a User-Agent. Nominatim geocoding: https://nominatim.openstreetmap.org/search?q=...&format=json.
- Compute haversine distance and bearing yourself in code.

COVERAGE: the SITG cadastre is canton Geneva only; swisstopo aerial and the GWR register cover all of Switzerland. Elsewhere, lean on OSM + aerial reasoning and be honest about confidence.

Reason explicitly about WHY you run each command — your thinking is saved as the documented trace of the investigation.`;

const TASK = `The images above and the text below are a property listing. Find the property's exact street address and cadastral parcel with your computer. Work step by step, verify visually against the aerials, and call submit_answer when you are confident.`;

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

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s;
}

// Periodic anti-over-search nudge. Escalates as the step budget runs down so the
// model reviews its best candidate and commits instead of scanning forever.
function convergeReminder(step: number, max: number): string | null {
  if (step >= max - 15)
    return `[system-reminder] You are near the ${max}-step limit. Commit now: call submit_answer with your best candidate at honest confidence, listing any alternates as candidates. Do not open new searches.`;
  if (step >= 24 && (step - 24) % 12 === 0)
    return `[system-reminder] ${step} steps in. If a candidate already satisfies the listing's primary key and an aerial or register check corroborates it, call submit_answer NOW — do not keep scanning for a better match; that is how the correct property gets discarded. If you are genuinely torn between two, submit the more likely one at "building" confidence and list the other as a candidate. State your current best candidate before doing anything else.`;
  return null;
}

// The model sometimes addresses files as if from the repo root ("runs/<id>/x")
// even though it is already inside the run dir. Strip that redundant prefix so
// the read/write resolves instead of ENOENT-ing on a doubled path.
function normalizePath(jobId: string, p: string): string {
  return p.replace(new RegExp(`^\\.?/?(runs/)?${jobId}/`), "");
}

// Pull the model's own reasoning (thinking + any visible text) out of a turn.
function extractReasoning(content: Anthropic.Messages.ContentBlock[]): string {
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

// Run one investigation to completion, streaming documented steps into `job`.
export async function runInvestigation(
  job: Job,
  images: AgentImage[],
  listingText: string | undefined,
): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initialContent(images, listingText) },
  ];

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      if (job.cancelRequested) {
        await addStep(job, { kind: "note", title: "Stopped by the user" });
        await finishJob(job, {
          status: "cancelled",
          answer: coerceAnswer({ found: false, confidence: "unknown", reasoning: `Stopped by the user after ${i} steps.` }),
        });
        return;
      }

      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 16_000,
        // display: "summarized" so the model's reasoning is actually returned
        // (Opus 4.8 omits thinking text by default) — that's the documented trace.
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
  }
}

async function dispatchTool(
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
  const { writeFile } = await import("node:fs/promises");
  await Promise.all(
    images.map((img, i) => {
      const ext = img.mediaType.split("/")[1].replace("jpeg", "jpg");
      return writeFile(path.join(runDir, `photo${i + 1}.${ext}`), Buffer.from(img.base64, "base64"));
    }),
  );
}
