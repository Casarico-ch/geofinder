import { useEffect, useState } from "react";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Play } from "lucide-react";

// Mirrors RoundSummary in server/practice.ts.
interface Round {
  id: string;
  createdAt: string;
  finishedAt: string | null;
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

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// The test track: GeoFinder searches listings whose building Radar already
// knows (address hidden), and every answer is scored against it.
export default function Practice() {
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [size, setSize] = useState("20");
  const [starting, setStarting] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/practice/rounds");
      if (res.ok) setRounds((await res.json()).rounds);
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

  return (
    <div className="min-h-screen bg-background">
      <AdminHeader subtitle="Practice" />
      <main className="container py-6 space-y-6">
        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">Start a practice round</h2>
            <p className="text-sm text-muted-foreground">
              Every search model looks for listings whose building Radar already knows, with the address hidden. Each
              model gets CHF 1 per listing; a run that reaches it without an answer counts as a failure.
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
                <TableHead className="text-right">Right</TableHead>
                <TableHead className="text-right">Wrong</TableHead>
                <TableHead className="text-right">Not sure</TableHead>
                <TableHead className="text-right">Over budget</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Avg min</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rounds === null && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {rounds?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-muted-foreground">
                    No practice round yet.
                  </TableCell>
                </TableRow>
              )}
              {rounds?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">
                    {when(r.createdAt)}{" "}
                    {r.running > 0 ? <Badge variant="secondary">{r.running} running</Badge> : null}
                  </TableCell>
                  <TableCell className="text-right">{r.total}</TableCell>
                  <TableCell className="text-right">{r.right}</TableCell>
                  <TableCell className={`text-right ${r.wrong ? "text-destructive font-medium" : ""}`}>{r.wrong}</TableCell>
                  <TableCell className="text-right">{r.unsure}</TableCell>
                  <TableCell className="text-right">{r.overBudget}</TableCell>
                  <TableCell className="text-right">{r.errors}</TableCell>
                  <TableCell className="text-right">{r.avgMinutes ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.avgCostUsd != null ? `$${r.avgCostUsd.toFixed(2)}` : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </main>
    </div>
  );
}
