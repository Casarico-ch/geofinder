// Is an exact answer proven? The PROOF section of the prompt, enforced: the
// claim was inspected and marked match, nothing else on the checklist is open,
// and the listing's facts fit the building and its plot (proof.ts).
import { flatsOf } from "./gwr";
import {
  decisive,
  factRows,
  listingFacts,
  neighbourPlots,
  plotAt,
  plotByEgrid,
  type ListingFacts,
  type Plot,
} from "./proof";
import { type LedgerEntry, claimedEntry, openPossibles, coverageText, mustCheck, topCheckText } from "./search";
import { type Answer, type AnswerProof, type Job } from "./jobs";
import { addFromRegister, searchOf } from "./agent-ledger";

export interface ProofResult {
  proof: AnswerProof | null;
  blocking: string[]; // must be fixed before the address is recorded
  soft: string[]; // mismatches to explain or reconsider (sent back once)
}

// Is this exact answer proven? See the PROOF section of the prompt.
export async function proveAnswer(job: Job, a: Answer): Promise<ProofResult> {
  const search = searchOf(job);
  const blocking: string[] = [],
    soft: string[] = [];
  if (!search.shortlisted.length) {
    blocking.push("Nothing is shortlisted: shortlist the commune, view every candidate and give each a verdict.");
    return { proof: null, blocking, soft };
  }
  const claim =
    claimedEntry(search, { lat: a.latitude, lon: a.longitude, address: a.address }) ??
    (a.latitude != null && a.longitude != null ? await addFromRegister(search, a.latitude, a.longitude) : null);
  if (!claim) {
    blocking.push(
      "Your answer is not a building on the checklist: give its exact pin (latitude/longitude on the building), shortlist its commune if it is not shortlisted yet, and inspect it with inspect_candidate.",
    );
  } else {
    if (!claim.closeLook)
      blocking.push(`Inspect your answer first: inspect_candidate ${claim.egid} (${claim.address ?? "?"}).`);
    if (claim.verdict !== "match")
      blocking.push(`Mark ${claim.egid} (${claim.address ?? "?"}) as match once the close look confirms it.`);
  }
  const all = Object.values(search.candidates);
  const others = all.filter((c) => c !== claim && c.verdict === "match");
  if (others.length) {
    blocking.push(
      `Other candidates are also marked match: ${others
        .slice(0, 6)
        .map((c) => `${c.egid} ${c.address ?? ""}`)
        .join(", ")}. Reject them with the visible difference, or submit a ranked shortlist at block confidence.`,
    );
  }
  // The rest of the checklist must be settled — unless the answer is decisive
  // on its own: its plot(s) match the listing's land within 2% and no register
  // fact contradicts it (proof.ts decisive).
  const checklist: string[] = [];
  const open = mustCheck(search).length;
  if (open)
    checklist.push(
      `${open} of ${topCheckText(search)} have no verdict yet (${coverageText(search)}): view and mark them.`,
    );
  const poss = openPossibles(search).filter((c) => c !== claim);
  if (poss.length) {
    checklist.push(
      `${poss.length} candidates are still "possible" (${poss
        .slice(0, 8)
        .map((c) => `${c.egid} ${c.address ?? ""}`)
        .join(
          ", ",
        )}${poss.length > 8 ? ", …" : ""}): inspect each and settle it — rejected with the difference you see, or match.`,
    );
  }
  if (!claim) return { proof: null, blocking: [...blocking, ...checklist], soft };

  const plots = await plotsOf(a, claim);
  const facts = listingFacts(job.input.listingText);
  const rows = factRows(facts, {
    floors: claim.floors,
    dwellings: claim.dwellings,
    footprintM2: claim.footprintM2,
    plots,
    flats: await flatsFor(facts, claim.egid),
  });
  const isDecisive =
    !facts.sharedLand && decisive(rows, plots, facts.landM2, facts.landAltM2) && (await plotsBelong(claim, plots));
  if (!isDecisive) blocking.push(...checklist);
  for (const r of rows.filter((x) => x.verdict === "mismatch")) {
    const line = `${r.fact} does not fit: the listing says ${r.listing}, the building has ${r.building}.`;
    if (r.hard)
      blocking.push(
        `${line} If the property covers several plots, list every one in parcels[]; otherwise this is not the house.`,
      );
    else
      soft.push(
        `${line} Check it against the photos and reconsider; if you still hold it is the house, submit again and say why in the reasoning.`,
      );
  }
  return {
    proof: {
      egid: claim.egid,
      facts: rows.map(({ fact, listing, building, verdict, off }) => ({
        fact,
        listing,
        building,
        verdict,
        ...(off != null ? { off } : {}),
      })),
      ruledOut: all.filter((c) => c.verdict === "rejected").length,
      total: all.length,
    },
    blocking,
    soft,
  };
}

// The register's flats, when the listing is a flat with a living area to find among them.
export function flatsFor(facts: ListingFacts, egid: string | number) {
  return facts.livingM2 != null && facts.dwellings !== 1 ? flatsOf(egid) : Promise.resolve(undefined);
}

// The plots an answer covers: the ones it names (by EGRID), else the group its
// building's plot was found to make with its neighbours, else that plot alone.
async function plotsOf(a: Answer, claim: LedgerEntry): Promise<Plot[]> {
  const named = (await Promise.all(a.parcels.filter((p) => p.egrid).map((p) => plotByEgrid(p.egrid!)))).filter(
    (p): p is Plot => !!p,
  );
  if (named.length) return named;
  if (claim.plotGroup?.length) return claim.plotGroup;
  const own = claim.plot ?? (await plotAt(claim.lat, claim.lon));
  return own ? [own] : [];
}

// Decisive only for plots that are the building's own and its neighbours, so a
// sum of unrelated plots picked to match the listing can never prove an answer.
async function plotsBelong(claim: LedgerEntry, plots: Plot[]): Promise<boolean> {
  const own = claim.plot ?? (await plotAt(claim.lat, claim.lon));
  if (!own) return false;
  const same = (x: Plot, y: Plot) => (x.egrid && y.egrid ? x.egrid === y.egrid : x.number === y.number);
  if (!plots.some((p) => same(p, own))) return false;
  if (plots.length === 1) return true;
  const near = await neighbourPlots(own);
  return plots.every((p) => same(p, own) || near.some((n) => same(n, p)));
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
