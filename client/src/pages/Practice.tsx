import { useEffect, useState } from "react";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { Link } from "wouter";
import { Fragment } from "react";

// Mirrors RoundSummary in server/practice.ts.
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
}

const SIZES = [5, 10, 20, 50, 100];

// Mirrors Lesson in server/lessons-store.ts.
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

// The test track: GeoFinder searches listings whose building Radar already
// knows (address hidden), and every answer is scored against it.
export default function Practice() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [size, setSize] = useState("20");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Round | null>(null);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/practice/rounds");
      if (res.ok) setRounds((await res.json()).rounds);
      const ls = await fetch("/api/practice/lessons");
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

  // Pause, resume or delete one round.
  const act = async (r: Round, action: "pause" | "resume" | "delete") => {
    setBusy(r.id);
    try {
      const res = await fetch(`/api/practice/rounds/${r.id}${action === "delete" ? "" : `/${action}`}`, {
        method: action === "delete" ? "DELETE" : "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(action === "pause" ? "Round paused" : action === "resume" ? "Round resumed" : "Round deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const lessonAct = async (l: Lesson, action: "keep" | "drop" | "test" | "delete") => {
    setBusy(l.id);
    try {
      const res = await fetch(`/api/practice/lessons/${l.id}/${action}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AdminHeader subtitle="Practice" />
      <main className="container py-6 space-y-6">
        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Start a practice round</h2>
            <p className="text-sm text-muted-foreground">
              Every search model looks for listings picked at random across Switzerland whose building Radar already knows, with the address hidden. Each
              model gets CHF 1 and 5 minutes per listing; a run that reaches either without an answer counts as a failure.
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
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rounds === null && (
                <TableRow>
                  <TableCell colSpan={11} className="text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {rounds?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="text-muted-foreground">
                    No practice round yet.
                  </TableCell>
                </TableRow>
              )}
              {rounds?.map((r) => (
                <Fragment key={r.id}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <TableCell className="whitespace-nowrap">
                    {open === r.id ? (
                      <ChevronDown className="inline h-4 w-4 mr-1 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="inline h-4 w-4 mr-1 text-muted-foreground" />
                    )}
                    {when(r.createdAt)}{" "}
                    {r.trialOf ? <Badge variant="outline">Lesson test</Badge> : null}{" "}
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
                  <TableCell className="text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    {r.paused ? (
                      <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => act(r, "resume")}>
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Resume
                      </Button>
                    ) : r.running > 0 ? (
                      <Button variant="ghost" size="sm" disabled={busy === r.id} onClick={() => act(r, "pause")}>
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
                {open === r.id ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={11} className="bg-muted/30 p-0">
                      <RoundDetails id={r.id} models={r.models} />
                    </TableCell>
                  </TableRow>
                ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Lessons</h2>
            <p className="text-sm text-muted-foreground">
              After each round a reviewer proposes rules from the runs that failed or were slow. Each rule is tested on the
              same listings with the same models, and kept only if accuracy stays at 100% (no more wrong answers) and the
              search finds more, or gets faster and cheaper. Kept lessons are read by every search.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lesson</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Before → after</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lessons?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    No lesson yet: the first ones come once a round has finished.
                  </TableCell>
                </TableRow>
              )}
              {lessons?.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="max-w-md whitespace-normal align-top">
                    <p className="text-sm">{l.text}</p>
                    <p className="text-xs text-muted-foreground mt-1">Why: {l.why}</p>
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap">
                    <Badge variant={STATUS[l.status].variant}>{STATUS[l.status].label}</Badge>
                  </TableCell>
                  <TableCell className="align-top text-xs whitespace-normal">
                    <p>Before: {kpiLine(l.before)}</p>
                    <p>After: {kpiLine(l.after)}</p>
                    {l.verdict ? <p className="text-muted-foreground mt-1">{l.verdict}</p> : null}
                  </TableCell>
                  <TableCell className="align-top text-right whitespace-nowrap">
                    {l.status === "proposed" ? (
                      <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => lessonAct(l, "test")}>
                        Test now
                      </Button>
                    ) : null}
                    {l.status !== "kept" ? (
                      <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => lessonAct(l, "keep")}>
                        Keep
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => lessonAct(l, "drop")}>
                        Drop
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={busy === l.id} onClick={() => lessonAct(l, "delete")}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>

      <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this practice round?</DialogTitle>
            <DialogDescription>
              Its {toDelete?.total} runs stop and are removed, together with their scores. This cannot be undone.
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
                void act(r, "delete");
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
