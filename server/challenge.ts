// =============================================================================
// challenge — a person suggests another house for a listing, and it is weighed
// against what the searches found, in full depth.
//
// Daniel, 13.10: "if I challenge … it's very serious, and it needs to go to the
// full depth, not just a quick check … compare very carefully the ones that it
// found or didn't find with the one I suggest, and give me a breakdown of which
// one wins and why". A challenge is not a correction: the suggested house is one
// more candidate, not the answer. So it runs the tie-breaker's method
// (tiebreak.ts) on Opus with a bigger budget: every house a search named plus
// the suggested one, each inspected (register facts, plot, aerial, real roof,
// neighbours) and compared with the photos, each marked match or rejected with
// the visible difference, and one named the winner — or none.
// The register facts of each house are also checked at once (proof.ts), free,
// so the screen has something to show while the run works.
// =============================================================================
import { randomUUID } from "node:crypto";
import { runInvestigation } from "./agent";
import { type AgentImage } from "./agent-prompt";
import { saveListingPhotos } from "./agent-state";
import { exactAddressOf } from "./consensus";
import { buildingAt, buildingByEgid, flatsOf, type GwrBuilding } from "./gwr";
import { costUsd, createJob, getJob, type Job, type ModelId } from "./jobs";
import { decisive, factRows, listingFacts, plotAt, plotGroupFor, strongFit, type FactRow } from "./proof";
import { CHECK_MARK, type PlatformRequest } from "./requests";
import { claimedEntry, type LedgerEntry, type SearchState } from "./search";

const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";
const MODEL = (process.env.CHALLENGE_MODEL ?? "opus-5-5-high") as ModelId;
const BUDGET_USD = Number(process.env.CHALLENGE_BUDGET_USD ?? 5);
const MAX_MINUTES = Number(process.env.CHALLENGE_MAX_MINUTES ?? 20);

type QuickVerdict = "yes" | "likely" | "no" | "unsure";
type Fact = Pick<FactRow, "fact" | "listing" | "building" | "verdict">;

/** One house in a challenge: one the searches named, or the suggested one. */
interface ChallengeHouse {
  label: string; // A, B, C…
  egid: string;
  address: string | null;
  commune: string | null;
  lat: number;
  lon: number;
  suggested: boolean; // the person's challenger
  namedBy: string[]; // the models whose search named it
  quick: { verdict: QuickVerdict; reason: string; facts: Fact[] }; // register facts only
}

/** Stored on the request. */
export interface Challenge {
  id: string;
  createdAt: string;
  query: string;
  jobId: string;
  model: ModelId;
  houses: ChallengeHouse[];
  /** No search named an exact house: the suggested one is weighed against "not found". */
  noneFound: boolean;
}

/** What the screen shows: the stored challenge with the run's state and verdicts. */
export interface ChallengeView extends Challenge {
  status: Job["status"];
  costUsd: number;
  winner: string | null; // a house label, "other" (a neighbour), or null (none)
  winnerAddress: string | null;
  confidence: string | null;
  reasoning: string | null;
  verdicts: Record<string, { verdict: LedgerEntry["verdict"]; reason: string | null; looked: boolean }>;
  /** The reasoning, read into its parts (see taskText); empty parts when the run wrote free text. */
  compare: { criterion: string; cells: Record<string, { text: string; fit: "yes" | "no" | "unclear" }> }[];
  summary: Record<string, { wins: boolean; text: string }>;
  decidedBy: string | null;
  photos: string | null;
  /** The register contradicts the winner on a fact (agent.ts registerContradiction): a caveat, not a different winner. */
  caveat: string | null;
}

const FIT: Record<string, "yes" | "no" | "unclear"> = { fits: "yes", fit: "yes", yes: "yes", no: "no", "doesn't fit": "no", unclear: "unclear" };

// "COMPARE: Plot | A: 800 m² vs 815 (fits) | B: 1355 m² (no)", "A: WINS — …", "DECIDED BY: …".
function readReasoning(text: string, labels: string[]) {
  const compare: ChallengeView["compare"] = [];
  const summary: ChallengeView["summary"] = {};
  let decidedBy: string | null = null, photos: string | null = null, caveat: string | null = null;
  const rest: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^COMPARE:\s*(.+)$/i))) {
      const [criterion, ...parts] = m[1].split("|").map((x) => x.trim());
      const cells: Record<string, { text: string; fit: "yes" | "no" | "unclear" }> = {};
      for (const part of parts) {
        const c = part.match(/^([A-Z]):\s*(.*?)\s*(?:\((fits?|no|doesn't fit|unclear|yes)\))?$/i);
        if (c && labels.includes(c[1].toUpperCase())) cells[c[1].toUpperCase()] = { text: c[2], fit: FIT[(c[3] ?? "unclear").toLowerCase()] ?? "unclear" };
      }
      if (criterion) compare.push({ criterion, cells });
    } else if ((m = line.match(/^([A-Z])\s*(?::|—|-)\s*(WINS|LOSES)\b[\s:—-]*(.*)$/i)) && labels.includes(m[1].toUpperCase())) {
      summary[m[1].toUpperCase()] = { wins: m[2].toUpperCase() === "WINS", text: m[3].trim() };
    } else if ((m = line.match(/^DECIDED BY:\s*(.+)$/i))) decidedBy = m[1];
    else if ((m = line.match(/^PHOTOS:\s*(.+)$/i))) photos = m[1];
    else if ((m = line.match(/^Not confirmed: the register contradicts the listing — (.+?)\.?$/i))) caveat = m[1];
    else rest.push(line);
  }
  if (!photos && rest.length) photos = rest.join(" ");
  return { compare, summary, decidedBy, photos, caveat };
}

async function getJson(url: string, ms = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// An EGID typed as is, else the first hit of the address search (its featureId is "EGID_EDID").
async function findBuilding(query: string): Promise<GwrBuilding | null> {
  const q = query.trim();
  if (/^\d{4,10}$/.test(q)) return buildingByEgid(q);
  const j = await getJson(`${SEARCH}?searchText=${encodeURIComponent(q)}&type=locations&origins=address&sr=4326&limit=1`);
  const hit = (j.results ?? [])[0]?.attrs;
  if (!hit) return null;
  const egid = String(hit.featureId ?? "").split("_")[0];
  const byEgid = /^\d+$/.test(egid) ? await buildingByEgid(egid).catch(() => null) : null;
  if (byEgid) return byEgid;
  return typeof hit.lat === "number" && typeof hit.lon === "number" ? buildingAt(hit.lat, hit.lon) : null;
}

// The construction period beside the proof's three facts, never deciding the
// quick verdict (a listed year can be a renovation). The register's own living area and rooms per home are left out: they are
// often decades old (Lancy, 13.10: 100 m² and 4 rooms for a 182 m², 7-room house).
function moreRows(l: ReturnType<typeof listingFacts>, b: Partial<GwrBuilding>): Fact[] {
  const rows: Fact[] = [];
  if (l.year != null) {
    const p = b.period ?? null;
    const built = b.year ?? null;
    const building = built != null ? String(built) : p ? (p[0] === 0 ? `before ${p[1] + 1}` : `${p[0]}–${p[1]}`) : "not in the register";
    const fits = built != null ? Math.abs(built - l.year) <= 2 : p ? l.year >= p[0] - 1 && l.year <= p[1] + 1 : null;
    rows.push({ fact: "Year built", listing: String(l.year), building, verdict: fits == null ? "unknown" : fits ? "match" : "mismatch" });
  }
  return rows;
}

/** The register facts of one building against the listing, with a plain verdict. */
async function quickCheck(
  listingText: string,
  b: Pick<GwrBuilding, "egid" | "lat" | "lon" | "floors" | "dwellings" | "footprintM2"> & Partial<GwrBuilding>,
) {
  const l = listingFacts(listingText);
  const own = await plotAt(b.lat, b.lon).catch(() => null);
  const group = own && l.landM2 != null && !l.sharedLand ? await plotGroupFor(own, l.landM2).catch(() => null) : null;
  const plots = group ?? (own ? [own] : []);
  const flats = l.livingM2 != null && l.dwellings !== 1 ? await flatsOf(b.egid).catch(() => undefined) : undefined;
  const rows = factRows(l, { floors: b.floors, dwellings: b.dwellings, footprintM2: b.footprintM2, plots, flats });
  const miss = rows.find((r) => r.verdict === "mismatch");
  let verdict: QuickVerdict, reason: string;
  if (miss) {
    verdict = "no";
    reason = `${miss.fact} does not fit: listing ${miss.listing}, this building ${miss.building}.`;
  } else if (!l.sharedLand && decisive(rows, plots, l.landM2, l.landAltM2)) {
    verdict = "yes";
    reason = "Its plot matches the listed land within 2% and nothing in the register contradicts it.";
  } else if (strongFit(rows)) {
    verdict = "likely";
    reason = "Every fact fits, but they don't prove it on their own.";
  } else {
    verdict = "unsure";
    reason = rows.length ? "Nothing rules it out, but no fact separates it from its neighbours." : "The listing states no size or home count to check.";
  }
  const facts = [...rows.map(({ fact, listing, building, verdict: v }) => ({ fact, listing, building, verdict: v })), ...moreRows(l, b)];
  return { verdict, reason, facts };
}

const key = (egid: string | number) => String(Number(egid));

// The building a search's exact answer names: its proof's EGID, the checklist entry it claimed, or the register at its pin.
async function namedBuilding(job: Job | undefined): Promise<GwrBuilding | null> {
  const a = job?.answer;
  const c = exactAddressOf(a ?? null);
  if (!a || !c) return null;
  if (a.proof?.egid) {
    const b = await buildingByEgid(a.proof.egid).catch(() => null);
    if (b) return b;
  }
  const e = job?.search ? claimedEntry(job.search, { lat: c.latitude, lon: c.longitude, address: c.address }) : null;
  if (e) return (await buildingByEgid(e.egid).catch(() => null)) ?? { ...e, egid: String(e.egid) } as unknown as GwrBuilding;
  return c.latitude != null && c.longitude != null ? buildingAt(c.latitude, c.longitude).catch(() => null) : null;
}

function taskText(listingText: string, houses: ChallengeHouse[], noneFound: boolean): string {
  const labels = houses.map((h) => h.label);
  const list = labels.join(", ").replace(/, ([^,]*)$/, " and $1");
  const sug = houses.find((h) => h.suggested)!;
  const describe = (h: ChallengeHouse) =>
    `${h.label}: ${h.address ?? "?"}, ${h.commune ?? ""} (lat ${h.lat}, lon ${h.lon}) — EGID ${h.egid} on your checklist — ` +
    (h.suggested ? "SUGGESTED BY A PERSON as a challenge" : `named by the search${h.namedBy.length > 1 ? "es" : ""} (${h.namedBy.join(", ")})`) +
    `\n   Register (already decoded, use these and do not re-derive them): ${h.quick.facts.map((f) => `${f.fact.toLowerCase()} ${f.building}`).join("; ")}.`;
  return [
    listingText,
    "",
    CHECK_MARK,
    "A CHALLENGE. The searches below were run on this listing, and a person now suggests another house. This is not a correction: the suggestion is one more candidate, not the answer. Weigh it as seriously and as fairly as the houses the searches found — a person suggesting it is not evidence, and neither is a search having named it before.",
    noneFound
      ? `No search named an exact house. The suggested house is ${sug.label}; decide whether it is the house in the listing.`
      : `The houses to compare:`,
    ...houses.map(describe),
    "Go to full depth. Do NOT search the commune again; compare these houses, and their direct neighbours where a look-alike could be confused with them.",
    `1. inspect_candidate ${list} (by EGID): each one's register facts and plot against the listing's numbers, its 40 m aerial and its real 3D roof.`,
    `2. render_roofs on ${list} and the houses right next to them: compare each roof's shape with the photos — hip or gable, ridge direction, dormers and roof windows, a lower wing — and each one's neighbours with the buildings beside the house in the photos.`,
    "3. Compare what the photos show of the place: which side the garden, terrace and pool face, the slope, the street, its place in a row, a shed, a carport, the view.",
    `4. Mark EVERY one of ${list} match or rejected with mark_candidates, the reason naming the concrete difference or the concrete fit you see. At most one is a match.`,
    "5. Submit the winner. Your reasoning MUST be exactly these lines, nothing else (it is shown as a table):",
    `COMPARE: <criterion> | ${labels.map((l) => `${l}: <what ${l} has, a few words> (fits|no|unclear)`).join(" | ")}`,
    "   one COMPARE line per criterion you checked, each one a separate line: roof shape, pool and garden, the street and surroundings, the neighbours, the view, and anything else the photos or aerial show. Do NOT repeat living area, plot, homes or year built: the register rows already show them. Keep each cell under 12 words.",
    ...houses.map((h) => `${h.label}: WINS or LOSES — <one sentence>`),
    "DECIDED BY: <one sentence: the one thing that settles it>",
    "PHOTOS: <one sentence: what the photos could and could not show>",
    `6. If you rejected ALL of ${list} with a visible difference, you may name a neighbour instead; if nothing fits clearly, submit found=false at block confidence and say what would separate them.`,
  ].join("\n");
}

/** Start a challenge on a listing request. Throws a message for the person when it cannot. */
export async function startChallenge(req: PlatformRequest, query: string, images: AgentImage[]): Promise<Challenge> {
  const listingText = req.input.listingText;
  if (!listingText) throw new Error("This request has no listing text to check against.");
  if (!images.length) throw new Error("The listing's photos are no longer available.");
  const suggested = await findBuilding(query);
  if (!suggested) throw new Error("No building found at that address. Try street, number and postcode, or an EGID.");

  // Every house a search named, once, with the models that named it.
  const named = new Map<string, { b: GwrBuilding; by: string[] }>();
  for (const r of req.results ?? []) {
    if (r.status !== "done") continue;
    const b = await namedBuilding(getJob(r.jobId));
    if (!b) continue;
    const k = key(b.egid);
    const by = `${r.model}${r.check ? " (check)" : ""}`;
    const seen = named.get(k);
    if (seen) seen.by.push(by);
    else named.set(k, { b, by: [by] });
  }
  if (named.has(key(suggested.egid))) {
    throw new Error(`${suggested.address ?? `EGID ${suggested.egid}`} is the house the search already named — suggest a different one to challenge it.`);
  }

  const all = [...Array.from(named.values()), { b: suggested, by: [] as string[] }];
  const houses: ChallengeHouse[] = await Promise.all(
    all.map(async ({ b, by }, i) => ({
      label: String.fromCharCode(65 + i),
      egid: key(b.egid),
      address: b.address,
      commune: b.commune || null,
      lat: b.lat,
      lon: b.lon,
      suggested: b === suggested,
      namedBy: by,
      quick: await quickCheck(listingText, b),
    })),
  );
  const noneFound = houses.length === 1;

  const candidates: SearchState["candidates"] = {};
  houses.forEach((h, i) => {
    const b = all[i].b;
    candidates[h.egid] = {
      egid: h.egid, order: i + 1, commune: h.commune ?? "", address: h.address, lat: h.lat, lon: h.lon,
      floors: b.floors, dwellings: b.dwellings, footprintM2: b.footprintM2, viewed: false, verdict: "unchecked",
    };
  });
  const text = taskText(listingText, houses, noneFound);
  const job = await createJob(
    {
      municipality: req.input.municipality,
      listingText: text,
      imageCount: images.length,
      listingId: req.input.listingId,
      listingUrl: req.input.listingUrl,
      radarUrl: req.input.radarUrl,
      budgetUsd: BUDGET_USD,
      maxMinutes: MAX_MINUTES,
      tieBreak: true,
      tieBreakEgids: houses.map((h) => h.egid),
    },
    MODEL,
  );
  void (async () => {
    await saveListingPhotos(job.runDir, images);
    await runInvestigation(job, images, text, { shortlisted: [], candidates });
  })().catch((err) => console.error(`[challenge] ${job.id} crashed:`, err));
  return { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), query, jobId: job.id, model: MODEL, houses, noneFound };
}

/** The challenge as it stands: the run's state, each house's verdict, and the winner. */
export function viewChallenge(c: Challenge): ChallengeView {
  const job = getJob(c.jobId);
  const search = job?.search;
  const verdicts: ChallengeView["verdicts"] = {};
  for (const h of c.houses) {
    const e = search?.candidates[h.egid];
    verdicts[h.label] = { verdict: e?.verdict ?? "unchecked", reason: e?.reason ?? null, looked: !!e?.closeLook };
  }
  const a = job?.answer ?? null;
  const read = readReasoning(a?.reasoning ?? "", c.houses.map((h) => h.label));
  let winner: string | null = null;
  if (a?.found && search && exactAddressOf(a)) {
    const picked = claimedEntry(search, { lat: a.latitude, lon: a.longitude, address: a.address });
    winner = (picked && c.houses.find((h) => h.egid === key(picked.egid))?.label) ?? "other";
  } else if (job && job.status !== "running") {
    // The pick the register contradicts is recorded "not found" (agent.ts), but
    // the comparison still has a winner: the one house marked match. The
    // contradiction is shown beside it as a caveat (Lancy, 13.10).
    const matched = c.houses.filter((h) => verdicts[h.label]?.verdict === "match");
    const said = c.houses.filter((h) => read.summary[h.label]?.wins);
    winner = matched.length === 1 ? matched[0].label : said.length === 1 ? said[0].label : null;
  }
  return {
    ...read,
    ...c,
    status: job?.status ?? "error",
    costUsd: job ? costUsd(job.tokens, job.model) : 0,
    winner,
    winnerAddress: a?.found ? a.address : null,
    confidence: a?.confidence ?? null,
    reasoning: a?.reasoning ?? (job?.error ? `The run failed: ${job.error}` : null),
    verdicts,
  };
}
