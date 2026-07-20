import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Brain,
  Building2,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  ImageIcon,
  Loader2,
  MapPin,
  Plus,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { toast } from "sonner";

type Confidence =
  | "street"
  | "building"
  | "block"
  | "neighborhood"
  | "city"
  | "region"
  | "country"
  | "unknown";

interface AnswerCandidate {
  parcel: string | null;
  address: string | null;
  note: string;
}

interface Answer {
  found: boolean;
  address: string | null;
  parcel: string | null;
  commune: string | null;
  confidence: Confidence;
  latitude: number | null;
  longitude: number | null;
  reasoning: string;
  candidates: AnswerCandidate[];
  links: string[];
}

type StepKind = "reasoning" | "bash" | "write" | "read" | "answer" | "note" | "error";

interface Step {
  n: number;
  at: string;
  kind: StepKind;
  title: string;
  detail?: string;
  reasoning?: string;
  image?: string;
}

type JobStatus = "running" | "done" | "error" | "cancelled";

interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  total: number;
}

interface DossierLink {
  label: string;
  url: string;
}
interface Dossier {
  generatedAt: string;
  coverage: "geneva" | "partial";
  parcel: { number: number | null; commune: string | null; area_m2: number | null; egrid: string | null; ownership: string | null } | null;
  building: {
    year: number | null;
    floorsAbove: number | null;
    floorsBelow: number | null;
    footprint_m2: number | null;
    height_m: number | null;
    dwellings: number | null;
    destination: string | null;
  } | null;
  zone: { code: string | null; name: string | null } | null;
  buildPotential: {
    existingSbp_m2: number | null;
    scenarios: { key: string; label: string; ius: number; allowedSbp_m2: number; headroom_m2: number }[];
    surelevation: { applies: boolean; sector: string | null; legalBasis: string | null; note: string | null };
    caveat: string | null;
  } | null;
  energy: { idc: string | null; heatingDemand_kWh: number | null; hotWaterDemand_kWh: number | null; solarRoofSurfaces: number | null } | null;
  environment: { noise: string | null; waterProtection: string | null } | null;
  links: DossierLink[];
  notes: string[];
}

interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  input: { municipality?: string; listingText?: string; imageCount: number };
  steps: Step[];
  answer: Answer | null;
  error?: string;
  tokens: TokenUsage;
  cost: number;
  dossier?: Dossier | null;
}

interface JobSummary {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  steps: number;
  title: string;
  found: boolean | null;
  tokens: number;
  cost: number;
}

interface Picture {
  file: File;
  url: string;
}

const CONFIDENCE_META: Record<Confidence, { label: string; tone: string }> = {
  street: { label: "Street-level", tone: "text-primary bg-primary/10" },
  building: { label: "Building-level", tone: "text-primary bg-primary/10" },
  block: { label: "Block-level", tone: "text-primary bg-primary/10" },
  neighborhood: { label: "Neighborhood", tone: "text-amber-700 bg-amber-500/10" },
  city: { label: "City-level", tone: "text-amber-700 bg-amber-500/10" },
  region: { label: "Region-level", tone: "text-muted-foreground bg-muted" },
  country: { label: "Country-level", tone: "text-muted-foreground bg-muted" },
  unknown: { label: "Inconclusive", tone: "text-destructive bg-destructive/10" },
};

const MAX_IMAGES = 15;

async function fileToJpegBase64(file: File, maxEdge = 2048): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function mapEmbedUrl(lat: number, lon: number, wide: boolean) {
  const d = wide ? 0.02 : 0.003;
  const bbox = [lon - d, lat - d, lon + d, lat + d].join(",");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const STEP_ICON: Record<StepKind, typeof Terminal> = {
  reasoning: Brain,
  bash: Terminal,
  write: FileText,
  read: Eye,
  answer: CheckCircle2,
  note: FileText,
  error: AlertCircle,
};

function StatusDot({ status }: { status: JobStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />;
  if (status === "error") return <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  if (status === "cancelled") return <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

function DRow({ k, v }: { k: string; v: React.ReactNode }) {
  if (v == null || v === "" || v === false) return null;
  return (
    <div className="flex justify-between gap-4 text-sm py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground text-right tabular-nums">{v}</span>
    </div>
  );
}

function DossierSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium text-muted-foreground mb-1.5">{title}</p>
      {children}
    </div>
  );
}

function DossierView({ d }: { d: Dossier }) {
  const p = d.parcel;
  const b = d.building;
  const bp = d.buildPotential;
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold text-foreground">Property dossier</p>
        {d.coverage === "partial" && (
          <span className="text-xs text-amber-700 bg-amber-500/10 rounded-full px-2 py-0.5">federal data only</span>
        )}
      </div>

      {p && (
        <DossierSection title="Parcel">
          <DRow k="Commune" v={p.commune} />
          <DRow k="Parcel N°" v={p.number} />
          <DRow k="Land area" v={p.area_m2 != null ? `${p.area_m2.toLocaleString()} m²` : null} />
          <DRow k="Ownership" v={p.ownership} />
          <DRow k="EGRID" v={p.egrid} />
        </DossierSection>
      )}

      {b && (
        <DossierSection title="Building">
          <DRow k="Built" v={b.year} />
          <DRow k="Type" v={b.destination} />
          <DRow k="Floors" v={b.floorsAbove != null ? `${b.floorsAbove} above${b.floorsBelow ? ` · ${b.floorsBelow} below` : ""}` : null} />
          <DRow k="Footprint" v={b.footprint_m2 != null ? `${b.footprint_m2} m²` : null} />
          <DRow k="Height" v={b.height_m != null ? `${b.height_m} m` : null} />
          <DRow k="Dwellings" v={b.dwellings} />
        </DossierSection>
      )}

      {(d.zone || bp) && (
        <DossierSection title="Zone & build potential">
          <DRow k="Zone" v={d.zone?.name ?? (d.zone?.code ? `Zone ${d.zone.code}` : null)} />
          {bp?.existingSbp_m2 != null && <DRow k="Existing floor area (est.)" v={`~${bp.existingSbp_m2} m²`} />}

          {bp && bp.scenarios.length > 0 && (
            <div className="mt-2 rounded-lg border border-border overflow-hidden">
              <div className="grid grid-cols-4 text-[11px] text-muted-foreground bg-muted/50 px-3 py-1.5">
                <span>Scenario</span>
                <span className="text-right">IUS</span>
                <span className="text-right">Allowed</span>
                <span className="text-right">Headroom</span>
              </div>
              {bp.scenarios.map((s) => (
                <div key={s.key} className="grid grid-cols-4 text-xs px-3 py-1.5 border-t border-border tabular-nums">
                  <span className="text-foreground">{s.label}</span>
                  <span className="text-right text-muted-foreground">{s.ius}</span>
                  <span className="text-right text-muted-foreground">{s.allowedSbp_m2} m²</span>
                  <span className={`text-right font-medium ${s.headroom_m2 > 0 ? "text-foreground" : "text-muted-foreground"}`}>
                    {s.headroom_m2 > 0 ? `+${s.headroom_m2} m²` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {bp?.surelevation.applies && (
            <div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 space-y-0.5">
              <p className="text-xs font-medium text-foreground">
                Surélévation (build-up) — sector {bp.surelevation.sector ?? "—"}
              </p>
              {bp.surelevation.legalBasis && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">{bp.surelevation.legalBasis}</p>
              )}
              {bp.surelevation.note && <p className="text-[11px] text-muted-foreground">{bp.surelevation.note}</p>}
            </div>
          )}

          {bp && !bp.surelevation.applies && bp.surelevation.note && (
            <p className="text-xs text-muted-foreground mt-1.5">{bp.surelevation.note}</p>
          )}
        </DossierSection>
      )}

      {d.energy && (
        <DossierSection title="Energy & solar">
          <DRow k="Energy index (IDC)" v={d.energy.idc} />
          <DRow k="Heating demand" v={d.energy.heatingDemand_kWh != null ? `${d.energy.heatingDemand_kWh.toLocaleString()} kWh/yr` : null} />
          <DRow k="Hot-water demand" v={d.energy.hotWaterDemand_kWh != null ? `${d.energy.hotWaterDemand_kWh.toLocaleString()} kWh/yr` : null} />
          <DRow k="Solar roof surfaces" v={d.energy.solarRoofSurfaces} />
        </DossierSection>
      )}

      {d.environment && (d.environment.noise || d.environment.waterProtection) && (
        <DossierSection title="Environment">
          <DRow k="Noise sector" v={d.environment.noise} />
          <DRow k="Water protection" v={d.environment.waterProtection} />
        </DossierSection>
      )}

      {d.links.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {d.links.map((l, i) => (
            <a key={i} href={l.url} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                {l.label} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </a>
          ))}
        </div>
      )}

      {d.notes.length > 0 && (
        <div className="space-y-1 pt-1">
          {d.notes.map((n, i) => (
            <p key={i} className="text-[11px] text-muted-foreground leading-relaxed">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const Icon = STEP_ICON[step.kind] ?? FileText;
  const tone =
    step.kind === "error"
      ? "text-destructive"
      : step.kind === "answer"
        ? "text-primary"
        : step.kind === "reasoning"
          ? "text-violet-600"
          : "text-muted-foreground";
  return (
    <li className="flex gap-2.5">
      <div className={`mt-0.5 shrink-0 ${tone}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className={`text-xs font-medium break-words ${step.kind === "bash" ? "font-mono" : ""} text-foreground`}>
          {step.title}
        </p>
        {step.reasoning && (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">{step.reasoning}</p>
        )}
        {step.detail && (
          <pre className="text-[11px] text-muted-foreground bg-muted/60 rounded-md p-2 overflow-x-auto whitespace-pre-wrap max-h-56">
            {step.detail}
          </pre>
        )}
        {step.image && (
          <img src={step.image} alt={step.title} className="mt-1 rounded-md border border-border max-h-72" loading="lazy" />
        )}
      </div>
    </li>
  );
}

export default function AddressFinder() {
  const [location, navigate] = useLocation();
  const [isDetail, detailParams] = useRoute("/i/:id");
  const jobId = isDetail ? detailParams.id : null;
  const isNew = location === "/new";
  const isOverview = !isDetail && !isNew;

  const [pictures, setPictures] = useState<Picture[]>([]);
  const [municipality, setMunicipality] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const traceEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => pictures.forEach((p) => URL.revokeObjectURL(p.url));
  }, [pictures]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/geo/investigations");
      if (res.ok) setRecent(((await res.json()).jobs ?? []) as JobSummary[]);
    } catch {
      /* ignore */
    }
  }, []);

  // Keep the overview list fresh while it's on screen (running jobs update live).
  useEffect(() => {
    if (!isOverview) return;
    void loadRecent();
    const timer = setInterval(() => void loadRecent(), 3000);
    return () => clearInterval(timer);
  }, [isOverview, loadRecent]);

  // Poll the active investigation until it reaches a terminal state.
  useEffect(() => {
    if (!jobId) return;
    setJob(null);
    setNotFound(false);
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/geo/investigate/${jobId}`);
        if (res.status === 404) {
          if (alive) setNotFound(true);
          return true;
        }
        if (!res.ok) return false;
        const data = (await res.json()) as Job;
        if (alive) setJob(data);
        if (data.status !== "running") return true;
      } catch {
        /* transient */
      }
      return false;
    };
    void tick();
    const timer = setInterval(async () => {
      if (await tick()) clearInterval(timer);
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId]);

  useEffect(() => {
    if (job?.status === "running") traceEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [job?.steps.length, job?.status]);

  const addFiles = useCallback((list: FileList | File[]) => {
    const chosen = Array.from(list).filter(
      (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name),
    );
    if (chosen.length === 0) {
      toast.error("Please choose image files");
      return;
    }
    setPictures((prev) => {
      const room = MAX_IMAGES - prev.length;
      if (room <= 0) {
        toast.error(`Up to ${MAX_IMAGES} images`);
        return prev;
      }
      const next = chosen.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }));
      if (chosen.length > room) toast.error(`Up to ${MAX_IMAGES} images — extra ignored`);
      return [...prev, ...next];
    });
  }, []);

  const removePicture = useCallback((index: number) => {
    setPictures((prev) => {
      const p = prev[index];
      if (p) URL.revokeObjectURL(p.url);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearForm = useCallback(() => {
    setPictures((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setMunicipality("");
    setDescription("");
    setError(null);
  }, []);

  const start = useCallback(async () => {
    if (pictures.length === 0) return;
    setSubmitting(true);
    setError(null);
    // Keep the files around after we clear the form so the background upload can
    // still read them once we've navigated away.
    const files = pictures.map((p) => p.file);
    try {
      // 1) Create the job on a tiny metadata request — returns in milliseconds.
      const res = await fetch("/api/geo/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageCount: files.length,
          listingText: description || undefined,
          municipality: municipality || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not start the investigation");
      const jobId = body.jobId as string;

      // 2) Navigate immediately — the user is free to move on right now.
      clearForm();
      navigate(`/i/${jobId}`);

      // 3) Encode + upload the photos in the background. The investigation
      //    starts the moment they land; the user isn't waiting on any of this.
      void (async () => {
        try {
          const images = await Promise.all(
            files.map(async (file) => ({
              imageBase64: await fileToJpegBase64(file),
              mediaType: "image/jpeg" as const,
            })),
          );
          const up = await fetch(`/api/geo/investigate/${jobId}/photos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images }),
          });
          if (!up.ok) throw new Error();
        } catch {
          toast.error("Could not upload the photos — please retry this investigation.");
        }
      })();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the investigation");
    } finally {
      setSubmitting(false);
    }
  }, [pictures, municipality, description, clearForm, navigate]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy"));
  }, []);

  const stop = useCallback(async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/geo/investigate/${jobId}/cancel`, { method: "POST" });
      toast.success("Stopping…");
    } catch {
      toast.error("Could not stop");
    }
  }, [jobId]);

  const enrich = useCallback(async () => {
    if (!jobId) return;
    setEnriching(true);
    try {
      const res = await fetch(`/api/geo/investigate/${jobId}/enrich`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not build the dossier");
      setJob((j) => (j ? { ...j, dossier: body as Dossier } : j));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build the dossier");
    } finally {
      setEnriching(false);
    }
  }, [jobId]);

  const answer = job?.answer ?? null;
  const coords =
    answer && answer.latitude !== null && answer.longitude !== null
      ? { lat: answer.latitude, lon: answer.longitude }
      : null;
  const primaryLine = answer?.address ?? answer?.parcel ?? "";
  const wideMap = answer ? !["street", "building", "block"].includes(answer.confidence) : true;
  const running = job?.status === "running";

  const inputClass =
    "w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border sticky top-0 bg-background/90 backdrop-blur z-10">
        <div className="container py-3.5 flex items-center gap-2.5">
          <Link href="/" className="flex items-center gap-2.5 group">
            <MapPin className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-base font-semibold text-foreground group-hover:text-primary transition-colors">
                GeoFinder
              </h1>
              <p className="text-xs text-muted-foreground">Find a property's exact address from its listing</p>
            </div>
          </Link>
          <div className="flex-1" />
          {isNew ? (
            <Link href="/">
              <Button variant="ghost" size="sm">
                Overview
              </Button>
            </Link>
          ) : (
            <Link href="/new">
              <Button size="sm">
                <Search className="mr-1.5 h-3.5 w-3.5" />
                New search
              </Button>
            </Link>
          )}
        </div>
      </header>

      <main className="flex-1 container py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* ---------- Overview ---------- */}
          {isOverview && (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-foreground">Investigations</h2>
                {recent.length > 0 && <span className="text-xs text-muted-foreground">{recent.length}</span>}
              </div>

              {recent.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card px-6 py-14 flex flex-col items-center text-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <MapPin className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">No investigations yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Add a listing's photos and text; the address is deduced from scratch.
                    </p>
                  </div>
                  <Link href="/new">
                    <Button size="sm">
                      <Search className="mr-1.5 h-3.5 w-3.5" />
                      New search
                    </Button>
                  </Link>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {recent.map((j) => (
                    <li key={j.id}>
                      <Link href={`/i/${j.id}`}>
                        <div className="rounded-lg border border-border bg-card px-3.5 py-2.5 hover:border-primary/40 transition-colors flex items-center gap-3 cursor-pointer">
                          <StatusDot status={j.status} />
                          <span className="text-sm text-foreground truncate flex-1">{j.title}</span>
                          <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">
                            {j.steps} steps
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums inline-flex items-center gap-1">
                            <Coins className="h-3 w-3" />
                            {fmtTokens(j.tokens)}
                          </span>
                          <span className="text-xs font-medium text-foreground tabular-nums w-14 text-right">
                            {fmtCost(j.cost)}
                          </span>
                          <span className="text-xs text-muted-foreground w-14 text-right hidden sm:inline">
                            {timeAgo(j.updatedAt)}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ---------- New search ---------- */}
          {isNew && (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Add the listing's photos, its description, and the municipality. A model is given a real computer —
                a shell, files, and eyes — and writes its own code to query the cadastre, download aerials and read
                the building register, iterating until it reaches the exact door. It runs in the background: you can
                close this window and come back.
              </p>

              <div className="rounded-xl border border-border bg-card p-5 space-y-5">
                <Field label="Photos">
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
                    }}
                    className={`grid grid-cols-3 sm:grid-cols-4 gap-2 rounded-lg border border-dashed p-2 transition-colors ${
                      dragging ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    {pictures.map((p, i) => (
                      <div
                        key={p.url}
                        className="relative aspect-square rounded-md overflow-hidden border border-border bg-muted group"
                      >
                        <img src={p.url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removePicture(i)}
                          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-card/90 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Remove photo"
                        >
                          <X className="h-3 w-3 text-foreground" />
                        </button>
                      </div>
                    ))}
                    {pictures.length < MAX_IMAGES && (
                      <label className="aspect-square rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors cursor-pointer">
                        {pictures.length === 0 ? <ImageIcon className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                        <span className="text-xs">{pictures.length === 0 ? "Add photos" : "Add"}</span>
                        <input
                          type="file"
                          accept="image/*,.heic,.heif"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files?.length) addFiles(e.target.files);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </Field>

                <Field label="Municipality">
                  <input
                    value={municipality}
                    onChange={(e) => setMunicipality(e.target.value)}
                    placeholder="e.g. Plan-les-Ouates, Corsier, Lutry…"
                    className={`${inputClass} h-10`}
                  />
                </Field>

                <Field label="Description">
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={5}
                    placeholder="Paste the listing text — rooms, floor, year built, parcel size, and any proximity claims (école 220 m, autoroute 1.25 km…)."
                    className="text-sm bg-card border-input focus-visible:ring-ring resize-none"
                  />
                </Field>

                <Button onClick={() => void start()} disabled={submitting || pictures.length === 0} className="w-full h-10">
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Starting…
                    </>
                  ) : (
                    "Find address"
                  )}
                </Button>
              </div>

              {error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm text-destructive">{error}</p>
                </div>
              )}
            </>
          )}

          {/* ---------- Detail ---------- */}
          {isDetail && notFound && (
            <div className="rounded-xl border border-border bg-card px-6 py-12 flex flex-col items-center text-center gap-3">
              <AlertCircle className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-foreground">This investigation doesn't exist.</p>
              <Link href="/">
                <Button variant="outline" size="sm">
                  Back to overview
                </Button>
              </Link>
            </div>
          )}

          {isDetail && !notFound && !job && (
            <div className="rounded-xl border border-border bg-card p-8 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading investigation…
            </div>
          )}

          {isDetail && job && (
            <>
              <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
                <StatusDot status={job.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {running
                      ? "Investigating…"
                      : job.status === "error"
                        ? "Failed"
                        : job.status === "cancelled"
                          ? "Stopped"
                          : "Done"}
                    <span className="text-muted-foreground font-normal">
                      {" · "}
                      {job.steps.length} steps · {fmtTokens(job.tokens.total)} tokens ·{" "}
                      <span className="text-foreground font-medium">{fmtCost(job.cost)}</span>
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" /> started {timeAgo(job.createdAt)}
                    {job.tokens.total > 0 &&
                      ` · ${fmtTokens(job.tokens.input)} in${job.tokens.cached > 0 ? ` (${fmtTokens(job.tokens.cached)} cached)` : ""} / ${fmtTokens(job.tokens.output)} out`}
                    {running && " · runs in the background — safe to close this window"}
                  </p>
                </div>
                {running && (
                  <Button variant="outline" size="sm" onClick={() => void stop()}>
                    Stop
                  </Button>
                )}
              </div>

              {job.error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm text-destructive">{job.error}</p>
                </div>
              )}

              {answer && (answer.found || answer.reasoning) && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <div className="p-5 space-y-4">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${CONFIDENCE_META[answer.confidence].tone}`}
                    >
                      {CONFIDENCE_META[answer.confidence].label}
                    </span>

                    {primaryLine ? (
                      <div className="space-y-0.5">
                        <p className="text-lg font-semibold text-foreground leading-snug">{primaryLine}</p>
                        {(answer.parcel || answer.commune) && (
                          <p className="text-xs text-muted-foreground">
                            {[answer.commune, answer.parcel].filter(Boolean).join(" · ")}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No parcel identified with confidence.</p>
                    )}

                    {coords && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {coords.lat.toFixed(6)}, {coords.lon.toFixed(6)}
                      </p>
                    )}

                    {answer.reasoning && (
                      <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                        {answer.reasoning}
                      </p>
                    )}

                    {answer.candidates.length > 0 && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">Candidates considered</p>
                        <ul className="space-y-1">
                          {answer.candidates.map((c, i) => (
                            <li key={i} className="text-sm text-muted-foreground leading-relaxed">
                              · <span className="text-foreground">{c.address ?? c.parcel ?? "candidate"}</span> — {c.note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      {primaryLine && (
                        <Button size="sm" onClick={() => copyText(primaryLine)}>
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          Copy
                        </Button>
                      )}
                      {answer.links.map((href, i) => (
                        <a key={i} href={href} target="_blank" rel="noopener noreferrer">
                          <Button variant="outline" size="sm">
                            {new URL(href).hostname.replace(/^www\./, "")} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                          </Button>
                        </a>
                      ))}
                      {coords && (
                        <a
                          href={`https://www.google.com/maps/@${coords.lat},${coords.lon},19z/data=!3m1!1e3`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Button variant="outline" size="sm">
                            Google satellite <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>

                  {coords && (
                    <iframe
                      title="Location map"
                      src={mapEmbedUrl(coords.lat, coords.lon, wideMap)}
                      className="w-full h-72 border-t border-border"
                      loading="lazy"
                    />
                  )}
                </div>
              )}

              {coords &&
                (job.dossier ? (
                  <DossierView d={job.dossier} />
                ) : (
                  <div className="rounded-xl border border-dashed border-border bg-card p-5 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Property dossier</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Optional — pull the public cadastre, zone, build potential, energy and environment data for
                        this parcel.
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void enrich()} disabled={enriching}>
                      {enriching ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Building…
                        </>
                      ) : (
                        <>
                          <Building2 className="mr-1.5 h-3.5 w-3.5" />
                          Build dossier
                        </>
                      )}
                    </Button>
                  </div>
                ))}

              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs font-medium text-muted-foreground mb-3">
                  Investigation trace — every step and the reasoning behind it
                </p>
                <ol className="space-y-3">
                  {job.steps.map((s) => (
                    <StepRow key={s.n} step={s} />
                  ))}
                  {running && job.steps.length === 0 && (
                    <li className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> thinking…
                    </li>
                  )}
                </ol>
                <div ref={traceEndRef} />
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-border py-4">
        <div className="container text-xs text-muted-foreground">
          No hard-coded geolocation logic — the model writes its own code against public Swiss geodata (SITG,
          swisstopo, GWR, OpenStreetMap).
        </div>
      </footer>
    </div>
  );
}
