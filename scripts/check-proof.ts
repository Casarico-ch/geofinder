// Checks for the proof rules: an exact address has to be earned (agent.ts
// proveAnswer, rejectionProblem), the listing's facts against the building's
// (proof.ts), and the checklist a cross-check starts from (platform.ts).
// The numbers are Zermatt's (radar-6664063): Gryfelblatte 58 fits every fact,
// Riedweg 89 — claimed and "confirmed" twice — fits none of the hard ones.
// Run: pnpm test   (tsx, node:assert — no test framework; no network)
import assert from "node:assert/strict";
import { proveAnswer, rejectionProblem, unprovenAsShortlist } from "../server/agent";
import type { Answer, Job } from "../server/jobs";
import { seedForCheck, verifyText } from "../server/platform";
import { factRows, listingFacts, polygonAreaM2, strongFit } from "../server/proof";
import { type LedgerEntry, type SearchState, claimedEntry, openPossibles } from "../server/search";

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

const LISTING = `Municipality / commune: Zermatt

Title: Chalet exclusif au cœur des Alpes à Zermatt
Type: house
Category: house
Subtype: chalet
Rooms: 7.0
Living area m²: 236
Land area m²: 331
Lot number: 79589
Description:
Le Petit Pilou bénéficie d’un emplacement exceptionnel sur un versant sud…`;

const GRYFELBLATTE = { floors: 3, dwellings: 1, footprintM2: 80, plots: [{ number: "1681", egrid: "CH687252302120", areaM2: 330.8 }] };
const RIEDWEG = { floors: 2, dwellings: 2, footprintM2: 95, plots: [{ number: "1686", egrid: "CH622172523076", areaM2: 427.4 }] };

function entry(egid: string, over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    egid,
    order: Number(egid) % 1000,
    commune: "Zermatt",
    address: null,
    lat: 46.02,
    lon: 7.75,
    floors: 3,
    dwellings: 1,
    footprintM2: 80,
    viewed: true,
    verdict: "rejected",
    reason: "flat roof, no terrace",
    ...over,
  };
}

function zermatt(over: Record<string, Partial<LedgerEntry>> = {}): SearchState {
  const g = entry("960338", {
    address: "Gryfelblatte 58",
    lat: 46.02389,
    lon: 7.755999,
    verdict: "match",
    reason: "plot 331 m², brown gable chalet, sauna pod on the terrace",
    closeLook: true,
    strongFit: true,
    plot: GRYFELBLATTE.plots[0],
  });
  const r = entry("960331", { address: "Riedweg 89", lat: 46.024131, lon: 7.756649, floors: 2, dwellings: 2, footprintM2: 95, plot: RIEDWEG.plots[0] });
  const candidates: Record<string, LedgerEntry> = { [g.egid]: g, [r.egid]: r, "959951": entry("959951", { lat: 46.0184, lon: 7.7427 }) };
  for (const [k, v] of Object.entries(over)) candidates[k] = { ...(candidates[k] ?? entry(k)), ...v };
  return { stated: "Zermatt", primary: "Zermatt", confidence: "high", evidence: [], ring: [], shortlisted: ["Zermatt"], candidates };
}

const job = (search: SearchState) => ({ id: "t", input: { listingText: LISTING, imageCount: 0 }, search }) as unknown as Job;

function answer(over: Partial<Answer>): Answer {
  return {
    found: true,
    address: "Gryfelblatte 58, 3920 Zermatt",
    parcel: null,
    parcels: [],
    commune: "Zermatt",
    confidence: "building",
    latitude: 46.02389,
    longitude: 7.755999,
    reasoning: "r",
    candidates: [],
    links: [],
    ...over,
  };
}

// ---- the listing's own facts --------------------------------------------------
await check("reads land, living area and a single dwelling from the listing", () => {
  assert.deepEqual(listingFacts(LISTING), { landM2: 331, livingM2: 236, dwellings: 1, sharedLand: false });
});
await check("a flat or multi-family listing does not pin dwellings; a PPE share is not a plot", () => {
  assert.equal(listingFacts("Type: apartment\nLiving area m²: 90").dwellings, null);
  assert.equal(listingFacts("Type: house\nSubtype: multi-family house").dwellings, null);
  assert.equal(listingFacts("Type: house\nVilla en PPE\nLand area m²: 500").sharedLand, true);
});

// ---- listing vs building --------------------------------------------------------
await check("Gryfelblatte 58 fits every fact", () => {
  const rows = factRows(listingFacts(LISTING), GRYFELBLATTE);
  assert.deepEqual(rows.map((r) => r.verdict), ["match", "match", "match"]);
  assert.ok(strongFit(rows));
});
await check("Riedweg 89: two homes and a 427 m² plot do not fit; the plot is a hard mismatch", () => {
  const rows = factRows(listingFacts(LISTING), RIEDWEG);
  const by = Object.fromEntries(rows.map((r) => [r.fact, r]));
  assert.equal(by["Homes in the building"].verdict, "mismatch");
  assert.equal(by["Plot area"].verdict, "mismatch");
  assert.equal(by["Plot area"].hard, true);
  assert.ok(!strongFit(rows));
});
await check("several plots summed can match the land area", () => {
  const rows = factRows(listingFacts("Type: house\nLand area m²: 1481"), {
    floors: 3, dwellings: 1, footprintM2: 130,
    plots: [{ number: "1", egrid: null, areaM2: 900 }, { number: "2", egrid: null, areaM2: 580 }],
  });
  assert.equal(rows.find((r) => r.fact === "Plot area")?.verdict, "match");
});
await check("polygon area of a 20 m × 20 m square", () => {
  const dLat = 20 / 111_320, dLon = dLat / Math.cos((46 * Math.PI) / 180);
  const sq = [[7.75, 46], [7.75 + dLon, 46], [7.75 + dLon, 46 + dLat], [7.75, 46 + dLat], [7.75, 46]];
  assert.ok(Math.abs(polygonAreaM2({ type: "Polygon", coordinates: [sq] }) - 400) < 2);
});

// ---- rejecting a candidate ------------------------------------------------------
await check("'no' and 'small' are not reasons", () => {
  assert.match(rejectionProblem({}, "rejected", "no")!, /not a reason/);
  assert.match(rejectionProblem({}, "rejected", "small")!, /not a reason/);
  assert.equal(rejectionProblem({}, "rejected", "grey roofs, no brown chalet"), null);
  assert.equal(rejectionProblem({}, "possible", "x"), null);
});
await check("a strong fit cannot be rejected without a close look", () => {
  assert.match(rejectionProblem({ strongFit: true }, "rejected", "roof looks too small")!, /STRONG FIT/);
  assert.equal(rejectionProblem({ strongFit: true, closeLook: true }, "rejected", "hip roof, not a gable"), null);
});

// ---- the checklist --------------------------------------------------------------
await check("an answer is matched to its checklist entry by pin, then by address", () => {
  const s = zermatt();
  assert.equal(claimedEntry(s, { lat: 46.02389, lon: 7.756, address: null })?.egid, "960338");
  assert.equal(claimedEntry(s, { lat: null, lon: null, address: "Riedweg 89, 3920 Zermatt" })?.egid, "960331");
  assert.equal(claimedEntry(s, { lat: 46.1, lon: 7.9, address: "Nowhere 1" }), null);
});

// ---- is an exact answer proven? -------------------------------------------------
await check("Gryfelblatte 58, inspected, matched, everything else ruled out: proven", async () => {
  const pr = await proveAnswer(job(zermatt()), answer({}));
  assert.deepEqual(pr.blocking, []);
  assert.deepEqual(pr.soft, []);
  assert.equal(pr.proof?.egid, "960338");
  assert.equal(pr.proof?.ruledOut, 2);
  assert.equal(pr.proof?.total, 3);
});
await check("unviewed candidates, open possibles and a second match each block it", async () => {
  const s = zermatt({ "1": { verdict: "unchecked", viewed: false }, "2": { verdict: "possible" }, "3": { verdict: "match", lat: 46.03 } });
  const pr = await proveAnswer(job(s), answer({}));
  const all = pr.blocking.join("\n");
  assert.match(all, /1 shortlisted candidates have no verdict/);
  assert.match(all, /1 candidates are still "possible"/);
  assert.match(all, /also marked match: 3/);
  assert.equal(openPossibles(s).length, 1);
});
await check("an answer never looked at closely, or not marked match, is not proven", async () => {
  const s = zermatt({ "960338": { closeLook: false, verdict: "possible" } });
  const all = (await proveAnswer(job(s), answer({}))).blocking.join("\n");
  assert.match(all, /inspect_candidate 960338/);
  assert.match(all, /Mark 960338/);
});
await check("Riedweg 89 is blocked by its plot even when inspected and matched", async () => {
  const s = zermatt({
    "960338": { verdict: "rejected", reason: "crane over the roof, under works" },
    "960331": { verdict: "match", closeLook: true, reason: "gable chalet with deck" },
  });
  const pr = await proveAnswer(job(s), answer({ address: "Riedweg 89, 3920 Zermatt", latitude: 46.024131, longitude: 7.756649 }));
  assert.equal(pr.blocking.length, 1);
  assert.match(pr.blocking[0], /Plot area does not fit/);
  assert.match(pr.soft.join(" "), /Homes in the building does not fit/);
});
await check("an unproven address is kept as the top of a shortlist, not reported", () => {
  const a = unprovenAsShortlist(answer({}), ["Plot area does not fit."]);
  assert.equal(a.found, false);
  assert.equal(a.confidence, "block");
  assert.equal(a.candidates[0].address, "Gryfelblatte 58, 3920 Zermatt");
  assert.match(a.reasoning, /^Not reported as the address/);
});

// ---- the cross-check's starting point ---------------------------------------------
await check("a cross-check re-opens the claim and the strongest alternatives, keeps the rest", () => {
  const s = zermatt({
    "960338": { verdict: "rejected", reason: "small", closeLook: false },
    "960331": { verdict: "match", closeLook: true, reason: "gable chalet" },
  });
  const { seed, claim, reopened } = seedForCheck(s, {
    address: "Riedweg 89, 3920 Zermatt",
    parcel: "Zermatt 1686",
    latitude: 46.024131,
    longitude: 7.756649,
  });
  assert.equal(claim?.egid, "960331");
  assert.deepEqual(reopened.map((c) => c.egid), ["960338"]);
  assert.equal(reopened[0].reason, "small"); // what the checker is shown: the earlier verdict
  assert.equal(seed.candidates["960338"].verdict, "unchecked");
  assert.equal(seed.candidates["960331"].verdict, "unchecked");
  assert.equal(seed.candidates["959951"].verdict, "rejected");
  assert.equal(s.candidates["960331"].verdict, "match"); // the original is untouched
  const text = verifyText(LISTING, { address: "Riedweg 89, 3920 Zermatt", parcel: null, latitude: 46.024131, longitude: 7.756649 }, "claude-opus-5-5", claim, reopened);
  assert.match(text, /--- VERIFICATION TASK ---/);
  assert.match(text, /PROVE THAT ANSWER WRONG/);
  assert.match(text, /960338 \| Gryfelblatte 58 \| STRONG FIT \| earlier: rejected — "small"/);
});

if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${passed} proof checks passed`);
