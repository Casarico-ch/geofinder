// Lock run (Daniel, 21.10): before a search change becomes the default, the
// listings the current search ran are all run again with the change, and the
// TOTAL found has to be at least what it was — "it's the total, not the exact
// same listings": a house lost here is fine when more are found there. Here:
// the depth of the ranked list a run owes a verdict to (search.ts TOP_CHECK),
// passed per run as `topCheck` so production keeps its default while the lock
// runs.
//
// Run against the deployed admin API (the listing photos are kept, "Run again"
// reuses them):
//   pnpm lock:run -- --base https://geofinder-production.up.railway.app --top 150 [--since 2026-10-15] [--limit 100] [--parallel 3] [--password …]
//   pnpm lock:run -- --base … --top 150 --report <ids.json>   # only compare a run started earlier
//   pnpm lock:run -- --base … --top 150 --dry                  # list the set, start nothing
// Found = a listing request with two finished runs naming the same house
// (practice.ts foundPair, re-implemented here from consensus.ts so the script
// needs no server state). Exit code 1 when the total found went down.
import { writeFile } from "node:fs/promises";
import { exactAddressOf, sameAddress, type Candidate } from "../server/consensus";
import type { Answer } from "../server/jobs";

type Result = { model: string; jobId: string; status: string; answer: Answer | null; confirm?: boolean; check?: boolean };
type Req = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  input: { listingId?: string; municipality?: string; imageCount?: number; topCheck?: number };
  results?: Result[];
  skipped?: string;
};

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = (arg("base") ?? "").replace(/\/+$/, "");
const top = Number(arg("top"));
if (!base || !(top > 0)) {
  console.error("usage: lock-run --base <admin url> --top <depth> [--since YYYY-MM-DD] [--limit N] [--parallel N] [--password P] [--report ids.json]");
  process.exit(2);
}
const since = arg("since", "2026-10-15")!;
const limit = Number(arg("limit", "100"));
const parallel = Number(arg("parallel", "3"));
const password = arg("password") ?? process.env.GEOFINDER_ADMIN_PASSWORD;
const headers: Record<string, string> = { "content-type": "application/json" };
if (password) headers.authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** The house two finished runs of a request agree on, or null. */
function settledHouse(r: Req): Candidate | null {
  const exact = (r.results ?? [])
    .filter((m) => m.status === "done")
    .map((m) => exactAddressOf(m.answer, { parcel: true }))
    .filter((c): c is Candidate => !!c);
  for (let i = 0; i < exact.length; i++)
    for (let j = i + 1; j < exact.length; j++) if (sameAddress(exact[i], exact[j])) return exact[i];
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { requests } = await api<{ requests: Req[] }>("/api/requests");
  const listings = requests.filter((r) => r.kind === "listing");
  const report = arg("report");
  let pairs: { oldId: string; newId: string }[];
  if (report) {
    pairs = JSON.parse(await (await import("node:fs/promises")).readFile(report, "utf8")) as typeof pairs;
  } else {
    // Every listing the current search ran (not the lock runs themselves, not
    // parking listings, not ones still running), newest first.
    const settled = listings
      .filter((r) => r.createdAt >= since && !r.input.topCheck && !r.skipped && r.status !== "running" && (r.results ?? []).length)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    const foundBefore = settled.filter((r) => settledHouse(r)).length;
    console.log(`${settled.length} listings since ${since}, ${foundBefore} found; re-running each with topCheck=${top}, ${parallel} at a time`);
    if (process.argv.includes("--dry")) {
      for (const r of settled) {
        const h = settledHouse(r);
        console.log(`  ${(h ? "found" : "-").padEnd(6)} ${(r.input.listingId ?? r.id).padEnd(16)} ${(r.input.municipality ?? "").padEnd(20)} ${h ? (h.address ?? h.parcel) : ""}`);
      }
      return;
    }
    pairs = [];
    let next = 0;
    const worker = async () => {
      while (next < settled.length) {
        const r = settled[next++];
        const search = (r.results ?? []).find((m) => !m.check && !m.confirm) ?? r.results![0];
        try {
          const { requestId } = await api<{ requestId: string }>("/api/requests/rerun", { method: "POST", body: JSON.stringify({ jobIds: [search.jobId], topCheck: top }) });
          pairs.push({ oldId: r.id, newId: requestId });
          console.log(`  started ${r.input.listingId ?? r.id} (${r.input.municipality ?? "?"}) → ${requestId}`);
          // Wait for this one before starting the next on this worker.
          for (;;) {
            await sleep(30_000);
            const cur = await api<Req>(`/api/requests/${requestId}`);
            if (cur.status !== "running") break;
          }
        } catch (err) {
          console.error(`  ${r.input.listingId ?? r.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: parallel }, worker));
    const file = `lock-run-${top}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    await writeFile(file, JSON.stringify(pairs, null, 2));
    console.log(`pairs saved to ${file} (re-read with --report)`);
  }

  const byId = new Map(listings.map((r) => [r.id, r]));
  const fresh = await Promise.all(pairs.map((p) => api<Req>(`/api/requests/${p.newId}`).catch(() => null)));
  let kept = 0, lost = 0, other = 0, gained = 0, stillNot = 0, running = 0, before = 0, after = 0, costBefore = 0, costAfter = 0;
  const rows: string[] = [];
  const costOf = (r: Req) => (r.results ?? []).reduce((t, m) => t + ((m as unknown as { aiCostUsd?: number }).aiCostUsd ?? 0), 0);
  pairs.forEach((p, i) => {
    const old = byId.get(p.oldId);
    const now = fresh[i];
    if (!old || !now) return;
    const was = settledHouse(old);
    const is = settledHouse(now);
    if (was) before++;
    costBefore += costOf(old);
    let verdict: string;
    if (now.status === "running") { verdict = "running"; running++; }
    else {
      if (is) after++;
      costAfter += costOf(now);
      if (was && is && sameAddress(was, is)) { verdict = "kept"; kept++; }
      else if (was && is) { verdict = `OTHER HOUSE: ${is.address}`; other++; }
      else if (was) { verdict = "LOST"; lost++; }
      else if (is) { verdict = `GAINED: ${is.address ?? is.parcel}`; gained++; }
      else { verdict = "still not"; stillNot++; }
    }
    rows.push(`${verdict.padEnd(12)} ${(old.input.listingId ?? p.oldId).padEnd(16)} ${(old.input.municipality ?? "").padEnd(20)} ${was ? (was.address ?? was.parcel) : "-"}  $${costOf(old).toFixed(2)} → $${costOf(now).toFixed(2)}  ${now.id}`);
  });
  console.log(rows.sort().join("\n"));
  const done = rows.length - running;
  console.log(
    `\ntopCheck=${top}: found ${before} → ${after} of ${done} (kept ${kept}, gained ${gained}, lost ${lost}, other house ${other}, still not found ${stillNot})` +
      `, cost $${costBefore.toFixed(0)} → $${costAfter.toFixed(0)}${running ? `; ${running} still running` : ""}`,
  );
  if (running) console.log("run again with --report to finish the comparison");
  if (!running && after < before) {
    console.log(`LOCK FAILED: ${after} found is fewer than ${before} before.`);
    process.exit(1);
  }
  if (!running) console.log(`LOCK PASSED: ${after} found is not fewer than ${before} before.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
