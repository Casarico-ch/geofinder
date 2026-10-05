// Shared pieces of the Practice pages (pages/Practice.tsx, pages/PracticeRound.tsx).
import { Fragment, useEffect, useState } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  ExternalLink,
  Loader2,
  Trash2,
  XCircle,
} from "lucide-react";

// A practice round, as GET /api/practice/rounds returns it (RoundSummary + learning).
export interface Learning {
  state: "searching" | "paused" | "waiting" | "reviewing" | "testing" | "done" | "failed" | "off";
  proposed: number;
  testing: number;
  kept: number;
  dropped: number;
  error?: string;
}
export interface Round {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  paused: boolean;
  trialOf: string | null;
  rerunOf: string | null;
  skipped: { propertyId: number; reason: string }[];
  lessons: number;
  accuracy: number | null;
  split: string;
  models: string[];
  total: number;
  right: number;
  wrong: number;
  unsure: number;
  overBudget: number;
  errors: number;
  running: number;
  avgMinutes: number | null;
  avgCostUsd: number | null;
  costUsd: number;
  testsCostUsd: number;
  totalCostUsd: number;
  learning: Learning | null;
  lostAt?: Record<string, number>;
  noProof?: boolean;
  agreed?: number;
  agreedRight?: number;
  agreedWrong?: number;
  ranks?: { measured: number; top10: number; top120: number; median: number | null };
  rechecks?: RecheckStats & { byModel?: (RecheckStats & { model: string; costUsd: number })[] };
}


// A lesson, as server/lessons-store.ts keeps it.
export interface Kpis {
  runs: number;
  right: number;
  wrong: number;
  notFound: number;
  errors: number;
  avgMinutes: number | null;
  avgCostUsd: number | null;
}
export interface Lesson {
  id: string;
  text: string;
  why: string;
  status: "proposed" | "testing" | "kept" | "dropped";
  createdAt: string;
  fromRound: string;
  trialRound?: string;
  pairs?: { propertyId: number; model: string }[];
  before?: Kpis;
  after?: Kpis;
  verdict?: string;
}

export const STATUS: Record<Lesson["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  proposed: { label: "Waiting to be tested", variant: "outline" },
  testing: { label: "Being tested", variant: "secondary" },
  kept: { label: "Kept", variant: "default" },
  dropped: { label: "Dropped", variant: "outline" },
};

export interface RecheckStats {
  done: number;
  fixed: number;
  caught: number;
  broke: number;
}

// Mirrors PracticeResult in server/practice.ts (the truth fingerprints left out).
export interface Result {
  propertyId: number;
  jobId: string | null;
  model: string;
  outcome: "right" | "wrong" | "unsure" | "over_budget" | "error" | "running";
  answer: string | null;
  lostAt: string | null;
  minutes: number | null;
  costUsd: number | null;
  error?: string;
  why?: { code: string; text: string } | null; // why the right house was never on its checklist
  twin?: boolean; // answered the attached twin of the right house: counted as found
  doubt?: boolean; // doubtful or not sure, so it was searched again
  doubtWhy?: string;
  twinPick?: string; // named one of two attached twins; the other one
  recheck?: boolean; // that second search
  rank?: number | null; // where the right house sat on the run's ranked list
  rankOf?: number | null;
}

/** A round still doing something: searching, or reviewing and testing its lessons. */
export const isBusy = (r: { running: number; learning?: { state: string } | null }) =>
  r.running > 0 || ["waiting", "reviewing", "testing"].includes(r.learning?.state ?? "");

export const MODEL_LABEL: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "sonnet-5-5-low": "Sonnet 5.5 · low",
  "sonnet-5-5-low-2": "Sonnet 5.5 · low (2nd)",
  "sonnet-5-5-low-3": "Sonnet 5.5 · low (3rd)",
  "sonnet-5-5-max-plain": "Sonnet 5.5 · max · plain",
  "gemini-3-8-flash-low": "Gemini 3.8 Flash · low",
  "opus-5-5-high": "Opus 5.5 · high · recheck",
  "sonnet-5-5-high": "Sonnet 5.5 · high · recheck",
  "opus-5-5-low": "Opus 5.5 · low · recheck",
  "claude-opus-5-5": "Opus 5.5",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
};

// The same soft tones as the Requests page.
export const OUTCOME: Record<Result["outcome"], { label: string; className: string }> = {
  right: { label: "Found", className: "bg-emerald-500/10 text-emerald-700" },
  wrong: { label: "Wrong", className: "bg-destructive/10 text-destructive" },
  unsure: { label: "Not sure", className: "bg-muted text-muted-foreground" },
  over_budget: { label: "Over limit", className: "bg-amber-500/10 text-amber-700" },
  error: { label: "Error", className: "bg-muted text-muted-foreground" },
  running: { label: "Running", className: "bg-muted text-muted-foreground" },
};

export const LOST: Record<string, string> = {
  commune: "searched the wrong commune",
  not_shortlisted: "never shortlisted it",
  rejected: "rejected the right house",
  left_possible: "left it as possible",
  not_proven: "matched but did not prove it",
  never_looked: "never looked at it",
};

// Why the right house was never on the checklist (server/miss.ts).
export const WHY: Record<string, string> = {
  wrong_commune: "It searched the wrong commune",
  not_residential: "The register does not list it as a home",
  floors: "Filtered out by its floors guess",
  dwellings: "Filtered out by its homes guess",
  footprint: "Filtered out by its footprint guess",
  cut_off: "Passed the filters, but never shown",
  not_found: "Not in any commune near the listing",
};

// What a listing is, from the text its searches were given (address hidden).
export interface ListingInfo {
  title: string | null;
  place: string | null;
  kind: string | null;
  rooms: string | null;
  price: string | null;
  radarUrl?: string;
  sourceUrl?: string | null;
}

// Where the right house sat on the ranked list: the best of the listing's runs.
function Rank({ runs }: { runs: Result[] }) {
  const measured = runs.filter((r) => r.rankOf != null);
  if (!measured.length) return <span className="text-muted-foreground">—</span>;
  const ranks = measured.map((r) => r.rank).filter((x): x is number => x != null);
  const of = measured[0].rankOf!;
  if (!ranks.length)
    return (
      <span className="text-destructive" title={`not on the list of ${of} homes`}>
        off list
      </span>
    );
  const best = Math.min(...ranks);
  return (
    <span className={best <= 10 ? "text-emerald-700" : best <= 120 ? "" : "text-amber-700"} title={`of ${of} homes`}>
      #{best}
      <span className="text-muted-foreground text-xs"> / {of}</span>
    </span>
  );
}

// The listing in Radar and on the web, for the person reading the results.
function ListingLinks({ info }: { info?: ListingInfo }) {
  if (!info?.radarUrl && !info?.sourceUrl) return null;
  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {info.radarUrl && (
        <Button asChild variant="outline" size="sm" className="h-6 px-2 text-xs">
          <a href={info.radarUrl} target="_blank" rel="noreferrer">
            Radar
            <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </Button>
      )}
      {info.sourceUrl && (
        <Button asChild variant="outline" size="sm" className="h-6 px-2 text-xs">
          <a href={info.sourceUrl} target="_blank" rel="noreferrer">
            Listing
            <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </Button>
      )}
    </span>
  );
}

const ICON: Record<Result["outcome"], { icon: typeof CheckCircle2; className: string }> = {
  right: { icon: CheckCircle2, className: "text-emerald-600" },
  wrong: { icon: XCircle, className: "text-destructive" },
  unsure: { icon: CircleHelp, className: "text-muted-foreground" },
  over_budget: { icon: Clock, className: "text-amber-600" },
  error: { icon: AlertTriangle, className: "text-muted-foreground" },
  running: { icon: Loader2, className: "text-primary animate-spin" },
};

const SHORT: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet",
  "sonnet-5-5-low": "Sonnet low",
  "sonnet-5-5-low-2": "Sonnet low 2",
  "sonnet-5-5-low-3": "Sonnet low 3",
  "sonnet-5-5-max-plain": "Plain · max",
  "gemini-3-8-flash-low": "Flash low",
  "claude-opus-5-5": "Opus",
  "gemini-3.1-pro-preview": "Gem Pro",
  "gemini-3.8-flash": "Gem Flash",
};

/** One run in one cell: the outcome as an icon, time and cost under it. */
function RunCell({ r }: { r?: Result }) {
  if (!r) return <span className="text-muted-foreground">—</span>;
  const { icon: Icon, className } = ICON[r.outcome];
  return (
    <div className="flex items-center gap-2">
      <Icon className={`h-4 w-4 shrink-0 ${className}`} />
      <div className="leading-tight">
        <p className="text-xs font-medium">
          {OUTCOME[r.outcome].label}
          {r.twin && <span className="font-normal text-muted-foreground"> · twin</span>}
          {r.twinPick && <span className="font-normal text-muted-foreground"> · twin pick</span>}
          {r.doubt && <span className="font-normal text-muted-foreground"> · rechecked</span>}
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {r.minutes != null ? `${r.minutes}m` : "—"} · {r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "—"}
        </p>
      </div>
    </div>
  );
}

/** One run in full, inside an opened listing. */
function RunCard({ model, r }: { model: string; r?: Result }) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{MODEL_LABEL[model] ?? model}</p>
        {r && (
          <Badge variant="outline" className={`border-transparent font-normal ${OUTCOME[r.outcome].className}`}>
            {OUTCOME[r.outcome].label}
          </Badge>
        )}
      </div>
      {!r ? (
        <p className="text-xs text-muted-foreground">Not part of this test.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            {r.minutes != null ? `${r.minutes} min` : "—"} · {r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "—"}
          </p>
          <p className="text-xs">
            <span className="text-muted-foreground">Answered: </span>
            {r.answer ?? "nothing"}
          </p>
          {r.twin && (
            <p className="text-xs text-emerald-700">Counted as found: the attached twin of the right house.</p>
          )}
          {r.twinPick && (
            <p className="text-xs text-amber-700">Twin pick: could not tell it from its attached twin {r.twinPick}; named the one whose plot is closest.</p>
          )}
          {r.doubt && (
            <p className="text-xs text-muted-foreground">Searched again by the recheck models{r.doubtWhy ? `: ${r.doubtWhy}` : ""}.</p>
          )}
          {r.rankOf != null && (
            <p className="text-xs">
              <span className="text-muted-foreground">Right house ranked: </span>
              {r.rank != null ? `#${r.rank} of ${r.rankOf}` : `not on its list (${r.rankOf} homes)`}
            </p>
          )}
          {r.lostAt && r.outcome !== "right" && (
            <p className="text-xs">
              <span className="text-muted-foreground">Missed: </span>
              {LOST[r.lostAt] ?? r.lostAt}
            </p>
          )}
          {r.why && (
            <p className="text-xs rounded-md bg-amber-500/10 text-amber-800 px-2 py-1">
              <span className="font-medium">Why: </span>
              {r.why.text}
            </p>
          )}
          {r.error && <p className="text-xs text-destructive">{r.error}</p>}
          {r.jobId && (
            <Link href={`/i/${r.jobId}`}>
              <Button variant="outline" size="sm" className="h-7 text-xs mt-1">
                Open trace <ExternalLink className="ml-1 h-3 w-3" />
              </Button>
            </Link>
          )}
        </>
      )}
    </div>
  );
}

type ListingFilter = "all" | "found" | "unsure" | "wrong";

/**
 * Every listing of a round: one compact row each, what every model did as an
 * icon, a filter for what to look at, and the full runs one click away.
 */
export function ListingsPanel({
  results,
  models,
  listings,
}: {
  results: Result[];
  models: string[];
  listings: Record<number, ListingInfo>;
}) {
  const [filter, setFilter] = useState<ListingFilter>("all");
  const [open, setOpen] = useState<number | null>(null);
  // Order by cost: none → most expensive first → cheapest first.
  const [sort, setSort] = useState<"none" | "desc" | "asc">("none");
  const ids = Array.from(new Set(results.map((r) => r.propertyId)));
  const runsOf = (pid: number) => results.filter((r) => r.propertyId === pid);
  const costOf = (pid: number) => runsOf(pid).reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const has = (pid: number, o: Result["outcome"]) => runsOf(pid).some((r) => r.outcome === o);
  const done = (pid: number) => runsOf(pid).every((r) => r.outcome !== "running");
  const count = {
    all: ids.length,
    found: ids.filter((p) => has(p, "right")).length,
    unsure: ids.filter((p) => has(p, "unsure") && !has(p, "right")).length,
    wrong: ids.filter((p) => has(p, "wrong")).length,
  };
  const shown = ids.filter((p) =>
    filter === "all" ? true : filter === "found" ? has(p, "right") : filter === "unsure" ? has(p, "unsure") && !has(p, "right") : has(p, "wrong"),
  );
  if (sort !== "none") shown.sort((a, b) => (sort === "desc" ? costOf(b) - costOf(a) : costOf(a) - costOf(b)));
  const SortIcon = sort === "desc" ? ArrowDown : sort === "asc" ? ArrowUp : ArrowUpDown;
  return (
    <div className="space-y-3">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as ListingFilter)}>
        <TabsList>
          <TabsTrigger value="all">All {count.all}</TabsTrigger>
          <TabsTrigger value="found">Found {count.found}</TabsTrigger>
          <TabsTrigger value="unsure">Not sure {count.unsure}</TabsTrigger>
          <TabsTrigger value="wrong">Wrong answer {count.wrong}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Listing</TableHead>
              {models.map((m) => (
                <TableHead key={m} className="whitespace-nowrap">
                  {SHORT[m] ?? MODEL_LABEL[m] ?? m}
                </TableHead>
              ))}
              <TableHead className="text-right">Found by</TableHead>
              <TableHead className="text-right whitespace-nowrap">Rank</TableHead>
              <TableHead className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-3 h-8 px-3"
                  onClick={() => setSort(sort === "none" ? "desc" : sort === "desc" ? "asc" : "none")}
                >
                  Cost
                  <SortIcon className="ml-1 h-3.5 w-3.5" />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={models.length + 5} className="text-muted-foreground">
                  No listing here.
                </TableCell>
              </TableRow>
            )}
            {shown.map((pid) => {
              const runs = runsOf(pid);
              const info = listings[pid];
              const found = runs.filter((r) => r.outcome === "right").length;
              const cost = runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
              const isOpen = open === pid;
              return (
                <Fragment key={pid}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(isOpen ? null : pid)}>
                    <TableCell className="align-top pt-3">
                      {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    </TableCell>
                    <TableCell className="max-w-96">
                      <p className="text-sm font-medium truncate">{info?.title ?? `Listing #${pid}`}</p>
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-xs text-muted-foreground truncate">
                          {[info?.place, info?.kind, info?.rooms ? `${info.rooms} rooms` : null, `#${pid}`].filter(Boolean).join(" · ")}
                        </p>
                        <ListingLinks info={info} />
                      </div>
                    </TableCell>
                    {models.map((m) => (
                      <TableCell key={m}>
                        <RunCell r={runs.find((r) => r.model === m)} />
                      </TableCell>
                    ))}
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={`border-transparent font-normal tabular-nums ${found ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground"}`}
                      >
                        {found}/{runs.length}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm whitespace-nowrap">
                      <Rank runs={runs} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">${cost.toFixed(2)}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={models.length + 5} className="bg-muted/40 whitespace-normal">
                        <div className="flex flex-wrap items-center gap-3 mb-2">
                          {info?.price && <p className="text-xs text-muted-foreground">{info.price}</p>}
                          <ListingLinks info={info} />
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          {models.map((m) => (
                            <RunCard key={m} model={m} r={runs.find((r) => r.model === m)} />
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** A round fetched by id, shown as its listings (a lesson's test). */
function TestRuns({ id, models }: { id: string; models: string[] }) {
  const [data, setData] = useState<{ results: Result[]; listings: Record<number, ListingInfo> } | null>(null);
  useEffect(() => {
    let live = true;
    const get = async () => {
      const res = await fetch(`/api/practice/rounds/${id}`).catch(() => null);
      if (res?.ok && live) {
        const body = await res.json();
        setData({ results: body.results, listings: body.listings ?? {} });
      }
    };
    get();
    const t = setInterval(get, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return <ListingsPanel results={data.results} models={models} listings={data.listings} />;
}

// One number before and after a lesson, with the change coloured by whether it helps.
function Delta({ before, after, better, format }: { before: number | null; after: number | null; better: "up" | "down"; format: (v: number) => string }) {
  if (before == null || after == null) return <span className="text-muted-foreground">—</span>;
  const d = after - before;
  const good = better === "up" ? d > 0 : d < 0;
  const tone = Math.abs(d) < 1e-9 ? "text-muted-foreground" : good ? "text-emerald-700" : "text-destructive";
  return (
    <span className={`tabular-nums ${tone}`}>
      {d > 0 ? "+" : d < 0 ? "−" : "±"}
      {format(Math.abs(d))}
    </span>
  );
}

const LESSON_FILTERS: { key: "all" | Lesson["status"]; label: string }[] = [
  { key: "all", label: "All" },
  { key: "kept", label: "Kept" },
  { key: "testing", label: "Being tested" },
  { key: "proposed", label: "Waiting" },
  { key: "dropped", label: "Dropped" },
];

/**
 * The lessons drawn from one round: the rule, the evidence, a before/after
 * table on the runs it was tested on, the decision, and the test's own runs.
 */
export function LessonsPanel({
  lessons,
  models,
  busy,
  onAct,
}: {
  lessons: Lesson[];
  models: string[];
  busy: string | null;
  onAct: (l: Lesson, a: "keep" | "drop" | "test" | "delete") => void;
}) {
  const [filter, setFilter] = useState<"all" | Lesson["status"]>("all");
  const [shown, setShown] = useState<string | null>(null);
  if (!lessons.length)
    return (
      <p className="text-sm text-muted-foreground">
        No lesson yet. Once the round has finished, a reviewer reads its failed and slow runs and proposes rules here.
      </p>
    );
  const rank: Record<Lesson["status"], number> = { kept: 0, testing: 1, proposed: 2, dropped: 3 };
  const list = lessons.filter((l) => filter === "all" || l.status === filter).sort((x, y) => rank[x.status] - rank[y.status]);
  const fmt = {
    n: (v: number) => String(v),
    min: (v: number) => `${Math.round(v * 100) / 100} min`,
    usd: (v: number) => `$${v.toFixed(2)}`,
  };
  return (
    <div className="space-y-3">
      <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
        <TabsList>
          {LESSON_FILTERS.map((f) => (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label} {f.key === "all" ? lessons.length : lessons.filter((l) => l.status === f.key).length}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list.map((l) => {
        const rows: { label: string; b: number | null; a: number | null; better: "up" | "down"; f: (v: number) => string }[] = [
          { label: "Found", b: l.before?.right ?? null, a: l.after?.right ?? null, better: "up", f: fmt.n },
          { label: "Wrong", b: l.before?.wrong ?? null, a: l.after?.wrong ?? null, better: "down", f: fmt.n },
          { label: "Avg time", b: l.before?.avgMinutes ?? null, a: l.after?.avgMinutes ?? null, better: "down", f: fmt.min },
          { label: "Avg cost", b: l.before?.avgCostUsd ?? null, a: l.after?.avgCostUsd ?? null, better: "down", f: fmt.usd },
        ];
        return (
          <Card key={l.id} className="p-4 space-y-3">
            <div className="flex flex-wrap items-start gap-3">
              <Badge variant={STATUS[l.status].variant} className="shrink-0 mt-0.5">
                {l.status === "testing" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {STATUS[l.status].label}
              </Badge>
              <p className="text-sm font-medium flex-1 min-w-60 leading-snug">{l.text}</p>
              <div className="flex gap-1 shrink-0">
                {l.status === "proposed" && (
                  <Button variant="outline" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "test")}>
                    Test now
                  </Button>
                )}
                {l.status === "kept" ? (
                  <Button variant="outline" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "drop")}>
                    Drop
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "keep")}>
                    Keep
                  </Button>
                )}
                <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "delete")} aria-label="Delete lesson">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Why: </span>
              {l.why}
            </p>
            {l.before && (
              <div className="grid gap-3 md:grid-cols-[minmax(0,22rem)_1fr] items-start">
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-8 text-xs">On {l.pairs?.length ?? l.before.runs} runs</TableHead>
                        <TableHead className="h-8 text-xs text-right">Before</TableHead>
                        <TableHead className="h-8 text-xs text-right">After</TableHead>
                        <TableHead className="h-8 text-xs text-right">Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.label}>
                          <TableCell className="py-1.5 text-xs">{r.label}</TableCell>
                          <TableCell className="py-1.5 text-xs text-right tabular-nums">{r.b == null ? "—" : r.f(r.b)}</TableCell>
                          <TableCell className="py-1.5 text-xs text-right tabular-nums">{r.a == null ? "—" : r.f(r.a)}</TableCell>
                          <TableCell className="py-1.5 text-xs text-right">
                            <Delta before={r.b} after={r.a} better={r.better} format={r.f} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="space-y-2">
                  {l.verdict ? (
                    <p className="text-sm">{l.verdict}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">The test is running; the decision comes when its runs finish.</p>
                  )}
                  {l.trialRound && (
                    <Button variant="outline" size="sm" onClick={() => setShown(shown === l.id ? null : l.id)}>
                      {shown === l.id ? <ChevronDown className="mr-1.5 h-3.5 w-3.5" /> : <ChevronRight className="mr-1.5 h-3.5 w-3.5" />}
                      {shown === l.id ? "Hide the test runs" : "See the test runs"}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {shown === l.id && l.trialRound && <TestRuns id={l.trialRound} models={models} />}
          </Card>
        );
      })}
    </div>
  );
}

export const kpiLine = (k?: Kpis) =>
  k ? `${k.right} right · ${k.wrong} wrong · ${k.avgMinutes ?? "—"} min · $${k.avgCostUsd?.toFixed(2) ?? "—"}` : "—";

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// The Learning cell of a round: where the review and the lesson tests stand.
export function LearningBadge({ l }: { l: Learning | null }) {
  if (!l) return null;
  const tested = l.kept + l.dropped;
  const total = tested + l.proposed + l.testing;
  const text: Record<Learning["state"], string> = {
    searching: "After the searches",
    paused: "Paused",
    waiting: "Review starts shortly",
    reviewing: "Reviewing…",
    testing: `Testing lessons ${tested + 1} of ${total}`,
    done: total ? `Done · ${l.kept} kept, ${l.dropped} dropped` : "Done · nothing to learn",
    failed: "Review failed",
    off: "No lessons yet",
  };
  const tone =
    l.state === "done"
      ? "bg-emerald-500/10 text-emerald-700"
      : l.state === "failed"
        ? "bg-destructive/10 text-destructive"
        : l.state === "reviewing" || l.state === "testing"
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground";
  const badge = (
    <Badge variant="outline" className={`border-transparent font-normal whitespace-nowrap ${tone}`}>
      {(l.state === "reviewing" || l.state === "testing") && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {text[l.state]}
    </Badge>
  );
  if (!l.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-sm">{l.error}</TooltipContent>
    </Tooltip>
  );
}

export const LEARNING_HELP =
  "Learning runs only when you press Find lessons on a round: a reviewer reads its failed and slow runs and proposes rules. Each rule is tested on a small batch of that round's runs: the ones it should fix and a few that were right. It is kept only if no answer turns wrong and the search finds more, or the same faster and cheaper. Kept lessons are read by every search.";

