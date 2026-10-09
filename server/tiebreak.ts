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
// Real requests (platform.ts) and practice rounds (practice.ts) both use it.
// =============================================================================
import { exactAddressOf, sameAddress, type Candidate } from "./consensus";
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

/** The listing text with the compare-two-houses task, and the checklist holding just those two. */
export function tieBreakSetup(
  listingText: string | undefined,
  a: Job,
  b: Job,
): { text: string; seed: Pick<SearchState, "shortlisted" | "candidates"> } | null {
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
  const text = [
    listingText ?? "",
    "",
    CHECK_MARK,
    "Two investigators searched this listing on their own and named DIFFERENT houses:",
    describe("A", ca, ea),
    describe("B", cb, eb),
    "Your job is to decide which of these two houses the listing shows — or that it is neither. Do NOT search the commune again: compare these two.",
    "1. inspect_candidate A and B (by EGID, or by lat/lon if one is not on your checklist): each one's register facts and plot against the listing's numbers, its 40 m aerial and its real 3D roof.",
    "2. render_roofs on A, B and the houses right next to them: compare each roof's shape with the photos — hip or gable, ridge direction, dormers and roof windows, the step down to a lower wing — and each one's neighbours (swissBUILDINGS3D) with the buildings the photos show beside the house.",
    "3. Compare what the photos show of the place: which side the terrace and garden face, the slope, the street, its position in the row (end or middle), a shed, a carport, the view.",
    "4. Mark the one that matches as match and the other rejected with the visible difference, then submit the match. If both fit equally, or neither does, submit found=false at block confidence and say what would separate them.",
  ].join("\n");
  return { text, seed: { shortlisted: [], candidates } };
}
