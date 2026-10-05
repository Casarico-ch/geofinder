// Checks that a plot's paid Popety data is bought once and then read from the
// store (popety-store.ts): a second look-up, a look-up after a restart and two
// look-ups at the same time each cost nothing more.
// Run: pnpm test   (tsx, node:assert — no network: fetch is replaced by a fake)
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const runs = await mkdtemp(path.join(tmpdir(), "popety-store-"));
process.env.RUNS_DIR = runs;
process.env.POPETY_API_KEY = "test";

const paid: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  paid.push(url.pathname);
  const body = url.pathname.endsWith("/buildings")
    ? { results: [] }
    : url.pathname.endsWith("/zoning")
      ? { general_plans: [{ regulations: {} }] }
      : { id: url.pathname.split("/")[3], plot_number: "HN12522", area: 596 };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const store = await import("../server/popety-store");

const first = await store.profileByLandId("land-1", "Horgen");
assert.equal(first.paid, true, "the first look-up buys the plot");
assert.equal(paid.length, 3, "a profile is three paid calls");

const again = await store.profileByLandId("land-1", null);
assert.equal(again.paid, false, "the second look-up is free");
assert.equal(paid.length, 3, "and calls Popety no more");
assert.equal(again.fetchedAt, first.fetchedAt, "it reports when the data was bought");
assert.deepEqual(await readdir(path.join(runs, "_popety")), ["land-1.json"], "kept on disk, no temp file left");

// Same time, same new plot: one purchase, one buyer.
const both = await Promise.all([store.profileByLandId("land-2", null), store.profileByLandId("land-2", null)]);
assert.equal(paid.length, 6, "two look-ups at once buy the plot once");
assert.deepEqual(both.map((b) => b.paid).sort(), [false, true], "only one of them is charged");

// A failed purchase is not kept: the next look-up tries again.
const ok = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
await assert.rejects(store.profileByLandId("land-3", null));
globalThis.fetch = ok;
const retry = await store.profileByLandId("land-3", null);
assert.equal(retry.paid, true, "a plot that failed is bought on the next look-up");

await rm(runs, { recursive: true, force: true });
console.log("popety-store: bought once, read back free, concurrent look-ups share one purchase ✓");
