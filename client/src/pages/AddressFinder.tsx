import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  ArrowDown,
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
  Pause,
  Play,
  Plus,
  RefreshCw,
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

type JobStatus = "running" | "done" | "error" | "cancelled" | "paused";

interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  total: number;
}

type ModelId = "claude-opus-4-8" | "claude-fable-5";
const MODEL_LABEL: Record<ModelId, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-fable-5": "Fable 5",
};

type PotentialStatus = "running" | "done" | "error";

interface BuildPotential {
  generatedAt: string;
  headline: string;
  canton: string | null;
  commune: string | null;
  zone: string | null;
  parcelArea_m2: number | null;
  metric: string | null;
  unit: string | null;
  existing: number | null;
  allowed: number | null;
  additional: number | null;
  discretionary: string | null;
  confidence: "exact" | "estimated" | "indicative";
  caveats: string[];
  sources: string[];
  reasoning: string;
}

interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  model?: ModelId;
  input: { municipality?: string; listingText?: string; imageCount: number };
  stepCount: number; // total steps; the trace itself is fetched in pages
  answer: Answer | null;
  error?: string;
  tokens: TokenUsage;
  cost: number;
  potential?: BuildPotential | null;
  potentialStatus?: PotentialStatus;
  promptVersion?: string | null;
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
  model?: ModelId;
  promptVersion?: string | null;
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

// True when the window is scrolled to (near) the bottom — used to decide
// whether newly-arrived trace steps are already in view.
function isNearBottom(threshold = 200): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - threshold;
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
  if (status === "paused") return <Pause className="h-3.5 w-3.5 text-amber-600 shrink-0" />;
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

const CONF_LABEL: Record<BuildPotential["confidence"], string> = {
  exact: "Exact — from the binding rule",
  estimated: "Estimated",
  indicative: "Indicative",
};

function PotentialView({ p }: { p: BuildPotential }) {
  const unit = p.unit ?? "";
  const fmt = (n: number | null) => (n != null ? `${n.toLocaleString()}${unit ? ` ${unit}` : ""}` : null);
  const confTone =
    p.confidence === "exact"
      ? "text-primary bg-primary/10"
      : p.confidence === "estimated"
        ? "text-amber-700 bg-amber-500/10"
        : "text-muted-foreground bg-muted";
  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-primary" />
        <p className="text-sm font-semibold text-foreground">Construction potential</p>
        <span className={`text-[11px] rounded-full px-2 py-0.5 ${confTone}`}>{CONF_LABEL[p.confidence]}</span>
      </div>

      <p className="text-base font-semibold text-foreground leading-snug">{p.headline}</p>

      <div className="space-y-0.5">
        <DRow k="Commune / canton" v={[p.commune, p.canton].filter(Boolean).join(" · ") || null} />
        <DRow k="Zone" v={p.zone} />
        <DRow k="Land area" v={p.parcelArea_m2 != null ? `${p.parcelArea_m2.toLocaleString()} m²` : null} />
        <DRow k="Governing rule" v={p.metric} />
        <DRow k="Already built" v={fmt(p.existing)} />
        <DRow k="Allowed by right" v={fmt(p.allowed)} />
        <DRow
          k="Additional by right"
          v={p.additional != null ? <span className="text-primary font-semibold">{`+${p.additional.toLocaleString()}${unit ? ` ${unit}` : ""}`}</span> : null}
        />
      </div>

      {p.discretionary && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="text-[11px] font-medium text-amber-700 mb-0.5">Possible only via a discretionary decision</p>
          <p className="text-xs text-foreground/90 leading-relaxed">{p.discretionary}</p>
        </div>
      )}

      {p.caveats.length > 0 && (
        <div className="space-y-1">
          {p.caveats.map((c, i) => (
            <p key={i} className="text-[11px] text-muted-foreground leading-relaxed">
              • {c}
            </p>
          ))}
        </div>
      )}

      {p.sources.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {p.sources.map((u, i) => (
            <a key={i} href={u} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                Source {i + 1} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </a>
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
  const [model, setModel] = useState<ModelId>("claude-opus-4-8");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [steps, setSteps] = useState<Step[]>([]); // loaded pages of the trace
  const [notFound, setNotFound] = useState(false);
  const [recent, setRecent] = useState<JobSummary[]>([]);
  const traceEndRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadedRef = useRef(0); // how many steps we've fetched
  const loadingRef = useRef(false);
  const [pollNonce, setPollNonce] = useState(0); // bump to (re)start the meta poll

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

  // Fetch the next page of trace steps and append it. Guarded so overlapping
  // triggers (scroll + poll) can't double-fetch the same page.
  const loadMoreSteps = useCallback(async () => {
    if (!jobId || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const offset = loadedRef.current;
      const res = await fetch(`/api/geo/investigate/${jobId}/steps?offset=${offset}&limit=30`);
      if (!res.ok) return;
      const body = (await res.json()) as { steps: Step[] };
      const incoming = body.steps ?? [];
      if (incoming.length) {
        loadedRef.current = offset + incoming.length;
        setSteps((prev) => [...prev, ...incoming]);
      }
    } catch {
      /* transient */
    } finally {
      loadingRef.current = false;
    }
  }, [jobId]);

  // Switching investigations: reset the trace and load only the FIRST page.
  useEffect(() => {
    setJob(null);
    setNotFound(false);
    setSteps([]);
    loadedRef.current = 0;
    if (jobId) void loadMoreSteps();
  }, [jobId, loadMoreSteps]);

  // Poll the investigation META (small — no trace) while anything is running:
  // the investigation itself, or a construction-potential analysis (which also
  // appends steps to this job). pollNonce restarts it when the user triggers one.
  useEffect(() => {
    if (!jobId) return;
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
        if (!alive) return true;
        setJob(data);
        const active = data.status === "running" || data.potentialStatus === "running";
        // If the user is already at the bottom, keep the tail loaded as new steps
        // arrive (this appends below — it never scrolls the page).
        if (active && loadedRef.current < data.stepCount && isNearBottom()) {
          void loadMoreSteps();
        }
        if (!active) return true;
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
  }, [jobId, loadMoreSteps, pollNonce]);

  // Progressive load: when the sentinel near the end of the list scrolls into
  // view, fetch the next page. This is what keeps the page fast — it fills in on
  // scroll instead of loading the whole trace up front.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && job && loadedRef.current < job.stepCount) {
          void loadMoreSteps();
        }
      },
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [job, loadMoreSteps]);

  // "New steps" pill: only for a RUNNING job whose latest steps aren't on screen
  // yet while the user is scrolled up. Finished traces just fill in on scroll.
  const analysisRunning = !!job && (job.status === "running" || job.potentialStatus === "running");
  const pendingSteps = analysisRunning ? Math.max(0, job!.stepCount - steps.length) : 0;
  const [showPill, setShowPill] = useState(false);
  useEffect(() => {
    const update = () => setShowPill(pendingSteps > 0 && !isNearBottom());
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [pendingSteps]);

  const jumpToLatest = useCallback(async () => {
    // Pull whatever remains, then jump to the newest step.
    for (let i = 0; i < 40 && job && loadedRef.current < job.stepCount; i++) {
      const before = loadedRef.current;
      await loadMoreSteps();
      if (loadedRef.current === before) break;
    }
    traceEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [job, loadMoreSteps]);

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
          model,
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
  }, [pictures, municipality, description, model, clearForm, navigate]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy"));
  }, []);

  // Pause the running investigation at the next turn boundary (keeps its saved
  // conversation; no tokens are spent while paused).
  const pause = useCallback(async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/geo/investigate/${jobId}/pause`, { method: "POST" });
      toast.success("Pausing…");
    } catch {
      toast.error("Could not pause");
    }
  }, [jobId]);

  // Relaunch a past investigation: one click starts a FRESH run from the same
  // photos + municipality + listing text + model — no findings carried over.
  const relaunch = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/geo/investigate/${id}/relaunch`, { method: "POST" });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? "Could not relaunch");
        navigate(`/i/${body.jobId as string}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not relaunch");
      }
    },
    [navigate],
  );

  // Resume a paused investigation from where it left off.
  const resume = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/geo/investigate/${jobId}/resume`, { method: "POST" });
      if (!res.ok) throw new Error();
      setJob((j) => (j ? { ...j, status: "running" } : j));
      setPollNonce((n) => n + 1); // restart polling now that it's running again
    } catch {
      toast.error("Could not resume");
    }
  }, [jobId]);

  // Kick off the focused construction-potential analysis. It runs in the
  // background (like the investigation) and streams its steps into the same
  // trace; polling picks up job.potential / job.potentialStatus.
  const analysePotential = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/geo/investigate/${jobId}/potential`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not start the analysis");
      }
      setJob((j) => (j ? { ...j, potentialStatus: "running" } : j));
      setPollNonce((n) => n + 1); // resume polling so the analysis streams in

    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the analysis");
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
                      <div className="rounded-lg border border-border bg-card px-3.5 py-2.5 hover:border-primary/40 transition-colors flex items-center gap-3">
                        <Link href={`/i/${j.id}`} className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
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
                        </Link>
                        <button
                          type="button"
                          onClick={() => void relaunch(j.id)}
                          title="Run again — a fresh investigation from the same photos & instructions"
                          className="shrink-0 h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                          aria-label="Run again"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ---------- New search ---------- */}
          {isNew && (
            <>
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

                <Field label="Model">
                  <div className="flex gap-2">
                    {(["claude-opus-4-8", "claude-fable-5"] as ModelId[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModel(m)}
                        className={`flex-1 h-9 rounded-md border text-sm font-medium transition-colors ${
                          model === m
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-input bg-card text-muted-foreground hover:border-primary/40"
                        }`}
                      >
                        {MODEL_LABEL[m]}
                        {m === "claude-opus-4-8" ? " · default" : " · 2× cost"}
                      </button>
                    ))}
                  </div>
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
              <div className="sticky top-[68px] z-10 rounded-xl border border-border bg-card/95 backdrop-blur p-4 flex items-center gap-3 shadow-sm">
                <StatusDot status={job.status} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {running
                      ? "Investigating…"
                      : job.status === "paused"
                        ? "Paused"
                        : job.status === "error"
                          ? "Failed"
                          : job.status === "cancelled"
                            ? "Stopped"
                            : "Done"}
                    <span className="text-muted-foreground font-normal">
                      {" · "}
                      {job.model ? `${MODEL_LABEL[job.model]} · ` : ""}
                      {job.stepCount} steps · {fmtTokens(job.tokens.total)} tokens ·{" "}
                      <span className="text-foreground font-medium">{fmtCost(job.cost)}</span>
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                    <Clock className="h-3 w-3 shrink-0" /> started {timeAgo(job.createdAt)}
                    {job.tokens.total > 0 &&
                      ` · ${fmtTokens(job.tokens.input)} in${job.tokens.cached > 0 ? ` (${fmtTokens(job.tokens.cached)} cached)` : ""} / ${fmtTokens(job.tokens.output)} out`}
                    {job.promptVersion && (
                      <>
                        {" · "}
                        <a
                          href={`/runs/${job.id}/prompt.txt`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono hover:text-foreground hover:underline"
                          title="View the exact prompt this run used"
                        >
                          prompt {job.promptVersion}
                        </a>
                      </>
                    )}
                  </p>
                </div>

                {/* Contextual CTA: pause while running, resume while paused, and
                    the construction-potential check once it's done. */}
                {running && (
                  <Button variant="outline" size="sm" onClick={() => void pause()} className="shrink-0">
                    <Pause className="mr-1.5 h-3.5 w-3.5" /> Pause
                  </Button>
                )}
                {job.status === "paused" && (
                  <Button size="sm" onClick={() => void resume()} className="shrink-0">
                    <Play className="mr-1.5 h-3.5 w-3.5" /> Resume
                  </Button>
                )}
                {job.status === "done" && coords && !job.potential && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void analysePotential()}
                    disabled={job.potentialStatus === "running"}
                    className="shrink-0"
                  >
                    {job.potentialStatus === "running" ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Analysing…
                      </>
                    ) : (
                      <>
                        <Building2 className="mr-1.5 h-3.5 w-3.5" /> Potential check
                      </>
                    )}
                  </Button>
                )}
                {!running && jobId && (
                  <Button variant="ghost" size="sm" onClick={() => void relaunch(jobId)} className="shrink-0">
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Run again
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
                (job.potential ? (
                  <PotentialView p={job.potential} />
                ) : (
                  <div className="rounded-xl border border-dashed border-border bg-card p-5 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Construction potential</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Optional — read the zone rule for this parcel and work out how much more can be built. Exact
                        where the regulation gives a number, flagged where it's discretionary.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void analysePotential()}
                      disabled={job.potentialStatus === "running"}
                    >
                      {job.potentialStatus === "running" ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Analysing…
                        </>
                      ) : (
                        <>
                          <Building2 className="mr-1.5 h-3.5 w-3.5" />
                          {job.potentialStatus === "error" ? "Retry analysis" : "Analyse potential"}
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
                  {steps.map((s) => (
                    <StepRow key={s.n} step={s} />
                  ))}
                  {steps.length === 0 && (
                    <li className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {running ? "thinking…" : "loading trace…"}
                    </li>
                  )}
                </ol>
                {/* Sentinel: scrolling this into view loads the next page. */}
                {steps.length < job.stepCount && (
                  <div ref={sentinelRef} className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> loading more steps…
                  </div>
                )}
                <div ref={traceEndRef} />
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="border-t border-border py-4">
        <div className="container text-xs text-muted-foreground">
          No hard-coded geolocation logic — the model writes its own code against public Swiss geodata (cantonal
          cadastres SITG / geodienste, swisstopo, GWR, OpenStreetMap).
        </div>
      </footer>

      {/* Non-intrusive cue that new trace steps arrived; click to jump down. */}
      {isDetail && showPill && pendingSteps > 0 && (
        <button
          onClick={() => void jumpToLatest()}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg ring-1 ring-black/5 hover:opacity-90 transition-opacity"
        >
          <ArrowDown className="h-4 w-4" />
          {pendingSteps} new step{pendingSteps > 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}
