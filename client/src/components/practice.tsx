// Shared pieces of the Practice pages (pages/Practice.tsx, pages/PracticeRound.tsx).
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";

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
}

export const MODEL_LABEL: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5",
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

// Every listing of a round, one row each, with what every model did on it.
export function RoundDetails({ id, models }: { id: string; models: string[] }) {
  const [results, setResults] = useState<Result[] | null>(null);
  useEffect(() => {
    let live = true;
    const get = async () => {
      const res = await fetch(`/api/practice/rounds/${id}`).catch(() => null);
      if (res?.ok && live) setResults((await res.json()).results);
    };
    get();
    const t = setInterval(get, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);
  if (!results) return <p className="text-sm text-muted-foreground p-3">Loading…</p>;
  return <ResultsGrid results={results} models={models} />;
}

// The grid itself: one row per listing, one column per model.
export function ResultsGrid({ results, models }: { results: Result[]; models: string[] }) {
  const listings = Array.from(new Set(results.map((r) => r.propertyId)));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Listing</TableHead>
          {models.map((m) => (
            <TableHead key={m}>{MODEL_LABEL[m] ?? m}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {listings.map((pid) => (
          <TableRow key={pid}>
            <TableCell className="align-top text-muted-foreground">#{pid}</TableCell>
            {models.map((m) => {
              const r = results.find((x) => x.propertyId === pid && x.model === m);
              if (!r) return <TableCell key={m}>—</TableCell>;
              return (
                <TableCell key={m} className="align-top whitespace-normal min-w-40">
                  <Badge variant="outline" className={`border-transparent font-normal ${OUTCOME[r.outcome].className}`}>{OUTCOME[r.outcome].label}</Badge>
                  <p className="text-xs mt-1">
                    {r.minutes != null ? `${r.minutes} min` : "—"} · {r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "—"}
                  </p>
                  {r.answer ? <p className="text-xs text-muted-foreground mt-0.5">{r.answer}</p> : null}
                  {r.lostAt && r.outcome !== "right" ? (
                    <p className="text-xs text-muted-foreground mt-0.5">Missed: {LOST[r.lostAt] ?? r.lostAt}</p>
                  ) : null}
                  {r.error ? <p className="text-xs text-muted-foreground mt-0.5">{r.error}</p> : null}
                  {r.jobId ? (
                    <Link href={`/i/${r.jobId}`} className="text-xs text-primary inline-flex items-center gap-1 hover:underline mt-0.5">
                      Trace <ExternalLink className="h-3 w-3" />
                    </Link>
                  ) : null}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    off: "Automatic learning is off",
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

// The lessons drawn from one round: each with its evidence, its test on a
// small batch of the round's runs, and the decision.
export function RoundLessons({
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
  const [shown, setShown] = useState<string | null>(null);
  if (!lessons.length) return <p className="text-sm text-muted-foreground px-3 pb-3">No lesson from this round yet.</p>;
  return (
    <div className="divide-y">
      {lessons.map((l) => (
        <div key={l.id} className="px-3 py-3 space-y-1.5">
          <div className="flex flex-wrap items-start gap-2">
            <Badge variant={STATUS[l.status].variant} className="shrink-0">
              {STATUS[l.status].label}
            </Badge>
            <p className="text-sm flex-1 min-w-60">{l.text}</p>
            <div className="flex gap-1 shrink-0">
              {l.status === "proposed" && (
                <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "test")}>
                  Test now
                </Button>
              )}
              {l.status === "kept" ? (
                <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "drop")}>
                  Drop
                </Button>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "keep")}>
                  Keep
                </Button>
              )}
              <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => onAct(l, "delete")}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Why: {l.why}</p>
          {l.before && (
            <p className="text-xs">
              Tested on {l.pairs?.length ?? l.before.runs} runs · before: {kpiLine(l.before)} · after: {kpiLine(l.after)}
            </p>
          )}
          {l.verdict && <p className="text-xs text-muted-foreground">{l.verdict}</p>}
          {l.trialRound && (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setShown(shown === l.id ? null : l.id)}>
              {shown === l.id ? "Hide its test" : "Show its test"}
            </Button>
          )}
          {shown === l.id && l.trialRound && (
            <div className="rounded-md border bg-background">
              <RoundDetails id={l.trialRound} models={models} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export const LEARNING_HELP =
  "After a round, a reviewer reads its failed and slow runs and proposes rules. Each rule is tested on a small batch of that round's runs: the ones it should fix and a few that were right. It is kept only if no answer turns wrong and the search finds more, or the same faster and cheaper. Kept lessons are read by every search.";

