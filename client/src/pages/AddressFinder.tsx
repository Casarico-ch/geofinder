import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Camera,
  Copy,
  ExternalLink,
  Eye,
  ImageIcon,
  Loader2,
  MapPin,
  MapPinned,
  RefreshCw,
  ScanSearch,
  Sparkles,
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
  sources: string[];
}

interface ResolvedAddress {
  formatted: string;
  latitude: number;
  longitude: number;
}

interface OsmVerification {
  status: "verified" | "unverified" | "skipped" | "unavailable";
  matches: { feature: string; clue: string }[];
  mismatches: string[];
  notes: string | null;
  refined: boolean;
}

interface AnalyzeResponse {
  estimate: LocationEstimate;
  resolvedAddress: ResolvedAddress | null;
  searchUsed: boolean;
  osmVerification?: OsmVerification;
}

type Stage =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "resolved"; data: AnalyzeResponse }
  | { kind: "error"; message: string };

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

export default function AddressFinder() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [hint, setHint] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const chooseFile = useCallback((selected: File) => {
    if (!selected.type.startsWith("image/") && !/\.(heic|heif)$/i.test(selected.name)) {
      toast.error("Please choose an image file");
      return;
    }
    setFile(selected);
    setPreviewFailed(false);
    setStage({ kind: "idle" });
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(selected);
    });
  }, []);

  const analyze = useCallback(async () => {
    if (!file) return;
    setStage({ kind: "analyzing" });
    try {
      const imageBase64 = await fileToJpegBase64(file);
      const res = await fetch("/api/geo/analyze-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          mediaType: "image/jpeg",
          hint: hint.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Vision analysis failed");
      setStage({ kind: "resolved", data: body as AnalyzeResponse });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "Vision analysis failed" });
    }
  }, [file, hint]);

  const reset = useCallback(() => {
    setFile(null);
    setPreviewFailed(false);
    setHint("");
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setStage({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const copyText = useCallback((text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy to clipboard"));
  }, []);

  const analyzing = stage.kind === "analyzing";
  const est = stage.kind === "resolved" ? stage.data.estimate : null;
  const resolved = stage.kind === "resolved" ? stage.data.resolvedAddress : null;
  const osm = stage.kind === "resolved" ? (stage.data.osmVerification ?? null) : null;
  const coords =
    est && est.latitude !== null && est.longitude !== null
      ? { lat: est.latitude, lon: est.longitude }
      : null;
  const primaryLine = resolved?.formatted ?? est?.address ?? est?.place ?? "";
  const wideMap = est ? !["street", "building", "block"].includes(est.confidence) : true;

  return (
    <div className="min-h-screen flex flex-col scanlines">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container py-4 flex items-center gap-3">
          <MapPin className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-bold tracking-wider text-primary glow-green">GEOFINDER</h1>
            <p className="text-xs text-muted-foreground">Vision-only geolocation — no metadata, ever</p>
          </div>
        </div>
      </header>

      <main className="flex-1 container py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Drop a photo. The address is worked out purely from what's <strong className="text-primary">visible</strong> in
            the picture — architecture, signage, street furniture, terrain, and any readable text — optionally guided by a
            note you add. Claude reads the scene, verifies distinctive clues with web search, cross-checks the result
            against OpenStreetMap ground truth, and reports how sure it is.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept="image/*,.heic,.heif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) chooseFile(f);
            }}
          />

          {!file ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) chooseFile(f);
              }}
              className={`w-full border border-dashed rounded p-10 flex flex-col items-center gap-3 transition-colors ${
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card/30 hover:border-primary/50 hover:bg-card/50"
              }`}
            >
              <Camera className="h-8 w-8 text-primary" />
              <span className="text-sm text-foreground">Drop a photo here, or click to choose</span>
              <span className="text-[11px] text-muted-foreground text-center max-w-sm">
                Any photo works — the more distinctive detail in frame (signs, shopfronts, a skyline), the tighter the fix.
              </span>
            </button>
          ) : (
            <Card className="bg-card/40 border-border">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center gap-4">
                  <div className="h-20 w-20 shrink-0 rounded border border-border bg-background/40 overflow-hidden flex items-center justify-center">
                    {previewUrl && !previewFailed ? (
                      <img
                        src={previewUrl}
                        alt="Selected photo"
                        className="h-full w-full object-cover"
                        onError={() => setPreviewFailed(true)}
                      />
                    ) : (
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-foreground truncate">{file.name}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={reset} disabled={analyzing}>
                    <RefreshCw className="mr-1.5 h-3 w-3" />
                    New photo
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold tracking-wider text-muted-foreground">
                    OPTIONAL CONTEXT
                  </label>
                  <Textarea
                    value={hint}
                    onChange={(e) => setHint(e.target.value)}
                    disabled={analyzing}
                    rows={2}
                    placeholder='Anything you know — e.g. "Fribourg town", "near a hospital", a street name you half-remember…'
                    className="text-xs bg-background/50 border-border focus-visible:ring-primary resize-none"
                  />
                </div>

                <Button
                  onClick={() => void analyze()}
                  disabled={analyzing}
                  className="w-full h-11 bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-xs tracking-widest"
                >
                  {analyzing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      READING THE SCENE…
                    </>
                  ) : (
                    <>
                      <ScanSearch className="mr-2 h-4 w-4" />
                      {stage.kind === "resolved" ? "RE-ANALYZE" : "FIND ADDRESS"}
                    </>
                  )}
                </Button>
                {analyzing && (
                  <p className="text-[11px] text-muted-foreground text-center">
                    Extracting clues, verifying with web search, then cross-checking against map data — this can take a
                    minute or two.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {stage.kind === "error" && (
            <Card className="bg-card/40 border-destructive/40">
              <CardContent className="p-5 space-y-3">
                <p className="text-sm text-destructive">{stage.message}</p>
                {file && (
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
                    {stage.kind === "resolved" && stage.data.searchUsed && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-border bg-background/40 text-[10px] font-bold tracking-wider text-muted-foreground">
                        <ScanSearch className="h-3 w-3" />
                        WEB-VERIFIED
                      </span>
                    )}
                    {osm?.status === "verified" && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-border bg-background/40 text-[10px] font-bold tracking-wider text-muted-foreground">
                        <MapPinned className="h-3 w-3" />
                        MAP-VERIFIED
                      </span>
                    )}
                  </div>

                  {est.location_found ? (
                    <div className="space-y-1">
                      <p className="text-xl font-bold text-primary leading-snug">{primaryLine}</p>
                      {resolved && est.address && resolved.formatted !== est.address && (
                        <p className="text-[11px] text-muted-foreground">Model read: {est.address}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Not enough in the frame to place this confidently. {est.place}
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
                        <Eye className="h-3 w-3" /> VISUAL CLUES
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
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-2">TEXT READ IN IMAGE</p>
                      <div className="flex flex-wrap gap-1.5">
                        {est.text_read.map((t, i) => (
                          <span key={i} className="text-[11px] font-mono text-foreground border border-border/60 rounded px-1.5 py-0.5">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {osm && (osm.matches.length > 0 || osm.mismatches.length > 0) && (
                    <div className="border border-border/60 bg-background/30 rounded p-3">
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
                        <MapPinned className="h-3 w-3" /> MAP CROSS-CHECK
                      </p>
                      <ul className="space-y-1">
                        {osm.matches.map((m, i) => (
                          <li key={i} className="text-[11px] text-muted-foreground leading-relaxed">
                            · {m.clue} — matches {m.feature}
                          </li>
                        ))}
                        {osm.mismatches.map((m, i) => (
                          <li key={`x-${i}`} className="text-[11px] text-destructive/80 leading-relaxed">
                            · {m}
                          </li>
                        ))}
                      </ul>
                      {osm.status === "unverified" && osm.notes && (
                        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{osm.notes}</p>
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

                  {est.sources.length > 0 && (
                    <div className="pt-1">
                      <p className="text-[10px] font-bold tracking-wider text-muted-foreground mb-1">SOURCES</p>
                      <ul className="space-y-0.5">
                        {est.sources.map((s, i) => (
                          <li key={i} className="truncate">
                            <a
                              href={s}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-primary hover:underline"
                            >
                              {s}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
        <div className="container">Vision only · verified with web search and OpenStreetMap · geocoding by Nominatim</div>
      </footer>
    </div>
  );
}
