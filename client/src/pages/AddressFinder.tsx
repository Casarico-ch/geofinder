import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Copy,
  ExternalLink,
  Eye,
  ImageIcon,
  Loader2,
  MapPin,
  MapPinned,
  Plus,
  RefreshCw,
  ScanSearch,
  Sparkles,
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

// How tight the result is — drives the badge. Only "street"/"building" is doorstep-accurate.
const CONFIDENCE_META: Record<Confidence, { label: string; tone: string }> = {
  street: { label: "STREET-LEVEL", tone: "text-primary border-primary/40 bg-primary/10" },
  building: { label: "BUILDING-LEVEL", tone: "text-primary border-primary/40 bg-primary/10" },
  block: { label: "BLOCK-LEVEL", tone: "text-primary border-primary/30 bg-primary/5" },
  neighborhood: { label: "NEIGHBORHOOD", tone: "text-chart-3 border-chart-3/40 bg-chart-3/10" },
  city: { label: "CITY-LEVEL", tone: "text-chart-3 border-chart-3/40 bg-chart-3/10" },
  region: { label: "REGION-LEVEL", tone: "text-muted-foreground border-border bg-background/40" },
  country: { label: "COUNTRY-LEVEL", tone: "text-muted-foreground border-border bg-background/40" },
  unknown: { label: "INCONCLUSIVE", tone: "text-destructive border-destructive/40 bg-destructive/10" },
};

// Badge for the map-the-land stage — only when it actually grounded the estimate.
const LAND_META: Partial<Record<LandVerification["status"], string>> = {
  pinned: "PARCEL PINNED",
  corroborated: "MAP-CORROBORATED",
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

  return (
    <div className="min-h-screen flex flex-col scanlines">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container py-4 flex items-center gap-3">
          <MapPin className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-bold tracking-wider text-primary glow-green">GEOFINDER</h1>
            <p className="text-xs text-muted-foreground">Find a property's address from its listing</p>
          </div>
        </div>
      </header>

      <main className="flex-1 container py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Add the listing's <strong className="text-primary">photos</strong>, its{" "}
            <strong className="text-primary">description</strong>, and the{" "}
            <strong className="text-primary">municipality</strong>. The address is deduced from what's in the
            photos and text — signage, architecture, orientation, the view — then the property's land is matched
            against aerial and map data to pin the parcel. The listing itself is never looked up.
          </p>

          <Card className="bg-card/40 border-border">
            <CardContent className="p-4 space-y-4">
              {/* Photos */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold tracking-wider text-muted-foreground">
                  PHOTOS {pictures.length > 0 && `· ${pictures.length}/${MAX_IMAGES}`}
                </label>
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
                  className={`grid grid-cols-3 sm:grid-cols-4 gap-2 rounded border border-dashed p-2 transition-colors ${
                    dragging ? "border-primary bg-primary/5" : "border-border bg-background/20"
                  }`}
                >
                  {pictures.map((p, i) => (
                    <div
                      key={p.url}
                      className="relative aspect-square rounded overflow-hidden border border-border bg-background/40 group"
                    >
                      <img src={p.url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                      {!analyzing && (
                        <button
                          type="button"
                          onClick={() => removePicture(i)}
                          className="absolute top-1 right-1 h-5 w-5 rounded-full bg-background/80 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Remove photo"
                        >
                          <X className="h-3 w-3 text-foreground" />
                        </button>
                      )}
                    </div>
                  ))}
                  {pictures.length < MAX_IMAGES && (
                    <label
                      className={`aspect-square rounded border border-dashed border-border flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-primary/50 hover:bg-card/50 transition-colors ${
                        analyzing ? "pointer-events-none opacity-50" : ""
                      }`}
                    >
                      {pictures.length === 0 ? (
                        <ImageIcon className="h-5 w-5 text-primary" />
                      ) : (
                        <Plus className="h-5 w-5 text-muted-foreground" />
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {pictures.length === 0 ? "Add photos" : "Add"}
                      </span>
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
              </div>

              {/* Municipality */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold tracking-wider text-muted-foreground">MUNICIPALITY</label>
                <input
                  value={municipality}
                  onChange={(e) => setMunicipality(e.target.value)}
                  disabled={analyzing}
                  placeholder="e.g. Corsier (GE), Fribourg, Lutry…"
                  className="w-full h-9 rounded border border-border bg-background/50 px-3 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold tracking-wider text-muted-foreground">DESCRIPTION</label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={analyzing}
                  rows={4}
                  placeholder="Paste the listing text — rooms, floor, year built, parcel size, proximity claims ('lakefront', 'station 100 m'), anything it says."
                  className="text-xs bg-background/50 border-border focus-visible:ring-primary resize-none"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={() => void analyze()}
                  disabled={analyzing || pictures.length === 0}
                  className="flex-1 h-11 bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-xs tracking-widest disabled:opacity-40"
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      MAPPING THE LAND…
                    </>
                  ) : (
                    <>
                      <ScanSearch className="mr-2 h-4 w-4" />
                      {stage.kind === "resolved" ? "RE-ANALYZE" : "FIND ADDRESS"}
                    </>
                  )}
                </Button>
                {(pictures.length > 0 || municipality || description) && !analyzing && (
                  <Button variant="outline" className="h-11 text-xs shrink-0" onClick={reset}>
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                    Reset
                  </Button>
                )}
              </div>
              {analyzing && (
                <p className="text-[11px] text-muted-foreground text-center">
                  Deducing the area, then matching the parcel against aerial and map data — this can take a minute or
                  two.
                </p>
              )}
            </CardContent>
          </Card>

          {stage.kind === "error" && (
            <Card className="bg-card/40 border-destructive/40">
              <CardContent className="p-5 space-y-3">
                <p className="text-sm text-destructive">{stage.message}</p>
                {pictures.length > 0 && (
                  <Button variant="outline" size="sm" className="text-xs" onClick={() => void analyze()}>
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                    Retry
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {est && (
            <Card className="bg-card/40 border-border glow-border-green overflow-hidden">
              <CardContent className="p-0">
                <div className="p-5 space-y-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[10px] font-bold tracking-wider ${
                        CONFIDENCE_META[est.confidence].tone
                      }`}
                    >
                      <Sparkles className="h-3 w-3" />
                      {CONFIDENCE_META[est.confidence].label}
                    </span>
                    {land && LAND_META[land.status] && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-border bg-background/40 text-[10px] font-bold tracking-wider text-muted-foreground">
                        <MapPinned className="h-3 w-3" />
                        {LAND_META[land.status]}
                      </span>
                    )}
                  </div>

                  {est.location_found ? (
                    <div className="space-y-1">
                      <p className="text-xl font-bold text-primary leading-snug">{primaryLine}</p>
                      {land?.matched_address && est.address && land.matched_address !== est.address && (
                        <p className="text-[11px] text-muted-foreground">Model read: {est.address}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Not enough to place this confidently. {est.place}
                    </p>
                  )}

                  {coords && (
                    <p className="text-[11px] text-muted-foreground font-mono">
                      {coords.lat.toFixed(6)}, {coords.lon.toFixed(6)}
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground leading-relaxed">{est.reasoning}</p>

                  {est.clues.length > 0 && (
                    <div className="border border-border/60 bg-background/30 rounded p-3">
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                        <Eye className="h-3 w-3" /> CLUES USED
                      </p>
                      <ul className="space-y-1">
                        {est.clues.map((c, i) => (
                          <li key={i} className="text-[11px] text-muted-foreground leading-relaxed">
                            · {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {est.text_read.length > 0 && (
                    <div className="border border-border/60 bg-background/30 rounded p-3">
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-2">TEXT READ</p>
                      <div className="flex flex-wrap gap-1.5">
                        {est.text_read.map((t, i) => (
                          <span
                            key={i}
                            className="text-[11px] font-mono text-foreground border border-border/60 rounded px-1.5 py-0.5"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {land && (land.matches.length > 0 || land.mismatches.length > 0) && (
                    <div className="border border-border/60 bg-background/30 rounded p-3">
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                        <MapPinned className="h-3 w-3" /> MAP THE LAND
                        {land.sources.length > 0 && (
                          <span className="font-normal normal-case tracking-normal">· {land.sources.join(", ")}</span>
                        )}
                      </p>
                      <ul className="space-y-1">
                        {land.matches.map((m, i) => (
                          <li key={i} className="text-[11px] text-muted-foreground leading-relaxed">
                            · {m.evidence} <span className="text-muted-foreground/60">({m.source})</span>
                          </li>
                        ))}
                        {land.mismatches.map((m, i) => (
                          <li key={`x-${i}`} className="text-[11px] text-destructive/80 leading-relaxed">
                            · {m}
                          </li>
                        ))}
                      </ul>
                      {land.notes && (
                        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{land.notes}</p>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    {primaryLine && (
                      <Button size="sm" className="text-xs h-8" onClick={() => copyText(primaryLine)}>
                        <Copy className="mr-1.5 h-3 w-3" />
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
                          <Button variant="outline" size="sm" className="text-xs h-8">
                            Google Maps <ExternalLink className="ml-1.5 h-3 w-3" />
                          </Button>
                        </a>
                        <a
                          href={`https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lon}#map=18/${coords.lat}/${coords.lon}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Button variant="outline" size="sm" className="text-xs h-8">
                            OpenStreetMap <ExternalLink className="ml-1.5 h-3 w-3" />
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
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <footer className="border-t border-border py-4 text-[11px] text-muted-foreground">
        <div className="container">Deduced from your photos + text · parcel matched against aerial, register & OpenStreetMap</div>
      </footer>
    </div>
  );
}
