// Lock run (Daniel, 21.10): before a search change becomes the default, the
// listings the current search settled are run again with the change, and every
// one of them has to come back with the same house. Here: the depth of the
// ranked list a run owes a verdict to (search.ts TOP_CHECK), passed per run as
// `topCheck` so production keeps its default while the lock runs.
//
// Run against the deployed admin API (the listing photos are kept, "Run again"
// reuses them):
//   pnpm lock:run -- --base https://geofinder-production.up.railway.app --top 150 [--since 2026-10-15] [--limit 53] [--parallel 3] [--password …]
//   pnpm lock:run -- --base … --top 150 --report <ids.json>   # only compare a run started earlier
//   pnpm lock:run -- --base … --top 150 --dry                  # list the settled set, start nothing
// Settled = a listing request with two finished runs naming the same house
// (practice.ts foundPair, re-implemented here from consensus.ts so the script
// needs no server state). Exit code 1 when any of them is lost.
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
    const settled = listings
      .filter((r) => r.createdAt >= since && !r.input.topCheck && settledHouse(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    console.log(`${settled.length} settled listings since ${since}; re-running each with topCheck=${top}, ${parallel} at a time`);
    if (process.argv.includes("--dry")) {
      for (const r of settled) console.log(`  ${(r.input.listingId ?? r.id).padEnd(16)} ${(r.input.municipality ?? "").padEnd(20)} ${settledHouse(r)!.address ?? settledHouse(r)!.parcel}`);
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
  let kept = 0, lost = 0, other = 0, running = 0;
  const rows: string[] = [];
  pairs.forEach((p, i) => {
    const before = byId.get(p.oldId);
    const after = fresh[i];
    const was = before ? settledHouse(before) : null;
    if (!before || !was || !after) return;
    const now = settledHouse(after);
    const cost = (after.results ?? []).reduce((t, m) => t + ((m as unknown as { aiCostUsd?: number }).aiCostUsd ?? 0), 0);
    let verdict: string;
    if (after.status === "running") { verdict = "running"; running++; }
    else if (now && sameAddress(was, now)) { verdict = "KEPT"; kept++; }
    else if (now) { verdict = `OTHER HOUSE: ${now.address}`; other++; }
    else { verdict = "LOST"; lost++; }
    rows.push(`${verdict.padEnd(12)} ${(before.input.listingId ?? p.oldId).padEnd(16)} ${(before.input.municipality ?? "").padEnd(20)} ${was.address ?? was.parcel}  $${cost.toFixed(2)}  ${after.id}`);
  });
  console.log(rows.sort().join("\n"));
  console.log(`\ntopCheck=${top}: kept ${kept}, lost ${lost}, other house ${other}, still running ${running} of ${rows.length}`);
  if (running) console.log("run again with --report to finish the comparison");
  if (lost || other) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
