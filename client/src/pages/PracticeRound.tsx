import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import {
  LOST,
  LearningBadge,
  MODEL_LABEL,
  ResultsGrid,
  RoundLessons,
  when,
  type Lesson,
  type Result,
  type Round,
} from "@/components/practice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Pause, Play, Trash2 } from "lucide-react";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v: number | null) => (v == null ? "—" : String(Math.round(v * 10) / 10));

// One model's score in the round.
interface ModelStats {
  model: string;
  runs: number;
  right: number;
  wrong: number;
  unsure: number;
  over: number;
  errors: number;
  minutes: number | null;
  cost: number;
  avgCost: number | null;
  uniqueFinds: number; // listings only this model found
}

function statsOf(results: Result[], models: string[]): ModelStats[] {
  const foundBy = new Map<number, string[]>();
  for (const r of results) if (r.outcome === "right") foundBy.set(r.propertyId, [...(foundBy.get(r.propertyId) ?? []), r.model]);
  return models.map((model) => {
    const mine = results.filter((r) => r.model === model);
    const n = (o: Result["outcome"]) => mine.filter((r) => r.outcome === o).length;
    const done = mine.filter((r) => r.outcome !== "running" && r.minutes != null);
    const cost = mine.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    return {
      model,
      runs: mine.length,
      right: n("right"),
      wrong: n("wrong"),
      unsure: n("unsure"),
      over: n("over_budget"),
      errors: n("error"),
      minutes: avg(done.map((r) => r.minutes!)),
      cost,
      avgCost: avg(done.map((r) => r.costUsd ?? 0)),
      uniqueFinds: Array.from(foundBy.values()).filter((ms) => ms.length === 1 && ms[0] === model).length,
    };
  });
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <Card className="p-4 space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone === "bad" ? "text-destructive" : tone === "good" ? "text-emerald-700" : ""}`}>
        {value}
      </p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

// One practice round in full: its score on the goal, how each model did,
// where the right house was lost, every listing's result, and its lessons.
export default function PracticeRound() {
  const [, params] = useRoute("/practice/:id");
  const id = params?.id ?? "";
  const [, navigate] = useLocation();
  const [round, setRound] = useState<Round | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = async () => {
    try {
      const [rs, ls] = await Promise.all([fetch(`/api/practice/rounds/${id}`), fetch("/api/practice/lessons")]);
      if (rs.status === 404) setMissing(true);
      if (rs.ok) {
        const body = await rs.json();
        setRound(body.summary);
        setResults(body.results);
      }
      if (ls.ok) setLessons(((await ls.json()).lessons as Lesson[]).filter((l) => l.fromRound === id));
    } catch {
      /* the next poll tries again */
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [id]);

  const call = async (key: string, url: string, method: "POST" | "DELETE", done?: string) => {
    setBusy(key);
    try {
      const res = await fetch(url, { method });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (done) toast.success(done);
      if (method === "DELETE" && url.endsWith(id)) navigate("/practice");
      else await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stats = useMemo(() => (round && results ? statsOf(results, round.models) : []), [round, results]);

  // Listing-level view: did anyone find it, did everyone, did anyone go wrong.
  const listings = useMemo(() => {
    if (!results) return null;
    const ids = Array.from(new Set(results.map((r) => r.propertyId)));
    const of = (pid: number) => results.filter((r) => r.propertyId === pid && r.outcome !== "running");
    const finished = ids.filter((pid) => of(pid).length === results.filter((r) => r.propertyId === pid).length);
    return {
      total: ids.length,
      finished: finished.length,
      foundByAny: finished.filter((pid) => of(pid).some((r) => r.outcome === "right")).length,
      foundByAll: finished.filter((pid) => of(pid).every((r) => r.outcome === "right")).length,
      foundByNone: finished.filter((pid) => !of(pid).some((r) => r.outcome === "right")).length,
      withWrong: finished.filter((pid) => of(pid).some((r) => r.outcome === "wrong")).length,
    };
  }, [results]);

  // Where the right house dropped out, per model.
  const lost = useMemo(() => {
    if (!results || !round) return [];
    const reasons = Object.keys(LOST).filter((k) => results.some((r) => r.lostAt === k && r.outcome !== "right"));
    return reasons.map((k) => ({
      reason: k,
      byModel: round.models.map((m) => results.filter((r) => r.model === m && r.lostAt === k && r.outcome !== "right").length),
    }));
  }, [results, round]);

  if (missing)
    return (
      <div className="min-h-screen bg-background">
        <AdminHeader subtitle="Practice" />
        <main className="container py-6 space-y-4">
          <p className="text-sm text-muted-foreground">This practice round no longer exists.</p>
          <Link href="/practice">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              All rounds
            </Button>
          </Link>
        </main>
      </div>
    );

  if (!round || !results || !listings)
    return (
      <div className="min-h-screen bg-background">
        <AdminHeader subtitle="Practice" />
        <main className="container py-6">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </main>
      </div>
    );

  const searchesCost = round.costUsd;
  const bestFind = Math.max(...stats.map((s) => (s.runs ? s.right / s.runs : 0)));

  return (
    <div className="min-h-screen bg-background">
      <AdminHeader subtitle="Practice round" />
      <main className="container py-6 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/practice">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              All rounds
            </Button>
          </Link>
          <h2 className="text-lg font-semibold">Practice round of {when(round.createdAt)}</h2>
          {round.trialOf && <Badge variant="outline">Lesson test</Badge>}
          {round.paused ? (
            <Badge variant="outline">Paused</Badge>
          ) : round.running > 0 ? (
            <Badge variant="secondary">{round.running} running</Badge>
          ) : (
            <Badge variant="outline">Finished</Badge>
          )}
          <LearningBadge l={round.learning} />
          <div className="flex-1" />
          {round.paused ? (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => call("round", `/api/practice/rounds/${id}/resume`, "POST", "Round resumed")}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          ) : round.running > 0 ? (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => call("round", `/api/practice/rounds/${id}/pause`, "POST", "Round paused")}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          <Kpi
            label="Accuracy"
            value={round.accuracy != null ? `${round.accuracy}%` : "—"}
            hint={`${round.right} found, ${round.wrong} wrong · goal 100%`}
            tone={round.accuracy == null ? undefined : round.accuracy < 100 ? "bad" : "good"}
          />
          <Kpi
            label="Houses found"
            value={`${listings.foundByAny} of ${listings.finished}`}
            hint={`by at least one model · ${listings.foundByAll} by all`}
          />
          <Kpi label="Runs that found it" value={pct(round.right, round.total)} hint={`${round.right} of ${round.total} runs`} />
          <Kpi label="Average time" value={round.avgMinutes != null ? `${round.avgMinutes} min` : "—"} hint="per run · limit 5 min" />
          <Kpi label="Cost per house found" value={round.right ? usd(searchesCost / round.right) : "—"} hint={`average run ${usd(round.avgCostUsd)}`} />
          <Kpi
            label="Total cost"
            value={usd(round.totalCostUsd)}
            hint={`searches ${usd(searchesCost)} · lesson tests ${usd(round.testsCostUsd)}`}
          />
        </div>

        <Card className="p-0 overflow-x-auto">
          <div className="px-4 pt-4">
            <h3 className="text-sm font-semibold">By model</h3>
            <p className="text-xs text-muted-foreground">
              Unique finds: houses only that model found in this round.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Found</TableHead>
                <TableHead className="text-right">Wrong</TableHead>
                <TableHead className="text-right">Not sure</TableHead>
                <TableHead className="text-right">Over limit</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Accuracy</TableHead>
                <TableHead className="text-right">Find rate</TableHead>
                <TableHead className="text-right">Unique finds</TableHead>
                <TableHead className="text-right">Avg min</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
                <TableHead className="text-right">Cost per find</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((s) => (
                <TableRow key={s.model}>
                  <TableCell className="font-medium whitespace-nowrap">{MODEL_LABEL[s.model] ?? s.model}</TableCell>
                  <TableCell className="text-right">{s.runs}</TableCell>
                  <TableCell className="text-right">{s.right}</TableCell>
                  <TableCell className={`text-right ${s.wrong ? "text-destructive font-medium" : ""}`}>{s.wrong}</TableCell>
                  <TableCell className="text-right">{s.unsure}</TableCell>
                  <TableCell className="text-right">{s.over}</TableCell>
                  <TableCell className="text-right">{s.errors}</TableCell>
                  <TableCell className={`text-right ${s.wrong ? "text-destructive" : ""}`}>{pct(s.right, s.right + s.wrong)}</TableCell>
                  <TableCell className={`text-right ${s.runs && s.right / s.runs === bestFind && bestFind > 0 ? "font-semibold" : ""}`}>
                    {pct(s.right, s.runs)}
                  </TableCell>
                  <TableCell className="text-right">{s.uniqueFinds}</TableCell>
                  <TableCell className="text-right">{round1(s.minutes)}</TableCell>
                  <TableCell className="text-right">{usd(s.avgCost)}</TableCell>
                  <TableCell className="text-right">{s.right ? usd(s.cost / s.right) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="p-0 overflow-x-auto">
            <div className="px-4 pt-4">
              <h3 className="text-sm font-semibold">Where the right house was missed</h3>
              <p className="text-xs text-muted-foreground">From each run's own checklist, for every run that did not find it.</p>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Missed because it</TableHead>
                  {round.models.map((m) => (
                    <TableHead key={m} className="text-right whitespace-nowrap">
                      {MODEL_LABEL[m] ?? m}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lost.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={round.models.length + 1} className="text-muted-foreground">
                      Nothing missed yet.
                    </TableCell>
                  </TableRow>
                )}
                {lost.map((l) => (
                  <TableRow key={l.reason}>
                    <TableCell>{LOST[l.reason]}</TableCell>
                    {l.byModel.map((n, i) => (
                      <TableCell key={i} className="text-right">
                        {n || "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-4 space-y-2">
            <h3 className="text-sm font-semibold">Listings</h3>
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Listings in the round</dt>
              <dd className="text-right">{listings.total}</dd>
              <dt className="text-muted-foreground">Finished</dt>
              <dd className="text-right">{listings.finished}</dd>
              <dt className="text-muted-foreground">Found by every model</dt>
              <dd className="text-right">{listings.foundByAll}</dd>
              <dt className="text-muted-foreground">Found by at least one</dt>
              <dd className="text-right">{listings.foundByAny}</dd>
              <dt className="text-muted-foreground">Found by none</dt>
              <dd className="text-right">{listings.foundByNone}</dd>
              <dt className="text-muted-foreground">With a wrong answer</dt>
              <dd className={`text-right ${listings.withWrong ? "text-destructive font-medium" : ""}`}>{listings.withWrong}</dd>
            </dl>
          </Card>
        </div>

        <Card className="p-0 overflow-x-auto">
          <div className="px-4 pt-4">
            <h3 className="text-sm font-semibold">Every listing</h3>
          </div>
          <ResultsGrid results={results} models={round.models} />
        </Card>

        {!round.trialOf && (
          <Card className="p-0">
            <div className="px-4 pt-4 pb-1">
              <h3 className="text-sm font-semibold">Lessons from this round</h3>
            </div>
            <RoundLessons
              lessons={lessons}
              models={round.models}
              busy={busy}
              onAct={(l, a) => call(l.id, `/api/practice/lessons/${l.id}/${a}`, "POST")}
            />
          </Card>
        )}
      </main>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this practice round?</DialogTitle>
            <DialogDescription>
              Its {round.total} runs stop and are removed with their scores, and so are its lessons that were not kept and
              their tests. Kept lessons stay in use. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                void call("round", `/api/practice/rounds/${id}`, "DELETE", "Round deleted");
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
