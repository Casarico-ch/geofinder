import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import AdminHeader from "@/components/AdminHeader";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, ChevronDown, ExternalLink, Loader2, Pause, RefreshCw, Trash2 } from "lucide-react";

// Mirrors server/popety.ts PropertyProfile and server/requests.ts PlatformRequest.
interface BuildingInfo {
  id: string;
  egid: string | null;
  address: string | null;
  use: string | null;
  floors: number | null;
  heightM: number | null;
  builtYear: number | null;
  heritageProtected: boolean;
  footprintM2: number | null;
  floorAreaM2: number | null;
  volumeM3: number | null;
  views: { lake_view?: string | null; mountain_view?: string | null } | null;
}

interface RatioIndex {
  current: number | null;
  max: number | null;
  usedPct: number | null;
}

interface Profile {
  address: string | null;
  landId: string;
  egrid: string;
  parcelNumber: string;
  parcelAreaM2: number;
  municipality: string | null;
  canton: string | null;
  scores: Record<string, number>;
  buildings: BuildingInfo[];
  heritageRank: number | null;
  map: {
    width: number;
    height: number;
    metresPerPixel: number;
    aerialUrl: string;
    cadastreUrl: string;
    parcelPixels: [number, number][];
  } | null;
  zoning: {
    cantonalZone: string | null;
    municipalPlan: string | null;
    planAdopted: string | null;
    federalZone: string | null;
    allowedUse: string | null;
    maxHeightM: number | null;
    maxFacadeHeightM: number | null;
    maxLengthM: number | null;
  };
  builtVsAllowed: Record<"siteCoverage" | "floorAreaRatio" | "grossFloorRatio" | "volumeRatio", RatioIndex>;
}

interface MapWindow {
  width: number;
  height: number;
  metresPerPixel: number;
  aerialUrl: string;
  cadastreUrl: string;
}

interface Combined {
  plotCount: number;
  totalAreaM2: number;
  plots: { landId: string; parcelNumber: string; egrid: string; areaM2: number }[];
  municipalities: string[];
  zones: string[];
  sameZone: boolean;
  buildingCount: number;
  builtVsAllowed: Profile["builtVsAllowed"];
  floorArea: { currentM2: number | null; allowedM2: number | null; remainingM2: number | null };
  map: (MapWindow & { parcelsPixels: [number, number][][] }) | null;
}

type JobStatus = "running" | "done" | "error" | "cancelled" | "paused";

interface ModelResult {
  model: string;
  jobId: string;
  status: JobStatus;
  answer: {
    found: boolean;
    address: string | null;
    parcels?: { commune: string; plot: string }[];
    confidence: string;
    reasoning: string;
  } | null;
  aiCostUsd: number;
  tokens?: number;
  startedAt?: string;
}

interface PlatformRequest {
  id: string;
  kind: "address" | "listing";
  status: "running" | "paused" | "done" | "error";
  createdAt: string;
  finishedAt?: string;
  input: {
    address?: string;
    latitude?: number;
    longitude?: number;
    commune?: string;
    plot?: string;
    egrid?: string | null;
    plots?: { address?: string; commune?: string; plot?: string; egrid?: string | null; latitude?: number; longitude?: number }[];
    listingText?: string;
    municipality?: string;
    imageCount?: number;
    listingId?: string;
    listingUrl?: string;
    radarUrl?: string;
  };
  profile?: Profile | null;
  candidates?: { landId: string; address: string | null }[];
  profiles?: Profile[];
  combined?: Combined;
  plotErrors?: { plot: string; error: string }[];
  results?: ModelResult[];
  popetyCostChf: number;
  error?: string;
  source?: "platform" | "website";
}

const MODEL_LABEL: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-fable-5": "Fable 5",
  "claude-fable-5-1": "Fable 5.1",
};

const SCORE_INFO: Record<string, string> = {
  development: "Room to build more",
  under_exploited: "Built below what zoning allows",
  legacy: "Existing buildings (no clear direction)",
  geo: "Plot shape",
  livability: "Quality of the location",
};

const RATIO_LABEL: Record<string, string> = {
  siteCoverage: "Site coverage (COS / IOS)",
  floorAreaRatio: "Floor area ratio (CUS / IUS)",
  grossFloorRatio: "Gross floor ratio (IBUS)",
  volumeRatio: "Volume ratio (IM)",
};

const num = (n: number | null | undefined, unit = "") =>
  n == null ? "—" : `${n.toLocaleString("de-CH")}${unit}`;

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />;
  if (status === "error") return <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  if (status === "cancelled") return <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  if (status === "paused") return <Pause className="h-3.5 w-3.5 text-amber-600 shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />;
}

function scoreTone(key: string, v: number) {
  if (key === "legacy") return { bar: "bg-muted-foreground", text: "text-foreground" };
  if (v >= 70) return { bar: "bg-emerald-600", text: "text-emerald-700" };
  if (v >= 40) return { bar: "bg-amber-500", text: "text-amber-700" };
  return { bar: "bg-red-600", text: "text-red-700" };
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(110px,38%)_1fr] gap-3 py-1.5 border-b border-border text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0">{v}</dd>
    </div>
  );
}

function ParcelMap({ map, outlines, label }: { map: MapWindow; outlines: [number, number][][]; label: string }) {
  const [cadastre, setCadastre] = useState(false);
  const bar = 20 / map.metresPerPixel;
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card max-w-md">
      <div className="flex text-xs font-medium">
        {(["Aerial photo", "Cadastral map"] as const).map((t, i) => (
          <button
            key={t}
            type="button"
            onClick={() => setCadastre(i === 1)}
            className={`px-3 py-2 border-b-2 ${cadastre === (i === 1) ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
          >
            {t}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${map.width} ${map.height}`} className="w-full h-auto block" role="img" aria-label={label}>
        <image href={cadastre ? map.cadastreUrl : map.aerialUrl} width={map.width} height={map.height} />
        {outlines.map((outline, i) => {
          const points = outline.map((p) => p.join(",")).join(" ");
          return (
            <g key={i}>
              <polygon points={points} fill="#e8364f" fillOpacity={0.18} />
              <polygon points={points} fill="none" stroke="#fff" strokeOpacity={0.85} strokeWidth={9} strokeLinejoin="round" />
              <polygon points={points} fill="none" stroke="#e0243f" strokeWidth={5} strokeLinejoin="round" />
            </g>
          );
        })}
        <g transform={`translate(24,${map.height - 36})`}>
          <rect x={-10} y={-22} width={bar + 86} height={40} rx={4} fill="#fff" fillOpacity={0.9} />
          <line x1={0} y1={0} x2={bar} y2={0} stroke="#18232b" strokeWidth={3} />
          <line x1={0} y1={-7} x2={0} y2={7} stroke="#18232b" strokeWidth={3} />
          <line x1={bar} y1={-7} x2={bar} y2={7} stroke="#18232b" strokeWidth={3} />
          <text x={bar + 12} y={8} fontSize={18} fontFamily="ui-monospace, monospace" fill="#18232b">
            20 m
          </text>
        </g>
      </svg>
    </div>
  );
}

function ProfileView({ p }: { p: Profile }) {
  const main = p.buildings.find((b) => b.egid) ?? p.buildings[0];
  const others = p.buildings.filter((b) => b !== main);
  const z = p.zoning;
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground">{p.address ?? "Address unknown"}</p>
        <p className="text-xs text-muted-foreground tabular-nums">
          Parcel {p.parcelNumber} · EGRID {p.egrid} · {num(p.parcelAreaM2, " m²")}
          {p.municipality ? ` · ${p.municipality}` : ""}
          {p.canton ? ` ${p.canton}` : ""}
        </p>
      </div>

      {p.map && <ParcelMap map={p.map} outlines={[p.map.parcelPixels]} label={`Parcel ${p.parcelNumber} on a swisstopo map`} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {Object.entries(p.scores ?? {}).map(([k, v]) => {
          const tone = scoreTone(k, v);
          return (
            <div key={k} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground capitalize">
                <span>{k.replace(/_/g, " ")}</span>
                <b className={`text-lg tabular-nums ${tone.text}`}>{v}</b>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${v}%` }} />
              </div>
              <p className="text-[11px] text-muted-foreground leading-tight">{SCORE_INFO[k] ?? ""}</p>
            </div>
          );
        })}
      </div>

      {main && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Building</h4>
          <dl>
            <Row k="Building" v={`${main.address ?? "—"}${main.egid ? ` · EGID ${main.egid}` : ""}`} />
            <Row k="Use" v={`${main.use ?? "—"} · ${num(main.floors)} floors · ${num(main.heightM, " m")} high`} />
            <Row
              k="Built"
              v={`${num(main.builtYear)}${main.heritageProtected ? ` · heritage protected${p.heritageRank != null ? ` (rank ${p.heritageRank})` : ""}` : ""}`}
            />
            <Row
              k="Footprint / floor area"
              v={`${num(main.footprintM2, " m²")} / ${num(main.floorAreaM2, " m²")} · ${num(main.volumeM3, " m³")}`}
            />
            {main.views && (main.views.lake_view || main.views.mountain_view) && (
              <Row k="Views" v={`Lake ${main.views.lake_view ?? "—"} · mountains ${main.views.mountain_view ?? "—"}`} />
            )}
            {others.map((b) => (
              <Row key={b.id} k="Other structure" v={`Building ${b.id}, ${num(b.footprintM2, " m²")} footprint${b.egid ? "" : ", no EGID"}`} />
            ))}
          </dl>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Zoning</h4>
        <dl>
          <Row k="Cantonal zone" v={z.cantonalZone ?? "—"} />
          <Row k="Municipal plan" v={`${z.municipalPlan ?? "—"}${z.planAdopted ? ` (adopted ${z.planAdopted})` : ""}`} />
          <Row k="Federal zone" v={z.federalZone ?? "—"} />
          <Row k="Allowed use" v={z.allowedUse ?? "—"} />
          <Row k="Max height" v={`${num(z.maxHeightM, " m")}${z.maxFacadeHeightM != null ? ` (facade ${z.maxFacadeHeightM} m)` : ""}`} />
          <Row k="Max building length" v={num(z.maxLengthM, " m")} />
        </dl>
      </div>

      <RatioTable ratios={p.builtVsAllowed} />
    </div>
  );
}

function RatioTable({ ratios, title = "Built today vs. allowed" }: { ratios: Profile["builtVsAllowed"]; title?: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{title}</h4>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Index</TableHead>
            <TableHead className="text-right">Current</TableHead>
            <TableHead className="text-right">Max</TableHead>
            <TableHead className="w-28">Used</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(ratios).map(([k, r]) => (
            <TableRow key={k} className="hover:bg-transparent">
              <TableCell>{RATIO_LABEL[k] ?? k}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.current)}</TableCell>
              <TableCell className="text-right tabular-nums">{num(r.max)}</TableCell>
              <TableCell>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden" title={r.usedPct != null ? `${r.usedPct}%` : ""}>
                  <div className="h-full bg-primary" style={{ width: `${Math.min(100, r.usedPct ?? 0)}%` }} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CombinedView({ c, profiles }: { c: Combined; profiles: Profile[] }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          {c.plotCount} plots together · {num(c.totalAreaM2, " m²")}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {c.plots.map((p) => `${p.parcelNumber} (${num(p.areaM2, " m²")})`).join(" + ")}
          {c.municipalities.length ? ` · ${c.municipalities.join(", ")}` : ""}
        </p>
      </div>
      {c.map && <ParcelMap map={c.map} outlines={c.map.parcelsPixels} label={`${c.plotCount} plots on a swisstopo map`} />}
      <dl>
        <Row k="Zone" v={c.sameZone ? c.zones[0] ?? "—" : `Different zones: ${c.zones.join(" / ")}`} />
        <Row k="Buildings" v={num(c.buildingCount)} />
        <Row k="Floor area built" v={num(c.floorArea.currentM2, " m²")} />
        <Row k="Floor area allowed" v={num(c.floorArea.allowedM2, " m²")} />
        <Row k="Floor area left to build" v={num(c.floorArea.remainingM2, " m²")} />
      </dl>
      <RatioTable ratios={c.builtVsAllowed} title="Built today vs. allowed, all plots" />
      {!c.sameZone && (
        <p className="text-xs text-amber-700">
          The plots sit in different zones, so the combined maximums are an area-weighted average of each zone's rules.
        </p>
      )}
      {profiles.map((p) => (
        <details key={p.landId} className="rounded-lg border border-border bg-background">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Plot {p.parcelNumber}
            {p.address ? ` · ${p.address}` : ""}
          </summary>
          <div className="p-3 border-t border-border">
            <ProfileView p={p} />
          </div>
        </details>
      ))}
    </div>
  );
}

function ModelColumn({ r }: { r: ModelResult }) {
  return (
    <Card className="gap-3 py-3.5 px-3.5 min-w-0 shadow-none">
      <div className="flex items-center gap-2">
        <StatusIcon status={r.status} />
        <span className="text-sm font-semibold">{MODEL_LABEL[r.model] ?? r.model}</span>
        <span className="text-xs text-muted-foreground tabular-nums">${r.aiCostUsd.toFixed(2)}</span>
        {r.startedAt && <span className="text-xs text-muted-foreground tabular-nums">{fmtDate(r.startedAt)}</span>}
        <div className="flex-1" />
        <Link href={`/i/${r.jobId}`} className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
          Trace <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      {r.status === "running" && <p className="text-sm text-muted-foreground">Investigating…</p>}
      {r.answer && (
        <div className="text-sm">
          <p className="font-medium">{foundLabel(r.answer, "Area only").replace(/^not found$/, "Not found")}</p>
          <p className="text-xs text-muted-foreground capitalize">Confidence: {r.answer.confidence}</p>
        </div>
      )}
    </Card>
  );
}

// What a model found: the address, else its exact plots, else just an area.
function foundLabel(a: NonNullable<ModelResult["answer"]>, area = "area"): string {
  if (!a.found) return "not found";
  if (a.address) return a.address;
  if (a.parcels?.length) return `${a.parcels[0].commune} ${a.parcels.map((p) => p.plot).join(" + ")}`;
  return area;
}

function summaryOf(r: PlatformRequest): string {
  if (r.kind === "address") {
    if (r.input.address) return r.input.address;
    if (r.input.plot) return `${r.input.commune} ${r.input.plot}`;
    if (r.input.egrid) return `EGRID ${r.input.egrid}`;
    if (r.input.plots)
      return r.input.plots
        .map((p) =>
          p.address ?? (p.plot ? `${p.commune} ${p.plot}` : p.egrid ? `EGRID ${p.egrid}` : `${p.latitude}, ${p.longitude}`),
        )
        .join(" + ");
    if (r.input.latitude != null) return r.profile?.address ?? `${r.input.latitude}, ${r.input.longitude}`;
    return "Property";
  }
  // Runs started from the form carry the commune folded into the text; show it once.
  const body = (r.input.listingText ?? "").replace(/^Municipality \/ commune: [^\n]*\n*/, "").trim();
  const text = [r.input.municipality?.trim(), body].filter(Boolean).join(" · ") || "Listing";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// The listing's own title ("Title: …" line, else its first line), else the commune.
function titleOf(r: PlatformRequest): string {
  if (r.kind === "address") return summaryOf(r);
  const body = (r.input.listingText ?? "").replace(/^Municipality \/ commune: [^\n]*\n*/, "");
  const titled = body.match(/^\s*Title:\s*(.+)$/im)?.[1];
  const first = body.split("\n").map((l) => l.trim()).find(Boolean);
  return (titled ?? first ?? r.input.municipality ?? "Listing").trim();
}

// "Sonnet 5.5 + Opus 5.5", plus the run count when a model ran more than once.
function modelsOf(r: PlatformRequest): string {
  const results = r.results ?? [];
  const names = Array.from(new Set(results.map((m) => MODEL_LABEL[m.model] ?? m.model)));
  return names.join(" + ") + (results.length > names.length ? ` · ${results.length} runs` : "");
}

function shortId(r: PlatformRequest): string {
  return r.input.listingId ?? r.id.replace(/^job-/, "").slice(0, 8);
}

type Outcome = { label: string; tone: string; detail?: string };

function outcomeOf(r: PlatformRequest): Outcome {
  if (r.kind === "address") {
    if (r.status === "error") return { label: "Failed", tone: "bg-red-500/10 text-red-700" };
    return r.profile || r.combined
      ? { label: "Property data", tone: "bg-emerald-500/10 text-emerald-700" }
      : { label: "Not found", tone: "bg-muted text-muted-foreground" };
  }
  const results = r.results ?? [];
  const hit = results.find((m) => m.status === "done" && m.answer?.found);
  if (hit?.answer) return { label: "Found", tone: "bg-emerald-500/10 text-emerald-700", detail: foundLabel(hit.answer) };
  if (results.some((m) => m.status === "running")) return { label: "Searching", tone: "bg-primary/10 text-primary" };
  if (results.some((m) => m.status === "paused")) return { label: "Paused", tone: "bg-amber-500/10 text-amber-700" };
  return { label: "Not found", tone: "bg-muted text-muted-foreground" };
}

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : n ? String(n) : "—";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// Run the selected requests again: same photos, text and models, each as a new row.
function RunAgain({ rows, onDone }: { rows: PlatformRequest[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const runnable = rows.filter(
    (r) => r.kind === "listing" && r.status !== "running" && (r.results ?? []).length > 0,
  );
  const run = async () => {
    setBusy(true);
    let started = 0;
    try {
      for (const r of runnable) {
        const res = await fetch("/api/requests/rerun", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobIds: (r.results ?? []).map((m) => m.jobId) }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? "Could not run it again");
        started++;
      }
      toast.success(started === 1 ? "Started again — the new run is at the top" : `Started ${started} again — the new runs are at the top`);
      onDone();
    } catch (err) {
      toast.error(
        (started ? `Started ${started}, then: ` : "") + (err instanceof Error ? err.message : "Could not run it again"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || runnable.length === 0}
      title={runnable.length === 0 ? "Only finished listing searches can run again" : undefined}
      onClick={() => void run()}
    >
      {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
      Run again
    </Button>
  );
}

function RequestDetails({ r }: { r: PlatformRequest }) {
  return (
    <div className="space-y-3">
      {r.error && <p className="text-sm text-destructive">{r.error}</p>}
      {r.candidates && r.candidates.length > 0 && (
        <ul className="text-sm list-disc pl-5">
          {r.candidates.map((c) => (
            <li key={c.landId}>{c.address ?? `Parcel ${c.landId}`}</li>
          ))}
        </ul>
      )}
      {r.plotErrors?.map((e) => (
        <p key={e.plot} className="text-sm text-destructive">
          {e.plot}: {e.error}
        </p>
      ))}
      {r.kind === "address" && r.combined && <CombinedView c={r.combined} profiles={r.profiles ?? []} />}
      {r.kind === "address" && r.profile && <ProfileView p={r.profile} />}
      {r.kind === "listing" && (
        <>
          {(r.input.listingUrl || r.input.radarUrl) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {r.input.listingUrl && (
                <a
                  href={r.input.listingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary inline-flex items-center gap-1 hover:underline break-all"
                >
                  {r.input.listingUrl} <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              )}
              {r.input.radarUrl && (
                <a
                  href={r.input.radarUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary font-medium inline-flex items-center gap-1 hover:underline shrink-0"
                >
                  Open in Radar <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              )}
            </div>
          )}
          {r.input.listingText && (
            <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">{r.input.listingText}</p>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            {(r.results ?? []).map((m) => (
              <ModelColumn key={m.jobId} r={m} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RequestRow({ r, selected, onToggle }: { r: PlatformRequest; selected: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const aiCost = (r.results ?? []).reduce((s, m) => s + m.aiCostUsd, 0);
  const tokens = (r.results ?? []).reduce((s, m) => s + (m.tokens ?? 0), 0);
  const outcome = outcomeOf(r);
  const title = titleOf(r);
  return (
    <>
      <TableRow
        data-state={selected ? "selected" : undefined}
        className="cursor-pointer"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Select ${title}`} />
        </TableCell>
        <TableCell className="hidden md:table-cell font-mono text-xs text-muted-foreground max-w-28 truncate" title={r.input.listingId ?? r.id}>
          {shortId(r)}
        </TableCell>
        <TableCell className="max-w-0 w-full">
          <div className="truncate font-medium" title={title}>
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {[
              r.kind === "address" ? "Property lookup" : r.input.municipality,
              r.source === "website" ? "Website" : "Platform",
              r.kind === "listing" && modelsOf(r),
            ]
              .filter(Boolean)
              .join(" · ")}
            <span className="md:hidden"> · {fmtDate(r.createdAt)}</span>
          </div>
        </TableCell>
        <TableCell className="max-w-44">
          <Badge variant="outline" className={`gap-1 whitespace-nowrap border-transparent ${outcome.tone}`}>
            {outcome.label === "Searching" && <Loader2 className="h-3 w-3 animate-spin" />}
            {outcome.label}
          </Badge>
          {outcome.detail && (
            <div className="hidden md:block mt-0.5 truncate text-xs text-muted-foreground" title={outcome.detail}>
              {outcome.detail}
            </div>
          )}
        </TableCell>
        <TableCell className="hidden md:table-cell text-right tabular-nums">
          {r.kind === "listing" ? `$${aiCost.toFixed(2)}` : `CHF ${r.popetyCostChf.toFixed(2)}`}
        </TableCell>
        <TableCell className="hidden md:table-cell text-right tabular-nums text-muted-foreground">
          {r.kind === "listing" ? fmtTokens(tokens) : "—"}
        </TableCell>
        <TableCell className="hidden md:table-cell text-right text-xs tabular-nums text-muted-foreground whitespace-nowrap">
          {fmtDate(r.createdAt)}
        </TableCell>
        <TableCell className="hidden md:table-cell w-8">
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={8} className="bg-muted/30 p-4 whitespace-normal">
            <RequestDetails r={r} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function Requests() {
  const [requests, setRequests] = useState<PlatformRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reload, setReload] = useState(0);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const visibleIds = (requests ?? []).map((r) => r.id);
  const chosen = visibleIds.filter((id) => selected.has(id));
  const allChosen = visibleIds.length > 0 && chosen.length === visibleIds.length;

  const deleteChosen = async () => {
    const rows = (requests ?? []).filter((r) => selected.has(r.id));
    const requestIds = rows.filter((r) => !r.id.startsWith("job-")).map((r) => r.id);
    const jobIds = rows.flatMap((r) => (r.results ?? []).map((m) => m.jobId));
    setDeleting(true);
    try {
      const res = await fetch("/api/requests/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestIds, jobIds }),
      });
      if (!res.ok) throw new Error();
      setRequests((prev) => (prev ?? []).filter((r) => !selected.has(r.id)));
      toast.success(`Deleted ${rows.length} ${rows.length === 1 ? "request" : "requests"}`);
      setSelected(new Set());
      setConfirming(false);
      setReload((n) => n + 1);
    } catch {
      toast.error("Could not delete the requests. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/requests");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { requests: PlatformRequest[] };
        if (!alive) return;
        setRequests(data.requests);
        setError(null);
      } catch {
        if (alive) setError("Could not load the requests. Retrying…");
      }
      if (alive) timer = setTimeout(load, 5000);
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reload]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader subtitle="One row per property request, each model's search inside" />
      <main className="flex-1 container py-8">
        <div className="max-w-5xl mx-auto space-y-3">
          <div className="flex items-center justify-between gap-3 min-h-9">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium text-foreground">
                {chosen.length > 0 ? `${chosen.length} selected` : "Requests"}
              </h2>
            </div>
            {chosen.length > 0 ? (
              confirming ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground hidden sm:inline">
                    Delete {chosen.length} {chosen.length === 1 ? "request" : "requests"} and their runs? This can't be undone.
                  </span>
                  <Button size="sm" variant="destructive" disabled={deleting} onClick={() => void deleteChosen()}>
                    {deleting ? "Deleting…" : "Delete"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <RunAgain
                    rows={(requests ?? []).filter((r) => selected.has(r.id))}
                    onDone={() => {
                      setSelected(new Set());
                      setReload((n) => n + 1);
                    }}
                  />
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirming(true)}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              )
            ) : (
              requests && requests.length > 0 && <span className="text-xs text-muted-foreground">{requests.length}</span>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {requests === null && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
          {requests?.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-card px-6 py-14 text-center">
              <p className="text-sm font-medium text-foreground">No requests yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Each property request, from the platform or a New search here, shows up as one row.
              </p>
            </div>
          )}
          {requests && requests.length > 0 && (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allChosen ? true : chosen.length > 0 ? "indeterminate" : false}
                        onCheckedChange={() => setSelected(allChosen ? new Set() : new Set(visibleIds))}
                        aria-label="Select all requests"
                      />
                    </TableHead>
                    <TableHead className="hidden md:table-cell">ID</TableHead>
                    <TableHead>Listing</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="hidden md:table-cell text-right">Cost</TableHead>
                    <TableHead className="hidden md:table-cell text-right">Tokens</TableHead>
                    <TableHead className="hidden md:table-cell text-right">Date</TableHead>
                    <TableHead className="hidden md:table-cell w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((r) => (
                    <RequestRow key={r.id} r={r} selected={selected.has(r.id)} onToggle={() => toggle(r.id)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
