// =============================================================================
// tiebreak — the third Opus, when the first answer and the confirming search
// named different houses (Daniel, 09.10).
//
// It does not search the commune again: it is given the two houses and must
// tell which one the listing shows, or neither, from what tells look-alike
// houses apart — each one's register facts and plot (inspect_candidate), its
// real roof and its neighbours in swissBUILDINGS3D (render_roofs, the
// neighbours clue), its aerial and its place in the row, against the photos.
// Kronenwis 32 / 35, Reichenburg: two attached row houses, one of them right.
// Every house any search named is compared, not just the last two (Verbier,
// 09.10: three searches, three chalets on one street, the first one left out).
// When they stand on one street, every house on it joins the checklist
// (Pré-du-Pont 56 / 38, Laténa: the right one was No 28), and it may name
// another house — only once it has rejected all the named ones with a visible
// difference (agent.ts). Its pick does not count while the register contradicts
// the listing (agent.ts registerContradiction). Real requests (platform.ts) and
// practice rounds (practice.ts) both use it.
// =============================================================================
import { exactAddressOf, sameAddress, streetOf, type Candidate } from "./consensus";
import { fetchCommuneBuildings, resolveCommune, type GwrBuilding } from "./gwr";
import type { Job } from "./jobs";
import { CHECK_MARK } from "./requests";
import { claimedEntry, type LedgerEntry, type SearchState } from "./search";

type Run = { done: boolean; answer: Job["answer"]; confirm?: boolean };

/**
 * The runs a tie-breaker compares: one per house the searches named, when the
 * confirming search named a house no other run agrees with. Null otherwise.
 */
export function tieBreakRuns<T extends Run>(runs: T[]): T[] | null {
  const exact = runs.filter((r) => r.done && exactAddressOf(r.answer));
  const confirm = [...exact].reverse().find((r) => r.confirm);
  if (!confirm) return null;
  // One run per house, the latest naming it.
  const distinct: T[] = [];
  for (const r of [...exact].reverse()) {
    const c = exactAddressOf(r.answer)!;
    if (!distinct.some((d) => sameAddress(exactAddressOf(d.answer)!, c))) distinct.push(r);
  }
  return distinct.length >= 2 ? distinct.reverse() : null;
}

const describe = (label: string, c: Candidate, e: LedgerEntry | null) =>
  `${label}: ${c.address}${c.parcel ? `, plot ${c.parcel}` : ""}` +
  (c.latitude != null && c.longitude != null ? ` (lat ${c.latitude}, lon ${c.longitude})` : "") +
  (e ? ` — EGID ${e.egid} on your checklist` : "");

const STREET_MAX = 40;

/** The listing text with the compare task, and the checklist holding the named houses (and their street). */
export async function tieBreakSetup(
  listingText: string | undefined,
  jobs: Job[],
): Promise<{ text: string; seed: Pick<SearchState, "shortlisted" | "candidates">; egids: string[] } | null> {
  const named = jobs
    .map((job) => ({ job, c: exactAddressOf(job.answer) }))
    .filter((x): x is { job: Job; c: Candidate } => !!x.c);
  if (named.length < 2) return null;
  const entry = (job: Job, c: Candidate): LedgerEntry | null => {
    const e = job.search ? claimedEntry(job.search, { lat: c.latitude, lon: c.longitude, address: c.address }) : null;
    return e ? { ...e, verdict: "unchecked", viewed: false, closeLook: false, reason: undefined } : null;
  };
  const entries = named.map((x) => entry(x.job, x.c));
  const candidates: SearchState["candidates"] = {};
  for (const e of entries) if (e) candidates[e.egid] = e;
  // One street for all of them: every home on it is a candidate too.
  const streets = new Set(named.map((x) => streetOf(x.c.address)));
  const street = streets.size === 1 ? Array.from(streets)[0] || null : null;
  const commune = entries.find((e) => e)?.commune ?? named[0].job.answer?.commune ?? null;
  const near = entries.find((e) => e) ?? null;
  const onStreet = street && commune ? await streetHomes(commune, street, near && { lat: near.lat, lon: near.lon }).catch(() => []) : [];
  let order = Object.keys(candidates).length;
  for (const h of onStreet) {
    if (candidates[h.egid]) continue;
    candidates[h.egid] = {
      egid: h.egid, order: ++order, commune: h.commune, address: h.address, lat: h.lat, lon: h.lon,
      floors: h.floors, dwellings: h.dwellings, footprintM2: h.footprintM2, viewed: false, verdict: "unchecked",
    };
  }
  const egids = entries.filter((e): e is LedgerEntry => !!e).map((e) => e.egid);
  const others = onStreet.filter((h) => !egids.includes(h.egid));
  const labels = named.map((_, i) => String.fromCharCode(65 + i)); // A, B, C…
  const list = labels.join(", ").replace(/, ([^,]*)$/, " and $1");
  const text = [
    listingText ?? "",
    "",
    CHECK_MARK,
    `${named.length} investigators searched this listing on their own and named ${named.length} DIFFERENT houses:`,
    ...named.map((x, i) => describe(labels[i], x.c, entries[i])),
    ...(others.length
      ? [`They are all on the same street. Its other ${others.length} homes are on your checklist too: ${others.map((h) => h.address).join("; ")}.`]
      : []),
    `Your job is to decide which house the listing shows. Do NOT search the commune again: compare these.`,
    `1. inspect_candidate ${list} (by EGID, or by lat/lon if one is not on your checklist): each one's register facts and plot against the listing's numbers, its 40 m aerial and its real 3D roof.`,
    `2. render_roofs on ${list} and the houses right next to them${others.length ? " (and the rest of the street)" : ""}: compare each roof's shape with the photos — hip or gable, ridge direction, dormers and roof windows, the step down to a lower wing — and each one's neighbours (swissBUILDINGS3D) with the buildings the photos show beside the house.`,
    "3. Compare what the photos show of the place: which side the terrace and garden face, the slope, the street, its position in the row (end or middle), a shed, a carport, the view.",
    `4. Mark each of ${list} match or rejected with the visible difference; at most one is a match. Submit it.`,
    `5. Only if you rejected ALL of ${list} with a visible difference may you answer another house${others.length ? " (a neighbour, or another home on the street)" : " (a neighbour)"}: inspect it, mark it match and say why it fits better. The code sends it back while one of ${list} is not rejected.`,
    "6. A pick the register contradicts (more homes in the building, a living area or rooms far from the listing's, a plot of another size) is not recorded as found. If nothing fits clearly, submit found=false at block confidence and say what would separate them.",
  ].join("\n");
  return { text, seed: { shortlisted: [], candidates }, egids };
}

async function streetHomes(commune: string, street: string, near: { lat: number; lon: number } | null): Promise<GwrBuilding[]> {
  const c = await resolveCommune(commune);
  if (!c) return [];
  const all = await fetchCommuneBuildings(c);
  const num = (a: string | null) => Number((a ?? "").match(/\d+/)?.[0] ?? 0);
  const dist = (h: GwrBuilding) => (near ? Math.hypot((h.lon - near.lon) * 78_000, (h.lat - near.lat) * 111_320) : num(h.address));
  return all
    // Homes only: "2.1" is a shed or garage numbered after its house.
    .filter((h) => h.address && streetOf(h.address) === street && !/\d+\.\d+/.test(h.address) && h.dwellings !== 0)
    // A long street: the homes nearest A and B.
    .sort((x, y) => dist(x) - dist(y))
    .slice(0, STREET_MAX)
    .sort((x, y) => num(x.address) - num(y.address));
}
