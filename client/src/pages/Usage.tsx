import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import AdminHeader from "@/components/AdminHeader";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CalendarDays } from "lucide-react";

// Mirrors GET /api/usage.
interface Run {
  id: string;
  model: string;
  createdAt: string;
  status: "running" | "done" | "error" | "cancelled" | "paused";
  found: boolean | null;
  confidence: string | null;
  tokens: { input: number; output: number; cached: number; cacheWrite: number; total: number };
  costUsd: number;
  elapsedMs: number;
  steps: number;
  title: string | null;
}
// One address search as the Requests table shows it (all its model runs together).
interface Search {
  id: string;
  createdAt: string;
  runs: number;
  found: boolean;
  settled: boolean;
}
interface PopetyCharge {
  id: string;
  createdAt: string;
  costChf: number;
  plots: number;
}

const MODEL_LABEL: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-flash": "DeepSeek Flash",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
};

type RangeKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "last7"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "all"
  | "custom";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "thisWeek", label: "This week" },
  { key: "last7", label: "Last 7 days" },
  { key: "lastWeek", label: "Last week" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom range" },
];

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Weeks start on Monday.
const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  return new Date(s.getTime() - ((s.getDay() + 6) % 7) * DAY);
};
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// [from, to) in local time; null bounds mean open-ended.
function rangeBounds(key: RangeKey, customFrom: string, customTo: string): [Date | null, Date | null] {
  const now = new Date();
  const today = startOfDay(now);
  switch (key) {
    case "today":
      return [today, null];
    case "yesterday":
      return [new Date(today.getTime() - DAY), today];
    case "thisWeek":
      return [startOfWeek(now), null];
    case "last7":
      return [new Date(today.getTime() - 6 * DAY), null];
    case "lastWeek": {
      const w = startOfWeek(now);
      return [new Date(w.getTime() - 7 * DAY), w];
    }
    case "thisMonth":
      return [new Date(now.getFullYear(), now.getMonth(), 1), null];
    case "lastMonth":
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1)];
    case "custom": {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const to = customTo ? new Date(new Date(`${customTo}T00:00:00`).getTime() + DAY) : null;
      return [from, to];
    }
    default:
      return [null, null];
  }
}

const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const chf = (n: number) => `CHF ${n.toFixed(2)}`;
const tok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const mins = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-0.5 px-4 py-3 min-w-0 shadow-none">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground truncate">{sub}</p>}
    </Card>
  );
}

interface Bucket {
  key: string;
  label: string;
  cost: number;
  tokens: number;
  runs: number;
}

// Single-series bar chart of AI cost per day (or per week for long ranges).
function CostChart({ buckets, unit }: { buckets: Bucket[]; unit: "day" | "week" }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const L = 52;
  const R = 8;
  const T = 12;
  const B = 28;
  const max = Math.max(...buckets.map((b) => b.cost), 0.01);
  // A round axis maximum so the gridlines land on readable values.
  const step = (() => {
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  })();
  const top = step * Math.ceil(max / step);
  const slot = (W - L - R) / buckets.length;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const labelEvery = Math.ceil(buckets.length / 8);
  const h = hover != null ? buckets[hover] : null;

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[480px] h-auto block" role="img" aria-label={`AI cost per ${unit}`}>
          {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground" fontSize={11}>
                ${top < 1 ? v.toFixed(2) : v.toFixed(step % 1 ? 1 : 0)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = L + i * slot + (slot - barW) / 2;
            const bh = Math.max(0, y(0) - y(b.cost));
            return (
              <g key={b.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
                {b.cost > 0 && (
                  <path
                    d={`M${x},${y(0)} V${y(0) - bh + Math.min(4, bh)} q0,-${Math.min(4, bh)} ${Math.min(4, barW / 2)},-${Math.min(4, bh)} H${x + barW - Math.min(4, barW / 2)} q${Math.min(4, barW / 2)},0 ${Math.min(4, barW / 2)},${Math.min(4, bh)} V${y(0)} Z`}
                    className={hover === i ? "fill-primary" : "fill-primary/80"}
                  />
                )}
                {i % labelEvery === 0 && (
                  <text x={L + i * slot + slot / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground" fontSize={11}>
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      {h && (
        <div className="absolute top-1 right-1 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-sm pointer-events-none">
          <p className="font-medium text-foreground">{unit === "week" ? `Week of ${h.label}` : h.label}</p>
          <p className="text-muted-foreground tabular-nums">
            {usd(h.cost)} · {tok(h.tokens)} tokens · {h.runs} {h.runs === 1 ? "run" : "runs"}
          </p>
        </div>
      )}
    </div>
  );
}

export default function Usage() {
  const [, navigate] = useLocation();
  const [data, setData] = useState<{ runs: Run[]; popety: PopetyCharge[]; searches?: Search[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>(() => readStored("usage-range", "last7" as RangeKey));
  const [customFrom, setCustomFrom] = useState(() => readStored("usage-from", isoDay(new Date(Date.now() - 30 * DAY))));
  const [customTo, setCustomTo] = useState(() => readStored("usage-to", isoDay(new Date())));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/usage");
        if (!res.ok) throw new Error();
        const body = await res.json();
        if (alive) {
          setData(body);
          setError(null);
        }
      } catch {
        if (alive) setError("Could not load the usage data. Reload the page to try again.");
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => store("usage-range", range), [range]);
  useEffect(() => store("usage-from", customFrom), [customFrom]);
  useEffect(() => store("usage-to", customTo), [customTo]);

  const view = useMemo(() => {
    if (!data) return null;
    const [from, to] = rangeBounds(range, customFrom, customTo);
    const inRange = (iso: string) => {
      const t = new Date(iso).getTime();
      return (!from || t >= from.getTime()) && (!to || t < to.getTime());
    };
    const runs = data.runs.filter((r) => inRange(r.createdAt));
    const popety = data.popety.filter((p) => inRange(p.createdAt));
    // Success is counted per request: found by any of its runs. Requests still
    // in progress only count once one of their runs has found it.
    const searches = (data.searches ?? []).filter((s) => inRange(s.createdAt));
    const counted = searches.filter((s) => s.found || s.settled);
    const solved = counted.filter((s) => s.found);

    const sum = (f: (r: Run) => number) => runs.reduce((s, r) => s + f(r), 0);
    const cost = sum((r) => r.costUsd);
    const input = sum((r) => r.tokens.input);
    const output = sum((r) => r.tokens.output);
    const cached = sum((r) => r.tokens.cached);
    const finished = runs.filter((r) => r.status === "done");
    const found = finished.filter((r) => r.found);

    const byModel = Object.values(
      runs.reduce<Record<string, Run[]>>((acc, r) => {
        (acc[r.model] ??= []).push(r);
        return acc;
      }, {}),
    )
      .map((rs) => {
        const done = rs.filter((r) => r.status === "done");
        const hits = done.filter((r) => r.found);
        const c = rs.reduce((s, r) => s + r.costUsd, 0);
        const t = rs.reduce((s, r) => s + r.tokens.total, 0);
        return {
          model: rs[0].model,
          runs: rs.length,
          done: done.length,
          found: hits.length,
          foundRate: done.length ? hits.length / done.length : null,
          cost: c,
          tokens: t,
          avgCost: c / rs.length,
          avgTokens: t / rs.length,
          avgTime: done.length ? done.reduce((s, r) => s + r.elapsedMs, 0) / done.length : null,
          costPerFound: hits.length ? c / hits.length : null,
          cacheRate: rs.reduce((s, r) => s + r.tokens.input, 0)
            ? rs.reduce((s, r) => s + r.tokens.cached, 0) / rs.reduce((s, r) => s + r.tokens.input, 0)
            : null,
        };
      })
      .sort((a, b) => b.cost - a.cost);

    // Buckets: from the first run (or range start) to the range end, daily up to 90 days, else weekly.
    const first = from ?? (runs.length ? startOfDay(new Date(Math.min(...runs.map((r) => Date.parse(r.createdAt))))) : startOfDay(new Date()));
    const last = to ? new Date(to.getTime() - 1) : new Date();
    const days = Math.max(1, Math.round((startOfDay(last).getTime() - startOfDay(first).getTime()) / DAY) + 1);
    const unit: "day" | "week" = days > 90 ? "week" : "day";
    const bucketStart = (d: Date) => (unit === "week" ? startOfWeek(d) : startOfDay(d));
    const buckets: Bucket[] = [];
    const index = new Map<string, Bucket>();
    for (let d = bucketStart(first); d.getTime() <= last.getTime(); d = new Date(d.getTime() + (unit === "week" ? 7 : 1) * DAY)) {
      const key = isoDay(d);
      const b = { key, label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), cost: 0, tokens: 0, runs: 0 };
      buckets.push(b);
      index.set(key, b);
      if (buckets.length > 400) break;
    }
    for (const r of runs) {
      const b = index.get(isoDay(bucketStart(new Date(r.createdAt))));
      if (!b) continue;
      b.cost += r.costUsd;
      b.tokens += r.tokens.total;
      b.runs += 1;
    }

    // Plain-language findings, only where the data supports them.
    const insights: string[] = [];
    const ranked = byModel.filter((m) => m.costPerFound != null && m.done >= 2);
    if (ranked.length >= 2) {
      const best = [...ranked].sort((a, b) => a.costPerFound! - b.costPerFound!)[0];
      insights.push(
        `${MODEL_LABEL[best.model] ?? best.model} is the cheapest per address found: ${usd(best.costPerFound!)} per found address (${pct(best.foundRate!)} of its finished runs found one).`,
      );
    }
    const top = byModel[0];
    if (top && cost > 0 && byModel.length > 1) {
      insights.push(`${MODEL_LABEL[top.model] ?? top.model} accounts for ${pct(top.cost / cost)} of the AI spend in this period.`);
    }
    const stopped = runs.filter((r) => r.status === "paused" || r.status === "cancelled" || r.status === "error");
    const stoppedCost = stopped.reduce((s, r) => s + r.costUsd, 0);
    if (stoppedCost > 0.05) {
      insights.push(
        `${usd(stoppedCost)} went to ${stopped.length} ${stopped.length === 1 ? "run" : "runs"} that were paused, stopped or failed without an answer.`,
      );
    }
    if (input > 0) {
      insights.push(
        `${pct(cached / input)} of input tokens were served from the prompt cache, which bills them at about a tenth of the normal price.`,
      );
    }
    if (output > 0 && input > 0) {
      insights.push(`Runs read ${Math.round(input / Math.max(1, output))} input tokens for every output token, so input is the main cost driver.`);
    }

    const expensive = [...runs].sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);
    const popetyChf = popety.reduce((s, p) => s + p.costChf, 0);
    return { runs, popety, counted, solved, cost, input, output, cached, finished, found, byModel, buckets, unit, insights, expensive, popetyChf };
  }, [data, range, customFrom, customTo]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader subtitle="Token use and costs over time" />
      <main className="flex-1 container py-8">
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-sm font-medium text-foreground">Usage</h2>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid gap-1">
                <Label htmlFor="usage-range">Created</Label>
                <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
                  <SelectTrigger id="usage-range" className="w-48 bg-card">
                    <CalendarDays className="h-4 w-4 text-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RANGES.map((r) => (
                      <SelectItem key={r.key} value={r.key}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {range === "custom" && (
                <>
                  <div className="grid gap-1">
                    <Label htmlFor="usage-from">From</Label>
                    <Input
                      id="usage-from"
                      type="date"
                      value={customFrom}
                      max={customTo || undefined}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="w-40 bg-card"
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="usage-to">To</Label>
                    <Input
                      id="usage-to"
                      type="date"
                      value={customTo}
                      min={customFrom || undefined}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="w-40 bg-card"
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {!view && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

          {view && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Tile label="AI cost" value={usd(view.cost)} sub={`${view.runs.length} runs`} />
                <Tile
                  label="Tokens"
                  value={tok(view.input + view.output)}
                  sub={`${tok(view.input)} in · ${tok(view.output)} out`}
                />
                <Tile
                  label="Addresses found"
                  value={view.counted.length ? `${((view.solved.length / view.counted.length) * 100).toFixed(1)}%` : "—"}
                  sub={`${view.solved.length} of ${view.counted.length} requests · ${view.runs.length} runs`}
                />
                <Tile label="Popety" value={chf(view.popetyChf)} sub={`${view.popety.length} property lookups`} />
              </div>

              <Card className="gap-2 p-4 shadow-none">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-medium">AI cost per {view.unit}</h3>
                  <span className="text-xs text-muted-foreground">Hover a bar for details</span>
                </div>
                {view.runs.length ? (
                  <CostChart buckets={view.buckets} unit={view.unit} />
                ) : (
                  <p className="text-sm text-muted-foreground py-10 text-center">No runs in this period.</p>
                )}
              </Card>

              {view.insights.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Insights</h3>
                  <Card className="gap-0 py-0 shadow-none">
                    <ul className="divide-y divide-border">
                      {view.insights.map((t) => (
                        <li key={t} className="px-4 py-2.5 text-sm text-foreground">
                          {t}
                        </li>
                      ))}
                    </ul>
                  </Card>
                </section>
              )}

              {view.byModel.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">By model</h3>
                  <div className="rounded-lg border bg-card">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Model</TableHead>
                          <TableHead className="text-right">Runs</TableHead>
                          <TableHead className="text-right">Found</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                          <TableHead className="text-right">Cache</TableHead>
                          <TableHead className="text-right">Avg / run</TableHead>
                          <TableHead className="text-right">Per found</TableHead>
                          <TableHead className="text-right">Avg time</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="tabular-nums">
                        {view.byModel.map((m) => (
                          <TableRow key={m.model}>
                            <TableCell className="font-medium">{MODEL_LABEL[m.model] ?? m.model}</TableCell>
                            <TableCell className="text-right">{m.runs}</TableCell>
                            <TableCell className="text-right">
                              {m.foundRate != null ? `${pct(m.foundRate)} (${m.found}/${m.done})` : "—"}
                            </TableCell>
                            <TableCell className="text-right">{tok(m.tokens)}</TableCell>
                            <TableCell className="text-right">{m.cacheRate != null ? pct(m.cacheRate) : "—"}</TableCell>
                            <TableCell className="text-right">{usd(m.avgCost)}</TableCell>
                            <TableCell className="text-right">{m.costPerFound != null ? usd(m.costPerFound) : "—"}</TableCell>
                            <TableCell className="text-right">{m.avgTime != null ? mins(m.avgTime) : "—"}</TableCell>
                            <TableCell className="text-right font-medium">{usd(m.cost)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Found counts finished runs only. Cache is the share of input tokens read from the prompt cache.
                  </p>
                </section>
              )}

              {view.expensive.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Most expensive runs</h3>
                  <div className="rounded-lg border bg-card">
                    <Table>
                      <TableBody>
                        {view.expensive.map((r) => (
                          <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/i/${r.id}`)}>
                            <TableCell className="w-24 text-muted-foreground">{MODEL_LABEL[r.model] ?? r.model}</TableCell>
                            <TableCell className="max-w-0 w-full truncate">{r.title ?? "Listing"}</TableCell>
                            <TableCell className="hidden sm:table-cell text-right text-xs text-muted-foreground tabular-nums">
                              {tok(r.tokens.total)} tokens · {r.steps} steps
                            </TableCell>
                            <TableCell className="text-right font-medium tabular-nums">{usd(r.costUsd)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
