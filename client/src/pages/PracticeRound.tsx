import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import {
  LearningBadge,
  ListingsPanel,
  LessonsPanel,
  when,
  type Lesson,
  isBusy,
  type ListingInfo,
  type Result,
  type Round,
} from "@/components/practice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, Lightbulb, Pause, Play, RotateCcw, Trash2 } from "lucide-react";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);

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
  const [listingInfo, setListingInfo] = useState<Record<number, ListingInfo>>({});
  // What Radar would show per listing: a house only when two runs name it (server: practice.ts listingVerdict).
  const [verdicts, setVerdicts] = useState<Record<number, "running" | "confirmed_right" | "confirmed_wrong" | "not_confirmed">>({});
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
        setListingInfo(body.listings ?? {});
        setVerdicts(body.verdicts ?? {});
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
      withWrong: finished.filter((pid) => of(pid).some((r) => r.outcome === "wrong")).length,
      // Found by the first search, or only by the recheck that followed it.
      firstFound: finished.filter((pid) => of(pid).some((r) => !r.recheck && r.outcome === "right")).length,
      secondFound: finished.filter((pid) => !of(pid).some((r) => !r.recheck && r.outcome === "right") && of(pid).some((r) => r.recheck && r.outcome === "right")).length,
      // As Radar shows it: a house only when two runs named it.
      confirmedRight: finished.filter((pid) => verdicts[pid] === "confirmed_right").length,
      confirmedWrong: finished.filter((pid) => verdicts[pid] === "confirmed_wrong").length,
      // Every run of a listing together: its first search plus any recheck.
      minutes: finished.reduce((a, pid) => a + of(pid).reduce((b, r) => b + (r.minutes ?? 0), 0), 0),
      cost: finished.reduce((a, pid) => a + of(pid).reduce((b, r) => b + (r.costUsd ?? 0), 0), 0),
    };
  }, [results, verdicts]);

  // The same listings again under today's code: all of them, or only those no run found.
  const rerun = async (failed: boolean) => {
    setBusy("round");
    try {
      const res = await fetch(`/api/practice/rounds/${id}/rerun${failed ? "?failed=1" : ""}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(`${body.total ?? ""} ${failed ? "failed " : ""}listings started again`.trim());
      navigate(`/practice/${body.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

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
          {round.rerunOf && (
            <Link href={`/practice/${round.rerunOf}`}>
              <Badge variant="outline" className="cursor-pointer">
                Re-run of an earlier round
              </Badge>
            </Link>
          )}
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
          ) : isBusy(round) ? (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => call("round", `/api/practice/rounds/${id}/pause`, "POST", "Round paused")}>
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          ) : null}
          {!round.trialOf && round.finishedAt && ["off", "done", "failed"].includes(round.learning?.state ?? "") && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => call("round", `/api/practice/rounds/${id}/learn`, "POST", "Looking for lessons")}>
              <Lightbulb className="mr-1.5 h-3.5 w-3.5" />
              Find lessons
            </Button>
          )}
          {!round.trialOf && listings.finished - listings.foundByAny > 0 && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => rerun(true)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Run again on the {listings.finished - listings.foundByAny} failed
            </Button>
          )}
          {!round.trialOf && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => rerun(false)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Run again on the same listings
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>

        <div className="grid gap-3 grid-cols-2 md:grid-cols-4 xl:grid-cols-8">
          <Kpi label="All listings" value={String(listings.total)} hint={`${listings.finished} finished`} />
          <Kpi label="Found 1st trial" value={String(listings.firstFound)} hint="by the first search" />
          <Kpi label="Found 2nd trial" value={String(listings.secondFound)} hint="only by the recheck" />
          <Kpi
            label="Success rate"
            value={pct(listings.confirmedRight, listings.finished)}
            hint={`${listings.confirmedRight} of ${listings.finished} confirmed by two searches, as Radar shows them · ${listings.confirmedWrong} confirmed wrong · ${listings.finished - listings.confirmedRight - listings.confirmedWrong} not confirmed`}
            tone={!listings.finished ? undefined : listings.confirmedWrong ? "bad" : "good"}
          />
          <Kpi label="Confirmed wrong" value={String(listings.confirmedWrong)} hint="two searches named the same wrong house" tone={listings.confirmedWrong ? "bad" : undefined} />
          <Kpi
            label="Avg time per listing"
            value={listings.finished ? `${Math.round((listings.minutes / listings.finished) * 10) / 10} min` : "—"}
            hint="every search of the listing together"
          />
          <Kpi label="Cost per listing" value={listings.finished ? usd(listings.cost / listings.finished) : "—"} hint="every search of the listing together" />
          <Kpi
            label="Total costs"
            value={usd(round.totalCostUsd)}
            hint={`searches ${usd(searchesCost)} · lesson tests ${usd(round.testsCostUsd)}`}
          />
        </div>

        <Tabs defaultValue="listings" className="space-y-4">
          <TabsList>
            <TabsTrigger value="listings">Listings {listings.total}</TabsTrigger>
            {!round.trialOf && <TabsTrigger value="lessons">Lessons {lessons.length}</TabsTrigger>}
          </TabsList>
          <TabsContent value="listings">
            <ListingsPanel results={results} models={round.models} listings={listingInfo} />
          </TabsContent>
          {!round.trialOf && (
            <TabsContent value="lessons">
              <LessonsPanel
                lessons={lessons}
                models={round.models}
                busy={busy}
                onAct={(l, a) => call(l.id, `/api/practice/lessons/${l.id}/${a}`, "POST")}
              />
            </TabsContent>
          )}
        </Tabs>
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
