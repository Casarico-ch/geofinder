// =============================================================================
// review — why each listing of a practice round was not confirmed right, and
// which of those causes need a code change rather than a prompt line.
//
// Daniel, 09.10: the prompt lessons never reached the code ("sometimes it was
// about the ranking code that had to be changed but it didn't happen"). This
// sorts every miss by cause from what the round already recorded (the
// verdict, where each run lost the right house, its rank, a twin, a time
// limit) and groups them into tasks with their evidence, to copy into a
// coding session. No model runs here: it costs nothing.
// =============================================================================
import { getJob } from "./jobs";
import { listingVerdict, truthCandidate, type PracticeResult, type PracticeRound } from "./practice";

export type Cause =
  | "agreed_wrong" // two runs named the same wrong house: the worst case
  | "wrong_commune" // no run shortlisted the right commune
  | "ranked_low" // the right house was ranked below what the runs looked at
  | "not_reached" // ranked high enough, but no run looked at it in time
  | "rejected" // a run looked at the right house and threw it out
  | "neighbour" // a run named the right house's attached twin or its neighbour
  | "no_agreement" // a run found it, no second run named the same house
  | "limits"; // the runs ran out of time or money, or crashed

export interface ReviewItem {
  propertyId: number;
  cause: Cause;
  code: boolean; // the fix is in code (ranking, flow, data), not in the prompt
  evidence: string; // one line: what the runs did
}

export interface ReviewGroup {
  cause: Cause;
  title: string;
  code: boolean;
  fix: string; // where a fix would go
  items: ReviewItem[];
  task: string; // the task text to paste into a coding session
}

const ABOUT: Record<Cause, { title: string; code: boolean; fix: string }> = {
  agreed_wrong: { title: "Two searches agreed on the wrong house", code: true, fix: "the confirm / tie-break rules (practice.ts wantsConfirm, tiebreak.ts) or the ranking that led both astray" },
  wrong_commune: { title: "The right commune was never searched", code: true, fix: "the commune choice (search plan, assessCommune)" },
  ranked_low: { title: "The right house was ranked too low", code: true, fix: "the ranking (shortlist.ts rankByListing): a listing fact it does not use yet" },
  not_reached: { title: "Ranked high enough, never looked at", code: true, fix: "the search flow: the top-of-list look (agent.ts unseenTop) or the time spent elsewhere" },
  rejected: { title: "Looked at the right house and rejected it", code: false, fix: "how candidates are compared with the photos (prompt, inspect_candidate, view_from)" },
  neighbour: { title: "Confused with a neighbour", code: true, fix: "the tie-breaker's comparison of look-alike neighbours (tiebreak.ts)" },
  no_agreement: { title: "Found, but no second search agreed", code: false, fix: "the confirming search: why it named another house or none" },
  limits: { title: "Ran out of time or money, or crashed", code: true, fix: "the time and cost limits (practice.ts stepLimits) or the error" },
};

const ORDER: Cause[] = ["agreed_wrong", "wrong_commune", "ranked_low", "not_reached", "neighbour", "rejected", "no_agreement", "limits"];

const LOOKED = 150; // the top of the list a run must see (agent.ts TOP_LOOK)

function ranks(runs: PracticeResult[]): string {
  const best = runs.filter((r) => r.rankOf != null).map((r) => (r.rank != null ? `#${r.rank}/${r.rankOf}` : `off the list/${r.rankOf}`));
  return best.length ? `right house ranked ${Array.from(new Set(best)).join(", ")}` : "right house never on a list";
}

function named(runs: PracticeResult[]): string {
  const a = runs.map((r) => r.answer).filter((x): x is string => !!x);
  return a.length ? `named ${Array.from(new Set(a)).join(" / ")}` : "named nothing";
}

/** The cause of one listing's miss, or null when it was confirmed right or is still running. */
export function reviewListing(round: PracticeRound, propertyId: number): ReviewItem | null {
  const verdict = listingVerdict(round, propertyId);
  if (verdict === "confirmed_right" || verdict === "running") return null;
  const runs = round.results.filter((r) => r.propertyId === propertyId);
  const line = (cause: Cause, extra = "") =>
    ({ propertyId, cause, code: ABOUT[cause].code, evidence: [named(runs), ranks(runs), extra].filter(Boolean).join("; ") });
  if (verdict === "confirmed_wrong") return line("agreed_wrong");
  if (runs.some((r) => r.twin)) return line("neighbour", "one answer is the right house's attached twin");
  if (runs.some((r) => r.outcome === "right")) return line("no_agreement");
  const lost = runs.map((r) => r.lostAt);
  if (lost.every((l) => l === "commune")) return line("wrong_commune");
  const rejected = runs.find((r) => r.lostAt === "rejected");
  if (rejected) {
    const job = rejected.jobId ? getJob(rejected.jobId) : undefined;
    const why = job ? truthCandidate(job, rejected.truth)?.reason : undefined;
    return line("rejected", why ? `rejected as: "${why.slice(0, 160)}"` : "");
  }
  const best = Math.min(...runs.map((r) => (r.rank != null ? r.rank : Infinity)));
  if (runs.some((r) => r.lostAt === "not_shortlisted") || best > LOOKED) return line("ranked_low");
  if (lost.some((l) => l === "never_looked" || l === "left_possible" || l === "not_proven")) return line("not_reached");
  if (runs.every((r) => r.outcome === "over_budget" || r.outcome === "error")) return line("limits");
  return line("ranked_low");
}

/** Every miss of a round, grouped by cause, worst first, with the task text to paste. */
// `withheld`: listings another practice run is still searching — a rejection
// reason names the right house's facts, so it waits until they are done.
export function reviewRound(round: PracticeRound, places: Record<number, string | null> = {}, withheld: Set<number> = new Set()): ReviewGroup[] {
  const ids = Array.from(new Set(round.results.map((r) => r.propertyId))).filter((id) => !withheld.has(id));
  const items = ids.map((id) => reviewListing(round, id)).filter((x): x is ReviewItem => !!x);
  return ORDER.map((cause) => {
    const mine = items.filter((i) => i.cause === cause);
    const about = ABOUT[cause];
    const task = [
      `GeoFinder practice round ${round.id}: ${about.title.toLowerCase()} (${mine.length} listing${mine.length === 1 ? "" : "s"}).`,
      `Likely fix: ${about.fix}.`,
      ...mine.map((i) => `- Radar ${i.propertyId}${places[i.propertyId] ? ` (${places[i.propertyId]})` : ""}: ${i.evidence}`),
      "Find the cause in the runs' traces, fix it, and re-run these listings in practice to show it helps.",
    ].join("\n");
    return { cause, title: about.title, code: about.code, fix: about.fix, items: mine, task };
  }).filter((g) => g.items.length);
}
