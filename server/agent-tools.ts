// The agent's tools: the schemas the model sees and the handler for each call
// (bash, files, the candidate checklist, close looks, map views).
import Anthropic from "@anthropic-ai/sdk";
import {
  runBash,
  writeSandboxFile,
  readSandboxFile,
} from "./sandbox";
import { renderCandidateRoofs, readRoofPng } from "./roofs";
import { buildingByEgid, sameRegisterPlot } from "./gwr";
import { annotateFit, factRows, fitText, listingFacts, plotAt, plotGroupFor, strongFit } from "./proof";
import { shortlistBuildings } from "./shortlist";
import { renderContactSheet } from "./sheet";
import {
  type LedgerEntry,
  type SearchState,
  addCandidates,
  coverageText,
  leavePrimaryBlocked,
  nextToView,
  unchecked,
} from "./search";
import { type Job, addStep, saveSearch } from "./jobs";
import { DIRECTIONS, type Direction } from "./locate";
import { shapeAt } from "./neighbours";
import { viewFrom } from "./view";
import { asText } from "./text";
import { addFromRegister, nearOf, searchOf, text } from "./agent-ledger";
import { flatsFor } from "./prove";

const MAX_TOOL_TEXT = 16_000; // chars of command output fed back to the model
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

export const TOOLS = [
  ...COMPUTER_TOOLS,
  {
    name: "record_signature",
    description:
      "Call this ONCE, first, before searching: from the listing photos, describe what this property looks like FROM ABOVE, as an ordered list of aerial-visible clues, biggest discriminator first. LEAD with the hard, cadastre-matchable STRUCTURE — number of floors, the main building's rough footprint in m², attached-vs-detached and position in a row, a second building in the garden, veranda/conservatory, pool — because those are what filter the building register. Then topology/context ('bar of attached houses' / 'detached villa next to a forest' / 'next to a church'), then the plot (garden size, shape, roads on which sides), then fine roof detail (shape, dormers, solar). Rank vegetation (hedges, topiary, trees) LAST — it barely shows from above. This signature drives the enumerate-and-filter search. Also fill `location` with what the photos say about WHERE the house is (which way the slope falls, landmarks seen from it and in which direction): the shortlist puts the houses whose surroundings fit first.",
    input_schema: {
      type: "object",
      properties: {
        clues: {
          type: "array",
          items: { type: "string" },
          description: "Ordered clues, biggest/most-discriminating filter FIRST, finest detail last.",
        },
        schematic_svg: {
          type: ["string", "null"],
          description: "Optional: a small top-down SVG sketch of the target (house, row, garden outline, positions of tree/path/pool/dependency, which sides have roads).",
        },
        location: {
          type: "object",
          description:
            "WHERE the photos place the house — read it from views through windows, from the terrace or garden, and from the slope. This ORDERS the shortlist (best fit first); it never removes a house, so give what the photos show, with an honest confidence, and omit what they don't.",
          properties: {
            slope: {
              type: "object",
              description: "The direction the ground falls away from the house (its view side), as on a map — read it from the photos (the view, shadows, the terrain). A listing's 'plein sud' / 'versant sud' / 'Südhang' usually means sunny, not where the slope falls (a chalet sold as 'versant sud' can stand on a slope that falls west), so text alone is a guess. Use 'flat' for level ground.",
              properties: {
                faces: { type: "string", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "flat"] },
                confidence: { type: "string", enum: ["sure", "likely", "guess"] },
              },
              required: ["faces", "confidence"],
            },
            landmarks: {
              type: "array",
              description: "Distinctive things visible from the house: a church or chapel, a named peak, a lake, a village. Direction is where it lies SEEN FROM THE HOUSE (map compass: work it out from the sun, shadows, the slope or known geography). Omit name for an unnamed local church. ALSO every place the listing's DESCRIPTION names near the house — a sports centre, a school, the station, a shop, the lake shore ('à proximité du centre sportif du Grand-Donzel', '5 Gehminuten zum Bahnhof'): kind 'other' (or 'place' for a village or quarter), its proper name, distance_m from what the text says (a walking minute ≈ 80 m, 'proximité' ≈ 300 m) and no direction unless the text gives one.",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["church", "peak", "lake", "place", "other"] },
                  name: { type: "string", description: "its proper name if you know it, e.g. 'Matterhorn', 'Lac Léman'" },
                  direction: { type: "string", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] },
                  distance_m: { type: "number", description: "rough distance from the house, if the photos allow it" },
                  confidence: { type: "string", enum: ["sure", "likely", "guess"] },
                },
                required: ["kind", "confidence"],
              },
            },
            neighbours: {
              type: "array",
              description:
                "The buildings the photos show NEXT TO the house (up to 6), and open sides — the strongest way to tell look-alike houses apart, because swissBUILDINGS3D has every neighbour's outline, height and roof and each candidate's surroundings are compared with these. Side: a compass point if you can tell it (sun, shadows, slope), otherwise where it stands as seen in the photo of the house's front: left, right, behind, front — the pattern is then tried in every orientation. Fill only what you can see; one sure neighbour beats three guesses.",
              items: {
                type: "object",
                properties: {
                  side: { type: "string", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "left", "right", "behind", "front"] },
                  distance_m: { type: "number", description: "the gap between the two buildings, roughly" },
                  size: { type: "string", enum: ["smaller", "similar", "bigger"], description: "its footprint against the house's" },
                  height: { type: "string", enum: ["lower", "similar", "taller"] },
                  roof: { type: "string", enum: ["flat", "pitched"] },
                  ridge: { type: "string", enum: ["parallel", "perpendicular"], description: "its ridge against the house's ridge, both pitched" },
                  none: { type: "boolean", description: "true: NO building on that side within ~40 m (field, road, lake, garden)" },
                  confidence: { type: "string", enum: ["sure", "likely", "guess"] },
                },
                required: ["confidence"],
              },
            },
          },
        },
      },
      required: ["clues"],
    },
  },
  {
    name: "shortlist_buildings",
    description:
      "Enumerate EVERY home in a Swiss commune — any canton (from the federal building register GWR), new builds (planned or being built) and buildings with shops or offices included — RANKED, nothing removed. The ranking uses what the LISTING states (the plot of its land area for a house, a flat of its living area for a flat, year built, homes in the building); candidates that fit on every checked fact come first and say so. Your estimates (floors, footprint, dwellings) only reorder, so a wrong guess costs places, not the house. Every candidate returned goes into your checklist; look at them with view_candidates and record a verdict with mark_candidates. Call again with the same commune for the next page. Do NOT re-filter the result by era or exact floors.",
    input_schema: {
      type: "object",
      properties: {
        commune: { type: "string", description: "the commune, e.g. 'Denges' or 'Saint-Sulpice (VD)'" },
        floors: { type: "number", description: "your estimate of the levels the register counts: a semi-basement + 2 storeys + attic is 4. Orders only." },
        footprintM2: { type: "number", description: "your estimate of THIS building's ground footprint in m² — for a flat, semi-detached or terraced house the register's entry is often just its own part of the block, not the whole block. NOT the listing's living area. Orders only." },
        dwellings: { type: "number", description: "homes in the building if the listing says (\"PPE de deux logements\" = 2). Orders only." },
        attached: { type: "boolean", description: "Geneva only: true for an attached/row house, false if free-standing; omit if unsure" },
        maxResults: { type: "number" },
      },
      required: ["commune"],
    },
  },
  {
    name: "view_candidates",
    description:
      "LOOK at shortlisted candidates fast: returns ONE contact-sheet image of up to 16 north-up aerial tiles (SWISSIMAGE, ~90 m across), each centred on a candidate building (red cross) and numbered, plus the legend number → EGID/address. Omit egids to get the next 16 unviewed candidates of your checklist (optionally of one commune). Compare each tile against the listing's photos and signature, then pass your verdicts as `marks` on the next view_candidates call (one turn per sheet), or with mark_candidates. Zoom on a tile with a tighter WMS aerial only when it is a real contender.",
    input_schema: {
      type: "object",
      properties: {
        egids: { type: "array", items: { type: "string" }, description: "specific candidates to show (max 16); omit for the next unviewed ones" },
        commune: { type: "string", description: "with no egids: take the next unviewed candidates of this commune" },
        marks: {
          type: "array",
          description: "your verdicts on the PREVIOUS sheet, recorded before the next one is drawn (same shape as mark_candidates)",
          items: {
            type: "object",
            properties: {
              egid: { type: "string" },
              verdict: { type: "string", enum: ["rejected", "possible", "match"] },
              reason: { type: "string" },
            },
            required: ["egid", "verdict", "reason"],
          },
        },
      },
    },
  },
  {
    name: "mark_candidates",
    description:
      "Record your verdict on candidates you have LOOKED at (view_candidates): rejected (with the visible reason — 'hip roof, no separate garage'), possible, or match. This is the checklist that proves a commune was exhausted; candidates you never viewed can't be rejected.",
    input_schema: {
      type: "object",
      properties: {
        marks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              egid: { type: "string" },
              verdict: { type: "string", enum: ["rejected", "possible", "match"] },
              reason: { type: "string" },
            },
            required: ["egid", "verdict", "reason"],
          },
        },
      },
      required: ["marks"],
    },
  },
  {
    name: "inspect_candidate",
    description:
      "Take a CLOSE LOOK at one candidate: its fact sheet (register floors, dwellings and footprint, and its cadastral plot with the plot's area, each checked against the listing's own numbers ✓/✗), a tight 40 m north-up aerial centred on it, and its real 3D roof. Required before you reject a candidate the shortlist flags STRONG FIT, and before the candidate you submit as the answer — an exact answer must be a candidate you inspected and marked match. Pass the EGID from your checklist; a building not on it can be given by lat/lon and is added.",
    input_schema: {
      type: "object",
      properties: {
        egid: { type: "string" },
        lat: { type: "number", description: "only for a building not on your checklist" },
        lon: { type: "number" },
      },
    },
  },
  {
    name: "view_from",
    description:
      "What a candidate house can actually SEE, from swisstopo's terrain model out to 25 km: per direction, the skyline (how high and how far), whether the ground falls away in front (a view down), a slope blocking the view close by, and a dead-flat surface in view below (a lake, or a valley floor). Use it when the photos show a view — through a window, from a terrace or a balcony: a lake below to the south, mountains far off, a hillside right in front. Look-alike houses a few hundred metres apart see very different things. Pass the candidate (EGID from your checklist, or lat/lon) and the directions the photos look in, if you know them (all 8 otherwise).",
    input_schema: {
      type: "object",
      properties: {
        egid: { type: "string" },
        lat: { type: "number" },
        lon: { type: "number" },
        directions: { type: "array", items: { type: "string", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] } },
      },
    },
  },
  {
    name: "render_roofs",
    description:
      "Given your shortlist of candidate buildings (each with lat/lon), render each one's REAL roof from swissBUILDINGS3D — swisstopo's national 3D building models — as a clean two-angle oblique 3D view, and get the images back to LOOK at. Use this in the confirm step to separate near-identical row houses: compare each candidate's roof SHAPE against the roof in the listing photos — hip vs gable, ridge direction, the step down to a lower wing. Pure built structure; vegetation is irrelevant here. Pass 2–12 candidates. Covers all of Switzerland.",
    input_schema: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "a short id you'll recognise, e.g. the parcel no. or address" },
              lat: { type: "number" },
              lon: { type: "number" },
            },
            required: ["label", "lat", "lon"],
          },
        },
      },
      required: ["candidates"],
    },
  },
  {
    name: "submit_answer",
    description:
      "Call once, when you are confident, to report the final result (or found=false). A street/building answer is only recorded once it is PROVEN: it is a candidate you inspected (inspect_candidate) and marked match, nothing else is marked match, every shortlisted candidate has a verdict, none is left as possible, and the listing's facts (homes, living area, plot area) do not contradict it. Otherwise it is sent back with what is missing — and near the time limit an unproven address is recorded as a ranked shortlist, not as the address.",
    input_schema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        address: { type: ["string", "null"] },
        parcel: { type: ["string", "null"], description: "e.g. 'Plan-les-Ouates 10917'" },
        parcels: {
          type: "array",
          description:
            "Every exact cadastral plot the property covers, when you have pinned them (one entry per plot). Use the commune name with accents and the plot number exactly as the land register writes it (e.g. 'HN12522'). For building land with no address, this IS the answer.",
          items: {
            type: "object",
            properties: {
              commune: { type: "string" },
              plot: { type: "string" },
              egrid: { type: ["string", "null"] },
            },
            required: ["commune", "plot"],
          },
        },
        commune: { type: ["string", "null"] },
        confidence: {
          type: "string",
          enum: ["street", "building", "parcel", "block", "neighborhood", "city", "region", "country", "unknown"],
          description:
            "street/building: exact address. parcel: the exact plot(s) are pinned in parcels[] but there is no address (e.g. vacant building land). Then wider areas.",
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

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s;
}

// The model sometimes addresses files as if from the repo root ("runs/<id>/x")
// even though it is already inside the run dir. Strip that redundant prefix so
// the read/write resolves instead of ENOENT-ing on a doubled path.
function normalizePath(jobId: string, p: string): string {
  return p.replace(new RegExp(`^\\.?/?(runs/)?${jobId}/`), "");
}

export async function dispatchTool(
  job: Job,
  name: string,
  input: Record<string, unknown>,
): Promise<Anthropic.Messages.ToolResultBlockParam["content"]> {
  if (name === "bash") {
    const command = asText(input.command);
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
    const p = normalizePath(job.id, asText(input.path));
    const content = asText(input.content);
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
    const p = normalizePath(job.id, asText(input.path));
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

  if (name === "shortlist_buildings") {
    const commune = asText(input.commune).trim();
    if (!commune) return "error: pass { commune, floors?, footprintM2?, dwellings?, attached? }";
    const search = searchOf(job);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    try {
      const r = await shortlistBuildings({
        commune,
        floors: num(input.floors),
        footprintM2: num(input.footprintM2),
        dwellings: num(input.dwellings),
        attached: typeof input.attached === "boolean" ? input.attached : undefined,
        maxResults: num(input.maxResults),
        // `near` is deliberately not in the tool schema: the shortlist note
        // offers it only when the run comes back for more of a commune, so
        // every other run keeps exactly the prompt it had.
        near: nearOf(input.near),
        known: new Set(Object.keys(search.candidates)),
        location: job.signature?.location,
        listing: listingFacts(job.input.listingText),
      });
      // HIGH commune confidence: the stated commune is exhausted before any other.
      const blocked = r.supported ? leavePrimaryBlocked(search, r.commune) : null;
      if (blocked) {
        await addStep(job, { kind: "note", title: `shortlist_buildings(${r.commune}) refused`, detail: blocked });
        return `refused: ${blocked}`;
      }
      const facts = listingFacts(job.input.listingText);
      // Strong fits (every register fact fits the listing) are checked first;
      // otherwise the shortlist's own order (location, then footprint) stands.
      const cands = (r.supported ? await annotateFit(facts, r.candidates) : []).sort(
        (a, b) => Number(b.strongFit) - Number(a.strongFit),
      );
      const added = r.supported ? addCandidates(search, r.commune, cands) : 0;
      if (r.supported)
        (search.calls ??= []).push({
          commune: r.commune,
          floors: num(input.floors),
          footprintM2: num(input.footprintM2),
          dwellings: num(input.dwellings),
          survivors: r.survivors,
          returned: r.candidates.length,
          ranked: true,
          ...(r.ranking ? { order: r.ranking } : {}),
        });
      await saveSearch(job, search);
      await addStep(job, {
        kind: "bash",
        title: `shortlist_buildings(${r.commune})`,
        detail: `${r.enumerated} enumerated → ${r.residential} residential → ${r.survivors} survivors; returned ${r.candidates.length} (${added} new on the checklist)`,
      });
      const strong = cands.filter((c) => c.strongFit).length;
      const lines = cands.map(
        (c) =>
          `${c.egid} | ${c.address ?? "?"} | floors ${c.floors ?? "?"} | dwellings ${c.dwellings ?? "?"} | ${c.footprintM2 ?? "?"} m²` +
          `${c.attached == null ? "" : c.attached ? " | attached" : " | detached"} | ${c.lat.toFixed(6)},${c.lon.toFixed(6)}` +
          (c.strongFit ? ` | STRONG FIT: ${c.fit}` : "") +
          (c.note ? ` | ${c.note}` : "") +
          (c.loc ? ` | location ${c.loc.score.toFixed(2)}: ${c.loc.why}` : ""),
      );
      const strongNote = strong
        ? `\n\n${strong} candidate(s) are STRONG FIT: every fact the register holds fits the listing's own numbers. Reject one only after inspect_candidate.`
        : "";
      return clip(
        `${r.note}${strongNote}\n\nChecklist coverage: ${coverageText(search)}.\n\negid | address | floors | dwellings | footprint | lat,lon | fit\n${lines.join("\n")}`,
        MAX_TOOL_TEXT,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await addStep(job, { kind: "error", title: `shortlist_buildings failed`, detail: message });
      return `error: ${message}`;
    }
  }

  if (name === "view_candidates") {
    const search = searchOf(job);
    // Verdicts on the previous sheet can ride along: one turn per sheet.
    const marked = Array.isArray(input.marks) && input.marks.length ? await recordMarks(job, search, input.marks) : null;
    const asked = Array.isArray(input.egids) ? input.egids.map((e) => String(e).trim()).filter(Boolean).slice(0, 16) : [];
    const commune = typeof input.commune === "string" && input.commune.trim() ? input.commune.trim() : undefined;
    const unknown = asked.filter((e) => !search.candidates[e]);
    let list = asked.length
      ? asked.map((e) => search.candidates[e]).filter(Boolean)
      : nextToView(search, 16, commune);
    if (!list.length && commune && !asked.length) {
      // Accept "Denges" for "Denges" / "Saint-Sulpice" for "Saint-Sulpice (VD)".
      const key = commune.toLowerCase();
      const match = search.shortlisted.find((c) => c.toLowerCase().startsWith(key));
      if (match) list = nextToView(search, 16, match);
    }
    if (!list.length) {
      if (marked) return `Recorded ${marked.done.length} verdict(s)${marked.refused.length ? `; refused: ${marked.refused.join("; ")}` : ""}. Nothing left to view${commune ? ` in ${commune}` : ""}. Coverage: ${coverageText(search)}.`;
      return unknown.length
        ? `error: ${unknown.join(", ")} not on your checklist — shortlist their commune first (shortlist_buildings).`
        : `Nothing left to view${commune ? ` in ${commune}` : ""}. Coverage: ${coverageText(search)}.`;
    }
    try {
      const sheetNo = String(job.steps.filter((st) => st.title.startsWith("contact sheet")).length + 1).padStart(2, "0");
      const sheet = await renderContactSheet(
        job.runDir,
        `sheet_${sheetNo}.png`,
        list.map((c, k) => ({ label: String(k + 1), lat: c.lat, lon: c.lon })),
      );
      for (const c of list) c.viewed = true;
      await saveSearch(job, search);
      const legend = list
        .map(
          (c, k) =>
            `${k + 1}: ${c.egid} | ${c.address ?? "?"}, ${c.commune} | floors ${c.floors ?? "?"} | dwellings ${c.dwellings ?? "?"} | ${c.footprintM2 ?? "?"} m²` +
            (c.strongFit ? ` | STRONG FIT (${c.fit}) — inspect before rejecting` : "") +
            (c.loc ? ` | location ${c.loc.score.toFixed(2)}: ${c.loc.why}` : ""),
        )
        .join("\n");
      await addStep(job, {
        kind: "read",
        title: `contact sheet ${sheetNo}: ${list.length} candidates`,
        detail: legend,
        image: `/runs/${job.id}/${sheet.relPath}`,
      });
      const left = unchecked(search).filter((c) => !c.viewed).length;
      return [
        {
          type: "text",
          text:
            `North-up aerials (SWISSIMAGE), ~90 m across, the red cross on each tile is the candidate building. Legend:\n${legend}` +
            (sheet.failed.length ? `\n(tiles ${sheet.failed.join(", ")} failed to load — view them again or zoom yourself)` : "") +
            (unknown.length ? `\n(not on your checklist, skipped: ${unknown.join(", ")})` : "") +
            (marked ? `\n(recorded ${marked.done.length} verdict(s)${marked.refused.length ? `; refused: ${marked.refused.join("; ")}` : ""})` : "") +
            `\nRecord a verdict for each — pass them as marks on your next view_candidates call (or mark_candidates). ${left} candidates not yet viewed.`,
        },
        { type: "image", source: { type: "base64", media_type: "image/png", data: sheet.png.toString("base64") } },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await addStep(job, { kind: "error", title: `view_candidates failed`, detail: message });
      return `error: ${message}`;
    }
  }

  if (name === "mark_candidates") {
    const search = searchOf(job);
    const { done, refused } = await recordMarks(job, search, input.marks);
    return (
      `Recorded ${done.length}.` +
      (refused.length ? ` Refused: ${refused.join("; ")}.` : "") +
      ` Coverage: ${coverageText(search)}.`
    );
  }

  if (name === "inspect_candidate") return inspectCandidate(job, input);
  if (name === "view_from") {
    const c = input.egid != null ? searchOf(job).candidates[asText(input.egid).trim()] : undefined;
    const lat = c?.lat ?? (typeof input.lat === "number" ? input.lat : null);
    const lon = c?.lon ?? (typeof input.lon === "number" ? input.lon : null);
    if (lat == null || lon == null) return "error: pass an EGID from your checklist, or lat/lon.";
    const dirs = (Array.isArray(input.directions) ? input.directions : [])
      .map((d) => String(d).trim().toUpperCase())
      .filter((d): d is Direction => (DIRECTIONS as readonly string[]).includes(d));
    const view = await viewFrom(lat, lon, dirs.length ? dirs : undefined);
    await addStep(job, { kind: "read", title: `view from ${c?.address ?? `${lat.toFixed(5)},${lon.toFixed(5)}`}`, detail: view });
    return `View from ${c?.address ?? "that point"} (eye 6 m above ground):\n${view}\nCompare it with what the photos show through the windows and from the terrace.`;
  }

  if (name === "render_roofs") {
    const raw = Array.isArray(input.candidates) ? input.candidates : [];
    const list = raw
      .map((c, i) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return { label: asText(o.label, `cand${i + 1}`), lat: Number(o.lat), lon: Number(o.lon) };
      })
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon))
      .slice(0, 12);
    if (list.length === 0) return "error: pass candidates:[{label,lat,lon}, …]";
    const rendered = await renderCandidateRoofs(job.runDir, list);
    const blocks: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [
      {
        type: "text",
        text: "Real roofs from swissBUILDINGS3D (each: two oblique angles). Match roof SHAPE to the listing photos — hip vs gable, ridge direction, the low-wing step.",
      },
    ];
    for (const r of rendered) {
      if (r.relPath) {
        await addStep(job, {
          kind: "read",
          title: `rendered roof: ${r.label}`,
          detail: `${r.faces} roof faces`,
          image: `/runs/${job.id}/${r.relPath}`,
        });
        blocks.push({ type: "text", text: `${r.label} (${r.faces} faces):` });
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: await readRoofPng(job.runDir, r.relPath) },
        });
      } else {
        blocks.push({ type: "text", text: `${r.label}: ${r.note}` });
      }
    }
    return blocks;
  }

  return `Unknown tool: ${name}`;
}

// Why a verdict is refused, or null. A rejection has to name what was seen
// ("no" and "small" threw out the right house in Zermatt), and a strong fit
// can only be rejected after a close look, never from a 90 m contact sheet.
export function rejectionProblem(
  c: Pick<LedgerEntry, "strongFit" | "closeLook">,
  verdict: string,
  reason: string,
): string | null {
  if (verdict !== "rejected") return null;
  const words = reason.trim().split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length < 3) return `"${reason.trim() || "no reason"}" is not a reason — name what you saw that rules it out`;
  if (c.strongFit && !c.closeLook) return "STRONG FIT: every register fact fits the listing — inspect_candidate it before rejecting";
  return null;
}

// inspect_candidate: the fact sheet, a tight aerial and the roof of one house.
// A 3D building's outline in words, for a floor plan: its length and width
// along its long axis, the axis direction, and how far it fills that rectangle.
function outlineText(sh: { areaM2: number; axisDeg: number; hull: number[][]; heightM: number }): string {
  const rad = (sh.axisDeg * Math.PI) / 180;
  const along = sh.hull.map(([x, y]) => x * Math.sin(rad) + y * Math.cos(rad));
  const across = sh.hull.map(([x, y]) => x * Math.cos(rad) - y * Math.sin(rad));
  const L = Math.max(...along) - Math.min(...along), W = Math.max(...across) - Math.min(...across);
  const names = ["N–S", "NNE–SSW", "NE–SW", "ENE–WSW", "E–W", "ESE–WNW", "SE–NW", "SSE–NNW"];
  const axis = names[Math.round(sh.axisDeg / 22.5) % 8];
  return `${L.toFixed(1)} × ${W.toFixed(1)} m, long side ${axis}, about ${Math.round(sh.areaM2)} m² from above, ${sh.heightM.toFixed(1)} m high`;
}

async function inspectCandidate(
  job: Job,
  input: Record<string, unknown>,
): Promise<Anthropic.Messages.ToolResultBlockParam["content"]> {
  const search = searchOf(job);
  let c = input.egid != null ? search.candidates[asText(input.egid).trim()] : undefined;
  if (!c && typeof input.lat === "number" && typeof input.lon === "number") {
    c = (await addFromRegister(search, input.lat, input.lon)) ?? undefined;
  }
  if (!c) return `error: ${asText(input.egid, "that point")} is not on your checklist and no register building of a shortlisted commune was found there — pass an EGID from your checklist, or lat/lon on the building (shortlist its commune first if it is in another one).`;
  const facts = listingFacts(job.input.listingText);
  const plot = c.plot ?? (await plotAt(c.lat, c.lon)) ?? undefined;
  const flats = await flatsFor(facts, c.egid);
  // Several plots can make one property: a smaller plot is tried with its neighbours.
  const group =
    c.plotGroup ?? (plot && facts.landM2 != null && !facts.sharedLand ? ((await plotGroupFor(plot, facts.landM2)) ?? undefined) : undefined);
  const plotGroup = group && group.length > 1 ? group : undefined;
  const rows = factRows(facts, { floors: c.floors, dwellings: c.dwellings, footprintM2: c.footprintM2, plots: plotGroup ?? (plot ? [plot] : []), flats });
  Object.assign(c, { plot, plotGroup, strongFit: strongFit(rows), fit: fitText(rows), closeLook: true });
  await saveSearch(job, search);
  const outline = await shapeAt(c.lat, c.lon).then((sh) => (sh ? outlineText(sh) : null)).catch(() => null);
  // The register's plot field against the plot under the address point: they
  // disagreed for 18 of 292 practice houses, and where the listing gave a land
  // area the address point's plot matched it 9 times out of 10, the register's
  // never (Ovronnaz, Chevalley 27/29: the field names the other half's plot).
  const registerPlot = await buildingByEgid(c.egid).then((b) => b?.registerPlot ?? null).catch(() => null);
  const plotClash =
    plot && registerPlot && !sameRegisterPlot(registerPlot, plot.number)
      ? `The register's own plot field says ${registerPlot}, but the plot under this building's official address point is ${plot.number}. Trust ${plot.number} and the address point: the register's field is often an old plot from before a split, or the plot of the other half of an attached pair. The house number ${c.address ?? ""} belongs to the building at the address point (the red cross).`
      : null;
  const sheetNo = String(job.steps.filter((st) => st.title.startsWith("close look")).length + 1).padStart(2, "0");
  const blocks: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [];
  const sheet = text(
    [
      `Close look at ${c.egid} | ${c.address ?? "?"}, ${c.commune} (verdict so far: ${c.verdict}).`,
      `Register: floors ${c.floors ?? "?"}, dwellings ${c.dwellings ?? "?"}, footprint ${c.footprintM2 ?? "?"} m².`,
      `Plot: ${plot ? `${plot.number}${plot.egrid ? ` (${plot.egrid})` : ""}, ${plot.areaM2} m²` : "not found"}.`,
      ...(plotClash ? [plotClash] : []),
      outline ? `Outline (swissBUILDINGS3D, from above): ${outline} — compare it with a floor plan in the photos, if there is one.` : "Outline: not in swissBUILDINGS3D.",
      rows.length
        ? `Against the listing:\n${rows.map((r) => `- ${r.fact}: listing ${r.listing}, building ${r.building} → ${r.verdict}`).join("\n")}`
        : "The listing states no homes / living area / land area to check against.",
      `Below: a 40 m north-up aerial (red cross = register point) and the real 3D roof. Compare them with the photos, then record your verdict with mark_candidates — a rejection names the difference you see.`,
    ].join("\n"),
  );
  blocks.push(sheet);
  try {
    const aerial = await renderContactSheet(job.runDir, `close_${sheetNo}.png`, [{ label: "", lat: c.lat, lon: c.lon }], {
      spanM: 40,
      tile: 640,
      cols: 1,
    });
    await addStep(job, {
      kind: "read",
      title: `close look ${sheetNo}: ${c.address ?? c.egid}`,
      detail: rows.map((r) => `${r.fact}: ${r.listing} vs ${r.building} → ${r.verdict}`).join("\n"),
      image: `/runs/${job.id}/${aerial.relPath}`,
    });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: aerial.png.toString("base64") } });
  } catch (err) {
    blocks.push(text(`(aerial failed: ${err instanceof Error ? err.message : String(err)})`));
  }
  try {
    const [roof] = await renderCandidateRoofs(job.runDir, [{ label: `roof_${c.egid}`, lat: c.lat, lon: c.lon }]);
    if (roof?.relPath) {
      blocks.push(text(`Real roof (${roof.faces} faces):`));
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: await readRoofPng(job.runDir, roof.relPath) } });
    } else if (roof) blocks.push(text(`Roof: ${roof.note}`));
  } catch (err) {
    blocks.push(text(`(roof render failed: ${err instanceof Error ? err.message : String(err)})`));
  }
  return blocks;
}

// Apply verdicts to the checklist. A rejection needs the candidate to have been
// on a contact sheet — the checklist must mean "looked at", not "dismissed".
async function recordMarks(
  job: Job,
  search: SearchState,
  marks: unknown,
): Promise<{ done: string[]; refused: string[] }> {
  const done: string[] = [], refused: string[] = [];
  for (const m of Array.isArray(marks) ? marks : []) {
    const o = (m ?? {}) as Record<string, unknown>;
    const egid = asText(o.egid).trim();
    const verdict = asText(o.verdict);
    const c = search.candidates[egid];
    if (!c || !["rejected", "possible", "match"].includes(verdict)) {
      refused.push(`${egid || "?"} (not on the checklist or bad verdict)`);
      continue;
    }
    if (verdict === "rejected" && !c.viewed && !c.closeLook) {
      refused.push(`${egid} (never viewed — view_candidates first)`);
      continue;
    }
    const why = rejectionProblem(c, verdict, asText(o.reason));
    if (why) {
      refused.push(`${egid} (${why})`);
      continue;
    }
    c.verdict = verdict as "rejected" | "possible" | "match";
    c.reason = asText(o.reason).slice(0, 300);
    done.push(`${egid} ${verdict}`);
  }
  await saveSearch(job, search);
  await addStep(job, {
    kind: "note",
    title: `marked ${done.length} candidate(s)`,
    detail: [...done, ...refused.map((r) => `refused: ${r}`)].join("\n"),
  });
  return { done, refused };
}
