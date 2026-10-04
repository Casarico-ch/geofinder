// Checks that a commune's building enumeration (gwr.ts) is complete even when
// the register service returns the pages of a full tile in a different order on
// every call — which it does (Zermatt's busiest tile: 925 features came back as
// 822, 900 and 865 distinct buildings on three calls with offset paging).
// Run: pnpm test   (tsx, node:assert — no network: fetch is replaced by a fake)
import assert from "node:assert/strict";
import { fetchCommuneBuildings, type Commune } from "../server/gwr";

// 1500 buildings packed into one 0.01° tile, plus 300 spread over the rest.
const BFS = 6300;
const features = Array.from({ length: 1800 }, (_, i) => {
  const dense = i < 1500;
  const lon = dense ? 7.75 + ((i * 7919) % 1000) / 1e5 : 7.7 + ((i * 104729) % 9000) / 1e5;
  const lat = dense ? 46.02 + ((i * 6271) % 1000) / 1e5 : 46.0 + ((i * 1299709) % 4000) / 1e5;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { egid: 100000 + i, ggdenr: BFS, ggdename: "Testdorf", gastw: 2, ganzwhg: 1, garea: 90, gkat: 1020, gstat: 1004 },
  };
});

let calls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  calls++;
  const url = new URL(String(input));
  const [x0, y0, x1, y1] = url.searchParams.get("geometry")!.split(",").map(Number);
  const limit = Number(url.searchParams.get("limit"));
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const inside = features.filter((f) => {
    const [x, y] = f.geometry.coordinates;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  });
  // Like the real service: no stable order between calls.
  const shuffled = [...inside].sort(() => Math.random() - 0.5);
  return new Response(JSON.stringify({ results: shuffled.slice(offset, offset + limit) }), { status: 200 });
}) as typeof fetch;

const commune: Commune = { name: "Testdorf", bfs: BFS, canton: "VS", bbox: [7.7, 46.0, 7.79, 46.04], rings: [] };
const all = await fetchCommuneBuildings(commune);
assert.equal(all.length, features.length, `enumerated ${all.length} of ${features.length}`);
assert.equal(new Set(all.map((b) => b.egid)).size, features.length);
console.log(`✓ gwr: all ${features.length} buildings enumerated despite shuffled pages (${calls} calls)`);
