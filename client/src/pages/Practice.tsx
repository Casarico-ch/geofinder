import { Fragment, useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Pause, Play, Trash2 } from "lucide-react";

// A practice round, as GET /api/practice/rounds returns it (RoundSummary + learning).
interface Learning {
  state: "searching" | "paused" | "waiting" | "reviewing" | "testing" | "done" | "failed" | "off";
  proposed: number;
  testing: number;
  kept: number;
  dropped: number;
  error?: string;
}
interface Round {
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
}

const SIZES = [5, 10, 20, 50, 100];

// A lesson, as server/lessons-store.ts keeps it.
interface Kpis {
  runs: number;
  right: number;
  wrong: number;
  notFound: number;
  errors: number;
  avgMinutes: number | null;
  avgCostUsd: number | null;
}
interface Lesson {
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

const STATUS: Record<Lesson["status"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  proposed: { label: "Waiting to be tested", variant: "outline" },
  testing: { label: "Being tested", variant: "secondary" },
  kept: { label: "Kept", variant: "default" },
  dropped: { label: "Dropped", variant: "outline" },
};

// Mirrors PracticeResult in server/practice.ts (the truth fingerprints left out).
interface Result {
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

const MODEL_LABEL: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
};

// The same soft tones as the Requests page.
const OUTCOME: Record<Result["outcome"], { label: string; className: string }> = {
  right: { label: "Found", className: "bg-emerald-500/10 text-emerald-700" },
  wrong: { label: "Wrong", className: "bg-destructive/10 text-destructive" },
  unsure: { label: "Not sure", className: "bg-muted text-muted-foreground" },
  over_budget: { label: "Over limit", className: "bg-amber-500/10 text-amber-700" },
  error: { label: "Error", className: "bg-muted text-muted-foreground" },
  running: { label: "Running", className: "bg-muted text-muted-foreground" },
};

const LOST: Record<string, string> = {
  commune: "searched the wrong commune",
  not_shortlisted: "never shortlisted it",
  rejected: "rejected the right house",
  left_possible: "left it as possible",
  not_proven: "matched but did not prove it",
  never_looked: "never looked at it",
};

// Every listing of a round, one row each, with what every model did on it.
function RoundDetails({ id, models }: { id: string; models: string[] }) {
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

const kpiLine = (k?: Kpis) =>
  k ? `${k.right} right · ${k.wrong} wrong · ${k.avgMinutes ?? "—"} min · $${k.avgCostUsd?.toFixed(2) ?? "—"}` : "—";

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// The Learning cell of a round: where the review and the lesson tests stand.
function LearningBadge({ l }: { l: Learning | null }) {
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
function RoundLessons({
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

const LEARNING_HELP =
  "After a round, a reviewer reads its failed and slow runs and proposes rules. Each rule is tested on a small batch of that round's runs: the ones it should fix and a few that were right. It is kept only if no answer turns wrong and the search finds more, or the same faster and cheaper. Kept lessons are read by every search.";

// The test track: GeoFinder searches listings whose building Radar already
// knows (address hidden), every answer is scored, and each round teaches it.
export default function Practice() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [size, setSize] = useState("20");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Round | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    try {
      const [rs, ls] = await Promise.all([fetch("/api/practice/rounds"), fetch("/api/practice/lessons")]);
      if (rs.ok) setRounds((await rs.json()).rounds);
      if (ls.ok) setLessons((await ls.json()).lessons);
    } catch {
      /* the next poll tries again */
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const call = async (id: string, url: string, method: "POST" | "DELETE", done?: string) => {
    setBusy(id);
    try {
      const res = await fetch(url, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (done) toast.success(done);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/practice/rounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: Number(size) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(`Practice round started: ${body.total} runs`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const roundAct = (r: Round, action: "pause" | "resume" | "delete") =>
    call(
      r.id,
      `/api/practice/rounds/${r.id}${action === "delete" ? "" : `/${action}`}`,
      action === "delete" ? "DELETE" : "POST",
      action === "pause" ? "Round paused" : action === "resume" ? "Round resumed" : "Round deleted",
    );
  const lessonAct = (l: Lesson, action: "keep" | "drop" | "test" | "delete") =>
    call(l.id, `/api/practice/lessons/${l.id}/${action}`, "POST");

  // Lesson tests are shown inside the round they came from, not as rounds of their own.
  const shown = rounds?.filter((r) => !r.trialOf) ?? null;
  const inUse = lessons.filter((l) => l.status === "kept").length;

  return (
    <div className="min-h-screen bg-background">
      <AdminHeader subtitle="Practice" />
      <main className="container py-6 space-y-6">
        <Card className="p-5 space-y-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Start a practice round</h2>
            <p className="text-sm text-muted-foreground">
              Every search model looks for listings picked at random across Switzerland whose building Radar already knows,
              with the address hidden. Each model gets CHF 1 and 5 minutes per listing; a run that reaches either without an
              answer counts as a failure. The goal: 100% accuracy, then faster and cheaper.
            </p>
            <p className="text-sm text-muted-foreground">{LEARNING_HELP}</p>
            <p className="text-sm">
              {inUse ? `${inUse} kept lesson${inUse === 1 ? "" : "s"} in use by every search.` : "No kept lesson in use yet."}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="practice-size">Listings</Label>
              <Select value={size} onValueChange={setSize}>
                <SelectTrigger id="practice-size" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={start} disabled={starting}>
              {starting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              Start practice round
            </Button>
          </div>
        </Card>

        <Card className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
                <TableHead className="text-right">Right</TableHead>
                <TableHead className="text-right">Wrong</TableHead>
                <TableHead className="text-right">Not sure</TableHead>
                <TableHead className="text-right">Over limit</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Avg min</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead>Learning</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown === null && (
                <TableRow>
                  <TableCell colSpan={13} className="text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {shown?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={13} className="text-muted-foreground">
                    No practice round yet.
                  </TableCell>
                </TableRow>
              )}
              {shown?.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell className="whitespace-nowrap">
                      {open === r.id ? (
                        <ChevronDown className="inline h-4 w-4 mr-1 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="inline h-4 w-4 mr-1 text-muted-foreground" />
                      )}
                      {when(r.createdAt)}{" "}
                      {r.paused ? (
                        <Badge variant="outline">Paused</Badge>
                      ) : r.running > 0 ? (
                        <Badge variant="secondary">{r.running} running</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{r.total}</TableCell>
                    <TableCell className={`text-right ${r.accuracy != null && r.accuracy < 100 ? "text-destructive font-medium" : ""}`}>
                      {r.accuracy != null ? `${r.accuracy}%` : "—"}
                    </TableCell>
                    <TableCell className="text-right">{r.right}</TableCell>
                    <TableCell className={`text-right ${r.wrong ? "text-destructive font-medium" : ""}`}>{r.wrong}</TableCell>
                    <TableCell className="text-right">{r.unsure}</TableCell>
                    <TableCell className="text-right">{r.overBudget}</TableCell>
                    <TableCell className="text-right">{r.errors}</TableCell>
                    <TableCell className="text-right">{r.avgMinutes ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.avgCostUsd != null ? `$${r.avgCostUsd.toFixed(2)}` : "—"}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>${r.totalCostUsd.toFixed(2)}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          Searches ${r.costUsd.toFixed(2)} · lesson tests ${r.testsCostUsd.toFixed(2)}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <LearningBadge l={r.learning} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      {r.paused ? (
                        <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => roundAct(r, "resume")}>
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                          Resume
                        </Button>
                      ) : r.running > 0 ? (
                        <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => roundAct(r, "pause")}>
                          <Pause className="mr-1.5 h-3.5 w-3.5" />
                          Pause
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => setToDelete(r)}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={13} className="bg-muted/30 p-0 whitespace-normal">
                        <h3 className="text-sm font-semibold px-3 pt-3">Results</h3>
                        <RoundDetails id={r.id} models={r.models} />
                        <h3 className="text-sm font-semibold px-3 pt-4">Lessons from this round</h3>
                        <RoundLessons
                          lessons={lessons.filter((l) => l.fromRound === r.id)}
                          models={r.models}
                          busy={busy}
                          onAct={lessonAct}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this practice round?</DialogTitle>
            <DialogDescription>
              Its {toDelete?.total} runs stop and are removed with their scores, and so are its lessons that were not kept
              and their tests. Kept lessons stay in use. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const r = toDelete!;
                setToDelete(null);
                void roundAct(r, "delete");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
