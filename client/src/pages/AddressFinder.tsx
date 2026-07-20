import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Brain,
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
  total: number;
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
const JOB_KEY = "geofinder.jobId";

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

const STEP_ICON: Record<StepKind, typeof Terminal> = {
  reasoning: Brain,
  bash: Terminal,
  write: FileText,
  read: Eye,
  answer: CheckCircle2,
  note: FileText,
  error: AlertCircle,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
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
          <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {step.reasoning}
          </p>
        )}
        {step.detail && (
          <pre className="text-[11px] text-muted-foreground bg-muted/60 rounded-md p-2 overflow-x-auto whitespace-pre-wrap max-h-56">
            {step.detail}
          </pre>
        )}
        {step.image && (
          <img
            src={step.image}
            alt={step.title}
            className="mt-1 rounded-md border border-border max-h-72"
            loading="lazy"
          />
        )}
      </div>
    </li>
  );
}

export default function AddressFinder() {
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [municipality, setMunicipality] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(() => localStorage.getItem(JOB_KEY));
  const [job, setJob] = useState<Job | null>(null);
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

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // Poll the active job until it reaches a terminal state.
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/geo/investigate/${jobId}`);
        if (!res.ok) {
          if (res.status === 404 && alive) {
            setJob(null);
          }
          return;
        }
        const data = (await res.json()) as Job;
        if (alive) setJob(data);
        if (data.status !== "running") {
          void loadRecent();
          return true;
        }
      } catch {
        /* transient */
      }
      return false;
    };
    void tick();
    const timer = setInterval(async () => {
      const done = await tick();
      if (done) clearInterval(timer);
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId, loadRecent]);

  // Keep the trace scrolled to the newest step while running.
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

  const start = useCallback(async () => {
    if (pictures.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const images = await Promise.all(
        pictures.map(async (p) => ({
          imageBase64: await fileToJpegBase64(p.file),
          mediaType: "image/jpeg" as const,
        })),
      );
      const res = await fetch("/api/geo/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, listingText: description || undefined, municipality: municipality || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Could not start the investigation");
      const id = body.jobId as string;
      localStorage.setItem(JOB_KEY, id);
      setJob(null);
      setJobId(id);
      void loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the investigation");
    } finally {
      setSubmitting(false);
    }
  }, [pictures, municipality, description, loadRecent]);

  const openJob = useCallback((id: string) => {
    localStorage.setItem(JOB_KEY, id);
    setJob(null);
    setJobId(id);
  }, []);

  const newSearch = useCallback(() => {
    localStorage.removeItem(JOB_KEY);
    setJobId(null);
    setJob(null);
    setError(null);
  }, []);

  const copyText = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy"));
  }, []);

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
      <header className="border-b border-border">
        <div className="container py-4 flex items-center gap-2.5">
          <MapPin className="h-5 w-5 text-primary" />
          <div className="flex-1">
            <h1 className="text-base font-semibold text-foreground">GeoFinder</h1>
            <p className="text-xs text-muted-foreground">
              An autonomous investigator finds a property's exact address from its listing
            </p>
          </div>
          {jobId && (
            <Button variant="outline" size="sm" onClick={newSearch}>
              New search
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1 container py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {!jobId && (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Add the listing's photos, its description, and the municipality. A model is given a real
                computer — a shell, files, and eyes — and it writes its own code to query the cadastre,
                download aerials and read the building register, iterating until it reaches the exact door.
                It runs in the background: you can close this window and come back.
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

              {recent.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    All investigations ({recent.length})
                  </p>
                  <ul className="space-y-1">
                    {recent.map((j) => (
                      <li key={j.id}>
                        <button
                          onClick={() => openJob(j.id)}
                          className="w-full text-left rounded-lg border border-border bg-card px-3 py-2 hover:border-primary/40 transition-colors flex items-center gap-2.5"
                        >
                          {j.status === "running" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
                          ) : j.status === "error" ? (
                            <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
                          )}
                          <span className="text-sm text-foreground truncate flex-1">{j.title}</span>
                          <span className="text-xs text-muted-foreground shrink-0 tabular-nums flex items-center gap-1">
                            <Coins className="h-3 w-3" />
                            {fmtTokens(j.tokens)}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0 w-14 text-right">
                            {timeAgo(j.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {jobId && job && (
            <>
              {/* Status */}
              <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-3">
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : job.status === "error" ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {running ? "Investigating…" : job.status === "error" ? "Failed" : "Done"}
                    <span className="text-muted-foreground font-normal"> · {job.steps.length} steps</span>
                    <span className="text-muted-foreground font-normal inline-flex items-center gap-1">
                      {" · "}
                      <Coins className="h-3 w-3" />
                      {fmtTokens(job.tokens.total)} tokens
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" /> started {timeAgo(job.createdAt)}
                    {job.tokens.total > 0 &&
                      ` · ${fmtTokens(job.tokens.input)} in${job.tokens.cached > 0 ? ` (${fmtTokens(job.tokens.cached)} cached)` : ""} / ${fmtTokens(job.tokens.output)} out`}
                    {running && " · runs in the background — safe to close this window"}
                  </p>
                </div>
              </div>

              {job.error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <p className="text-sm text-destructive">{job.error}</p>
                </div>
              )}

              {/* Answer */}
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

              {/* Documented trace */}
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

          {jobId && !job && (
            <div className="rounded-xl border border-border bg-card p-8 flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading investigation…
            </div>
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
