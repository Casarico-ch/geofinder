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
import { RunFiles } from "./files";
import { seedGeoHelper } from "./geo-helper";
import { renderCandidateRoofs, readRoofPng } from "./roofs";
import { buildingAt, normalizeCommune } from "./gwr";
import { annotateFit, factRows, fitText, listingFacts, plotAt, plotByEgrid, strongFit, type Plot } from "./proof";
import { shortlistBuildings } from "./shortlist";
import { renderContactSheet } from "./sheet";
import {
  type LedgerEntry,
  type SearchState,
  addCandidates,
  assessCommune,
  claimedEntry,
  openPossibles,
  coverageText,
  leavePrimaryBlocked,
  nextToView,
  pendingCommunes,
  searchPlanText,
  unchecked,
} from "./search";
import {
  type Answer,
  type AnswerProof,
  type Confidence,
  type Job,
  type Signature,
  addStep,
  addUsage,
  finishJob,
  markStarted,
  saveSearch,
  setPromptVersion,
  setSignature,
  DEFAULT_MODEL,
} from "./jobs";
import { cluesText, coerceLocation } from "./locate";
import * as team from "./team";

export const MODEL = DEFAULT_MODEL;
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 150);
// Wall-clock budget for one investigation. Checking every candidate takes longer
// than giving up early, so the cap is what keeps a hopeless search bounded.
const MAX_MINUTES = Number(process.env.AGENT_MAX_MINUTES ?? 45);
export const MAX_TOOL_TEXT = 16_000; // chars of command output fed back to the model
// Speed. Fast mode runs the same model at up to 2.5x the output speed for 2x the
// price; only some models offer it. AGENT_FAST=0 turns it off.
const FAST_MODELS = new Set(["claude-opus-4-8", "claude-opus-5-5"]); // 4.8: resumed old runs
const FAST_MODE = process.env.AGENT_FAST !== "0";
// Thinking depth per turn — the biggest single lever on how long a turn takes.
// "medium" or "low" is faster but looks less carefully.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT: (typeof EFFORTS)[number] = (EFFORTS as readonly string[]).includes(process.env.AGENT_EFFORT ?? "")
  ? (process.env.AGENT_EFFORT as (typeof EFFORTS)[number])
  : "high";
// Tools that only read or fetch, and touch no search state: several of them in
// one turn run at the same time. write_file and the checklist tools run alone,
// in order, so "write fetch.mjs, then run it" still works.
const PARALLEL_TOOLS = new Set(["bash", "read_file", "render_roofs"]);

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
              description: "Distinctive things visible from the house: a church or chapel, a named peak, a lake, a village. Direction is where it lies SEEN FROM THE HOUSE (map compass: work it out from the sun, shadows, the slope or known geography). Omit name for an unnamed local church.",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["church", "peak", "lake", "place", "other"] },
                  name: { type: "string", description: "its proper name if you know it, e.g. 'Matterhorn', 'Lac Léman'" },
                  direction: { type: "string", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] },
                  distance_m: { type: "number", description: "rough distance from the house, if the photos allow it" },
                  confidence: { type: "string", enum: ["sure", "likely", "guess"] },
                },
                required: ["kind", "direction", "confidence"],
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
      "Enumerate EVERY building in a Swiss commune and get back a RECALL-FIRST shortlist that still contains the target — any canton (Geneva from the SITG cadastre, everywhere else from the federal building register GWR). You pass your best estimates and this filters SAFELY so the right house can't be dropped: floors and dwellings as ±1 ranges (never exact — the register counts a semi-basement and a habitable attic as levels), footprint a wide band, existing residential buildings only. It deliberately has NO era filter — the register's construction date routinely disagrees with how old a house looks. Every candidate returned goes into your checklist; look at them with view_candidates and record a verdict with mark_candidates. Do NOT then re-filter the result by era or exact floors — that is exactly how the right house gets discarded.",
    input_schema: {
      type: "object",
      properties: {
        commune: { type: "string", description: "the commune, e.g. 'Denges' or 'Saint-Sulpice (VD)'" },
        floors: { type: "number", description: "your estimate of the levels the register counts (matched ±1): a semi-basement + 2 storeys + attic is 4" },
        footprintM2: { type: "number", description: "your estimate of the MAIN building's ground footprint in m² (NOT the listing's living area). Matched as a wide band." },
        dwellings: { type: "number", description: "number of dwellings in the building if the listing says (\"PPE de deux logements\" = 2); matched ±1" },
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

// A team run gets the chat tools and a certainty on its votes (team.ts).
const TEAM_RUN_TOOLS = [
  ...TOOLS.map((t) => {
    const tool = t as unknown as { name: string; input_schema: { properties: Record<string, unknown>; required: string[] } };
    if (tool.name !== "submit_answer") return t;
    return {
      ...tool,
      input_schema: {
        ...tool.input_schema,
        properties: { ...tool.input_schema.properties, certainty: team.CERTAINTY_FIELD },
        required: [...tool.input_schema.required, "certainty"],
      },
    } as unknown as Anthropic.Messages.ToolUnion;
  }),
  ...(team.TEAM_TOOLS as unknown as Anthropic.Messages.ToolUnion[]),
];

const SYSTEM = `You are GeoFinder — an autonomous investigator that finds the exact street address and cadastral parcel of a Swiss property from its listing (photos + text + municipality).

You have no geo tools. You have a real Linux computer (Node ≥18 with global fetch, network access) and you build your own access to public data by writing and running code, like a human analyst. The method is entirely yours — reason it out, invent and switch approaches freely, and verify however you see fit.

PRIMITIVES
- bash(command): run a shell command, get stdout+stderr (truncated).
- write_file(path, content) / read_file(path): read_file on an image lets you SEE it (vision) — that's how you look at aerials you download.
- submit_answer(...): call once, when confident.

ENVIRONMENT
- Each bash call is a fresh process: no cd, use paths relative to the working directory. The photos are already there as photo1.jpg, photo2.jpg, … (also shown inline). Save what you fetch there and read images back to look at them.
- No Python/pip, no image libraries. To zoom, re-fetch a WMS aerial with a tighter bbox centred on the point — never crop or compute GPS→pixels.
- A tested helper geo.mjs is already in your working directory — import it instead of hand-rolling the fiddly geometry (that is where the mistakes creep in, and it is why hand-computed distances are unreliable): wmsBbox4326(lat,lon,spanM) gives the correct lat,lon-order BBOX for a swisstopo WMS aerial; also haversine, bearing, wgs84ToLv95, polygonAreaMetres, polygonCentroid, pointInPolygon, and minEdgeDistanceMetres(ringA,ringB) — ≈0 means two footprints share a wall, i.e. an attached row house. Rings are [lon,lat] arrays. e.g. node -e "import('./geo.mjs').then(g=>console.log(g.wmsBbox4326(46.16,6.04,140)))".

GROUNDING ONLY
Never web-search, and never look up the listing, the agency, or the property online. Deduce everything from the given photos + text, grounded only against neutral geodata (cadastre, aerials, building register, OSM). Nominatim is fine solely to turn a place NAME into coordinates.

METHOD — enumerate, don't scan
Your first message carries a SEARCH PLAN: the commune confidence and the ring of neighbouring communes, nearest first. Follow it. HIGH confidence: the property is in the stated commune — exhaust that commune before looking anywhere else (the tools enforce this). LOW confidence: the listing only places the property NEAR the stated commune ("à 5 minutes de …") — search outward commune by commune, nearest first, finishing each before the next.
Treat each commune as a FINITE, listable set of buildings, not a map to eyeball. You pin a house by enumerating every candidate and filtering — not by wandering the aerial hoping to recognise it. (This is the difference that matters: runs that only scan reach the right neighbourhood but never look at the actual house.)
1. Read the building's HARD structural attributes off the photos: the levels the register counts (a two-storey block + single-storey wing reads as ~3; a semi-basement "rez inférieur" + two storeys + attic is 4), the number of dwellings when the listing says it ("PPE de deux logements" = 2), the rough FOOTPRINT in m² of the main building, attached-vs-free-standing (one of a row/terrace, or detached?), roof shape, plus any second building in the garden / veranda-conservatory / pool. Do NOT judge by how OLD it looks — the registered construction era routinely disagrees with the appearance, so never filter on age.
2. Get your candidate list from shortlist_buildings(commune, floors, footprintM2, dwellings, attached) — any canton. It enumerates every building in the commune and filters SAFELY so the target cannot be dropped (floors and dwellings matched ±1, footprint wide, and NO era filter). Never hand-write this filter yourself — a hand-written "2–3 floors" is exactly how a house the register counts as 4 was lost. Two things to get right when you pass estimates: (a) footprintM2 is the MAIN building's GROUND footprint, NOT the listing's living area — a "262 m² house" over ~3 levels is only ~90–130 m² on the ground; (b) estimate floors generously — a two-storey block with a habitable attic is registered as 3. Then treat the returned list as your candidate set and do NOT re-filter it by era or exact floors — that is exactly how the right house gets discarded.
3. Shortlist on the BUILDING (floors, footprint, dwellings), never on the plot. But once you have candidates, the listing's land area is strong evidence: the shortlist checks each strong candidate's cadastral plot against it, and a plot that matches to within a few m² (331 m² listed, plot 330.8 m²) all but names the house. A plot that does NOT match is not a rejection on its own — a property is often several plots (house plot + garden plots, e.g. 1481 m² listed = two plots summed) — so look at the neighbouring plots before ruling it out, and list every plot in parcels[] when you answer.
4. LOOK at every candidate: view_candidates shows 16 at a time on one contact sheet; record a verdict on each (pass them as marks on the next view_candidates call — one turn per sheet — or with mark_candidates). That checklist is how you (and the reminders) know a commune is exhausted — a commune is not "searched" until every candidate has a verdict. A rejection names what you SAW that rules it out ("hip roof, no garden terrace on the south side") — "no" or "small" is refused. A candidate flagged STRONG FIT (every register fact fits the listing) cannot be rejected from the contact sheet at all: inspect_candidate it first.
5. Confirm survivors by ARRANGEMENT and ROOF SHAPE, on built structure only (vegetation — hedges, topiary, trees — does not reliably read from above). On the aerial: which side the veranda/terrace is on, a second building in the garden, roads on which sides, position in the row. And call render_roofs on your shortlist (pass each candidate's lat/lon) to SEE each one's real roof from swissBUILDINGS3D and match its shape to the roof in the photos — hip vs gable, ridge direction, the step down to a lower wing. That is what separates near-identical row houses.

PROOF — what the code accepts as an exact address
An exact (street/building) answer is recorded only when: it is a candidate you inspected with inspect_candidate and marked match; no other candidate is marked match; every shortlisted candidate has a verdict and none is left "possible" (settle each one: inspect it, then reject it with the visible difference, or match); and the listing's facts do not contradict it (a single house in a 2-dwelling building, a living area the building cannot hold, a plot of a different size). Until then submit_answer sends it back with what is missing. If you cannot get there, submit found=false at block confidence with your ranked candidates and what would separate them.

ANSWER HONESTLY — a shortlist beats a wrong pin
Building-level confidence is EARNED, not asserted: claim a single precise address/parcel only when the aerial has CONFIRMED the arrangement AND your top candidate clearly beats the runner-up. If several candidates survive, or nothing confirms, that is still a SUCCESS — submit them as a ranked candidates[] at block/neighborhood confidence and say what would separate them. Never fabricate a precise address to seem more certain than the evidence; a confident wrong pin is the worst possible outcome — worse than an honest shortlist.
Exact plots are a full result too: when you have pinned the exact cadastral plot(s) the property covers, list every one in parcels[] (commune + plot number as the land register writes it). For building land or other plots with no street address, that is a success: found=true, confidence "parcel". When it also has an address, give both.

SOURCES (starting points, not limits; set a User-Agent header)
- Geneva cadastre (SITG, ArcGIS REST, f=json&outSR=4326). Parcels: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_PARCELLE_MENSU/MapServer/0/query — NO_PARCELLE, SURFACE, COMMUNE; filter by where=COMMUNE='X' AND SURFACE BETWEEN a AND b, or geometry=lon,lat&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects; returnGeometry=true → geometry.rings. Buildings: https://vector.sitg.ge.ch/arcgis/rest/services/CAD_BATIMENT_HORSOL/MapServer/0/query — EPOQUE_CONSTRUCTION, NIVEAUX_HORSOL, SURFACE (footprint), EGID.
- Other cantons (ZH etc.) — official cadastre on geodienste.ch, WFS 2.0, bbox axis order lat,lon: https://geodienste.ch/db/av_0/deu?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:RESF&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX={latmin},{lonmin},{latmax},{lonmax},urn:ogc:def:crs:EPSG::4326&COUNT=30 — ms:RESF = parcel (ms:Flaeche = area, the villa key; ms:Nummer, ms:EGRIS_EGRID). ms:HADR = address (ms:Strassenname, ms:Hausnummer, ms:GWR_EGID). ms:LCSF = building footprints. Geometry is gml:posList (lat lon). av_0 is ZH; other cantons' free WFS: https://www.geodienste.ch/info/services.csv?base_topics=av&language=de.
- Aerial (swisstopo SWISSIMAGE) — download the JPEG then read_file: https://wms.geo.admin.ch/?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ch.swisstopo.swissimage&CRS=EPSG:4326&BBOX={latmin},{lonmin},{latmax},{lonmax}&WIDTH=1200&HEIGHT=1200&FORMAT=image/jpeg (lat,lon order; square bbox in metres: dLat=span/2/111320, dLon=dLat/cos(lat)).
- Building register (GWR, nationwide): https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometry={lon},{lat}&geometryType=esriGeometryPoint&layers=all:ch.bfs.gebaeude_wohnungs_register&tolerance=15&sr=4326&geometryFormat=geojson&mapExtent={lon-0.002},{lat-0.0015},{lon+0.002},{lat+0.0015}&imageDisplay=800,600,96 — strname_deinr (street+no.), gbauj (year), gastw (floors), ganzwhg (dwellings), egid.
- OSM amenities: Overpass POST https://overpass-api.de/api/interpreter (body 'data='+urlencoded QL). Geocoding: https://nominatim.openstreetmap.org/search?q=...&format=json. Compute haversine/bearing yourself.

SPEED
Several tool calls in one turn run at the same time (bash, read_file, render_roofs). When calls do not depend on each other — fetching several aerials or registers, reading several images — make them all in the same turn instead of one per turn.

Reason explicitly about why you run each command — your thinking is the saved trace of the investigation.`;

const TASK = `The images above and the text below are a property listing. Find the property's exact street address and cadastral parcel with your computer.

FIRST, before searching: study the photos and call record_signature — LEAD with the hard, register-matchable structure (floors, the main building's rough footprint in m², attached-vs-detached and position in a row, a second building in the garden, veranda, pool), biggest discriminator first, then the plot and finally roof detail. Fill its location too: which way the ground falls away, and the church, peak, lake or village seen from the house and in which direction — the shortlist then checks the houses whose surroundings fit first. A property can be several parcels fused into one visual unit — describe the whole unit, but name the main BUILDING footprint specifically.

Then follow the SEARCH PLAN and METHOD: shortlist the commune it names (floors + footprint + dwellings — the plot area is checked for you afterwards), look at every candidate with view_candidates and record a verdict with mark_candidates, inspect every strong fit and every possible with inspect_candidate, then confirm the survivor by its built arrangement. Work step by step and verify visually. Call submit_answer with a single address ONLY when it meets the PROOF rules — otherwise submit your ranked shortlist honestly.`;

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
  searchPlan: string,
  teamRun = false,
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
      `\n\nListing text:\n${listingText ? `"""${listingText}"""` : "(none provided)"}` +
      `\n\n${searchPlan}` +
      (teamRun ? `\n\n${team.TEAM_BRIEF}` : ""),
  });
  return blocks;
}

// Contact sheets, aerials and roof renders reach the model by file_id (see
// files.ts), so they no longer weigh on the request. Only a picture whose upload
// failed still travels inline, and if those ever pass IMAGES_MAX_BYTES the
// oldest are replaced by a note until they are back under IMAGES_KEEP_BYTES —
// in one go, rarely, since every such edit changes an earlier turn. The listing
// photos in the first message are never touched.
const SHEET_NOTE = "North-up aerials (SWISSIMAGE)";
const IMAGES_MAX_BYTES = 14_000_000; // base64 characters
const IMAGES_KEEP_BYTES = 5_000_000;

export function pruneOldImages(
  messages: Anthropic.Messages.MessageParam[],
  inline: (base64: string) => boolean = () => true,
): boolean {
  const images: { blocks: unknown[]; at: number; size: number; sheet: boolean }[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      const sheet = b.content.some((c) => c.type === "text" && c.text.startsWith(SHEET_NOTE));
      b.content.forEach((c, at) => {
        if (c.type === "image" && c.source.type === "base64" && inline(c.source.data))
          images.push({ blocks: b.content as unknown[], at, size: c.source.data.length, sheet });
      });
    }
  }
  let total = images.reduce((n, i) => n + i.size, 0);
  if (total <= IMAGES_MAX_BYTES) return false;
  for (const img of images) {
    if (total <= IMAGES_KEEP_BYTES) break;
    total -= img.size;
    img.blocks[img.at] = {
      type: "text",
      text: img.sheet
        ? "[contact sheet image removed to keep the request small — your verdicts on it are in the checklist]"
        : "[image removed to keep the request small — read the file again if you need to see it]",
    };
  }
  return true;
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n…[truncated, ${s.length} chars total]` : s;
}

// Periodic anti-over-search nudge. Escalates as the step (or time) budget runs
// down so the model reviews its best candidate and commits instead of scanning
// forever. While the search plan still has candidates without a verdict (or
// planned communes not yet shortlisted), the periodic nudge points at THAT work
// instead of inviting an early "conclude honestly": in run c5bc3cfd the
// turn-24 nudge was followed, word for word, by giving up with ~170 neighbour
// candidates never looked at.
function convergeReminder(step: number, max: number, search?: SearchState, nearTimeLimit = false): string | null {
  if (step >= max - 15 || nearTimeLimit)
    return `[system-reminder] You are near the ${nearTimeLimit ? "time" : `${max}-step`} limit. Reach a conclusion now — an HONEST one. If the evidence has converged on one property, submit_answer with it. If it has not, submit your tightest defensible area with found=false and your ranked candidates. Do NOT fabricate a precise address just to finish, and do not open new searches.`;
  if (step >= 24 && (step - 24) % 12 === 0) {
    const open = search ? unchecked(search).length : 0;
    const todo = search ? pendingCommunes(search, 3) : [];
    if (search && (open > 0 || todo.length > 0)) {
      return `[system-reminder] ${step} steps in. Coverage: ${coverageText(search)}.` +
        (open > 0 ? ` ${open} shortlisted candidates still have no verdict — view them (view_candidates) and mark them (mark_candidates) before anything else.` : "") +
        (todo.length > 0 ? ` Not yet shortlisted, in plan order: ${todo.join(", ")}.` : "") +
        ` If a candidate already matches EVERY hard signal, confirm it and submit_answer.`;
    }
    return `[system-reminder] ${step} steps in. Stop and assess your strongest candidate: does it match EVERY hard signal in the listing (area/footprint, era, floors, orientation, background landmarks, amenity distances)? If the signals CONVERGE, that is confirmation — submit_answer now and do not reopen the search (re-searching after convergence is how the right property gets discarded). If they do NOT converge, name the single check that would resolve it and do only that — or conclude honestly (found=false + candidates). Do not keep scanning the same way, and do not commit just because a candidate is the "best" of a weak field.`;
  }
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

function coerceSignature(input: Record<string, unknown>): Signature {
  const raw = Array.isArray(input.clues) ? input.clues : [];
  const clues = raw
    .map((c) => (typeof c === "string" ? c.trim() : String(c ?? "").trim()))
    .filter(Boolean)
    .slice(0, 30);
  const svg = typeof input.schematic_svg === "string" && input.schematic_svg.trim()
    ? clip(input.schematic_svg, 20_000)
    : undefined;
  return { clues, schematicSvg: svg, location: coerceLocation(input.location) };
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
    parcels: (Array.isArray(input.parcels) ? input.parcels : [])
      .map((p) => (p ?? {}) as Record<string, unknown>)
      .filter((p) => str(p.commune) && str(p.plot))
      .map((p) => ({ commune: String(p.commune).trim(), plot: String(p.plot).trim(), egrid: str(p.egrid) })),
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
  // A cross-check starts from the checklist of the search it checks.
  seed?: Pick<SearchState, "shortlisted" | "candidates">,
): Promise<void> {
  // Attribute this run to the exact prompt it will use: stamp the version and
  // save the full prompt text next to the trace. This is what lets a later
  // post-mortem know which prompt produced these costs and this reasoning.
  await stampPrompt(job);
  await seedGeoHelper(job.runDir); // drop the tested geo.mjs into the working dir
  await markStarted(job); // start the elapsed-time clock
  // Where to look: commune confidence + neighbour ring, decided in code from the
  // listing before the model starts, and handed to it as the SEARCH PLAN.
  const search = await assessCommune(job.input.municipality, listingText);
  if (seed) {
    search.shortlisted = [...seed.shortlisted];
    search.candidates = structuredClone(seed.candidates);
  }
  await saveSearch(job, search);
  if (job.team) await team.joinTeam(job.team, job.id);
  const plan = searchPlanText(search);
  await addStep(job, { kind: "note", title: `Search plan: commune confidence ${search.confidence}`, detail: plan });
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initialContent(images, listingText, plan, !!job.team) },
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


// Why a found=false is premature, or null when the plan's work is done.
function prematureGiveUp(search: SearchState | undefined): string | null {
  if (!search || search.submitGated) return null;
  const open = unchecked(search).length;
  const todo = pendingCommunes(search, 3);
  if (open === 0 && todo.length === 0) return null;
  return (
    `Not recorded — the search plan is not finished. Coverage: ${coverageText(search)}.` +
    (open > 0 ? ` ${open} shortlisted candidates have never been given a verdict: view them (view_candidates) and mark them (mark_candidates).` : "") +
    (todo.length > 0 ? ` Planned communes not yet shortlisted: ${todo.join(", ")}.` : "") +
    ` Continue the plan; submit found=false only once it is done (or if you can name a concrete reason the rest cannot hold the property).`
  );
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
  const files = await RunFiles.load(client, job.runDir);

  try {
    if (startTurn > 0) {
      const lost = await files.verify();
      if (lost > 0)
        await addStep(job, { kind: "note", title: `${lost} uploaded picture(s) had expired and are sent again` });
    }
    // Active running time only: a run paused for a day, or resumed after a
    // redeploy, must not trip the time limit on its first turn.
    const activeBefore = job.activeMs ?? 0;
    const loopStart = Date.now();
    const elapsedMinutes = () => {
      job.activeMs = activeBefore + (Date.now() - loopStart);
      return job.activeMs / 60_000;
    };
    const nearTimeLimit = () => elapsedMinutes() >= MAX_MINUTES * 0.85;
    const nearLimit = (step: number) => step >= MAX_STEPS - 15 || nearTimeLimit();
    let fastUnavailable = false;
    for (let i = startTurn; i < MAX_STEPS; i++) {
      if (elapsedMinutes() >= MAX_MINUTES) {
        await finishJob(job, {
          status: "done",
          answer: coerceAnswer({
            found: false,
            confidence: "unknown",
            reasoning: `Did not converge within the ${MAX_MINUTES}-minute limit.` +
              (job.search ? ` Coverage: ${coverageText(job.search)}.` : ""),
          }),
        });
        return;
      }
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

      if (job.team) {
        // The teammate's vote may have settled it while this member was busy.
        const settled = await team.agreed(job);
        if (settled) {
          await addStep(job, { kind: "answer", title: `Team agreed: ${settled.address ?? settled.parcel ?? "Answer"}`, detail: settled.reasoning });
          await finishJob(job, { status: "done", answer: settled });
          return;
        }
        // Show what the teammate posted since this member last looked.
        const news = await team.unseen(job, i);
        const last = messages[messages.length - 1];
        if (news && last.role === "user") {
          if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
          last.content.push({ type: "text", text: news.text });
          for (const p of news.posts)
            await addStep(job, { kind: "note", title: `Team chat — ${p.model} #${p.id}`, detail: p.text });
          await saveState(job, i, messages);
        }
      }

      await files.upload(messages);
      if (pruneOldImages(messages, files.isInline)) await saveState(job, i, messages);
      const model = job.model ?? MODEL;
      const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: 16_000,
        // display: "summarized" so the model's reasoning is actually returned
        // (Opus 5.5 / Fable 5 omit thinking text by default) — that's the trace.
        // adaptive thinking is valid on both models (Fable rejects only
        // disabled/budget_tokens, which we never send).
        thinking: { type: "adaptive", display: "summarized" },
        // Pin effort so every model runs at the same depth — Opus 5.5 would
        // otherwise default to "medium" while the others default to "high".
        output_config: { effort: EFFORT },
        // Cache the static tools + system prompt (re-sent every turn). The
        // breakpoint on the system block covers tools + system together.
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        tools: job.team ? TEAM_RUN_TOOLS : TOOLS,
        // Top-level auto-caching rolls a second breakpoint over the growing
        // conversation — so the re-sent listing photos and the aerials the
        // model has already downloaded are read from cache, not reprocessed.
        cache_control: { type: "ephemeral" },
        messages: files.wire(messages),
      };
      let fast = FAST_MODE && FAST_MODELS.has(model) && !fastUnavailable;
      let resp: Anthropic.Messages.Message;
      try {
        resp = fast
          ? ((await client.beta.messages.create({
              ...(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
              speed: "fast",
              betas: ["fast-mode-2026-02-01"],
            })) as unknown as Anthropic.Messages.Message)
          : await client.messages.create(params);
      } catch (err) {
        // Fast mode has its own rate limit: when it is exhausted (or refused),
        // finish the run at standard speed instead of failing it.
        if (!fast || !(err instanceof Anthropic.RateLimitError || err instanceof Anthropic.BadRequestError)) throw err;
        fastUnavailable = true;
        fast = false;
        await addStep(job, { kind: "note", title: "Fast mode unavailable — continuing at standard speed" });
        resp = await client.messages.create(params);
      }

      // Record token usage for this turn (input includes cache traffic so the
      // total reflects what actually moved through the model).
      const u = resp.usage;
      if (u) {
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const inTok = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
        await addUsage(job, inTok, u.output_tokens ?? 0, cacheRead, cacheWrite, fast);
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

      // A run of consecutive read/fetch-only calls is started together when the
      // loop reaches its first call — after every call before it has finished —
      // and its outputs are then used in order, as if run one by one.
      const early = new Map<string, Promise<Anthropic.Messages.ToolResultBlockParam["content"]>>();
      const startGroup = (from: number) => {
        for (let k = from; k < toolUses.length && PARALLEL_TOOLS.has(toolUses[k].name); k++) {
          const tu = toolUses[k];
          const out = dispatchTool(job, tu.name, tu.input as Record<string, unknown>);
          // Awaited in order below; if an earlier one throws, the run ends and
          // a later failure must not surface as an unhandled rejection.
          out.catch(() => {});
          early.set(tu.id, out);
        }
      };

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (let idx = 0; idx < toolUses.length; idx++) {
        const tu = toolUses[idx];
        if (PARALLEL_TOOLS.has(tu.name) && !early.has(tu.id)) startGroup(idx);
        if (tu.name === "submit_answer") {
          const answer = coerceAnswer(tu.input as Record<string, unknown>);
          // A "not found" while the plan still has unchecked candidates (or
          // planned communes never shortlisted) is turned back ONCE — giving up
          // with the answer still unviewed is how run c5bc3cfd was lost. Near
          // the step/time limit it always goes through.
          const gate = !answer.found && !nearLimit(i + 1) ? prematureGiveUp(job.search) : null;
          if (gate && job.search) {
            job.search.submitGated = true;
            await saveSearch(job, job.search);
            await addStep(job, { kind: "note", title: "Not finished yet — search plan incomplete", detail: gate });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: gate, is_error: true });
            continue;
          }
          // An exact address is recorded only once it is proven (proveAnswer).
          // Unproven, it goes back with what is missing (up to 3 times); near
          // the limit, or after that, it is recorded as a ranked shortlist.
          let final = answer;
          if (answer.found && EXACT.has(answer.confidence)) {
            const search = searchOf(job);
            const pr = await proveAnswer(job, answer);
            const asks = [...pr.blocking, ...((search.foundGates ?? 0) === 0 ? pr.soft : [])];
            if (asks.length && !nearLimit(i + 1) && (search.foundGates ?? 0) < 3) {
              search.foundGates = (search.foundGates ?? 0) + 1;
              await saveSearch(job, search);
              const msg =
                `Not recorded — this address is not proven yet:\n${asks.map((x) => `- ${x}`).join("\n")}\n` +
                `Do that and submit again, or submit found=false at block confidence with your ranked candidates.`;
              await addStep(job, { kind: "note", title: "Not proven yet — answer sent back", detail: msg });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
              continue;
            }
            final = pr.blocking.length ? unprovenAsShortlist(answer, pr.blocking) : answer;
            if (pr.proof) final = { ...final, proof: pr.proof };
          }
          // A team run stops only when both members name the same building at
          // team.AGREE_AT or more; until then the answer is a vote. Once the
          // teammate has stopped (or near the limit) the solo rules apply.
          if (job.team && !nearLimit(i + 1) && (await team.hasLiveMate(job))) {
            const certainty = Number((tu.input as Record<string, unknown>).certainty ?? 0);
            const outcome = await team.vote(job, final, certainty);
            if (outcome.kind === "waiting") {
              await addStep(job, {
                kind: "note",
                title: `Vote: ${final.found ? (final.address ?? final.parcel ?? "Answer") : "no match"} · ${Math.round(certainty)}%`,
                detail: outcome.message,
              });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: outcome.message, is_error: true });
              continue;
            }
            await addStep(job, { kind: "note", title: `Team agreed at ${team.AGREE_AT}%+`, detail: "Both members voted for this building." });
          }
          const rankNote = job.search ? answerRank(job.search, final) : null;
          if (rankNote) await addStep(job, { kind: "note", title: "Checking order", detail: rankNote });
          await addStep(job, {
            kind: "answer",
            title: final.found ? (final.address ?? final.parcel ?? "Answer") : "No proven match",
            detail: final.reasoning,
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          await finishJob(job, { status: "done", answer: final });
          return;
        }
        if (job.team && tu.name === "team_post") {
          const inp = tu.input as Record<string, unknown>;
          const p = await team.post(
            job,
            {
              text: String(inp.message ?? ""),
              replyTo: Number(inp.reply_to) || undefined,
              ask: inp.ask === true,
              leading: inp.leading == null ? undefined : String(inp.leading),
              certainty: inp.certainty == null ? undefined : Number(inp.certainty),
            },
            i + 1,
          );
          await addStep(job, {
            kind: "note",
            title: `Team chat — ${p.model} #${p.id}${p.replyTo ? ` (re #${p.replyTo})` : ""}`,
            detail: p.text + (p.leading ? `\nLeading: ${p.leading}${p.certainty !== undefined ? ` · ${p.certainty}%` : ""}` : ""),
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `posted as #${p.id}` });
          continue;
        }
        if (job.team && tu.name === "team_read") {
          const out = await team.readMate(job, Number((tu.input as Record<string, unknown>).steps) || 25);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: clip(out, MAX_TOOL_TEXT) });
          continue;
        }
        if (tu.name === "record_signature") {
          const sig = coerceSignature(tu.input as Record<string, unknown>);
          await setSignature(job, sig);
          await addStep(job, {
            kind: "note",
            title: "Target signature",
            detail:
              sig.clues.map((c, i) => `${i + 1}. ${c}`).join("\n") +
              (sig.location ? `\nLocation clues: ${cluesText(sig.location)}` : ""),
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          continue;
        }
        const out = await (early.get(tu.id) ?? dispatchTool(job, tu.name, tu.input as Record<string, unknown>));
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      const content: Anthropic.Messages.ContentBlockParam[] = [...results];
      const nudge = convergeReminder(i + 1, MAX_STEPS, job.search, nearTimeLimit());
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
      // Keep the whole thread — photos, text, every tool call and result, the
      // model's reasoning — exactly as the model saw it, for the export.
      await saveConversation(job, messages);
      await clearState(job);
      await files.deleteAll();
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

// The finished run's full conversation, kept for the export (never served raw).
export const CONVERSATION_FILE = "conversation.json";

async function saveConversation(job: Job, messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  try {
    await writeFile(path.join(job.runDir, CONVERSATION_FILE), JSON.stringify({ messages }));
  } catch (err) {
    console.error(`[agent] could not save the conversation for ${job.id}:`, err);
  }
}

/** The run's conversation: the kept one when finished, the live one while running/paused. */
export async function loadConversation(runDir: string): Promise<Anthropic.Messages.MessageParam[] | null> {
  for (const file of [CONVERSATION_FILE, STATE_FILE]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(runDir, file), "utf8")) as { messages?: unknown };
      if (Array.isArray(parsed.messages)) return parsed.messages as Anthropic.Messages.MessageParam[];
    } catch {
      /* try the next */
    }
  }
  return null;
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

  if (name === "shortlist_buildings") {
    const commune = String(input.commune ?? "").trim();
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

  if (name === "render_roofs") {
    const raw = Array.isArray(input.candidates) ? input.candidates : [];
    const list = raw
      .map((c, i) => {
        const o = (c ?? {}) as Record<string, unknown>;
        return { label: String(o.label ?? `cand${i + 1}`), lat: Number(o.lat), lon: Number(o.lon) };
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
async function inspectCandidate(
  job: Job,
  input: Record<string, unknown>,
): Promise<Anthropic.Messages.ToolResultBlockParam["content"]> {
  const search = searchOf(job);
  let c = input.egid != null ? search.candidates[String(input.egid).trim()] : undefined;
  if (!c && typeof input.lat === "number" && typeof input.lon === "number") {
    c = (await addFromRegister(search, input.lat, input.lon)) ?? undefined;
  }
  if (!c) return `error: ${input.egid ?? "that point"} is not on your checklist and no register building of a shortlisted commune was found there — pass an EGID from your checklist, or lat/lon on the building (shortlist its commune first if it is in another one).`;
  const facts = listingFacts(job.input.listingText);
  const plot = c.plot ?? (await plotAt(c.lat, c.lon)) ?? undefined;
  const rows = factRows(facts, { floors: c.floors, dwellings: c.dwellings, footprintM2: c.footprintM2, plots: plot ? [plot] : [] });
  Object.assign(c, { plot, strongFit: strongFit(rows), fit: fitText(rows), closeLook: true });
  await saveSearch(job, search);
  const sheetNo = String(job.steps.filter((st) => st.title.startsWith("close look")).length + 1).padStart(2, "0");
  const blocks: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [];
  const sheet = text(
    [
      `Close look at ${c.egid} | ${c.address ?? "?"}, ${c.commune} (verdict so far: ${c.verdict}).`,
      `Register: floors ${c.floors ?? "?"}, dwellings ${c.dwellings ?? "?"}, footprint ${c.footprintM2 ?? "?"} m².`,
      `Plot: ${plot ? `${plot.number}${plot.egrid ? ` (${plot.egrid})` : ""}, ${plot.areaM2} m²` : "not found"}.`,
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

const text = (t: string): Anthropic.Messages.TextBlockParam => ({ type: "text", text: t });

// Put the register building at a point on the checklist (an answer or a close
// look outside the shortlist). Only into a commune already being searched.
async function addFromRegister(search: SearchState, lat: number, lon: number): Promise<LedgerEntry | null> {
  const b = await buildingAt(lat, lon).catch(() => null);
  if (!b) return null;
  const commune = search.shortlisted.find((x) => normalizeCommune(x) === normalizeCommune(b.commune));
  if (!commune) return null;
  const key = String(Number(b.egid));
  if (!search.candidates[key]) {
    addCandidates(search, commune, [
      { egid: Number(b.egid), lat: b.lat, lon: b.lon, floors: b.floors, footprintM2: b.footprintM2, dwellings: b.dwellings, address: b.address },
    ]);
  }
  return search.candidates[key];
}

const EXACT: ReadonlySet<Confidence> = new Set<Confidence>(["street", "building"]);

export interface ProofResult {
  proof: AnswerProof | null;
  blocking: string[]; // must be fixed before the address is recorded
  soft: string[]; // mismatches to explain or reconsider (sent back once)
}

// Is this exact answer proven? See the PROOF section of the prompt.
export async function proveAnswer(job: Job, a: Answer): Promise<ProofResult> {
  const search = searchOf(job);
  const blocking: string[] = [], soft: string[] = [];
  if (!search.shortlisted.length) {
    blocking.push("Nothing is shortlisted: shortlist the commune, view every candidate and give each a verdict.");
    return { proof: null, blocking, soft };
  }
  const claim =
    claimedEntry(search, { lat: a.latitude, lon: a.longitude, address: a.address }) ??
    (a.latitude != null && a.longitude != null ? await addFromRegister(search, a.latitude, a.longitude) : null);
  if (!claim) {
    blocking.push("Your answer is not a building on the checklist: give its exact pin (latitude/longitude on the building), shortlist its commune if it is not shortlisted yet, and inspect it with inspect_candidate.");
  } else {
    if (!claim.closeLook) blocking.push(`Inspect your answer first: inspect_candidate ${claim.egid} (${claim.address ?? "?"}).`);
    if (claim.verdict !== "match") blocking.push(`Mark ${claim.egid} (${claim.address ?? "?"}) as match once the close look confirms it.`);
  }
  const all = Object.values(search.candidates);
  const others = all.filter((c) => c !== claim && c.verdict === "match");
  if (others.length) {
    blocking.push(
      `Other candidates are also marked match: ${others.slice(0, 6).map((c) => `${c.egid} ${c.address ?? ""}`).join(", ")}. Reject them with the visible difference, or submit a ranked shortlist at block confidence.`,
    );
  }
  const open = unchecked(search).length;
  if (open) blocking.push(`${open} shortlisted candidates have no verdict yet (${coverageText(search)}): view and mark them.`);
  const poss = openPossibles(search).filter((c) => c !== claim);
  if (poss.length) {
    blocking.push(
      `${poss.length} candidates are still "possible" (${poss.slice(0, 8).map((c) => `${c.egid} ${c.address ?? ""}`).join(", ")}${poss.length > 8 ? ", …" : ""}): inspect each and settle it — rejected with the difference you see, or match.`,
    );
  }
  if (!claim) return { proof: null, blocking, soft };

  const plots = await plotsOf(a, claim);
  const rows = factRows(listingFacts(job.input.listingText), {
    floors: claim.floors,
    dwellings: claim.dwellings,
    footprintM2: claim.footprintM2,
    plots,
  });
  for (const r of rows.filter((x) => x.verdict === "mismatch")) {
    const line = `${r.fact} does not fit: the listing says ${r.listing}, the building has ${r.building}.`;
    if (r.hard) blocking.push(`${line} If the property covers several plots, list every one in parcels[]; otherwise this is not the house.`);
    else soft.push(`${line} Check it against the photos and reconsider; if you still hold it is the house, submit again and say why in the reasoning.`);
  }
  return {
    proof: {
      egid: claim.egid,
      facts: rows.map(({ fact, listing, building, verdict }) => ({ fact, listing, building, verdict })),
      ruledOut: all.filter((c) => c.verdict === "rejected").length,
      total: all.length,
    },
    blocking,
    soft,
  };
}

// The plots an answer covers: the ones it names (by EGRID), else the one under its building.
async function plotsOf(a: Answer, claim: LedgerEntry): Promise<Plot[]> {
  const named = (await Promise.all(a.parcels.filter((p) => p.egrid).map((p) => plotByEgrid(p.egrid!)))).filter(
    (p): p is Plot => !!p,
  );
  if (named.length) return named;
  const own = claim.plot ?? (await plotAt(claim.lat, claim.lon));
  return own ? [own] : [];
}

// An address that could not be proven is kept, as the top of a ranked
// shortlist, but not reported as the address.
export function unprovenAsShortlist(a: Answer, problems: string[]): Answer {
  return {
    ...a,
    found: false,
    confidence: "block",
    candidates: [
      { address: a.address, parcel: a.parcel, note: "Best candidate, not proven: " + problems.join(" ") },
      ...a.candidates,
    ],
    reasoning: `Not reported as the address because it is not proven: ${problems.join(" ")}\n\n${a.reasoning}`,
  };
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
    const egid = String(o.egid ?? "").trim();
    const verdict = String(o.verdict ?? "");
    const c = search.candidates[egid];
    if (!c || !["rejected", "possible", "match"].includes(verdict)) {
      refused.push(`${egid || "?"} (not on the checklist or bad verdict)`);
      continue;
    }
    if (verdict === "rejected" && !c.viewed && !c.closeLook) {
      refused.push(`${egid} (never viewed — view_candidates first)`);
      continue;
    }
    const why = rejectionProblem(c, verdict, String(o.reason ?? ""));
    if (why) {
      refused.push(`${egid} (${why})`);
      continue;
    }
    c.verdict = verdict as "rejected" | "possible" | "match";
    c.reason = String(o.reason ?? "").slice(0, 300);
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

// The job's search plan + checklist; runs started before it existed get an
// empty one (no plan, nothing gated) so the tools still work on resume.
function searchOf(job: Job): SearchState {
  if (!job.search) {
    job.search = {
      stated: job.input.municipality ?? null,
      primary: null,
      confidence: "unknown",
      evidence: [],
      ring: [],
      shortlisted: [],
      candidates: {},
    };
  }
  return job.search;
}

// Where the answer stood in the checking order of its commune — the measure of
// whether the shortlist's ordering (location clues, footprint) put it early.
function answerRank(search: SearchState, answer: Answer): string | null {
  const claim = claimedEntry(search, { lat: answer.latitude, lon: answer.longitude, address: answer.address });
  if (!claim) return null;
  const line = Object.values(search.candidates)
    .filter((c) => c.commune === claim.commune)
    .sort((a, b) => a.order - b.order);
  const k = line.indexOf(claim) + 1;
  return (
    `The answer (${claim.address ?? claim.egid}) was #${k} of ${line.length} in ${claim.commune}'s checking order` +
    ` (contact sheet ${Math.ceil(k / 16)})` +
    (claim.loc ? `; location fit ${claim.loc.score.toFixed(2)}: ${claim.loc.why}.` : "; no location score.")
  );
}

// shortlist_buildings' `near`: {lat, lon} or "lat,lon"; anything else is ignored.
function nearOf(v: unknown): { lat: number; lon: number } | undefined {
  let lat: unknown, lon: unknown;
  if (typeof v === "string") [lat, lon] = v.split(",").map((x) => Number(x.trim()));
  else if (v && typeof v === "object") ({ lat, lon } = v as { lat?: unknown; lon?: unknown });
  else return undefined;
  const ok = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  return ok(lat, 45, 48.5) && ok(lon, 5.5, 11) ? { lat, lon } : undefined;
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
