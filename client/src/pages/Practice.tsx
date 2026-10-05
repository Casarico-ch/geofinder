import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import { LEARNING_HELP, LearningBadge, when, type Lesson, type Round } from "@/components/practice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronRight, Loader2, Pause, Play, Trash2 } from "lucide-react";

// The test track: GeoFinder searches listings whose building Radar already
// knows (address hidden), every answer is scored, and each round teaches it.
export default function Practice() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [size, setSize] = useState("20");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Round | null>(null);
  const [, navigate] = useLocation();

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

  const n = Number(size);
  const validSize = Number.isInteger(n) && n >= 1 && n <= 200;

  const start = async () => {
    setStarting(true);
    try {
      const res = await fetch("/api/practice/rounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: n }),
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
              <Label htmlFor="practice-size">Listings (1–200)</Label>
              <Input
                id="practice-size"
                type="number"
                inputMode="numeric"
                min={1}
                max={200}
                step={1}
                className="w-32"
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </div>
            <Button onClick={start} disabled={starting || !validSize}>
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
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/practice/${r.id}`)}>
                    <TableCell className="whitespace-nowrap">
                      <ChevronRight className="inline h-4 w-4 mr-1 text-muted-foreground" />
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
