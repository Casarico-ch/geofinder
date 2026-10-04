// Checks for the shortlist's checking order (shortlist.ts) and the location
// clues that reorder it (locate.ts). The footprints are Zermatt's survivors as
// the register gave them on 2026-10-04: some have no footprint at all, which
// used to scatter the order.
// Run: pnpm test   (tsx, node:assert — no test framework; no network)
import assert from "node:assert/strict";
import { angleDiff, coerceLocation, scoreHouse, slopeFit, type ResolvedLandmark } from "../server/locate";
import { footprintKey, interleave } from "../server/shortlist";

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

await check("an unknown footprint ranks last, so the order is consistent", () => {
  // 40 houses with no footprint mixed among 300 with one; the target is 80 m².
  const houses = Array.from({ length: 340 }, (_, i) => ({
    id: i,
    fp: i % 8 === 0 ? null : 44 + ((i * 37) % 92),
  }));
  houses.push({ id: 999, fp: 80 });
  const sorted = [...houses].sort((a, b) => footprintKey(a.fp, 80) - footprintKey(b.fp, 80));
  const at = sorted.findIndex((h) => h.id === 999);
  const exact = houses.filter((h) => h.fp === 80).length;
  assert.ok(at < exact, `target at ${at + 1}, ${exact} houses share its footprint`);
  assert.ok(sorted.slice(-40).every((h) => h.fp === null), "unknown footprints are at the end");
});

await check("no footprint estimate keeps the incoming order", () => {
  assert.equal(footprintKey(null, undefined), 0);
  assert.equal(footprintKey(120, undefined), 0);
});

await check("interleave keeps every house exactly once", () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  const b = [...a].reverse();
  for (const take of [[2, 1], [1, 1], [1, 2]] as [number, number][]) {
    const out = interleave(a, b, take);
    assert.equal(out.length, 50);
    assert.equal(new Set(out).size, 50);
  }
});

await check("a wrong clue at most triples (sure), doubles (likely), 1.5× (guess) a house's place", () => {
  const n = 300;
  const footprint = Array.from({ length: n }, (_, i) => i);
  for (const [take, bound] of [[[2, 1], 3], [[1, 1], 2], [[1, 2], 1.5]] as [[number, number], number][]) {
    for (const target of [0, 10, 40, 113]) {
      // The worst case: the clue puts the target dead last.
      const location = [...footprint.filter((x) => x !== target), target];
      const place = interleave(location, footprint, take).indexOf(target) + 1;
      assert.ok(place <= Math.ceil((target + 1) * bound), `take ${take}: #${target + 1} → #${place}`);
    }
  }
});

await check("compass differences wrap around north", () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(90, 270), 180);
});

await check("slope: a west-falling slope fits W, not S (Zermatt's 'versant sud' house falls west)", () => {
  const gryfelblatte = { downhill: 272, grade: 0.44 };
  assert.equal(slopeFit(gryfelblatte, "W"), 1);
  assert.equal(slopeFit(gryfelblatte, "S"), 0);
  assert.equal(slopeFit(null, "W"), null);
  assert.equal(slopeFit({ downhill: 90, grade: 0.01 }, "flat"), 1);
});

await check("landmark: direction and distance seen from the house", () => {
  const house = { lat: 46.0, lon: 7.75 };
  const church: ResolvedLandmark = {
    clue: { kind: "church", direction: "N", distanceM: 200, confidence: "sure" },
    points: [{ lat: 46.0018, lon: 7.75, label: "Kirchplatz" }], // ~200 m north
    note: "",
  };
  const fits = scoreHouse(house, { landmarks: [church.clue] }, null, [church])!;
  assert.equal(fits.score, 1);
  const wrongSide = scoreHouse({ lat: 46.0036, lon: 7.75 }, { landmarks: [church.clue] }, null, [church])!;
  assert.equal(wrongSide.score, 0);
});

await check("confidence weighs the clues against each other", () => {
  const clues = coerceLocation({
    slope: { faces: "W", confidence: "sure" },
    landmarks: [{ kind: "peak", name: "Matterhorn", direction: "N", confidence: "guess" }],
  })!;
  const peak: ResolvedLandmark = { clue: clues.landmarks![0], points: [{ lat: 45.9763, lon: 7.6586, label: "Matterhorn" }], note: "" };
  // Slope fits, the guessed peak direction does not: still a good score.
  const s = scoreHouse({ lat: 46.0239, lon: 7.756 }, clues, { downhill: 272, grade: 0.44 }, [peak])!;
  assert.ok(s.score > 0.7 && s.score < 1, String(s.score));
});

await check("the model's location input is cleaned up", () => {
  assert.equal(coerceLocation(undefined), undefined);
  assert.equal(coerceLocation({ slope: { faces: "uphill" } }), undefined);
  const c = coerceLocation({
    slope: { faces: "sw", confidence: "very" },
    landmarks: [{ kind: "church", direction: "ne", confidence: "likely" }, { kind: "lake" }],
  })!;
  assert.deepEqual(c.slope, { faces: "SW", confidence: "guess" });
  assert.equal(c.landmarks!.length, 1);
  assert.equal(c.landmarks![0].direction, "NE");
});

if (failures.length) {
  console.error(`check-shortlist: ${failures.length} failed, ${passed} passed\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`check-shortlist: ${passed} passed`);
