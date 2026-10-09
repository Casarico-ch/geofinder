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
// When A and B stand on the same street, every house on it joins the checklist
// (Pré-du-Pont 56 / 38, Laténa: the right one was No 28), and it may name a
// third house — only once it has rejected A and B with a visible difference
// (agent.ts). Real requests (platform.ts) and practice rounds (practice.ts) both use it.
// =============================================================================
import { exactAddressOf, sameAddress, streetOf, type Candidate } from "./consensus";
import { fetchCommuneBuildings, resolveCommune, type GwrBuilding } from "./gwr";
import type { Job } from "./jobs";
import { CHECK_MARK } from "./requests";
import { claimedEntry, type LedgerEntry, type SearchState } from "./search";

type Run = { done: boolean; answer: Job["answer"]; confirm?: boolean };

/**
 * The two runs a tie-breaker compares: the confirming search's house and the
 * latest other house it disagrees with. Null when there is no such pair.
 */
export function tieBreakPair<T extends Run>(runs: T[]): [T, T] | null {
  const exact = runs.filter((r) => r.done && exactAddressOf(r.answer));
  const confirm = [...exact].reverse().find((r) => r.confirm);
  if (!confirm) return null;
  const mine = exactAddressOf(confirm.answer)!;
  const other = [...exact].reverse().find((r) => r !== confirm && !sameAddress(exactAddressOf(r.answer)!, mine));
  return other ? [other, confirm] : null;
}

const describe = (label: string, c: Candidate, e: LedgerEntry | null) =>
  `${label}: ${c.address}${c.parcel ? `, plot ${c.parcel}` : ""}` +
  (c.latitude != null && c.longitude != null ? ` (lat ${c.latitude}, lon ${c.longitude})` : "") +
  (e ? ` — EGID ${e.egid} on your checklist` : "");

const STREET_MAX = 40;

/** The listing text with the compare-two-houses task, and the checklist holding those two (and their street). */
export async function tieBreakSetup(
  listingText: string | undefined,
  a: Job,
  b: Job,
): Promise<{ text: string; seed: Pick<SearchState, "shortlisted" | "candidates">; egids: string[] } | null> {
  const ca = exactAddressOf(a.answer);
  const cb = exactAddressOf(b.answer);
  if (!ca || !cb) return null;
  const entry = (job: Job, c: Candidate): LedgerEntry | null => {
    const e = job.search ? claimedEntry(job.search, { lat: c.latitude, lon: c.longitude, address: c.address }) : null;
    return e ? { ...e, verdict: "unchecked", viewed: false, closeLook: false, reason: undefined } : null;
  };
  const ea = entry(a, ca);
  const eb = entry(b, cb);
  const candidates: SearchState["candidates"] = {};
  for (const e of [ea, eb]) if (e) candidates[e.egid] = e;
  // The same street: every home on it is a candidate too (the register's, in house-number order).
  const street = streetOf(ca.address) && streetOf(ca.address) === streetOf(cb.address) ? streetOf(ca.address) : null;
  const commune = ea?.commune ?? eb?.commune ?? a.answer?.commune ?? null;
  const near = ea ?? eb ?? null;
  const onStreet = street && commune ? await streetHomes(commune, street, near && { lat: near.lat, lon: near.lon }).catch(() => []) : [];
  let order = Object.keys(candidates).length;
  for (const h of onStreet) {
    if (candidates[h.egid]) continue;
    candidates[h.egid] = {
      egid: h.egid, order: ++order, commune: h.commune, address: h.address, lat: h.lat, lon: h.lon,
      floors: h.floors, dwellings: h.dwellings, footprintM2: h.footprintM2, viewed: false, verdict: "unchecked",
    };
  }
  const others = onStreet.filter((h) => h.egid !== ea?.egid && h.egid !== eb?.egid);
  const text = [
    listingText ?? "",
    "",
    CHECK_MARK,
    "Two investigators searched this listing on their own and named DIFFERENT houses:",
    describe("A", ca, ea),
    describe("B", cb, eb),
    ...(others.length
      ? [`Both are on the same street. Its other ${others.length} homes are on your checklist too: ${others.map((h) => h.address).join("; ")}.`]
      : []),
    "Your job is to decide which house the listing shows. Do NOT search the commune again: compare these.",
    "1. inspect_candidate A and B (by EGID, or by lat/lon if one is not on your checklist): each one's register facts and plot against the listing's numbers, its 40 m aerial and its real 3D roof.",
    "2. render_roofs on A, B and the houses right next to them: compare each roof's shape with the photos — hip or gable, ridge direction, dormers and roof windows, the step down to a lower wing — and each one's neighbours (swissBUILDINGS3D) with the buildings the photos show beside the house.",
    "3. Compare what the photos show of the place: which side the terrace and garden face, the slope, the street, its position in the row (end or middle), a shed, a carport, the view.",
    "4. If one of A and B matches, mark it match and the other rejected with the visible difference, then submit it.",
    `5. Only if you rejected BOTH A and B with a visible difference may you answer a third house${others.length ? " (a neighbour, or another home on the street)" : " (a neighbour)"}: inspect it, mark it match and say why it fits better. The code sends a third house back while A or B is not rejected.`,
    "6. If nothing fits clearly, submit found=false at block confidence and say what would separate them.",
  ].join("\n");
  return { text, seed: { shortlisted: [], candidates }, egids: [ea?.egid, eb?.egid].filter((x): x is string => !!x) };
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
