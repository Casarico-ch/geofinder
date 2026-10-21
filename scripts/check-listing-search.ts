// Checks for the one search every listing gets, in practice and in real
// requests alike (practice.ts nextSteps, foundPair).
// Run: pnpm test   (tsx, node:assert — no test framework; no network)
import assert from "node:assert/strict";
import type { Answer } from "../server/jobs";
import { foundPair, nextSteps, type ListingRun } from "../server/practice";
import { isParkingListing } from "../server/proof";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const answer = (a: Partial<Answer>): Answer =>
  ({ found: true, confidence: "street", address: "Seestrasse 12, 8810 Horgen", parcel: null, latitude: 47.26, longitude: 8.6, reasoning: "Roof and plot match.", ...a }) as Answer;
const run = (role: ListingRun["role"], a: Answer | null, settled = true): ListingRun => ({ role, jobId: `j${Math.random()}`, settled, done: settled && !!a, answer: a });

await check("a sure first answer needs a confirming search", () => {
  const steps = nextSteps([run("search", answer({}))]);
  assert.deepEqual(steps.map((s) => s.role), ["confirm"]);
});

await check("a doubtful first answer is searched again before anything else", () => {
  const steps = nextSteps([run("search", answer({ reasoning: "Probably this one." }))]);
  assert.deepEqual(steps.map((s) => s.role), ["recheck"]);
});

await check("a recheck happens once, and never after a confirm started", () => {
  const doubt = answer({ reasoning: "Probably this one." });
  assert.equal(nextSteps([run("search", doubt), run("recheck", null, false)]).length, 0);
  assert.ok(nextSteps([run("search", doubt), run("confirm", null, false)]).every((s) => s.role !== "recheck"));
});

await check("two runs naming the same house: found, nothing more runs", () => {
  const runs = [run("search", answer({})), run("confirm", answer({ address: "Seestr. 12, Horgen" }))];
  assert.ok(foundPair(runs));
  assert.equal(nextSteps(runs).length, 0);
});

await check("a plot named twice at parcel confidence counts as found", () => {
  const plot = answer({ confidence: "parcel", address: null, parcel: "Horgen 1234" });
  assert.ok(foundPair([run("search", plot), run("confirm", plot)]));
});

await check("a confirm naming another house brings the tie-breaker", () => {
  const steps = nextSteps([run("search", answer({})), run("confirm", answer({ address: "Bergweg 3, 8810 Horgen", latitude: 47.3, longitude: 8.7 }))]);
  assert.equal(steps[0]?.role, "confirm");
  assert.equal(steps[0]?.tieBreakOf?.length, 2);
});

await check("a lesson test runs no confirm", () => {
  assert.equal(nextSteps([run("search", answer({}))], { confirm: false }).length, 0);
});

await check("a confirm that crashed runs again, once", () => {
  const crashed = { ...run("confirm", null), settled: true, done: false };
  const again = nextSteps([run("search", answer({})), crashed]);
  assert.deepEqual(again.map((s) => s.role), ["confirm"]);
  assert.equal(again[0].verifyOf, undefined);
  assert.equal(nextSteps([run("search", answer({})), crashed, { ...crashed, jobId: "j-crash-2" }]).length, 0);
});

await check("a confirm that found nothing brings the third judge, handed the house", () => {
  const first = run("search", answer({}));
  const missed = run("confirm", answer({ found: false, confidence: "block", address: null }));
  const steps = nextSteps([first, missed]);
  assert.equal(steps[0]?.role, "confirm");
  assert.equal(steps[0]?.verifyOf, first.jobId);
  assert.deepEqual(steps[0]?.missedBy, [missed.jobId]);
  assert.equal(steps[0]?.tieBreakOf, undefined);
});

await check("the third judge is the last word", () => {
  const first = run("search", answer({}));
  const missed = run("confirm", answer({ found: false, confidence: "block", address: null }));
  assert.equal(nextSteps([first, missed, run("confirm", answer({ found: false, confidence: "block", address: null }))]).length, 0);
  const judged = [first, missed, run("confirm", answer({ address: "Seestr. 12, Horgen" }))];
  assert.ok(foundPair(judged));
  assert.equal(nextSteps(judged).length, 0);
});

await check("a parking listing is recognised, land and a house with parking are not", () => {
  assert.ok(isParkingListing("Title: Place de parc\nType: other\nCategory: parking\nSubtype: underground_parking\n"));
  assert.ok(isParkingListing("Title: Box fermé\nType: parking\nCategory: garage\nSubtype: garage\n"));
  assert.ok(!isParkingListing("Title: Terrain\nType: other\nCategory: land\nSubtype: building_plot\n"));
  assert.ok(!isParkingListing("Title: Villa\nCategory: house\nSubtype: villa\nParking: garage, 2 places\n"));
  assert.ok(!isParkingListing(undefined));
});

if (failures.length) {
  console.error(`listing search: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`listing search: ${passed} passed`);
