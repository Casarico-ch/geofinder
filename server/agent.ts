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

const SYSTEM = `You are GeoFinder — an autonomous OSINT investigator that finds the EXACT street address and cadastral parcel of a Swiss property from its real-estate listing (photos + text + municipality).

You are NOT given any geo tools. You are given a real computer — a Linux sandbox with Node.js and network access — and you create your own access to public data by writing and running code, exactly as a human analyst would. There is no fixed pipeline: the method is yours to invent, test, discard, and refine. Correctness is what matters — but reach it EFFICIENTLY: lead with the strongest key, narrow in code, and verify decisively. A good analyst pins the door in a handful of decisive moves, not by brute-forcing dozens of aerials. Get to the exact door.

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
2. GROUND the deduction against real cadastre/aerial/register data — that is what turns "an area" into ONE building. Pick the MOST DISCRIMINATING queryable fact for THIS listing and put it in the WHERE clause of a cadastre/register query — filter with it, don't save it as a final check. The terrain area is usually the strongest single key (near-unique inside a commune) — BUT only when it maps to one parcel. A large "parc/domaine" (say ≥ ~2500 m²) around a modest house, or a terrain that matches NO single parcel, is an ASSEMBLED estate: the land will never be one parcel, so switch the key immediately from the LAND to the BUILDING. The building keys are strong and queryable: FOOTPRINT area (often equals the advertised sous-sol / emprise m²) + construction era + floors + basement levels + dwelling count (1 logement), plus the GWR HEATING type (mazout/fioul, bois/granulés, PAC, gaz — a "chauffage mixte fioul + bois" is near-unique). Combine two of these in one filtered query and a whole commune collapses to a handful of EGIDs. Also usable: MITOYENNETÉ (a semi-detached villa's footprint shares a wall), distance-ring triangulation on named amenities, and ORIENTATION / bearing to a background landmark.
3. ALWAYS verify visually — but economically. Do NOT download and read one aerial per candidate. First narrow to a SHORT list in code (step 2), then verify it on ONE wide swisstopo aerial that covers the whole cluster (read it once, spot the matching roof/garden/pool/veranda/driveway), and only THEN zoom a tight bbox into the best 1–2. Reading dozens of single-plot aerials is brute-forcing — if you have viewed more than ~10 aerials you have skipped the narrowing.
4. Iterate relentlessly, but by the strongest lever. If one method stalls, switch angle. To get the exact street + house number, ask the register (GWR strname_deinr at the parcel) — do NOT build road-topology / dead-end solvers over OSM (that thrashes). Check an "impasse / cul-de-sac / fond de …" claim by eye on the aerial, or from the named street's own endpoints in one Overpass query — not a general graph solver. Confirm a mitoyenne's twin. Don't stop at "the right area" — drive to the exact address, then re-check it against every photo.
5. submit_answer with the address, parcel, coordinates, honest confidence, your full reasoning, the ranked candidates, and DIRECT links (cadastre extract + satellite + map). Never fabricate — every address must come from real data you fetched. If you truly cannot pin it, return the tightest honest area with found=false.

WORK EFFICIENTLY — funnel, don't brute-force (this is how you pin it in a handful of moves)
- FUNNEL: hard-key filter (terrain area, in one cadastre query) → rank the shortlist by secondary hard signals IN CODE (footprint, floors, era, basement, mitoyenneté, orientation) → only then look at aerials, best candidate first. Narrowing before you look is the whole game; broadening the net after a shortlist exists is the classic time-sink.
- AERIAL ECONOMY: one wide aerial over the cluster beats many small ones. Each aerial you read is re-processed every turn, so a run with 40+ aerial views is mostly waste. Aim for a single overview + one or two zoom-ins.
- PREFER SITG / GWR over Overpass/Nominatim: the cadastre and register have no rate limits and answer the decisive questions (area, footprint, floors, era, exact address). Reach for Overpass only for amenity distances, and never sit in a sleep/retry loop against a rate limit — switch source instead.
- Once step 2's key + one aerial + the register agree on a parcel, that IS convergence — commit (see below). Do not keep scanning.

WHEN TO COMMIT — confidence, not exhaustion, and never fabrication
Commit when the EVIDENCE confirms one property — not because you have searched a lot, and not because a candidate is merely the best of a weak field.
- Confirmation = independent signals CONVERGING on one parcel: the primary key (terrain area — or footprint + era + floors + mitoyenneté) matches, AND the aerial matches the photos (roof, garden, pool, veranda, driveway), AND the register/address is consistent. When several independent checks all point to the same building, THAT is your confirmation — submit_answer then, and do NOT reopen the search. Re-searching after the evidence has already converged is exactly how the correct property gets discarded.
- Keep a running shortlist. For your strongest candidate, actively test it against EVERY hard signal in the listing (area, rooms, floors, year, orientation/sun, any background landmark, amenity distances). Convergence across signals is what earns a commit — a single loose match is not enough.
- If the signals do NOT converge and you cannot close the gap, do NOT invent a door number to "finish." Submit your honest conclusion instead: the tightest defensible area with found=false (or a deliberately low confidence), plus your ranked candidates and the one check that would resolve them. An honest "neighbourhood, not pinned" beats a confident wrong address.
- The only real tie is two adjacent units that share every signal (a mitoyenne pair / twin address). There, submit the more likely one at "building" confidence and list the other — that is confident-enough, not a guess.

DON'T WRONGLY REJECT THE RIGHT PROPERTY (this is how the answer is actually lost)
The correct property is usually lost by ELIMINATING it on one soft or misread signal — not by never finding it. Before you discard a candidate that already fits most signals, reconcile the apparent mismatch; it is noisy or measured wrong far more often than it is decisive:
- Register/cadastre year is the ORIGINAL construction year, not renovation — a 1960s house can look modern in the photos. Do not reject on "looks newer than the register".
- Listing distances are WALKING distances (~1.15–1.3× straight-line). Do not reject a candidate because your straight-line measurement is shorter than the stated one.
- Living/habitable area vs building footprint differ by the number of floors and the basement — reconcile via NIVEAUX_HORSOL / NIVEAUX_SSOL before concluding the sizes "don't match".
- "Vue lac" / "proche du lac" is a view or a short walk, NOT necessarily lakefront; a private pontoon can be a few minutes away. Do not require the house to sit on the shore.
- Register/cadastre fields can be stale, generalized, or attached to a neighbouring sub-building. Treat a single conflicting field as a question to resolve, not a verdict.
Reject a strong candidate ONLY on a hard, verified contradiction (e.g. the parcel area is unambiguously different from a stated terrain area, or the commune is wrong). Otherwise keep it on the shortlist and resolve the mismatch — do not move on and forget it.

FIELD NOTES — useful keyless public sources (starting points, not limits; set a User-Agent header on every request)
- Geneva cadastre (SITG), ArcGIS REST, params f=json&outSR=4326:
  · Parcels: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_PARCELLE_MENSU/MapServer/0/query — fields NO_PARCELLE, SURFACE, LIEN_WWW, COMMUNE. Filter with where=COMMUNE='X' AND SURFACE>=a AND SURFACE<=b, or spatially (geometry=lon,lat & geometryType=esriGeometryPoint, or an esriGeometryEnvelope 'lonmin,latmin,lonmax,latmax', inSR=4326, spatialRel=esriSpatialRelIntersects). returnGeometry=true → geometry.rings → centroid = average of the outer ring vertices.
  · Buildings: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/MapServer/0/query — fields COMMUNE, DESTINATION, EPOQUE_CONSTRUCTION, ANNEE_CONSTRUCTION, NIVEAUX_HORSOL (above-ground floors), NIVEAUX_SSOL (basement levels), SURFACE (footprint m²), EGID. (ANNEE_CONSTRUCTION is often empty — EPOQUE_CONSTRUCTION like 'Période de 1971 à 1980' is more reliable.)
- Zürich cadastre (and most other cantons) — the official survey (Amtliche Vermessung) on geodienste.ch, free for ZH. This is your ZH equivalent of the SITG parcel/building layers. WFS 2.0, returns GML you parse (try &OUTPUTFORMAT=geojson too); a WGS84 bbox works directly, axis order lat,lon:
  · Parcels: https://geodienste.ch/db/av_0/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:RESF&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX={latmin},{lonmin},{latmax},{lonmax},urn:ogc:def:crs:EPSG::4326&COUNT=30 — each ms:RESF has <ms:Nummer> (parcel no.), <ms:Flaeche> (terrain area m² — the villa key, same role as SITG SURFACE), <ms:EGRIS_EGRID> (EGRID), <ms:BFSNr>. Geometry is gml:posList (lat lon pairs); centroid = average of the ring vertices.
  · Addresses: TYPENAMES=ms:HADR (same base URL/params) → <ms:Strassenname>, <ms:Hausnummer>, <ms:PLZ>, <ms:Ortschaftsname>, <ms:GWR_EGID> — the exact street + number for a point/bbox.
  · Building footprints: TYPENAMES=ms:LCSF (Bodenbedeckung) → land-cover polygons; the 'Gebaeude' ones are building footprints (area from the geometry).
  · 'av_0' is Zürich's instance. For another canton, find its free WFS URL in https://www.geodienste.ch/info/services.csv?base_topics=av&language=de (WFS column; 'Frei erhältlich' = free); the layer names ms:RESF / ms:HADR are the same everywhere. If a service ever needs LV95, convert with https://geodesy.geo.admin.ch/reframe/wgs84tolv95?easting={lon}&northing={lat}&format=json.
- swisstopo aerial (SWISSIMAGE) WMS GetMap → a JPEG you download then read_file: https://wms.geo.admin.ch/?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ch.swisstopo.swissimage&STYLES=&CRS=EPSG:4326&BBOX={latmin},{lonmin},{latmax},{lonmax}&WIDTH=1200&HEIGHT=1200&FORMAT=image/jpeg  (WMS 1.3.0 + EPSG:4326 uses lat,lon axis order; make the bbox square in metres: dLat=span/2/111320, dLon=dLat/cos(lat)). Switzerland only.
- Swiss building register (GWR) via geo.admin identify: https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry={lon},{lat}&geometryType=esriGeometryPoint&layers=all:ch.bfs.gebaeude_wohnungs_register&tolerance=15&sr=4326&geometryFormat=geojson&mapExtent={lon-0.002},{lat-0.0015},{lon+0.002},{lat+0.0015}&imageDisplay=800,600,96 — each result's properties has strname_deinr (street + number), gbauj (year), gastw (floors), ganzwhg (dwellings), ggdename (commune), egid.
- Overpass (OSM) for schools/bus/motorway/POIs: POST https://overpass-api.de/api/interpreter with body 'data=' + urlencoded Overpass-QL and a User-Agent. Nominatim geocoding: https://nominatim.openstreetmap.org/search?q=...&format=json.
- Compute haversine distance and bearing yourself in code.

COVERAGE: Geneva has the richest cadastre (SITG); Zürich and most other cantons expose the official cadastre (parcels + addresses) on geodienste.ch. swisstopo aerial and the GWR register cover ALL of Switzerland. So outside Geneva your primary keys are the GWR street+number and the geodienste parcel area (ms:RESF Flaeche) — use them exactly as you use SITG in Geneva: match the terrain area, confirm the aerial against the photos, read the street number. For a canton with no free cadastre, lean on GWR + OSM + aerial and be honest about confidence.

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
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initialContent(images, listingText) },
  ];
  await saveState(job, 0, messages);
  await runLoop(job, messages, 0);
}

// Continue an investigation that was mid-flight when the process died (a
// redeploy or crash). The next process reloads the saved conversation and picks
// up exactly where it left off — the run is independent of any single container.
export async function resumeInvestigation(job: Job): Promise<void> {
  const state = await loadState(job.runDir);
  if (!state) {
    await finishJob(job, {
      status: "error",
      error: "Interrupted by a server restart (no resumable state was saved).",
    });
    return;
  }
  await addStep(job, {
    kind: "note",
    title: "Resumed after a server restart",
    detail: `The investigation continued automatically from turn ${state.turn}.`,
  });
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
    // Once the job is no longer running, the saved conversation is dead weight —
    // drop it so a resumable-jobs scan on the next boot ignores this run.
    if (job.status !== "running") await clearState(job);
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
