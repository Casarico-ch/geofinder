import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Copy,
  ExternalLink,
  ImageIcon,
  Loader2,
  MapPin,
  MapPinned,
  Plus,
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

interface LocationEstimate {
  location_found: boolean;
  confidence: Confidence;
  address: string | null;
  place: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  clues: string[];
  text_read: string[];
  reasoning: string;
}

interface LandVerification {
  status: "pinned" | "corroborated" | "inconclusive" | "unavailable" | "skipped";
  matched_address: string | null;
  matches: { evidence: string; source: string }[];
  mismatches: string[];
  notes: string | null;
  aerialUsed: boolean;
  sources: string[];
}

interface AnalyzeResponse {
  estimate: LocationEstimate;
  landVerification: LandVerification;
}

type Stage =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "resolved"; data: AnalyzeResponse }
  | { kind: "error"; message: string };

interface Picture {
  file: File;
  url: string;
}

// How tight the result is. Color carries the meaning: blue = doorstep-tight,
// amber = coarse, gray = area-level, red = inconclusive.
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

const LAND_META: Partial<Record<LandVerification["status"], string>> = {
  pinned: "Parcel pinned",
  corroborated: "Map-corroborated",
};

const MAX_IMAGES = 15;

// Re-encode to a downscaled JPEG before upload: keeps the request small and
// normalizes formats (incl. HEIC from iPhones on Safari).
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

// Fold the municipality and free-text description into the single listing-text field.
function buildListingText(municipality: string, description: string): string | undefined {
  const parts: string[] = [];
  if (municipality.trim()) parts.push(`Municipality / commune: ${municipality.trim()}`);
  if (description.trim()) parts.push(description.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export default function AddressFinder() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [municipality, setMunicipality] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return () => pictures.forEach((p) => URL.revokeObjectURL(p.url));
  }, [pictures]);

  const addFiles = useCallback((list: FileList | File[]) => {
    const chosen = Array.from(list).filter(
      (f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name),
    );
    if (chosen.length === 0) {
      toast.error("Please choose image files");
      return;
    }
    setStage({ kind: "idle" });
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

  const analyze = useCallback(async () => {
    if (pictures.length === 0) return;
    setStage({ kind: "analyzing" });
    try {
      const images = await Promise.all(
        pictures.map(async (p) => ({
          imageBase64: await fileToJpegBase64(p.file),
          mediaType: "image/jpeg" as const,
        })),
      );
      const res = await fetch("/api/geo/analyze-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, listingText: buildListingText(municipality, description) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Analysis failed");
      setStage({ kind: "resolved", data: body as AnalyzeResponse });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "Analysis failed" });
    }
  }, [pictures, municipality, description]);

  const reset = useCallback(() => {
    setPictures((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
    setMunicipality("");
    setDescription("");
    setStage({ kind: "idle" });
  }, []);

  const copyText = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy to clipboard"));
  }, []);

  const analyzing = stage.kind === "analyzing";
  const est = stage.kind === "resolved" ? stage.data.estimate : null;
  const land = stage.kind === "resolved" ? stage.data.landVerification : null;
  const coords =
    est && est.latitude !== null && est.longitude !== null
      ? { lat: est.latitude, lon: est.longitude }
      : null;
  const primaryLine = land?.matched_address ?? est?.address ?? est?.place ?? "";
  const wideMap = est ? !["street", "building", "block"].includes(est.confidence) : true;

  const inputClass =
    "w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border">
        <div className="container py-4 flex items-center gap-2.5">
          <MapPin className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-base font-semibold text-foreground">GeoFinder</h1>
            <p className="text-xs text-muted-foreground">Find a property's address from its listing</p>
          </div>
        </div>
      </header>

      <main className="flex-1 container py-10">
        <div className="max-w-xl mx-auto space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Add the listing's photos, its description, and the municipality. The address is deduced from what's
            in the photos and text, then the property's land is matched against aerial and map data to pin the
            parcel.
          </p>

          <div className="rounded-xl border border-border bg-card p-5 space-y-5">
            {/* Photos */}
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
                    {!analyzing && (
                      <button
                        type="button"
                        onClick={() => removePicture(i)}
                        className="absolute top-1 right-1 h-5 w-5 rounded-full bg-card/90 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Remove photo"
                      >
                        <X className="h-3 w-3 text-foreground" />
                      </button>
                    )}
                  </div>
                ))}
                {pictures.length < MAX_IMAGES && (
                  <label
                    className={`aspect-square rounded-md border border-dashed border-border flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors ${
                      analyzing ? "pointer-events-none opacity-50" : "cursor-pointer"
                    }`}
                  >
                    {pictures.length === 0 ? <ImageIcon className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                    <span className="text-xs">{pictures.length === 0 ? "Add photos" : "Add"}</span>
                    <input
                      type="file"
                      accept="image/*,.heic,.heif"
                      multiple
                      className="hidden"
                      disabled={analyzing}
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
                disabled={analyzing}
                placeholder="e.g. Corsier, Fribourg, Lutry…"
                className={`${inputClass} h-10`}
              />
            </Field>

            <Field label="Description">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={analyzing}
                rows={5}
                placeholder="Paste the listing text — rooms, floor, year built, parcel size, and any proximity claims (lakefront, station 100 m…)."
                className="text-sm bg-card border-input focus-visible:ring-ring resize-none"
              />
            </Field>

            <div className="flex gap-2">
              <Button
                onClick={() => void analyze()}
                disabled={analyzing || pictures.length === 0}
                className="flex-1 h-10"
              >
                {analyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analyzing…
                  </>
                ) : stage.kind === "resolved" ? (
                  "Re-analyze"
                ) : (
                  "Find address"
                )}
              </Button>
              {(pictures.length > 0 || municipality || description) && !analyzing && (
                <Button variant="outline" className="h-10" onClick={reset}>
                  Reset
                </Button>
              )}
            </div>
            {analyzing && (
              <p className="text-xs text-muted-foreground text-center">
                Deducing the area, then matching the parcel against aerial and map data — this can take a minute
                or two.
              </p>
            )}
          </div>

          {stage.kind === "error" && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
              <p className="text-sm text-destructive">{stage.message}</p>
              {pictures.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => void analyze()}>
                  Retry
                </Button>
              )}
            </div>
          )}

          {est && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="p-5 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      CONFIDENCE_META[est.confidence].tone
                    }`}
                  >
                    {CONFIDENCE_META[est.confidence].label}
                  </span>
                  {land && LAND_META[land.status] && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-primary bg-primary/10">
                      <MapPinned className="h-3 w-3" />
                      {LAND_META[land.status]}
                    </span>
                  )}
                </div>

                {est.location_found ? (
                  <div className="space-y-0.5">
                    <p className="text-lg font-semibold text-foreground leading-snug">{primaryLine}</p>
                    {land?.matched_address && est.address && land.matched_address !== est.address && (
                      <p className="text-xs text-muted-foreground">Model read: {est.address}</p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Not enough to place this confidently. {est.place}</p>
                )}

                {coords && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {coords.lat.toFixed(6)}, {coords.lon.toFixed(6)}
                  </p>
                )}

                <p className="text-sm text-muted-foreground leading-relaxed">{est.reasoning}</p>

                {est.clues.length > 0 && (
                  <Section title="Clues used">
                    <ul className="space-y-1">
                      {est.clues.map((c, i) => (
                        <li key={i} className="text-sm text-muted-foreground leading-relaxed">
                          · {c}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {est.text_read.length > 0 && (
                  <Section title="Text read">
                    <div className="flex flex-wrap gap-1.5">
                      {est.text_read.map((t, i) => (
                        <span
                          key={i}
                          className="text-xs text-foreground border border-border rounded-md px-1.5 py-0.5"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </Section>
                )}

                {land && (land.matches.length > 0 || land.mismatches.length > 0) && (
                  <Section title={`Map the land${land.sources.length ? ` · ${land.sources.join(", ")}` : ""}`}>
                    <ul className="space-y-1">
                      {land.matches.map((m, i) => (
                        <li key={i} className="text-sm text-muted-foreground leading-relaxed">
                          · {m.evidence} <span className="text-muted-foreground/60">({m.source})</span>
                        </li>
                      ))}
                      {land.mismatches.map((m, i) => (
                        <li key={`x-${i}`} className="text-sm text-destructive/80 leading-relaxed">
                          · {m}
                        </li>
                      ))}
                    </ul>
                    {land.notes && <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{land.notes}</p>}
                  </Section>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  {primaryLine && (
                    <Button size="sm" onClick={() => copyText(primaryLine)}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy address
                    </Button>
                  )}
                  {coords && (
                    <>
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lon}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button variant="outline" size="sm">
                          Google Maps <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                        </Button>
                      </a>
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lon}#map=18/${coords.lat}/${coords.lon}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button variant="outline" size="sm">
                          OpenStreetMap <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                        </Button>
                      </a>
                    </>
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
        </div>
      </main>

      <footer className="border-t border-border py-4">
        <div className="container text-xs text-muted-foreground">
          Deduced from your photos and text · parcel matched against aerial, building register & OpenStreetMap
        </div>
      </footer>
    </div>
  );
}
