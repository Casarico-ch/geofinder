// =============================================================================
// verify — the third judge, when one search named a house and the confirming
// search found nothing (Daniel, 21.10: "hand the address to the 3rd judge and
// let him know that the second one didn't find anything").
//
// Before, a confirm that found nothing ended the listing with no address for
// Radar: 10 of the last 100 real searches, among them Quai Wilson 39 and Rue de
// Bernex 318, where the first search had the house and the confirm died at its
// budget 31/350 candidates in. The judge does not search the commune again: it
// starts from the finder's checklist with the claimed house and its strongest
// alternatives open, is told what the second search covered without finding it,
// and must confirm the house with a close look or reject it with a visible
// difference. Its confirmation is the second run naming the house (foundPair).
// =============================================================================
import { exactAddressOf, type Candidate } from "./consensus";
import type { Job, KnownModel } from "./jobs";
import { CHECK_MARK } from "./requests";
import { claimedEntry, coverageText, type LedgerEntry, type SearchState } from "./search";

// How many alternatives a cross-check re-opens besides the claimed house.
const REOPEN = 8;

const modelLabel = (m: KnownModel) =>
  m
    .replace(/^claude-/, "")
    .replace(/-(\d)-(\d)$/, " $1.$2")
    .replace(/^./, (c) => c.toUpperCase());

/**
 * The checklist a cross-check starts from: the search's own, with its verdicts
 * kept, except the claimed house and the strongest alternatives it set aside
 * (strong fits first, then "possible" ones, nearest to the claim first), which
 * are open again. The proof rules (prove.ts proveAnswer) then mean the checker
 * can only confirm the claim after a close look at it AND a visible reason
 * against each re-opened alternative.
 */
export function seedForCheck(
  search: Pick<SearchState, "shortlisted" | "candidates"> | undefined,
  candidate: Candidate,
): { seed: Pick<SearchState, "shortlisted" | "candidates">; claim: LedgerEntry | null; reopened: LedgerEntry[] } {
  const seed = { shortlisted: [...(search?.shortlisted ?? [])], candidates: structuredClone(search?.candidates ?? {}) };
  const claim = claimedEntry(seed as SearchState, {
    lat: candidate.latitude,
    lon: candidate.longitude,
    address: candidate.address,
  });
  const near = (c: LedgerEntry) =>
    claim ? Math.hypot((c.lon - claim.lon) * 78_000, (c.lat - claim.lat) * 111_320) : c.order;
  const reopened = Object.values(seed.candidates)
    .filter((c) => c !== claim && (c.strongFit || c.verdict === "possible" || c.verdict === "match"))
    .sort((a, b) => Number(!!b.strongFit) - Number(!!a.strongFit) || near(a) - near(b))
    .slice(0, REOPEN);
  const before = reopened.map((c) => ({ ...c }));
  for (const c of [claim, ...reopened]) {
    if (!c) continue;
    Object.assign(c, { verdict: "unchecked", viewed: false, closeLook: false, reason: undefined });
  }
  return { seed, claim, reopened: before };
}

/** What a search that found nothing can say for itself: its coverage and the start of its explanation. */
function missedNote(job: Job): string {
  const cover = job.search?.shortlisted.length ? ` It covered: ${coverageText(job.search)}.` : "";
  const why = (job.answer?.reasoning ?? "").replace(/\s+/g, " ").trim();
  return `${modelLabel(job.model)} searched on its own and did NOT find this house.${cover}${why ? ` It said: "${why.slice(0, 700)}${why.length > 700 ? "…" : ""}"` : ""}`;
}

/**
 * The listing text with the judge's task appended, and the checklist it starts
 * from. `named`: the run that found the house; `missedBy`: the confirming
 * search(es) that found nothing. Null when the named run has no exact house.
 */
export function verifySetup(
  listingText: string | undefined,
  named: Job,
  missedBy: Job[],
): { text: string; seed: Pick<SearchState, "shortlisted" | "candidates"> } | null {
  const candidate = exactAddressOf(named.answer);
  if (!candidate) return null;
  const { seed, claim, reopened } = seedForCheck(named.search, candidate);
  const pin =
    candidate.latitude != null && candidate.longitude != null
      ? ` (around ${candidate.latitude}, ${candidate.longitude})`
      : "";
  const alt = reopened.map(
    (c) =>
      `- ${c.egid} | ${c.address ?? "?"}${c.strongFit ? " | STRONG FIT" : ""} | earlier: ${c.verdict}${c.reason ? ` — "${c.reason}"` : ""}`,
  );
  const text = [
    listingText ?? "",
    "",
    CHECK_MARK,
    `An investigator (${modelLabel(named.model)}) concluded that this property is at: ${candidate.address}${candidate.parcel ? `, plot ${candidate.parcel}` : ""}${pin}${claim ? ` — EGID ${claim.egid} on your checklist` : ""}.`,
    ...missedBy.map(missedNote),
    "You are the third judge. Decide whether the named house is the one — not by searching the commune again: you start from the finder's checklist. Its verdicts are kept, except the named house" +
      (alt.length ? " and these alternatives it set aside, which are open again:" : ", which is open again."),
    ...alt,
    '1. inspect_candidate the named house. Every ✗ in its fact sheet (homes, living area, plot area) counts against it; then compare its roof, its aerial and its neighbours with the photos. One clear mismatch rejects it — never explain one away ("the register may be wrong").',
    "2. inspect_candidate every re-opened alternative and settle it: rejected with the difference you see, or match. If one fits better than the named house, that one is the answer.",
    "3. Weigh what the second search says: where it looked and why it rejected what it saw. A house it never viewed is not weakened by its miss; a house it rejected for a visible reason is.",
    "4. The named house is confirmed only if it survives step 1 and every alternative is rejected with a visible difference — the code checks this before it records a street/building answer. Then submit it as the answer. Otherwise report found=false at block confidence with your ranked candidates and the mismatch you found.",
  ].join("\n");
  return { text, seed };
}
