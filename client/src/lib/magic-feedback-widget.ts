// =============================================================================
// Magic feedback — the browser half: the shortcut listener, the screenshot, the
// mic, the mouse path and clicks, the two calls to this app's own server
// (/api/magic-feedback, /api/magic-feedback/confirm), and burning the pins
// into the screenshot. The rules it follows are in magic-feedback.ts; the
// screens are components/MagicFeedback.tsx and components/MagicReview.tsx.
//
// The browser never talks to the Rico cockpit: this app's server forwards
// both calls with its own key, which the browser never sees.
// =============================================================================
import {
  MAX_CLICKS,
  MAX_ELEMENTS,
  MAX_PAGES,
  MAX_RECORD_MS,
  MOUSE_SAMPLE_MS,
  SHOT_JPEG_QUALITY,
  URL_POLL_MS,
  confirmBody,
  shortcutAction,
  filedToast,
  labelFor,
  maskClone,
  modelShotSize,
  notesFromReply,
  pageLabel,
  readBody,
  readFailureToast,
  resumeDecision,
  stitchLayout,
  urlWatchStep,
  type CapturedPage,
  type MappedElement,
  type PathPoint,
  type ReadReply,
  type ReviewNote,
  type SavedClip,
  type SessionRecord,
  type UrlWatch,
} from "./magic-feedback";
import { clearSession, loadSession, saveSession } from "./magic-feedback-store";

type Phase = "idle" | "starting" | "recording" | "reading" | "review";

/** What the review screen needs of each page: its address and the picture its pins were measured on. */
export interface ReviewPage {
  url: string;
  shot: string;
  vw: number;
  vh: number;
}

export interface MagicState {
  phase: Phase;
  startedAt: number;
  reply: ReadReply | null;
  notes: ReviewNote[];
  pages: ReviewPage[];
  /** This recording was picked up again after a real page load. */
  resumed: boolean;
}

type Notify = (kind: "error" | "success", message: string) => void;

/** Everything one recording has gathered so far; what is saved to survive a page load. */
interface Session {
  startedAt: number;
  stopped: boolean;
  pages: CapturedPage[];
  clips: SavedClip[];
  mousePath: PathPoint[];
  clicks: PathPoint[];
  review: { reply: ReadReply; notes: ReviewNote[] } | null;
}

const IDLE: MagicState = {
  phase: "idle",
  startedAt: 0,
  reply: null,
  notes: [],
  pages: [],
  resumed: false,
};
const SAVE_DEBOUNCE_MS = 400;

const ELEMENT_SELECTOR =
  "button, a, input, textarea, select, [role=button], [role=link], [role=tab], h1, h2, h3, label, [data-mf-label]";

/** Every visible, labelled, interactive-ish element on screen right now, capped. Viewport coordinates. */
function buildElementMap(): MappedElement[] {
  const seen: MappedElement[] = [];
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(ELEMENT_SELECTOR)
  )) {
    if (seen.length >= MAX_ELEMENTS) break;
    if (el.closest("[data-mf-ui]")) continue; // never map the widget itself
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (
      r.bottom < 0 ||
      r.right < 0 ||
      r.top > window.innerHeight ||
      r.left > window.innerWidth
    )
      continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const label = labelFor(el);
    if (!label) continue;
    seen.push({
      label,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return seen;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function pickAudioMime(): string {
  const cands = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported)
    return "";
  return cands.find(c => MediaRecorder.isTypeSupported(c)) ?? "";
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image did not decode"));
    img.src = src;
  });
}

/**
 * The copy of a page's screenshot the model reads: downscaled to the viewport's
 * CSS size (capped at MODEL_SHOT_MAX), so a retina capture uploads a quarter of
 * the bytes and its pixels match the element map. The page's own full-size
 * shot is untouched — the card's picture is still burned from it.
 */
async function modelShot(p: CapturedPage): Promise<string> {
  const img = await loadImage(p.shot);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const size = modelShotSize(w, h, p.vw, p.vh);
  if (size.w === w && size.h === h) return p.shot;
  const c = document.createElement("canvas");
  c.width = size.w;
  c.height = size.h;
  const ctx = c.getContext("2d");
  if (!ctx) return p.shot;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size.w, size.h);
  return c.toDataURL("image/jpeg", SHOT_JPEG_QUALITY);
}

/** The pages as the read-back sends them: each with its model-sized shot. */
async function modelPages(pages: CapturedPage[]): Promise<CapturedPage[]> {
  return Promise.all(
    pages.map(async p => {
      try {
        return { ...p, shot: await modelShot(p) };
      } catch (err) {
        console.error("[magicFeedback.modelShot]", err);
        return p;
      }
    })
  );
}

function reviewPages(pages: CapturedPage[]): ReviewPage[] {
  return pages.map(p => ({ url: p.url, shot: p.shot, vw: p.vw, vh: p.vh }));
}

/** The viewport as it is right now: picture (JPEG) and element map, in shared coordinates. */
async function capturePage(at: number): Promise<CapturedPage> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const url = location.href;
  const elements = buildElementMap();
  // Pinned to the viewport so the canvas and the element map share coordinates.
  const canvas = await html2canvas(document.body, {
    logging: false,
    useCORS: true,
    x: window.scrollX,
    y: window.scrollY,
    width: vw,
    height: vh,
    windowWidth: vw,
    windowHeight: vh,
    ignoreElements: el =>
      el instanceof HTMLElement && el.hasAttribute("data-mf-ui"),
    onclone: doc => {
      maskClone(doc);
    },
  });
  return {
    shot: canvas.toDataURL("image/jpeg", SHOT_JPEG_QUALITY),
    elements,
    url,
    at,
    vw,
    vh,
  };
}

async function postJson(
  path: string,
  body: unknown
): Promise<{ ok: boolean; body: any; status: number }> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: any = {};
  try {
    parsed = await r.json();
  } catch {
    /* a proxy's HTML error page: the status is all there is */
  }
  return { ok: r.ok && !!parsed?.ok, body: parsed, status: r.status };
}

export class MagicFeedbackWidget {
  private state: MagicState = IDLE;
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private session: Session | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private watch: UrlWatch = { current: "", pending: null };
  private capturing = false;
  private lastSample = 0;
  /** Bumped on teardown, so an async step that outlives its widget does nothing. */
  private gen = 0;

  constructor(private notify: Notify) {}

  // ---- the store React reads (useSyncExternalStore) ----
  getState = (): MagicState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<MagicState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }

  /** Wires the shortcut and picks up a recording a page load interrupted. A scripted browser gets nothing. */
  attach(): () => void {
    if (typeof navigator !== "undefined" && navigator.webdriver)
      return () => {};
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("pagehide", this.onPageHide);
    void this.resumeFromStore();
    return () => {
      document.removeEventListener("keydown", this.onKeyDown, true);
      window.removeEventListener("pagehide", this.onPageHide);
      this.abort();
    };
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const { phase } = this.state;
    const action = shortcutAction(e, phase === "recording");
    if (!action) return;
    e.preventDefault();
    if (action === "start" && phase === "idle") void this.start();
    else if (action === "stop" && phase === "recording") void this.stop();
  };

  /** The page is going away: save what there is; the next load picks it up. */
  private onPageHide = () => {
    if (this.state.phase === "recording") {
      try {
        this.recorder?.requestData();
      } catch {
        /* best effort */
      }
    }
    this.flush();
  };

  private onMove = (e: MouseEvent) => {
    const s = this.session;
    if (!s) return;
    const t = Date.now();
    if (t - this.lastSample < MOUSE_SAMPLE_MS) return;
    this.lastSample = t;
    s.mousePath.push({ x: e.clientX, y: e.clientY, t: t - s.startedAt });
  };
  private onClick = (e: MouseEvent) => {
    const s = this.session;
    if (s && s.clicks.length < MAX_CLICKS)
      s.clicks.push({
        x: e.clientX,
        y: e.clientY,
        t: Date.now() - s.startedAt,
      });
  };

  // ---- persistence ----
  private record(): SessionRecord | null {
    const s = this.session;
    if (!s) return null;
    return {
      v: 1,
      startedAt: s.startedAt,
      phase: s.review ? "review" : "recording",
      stopped: s.stopped,
      pages: s.pages,
      clips: s.clips,
      mousePath: s.mousePath,
      clicks: s.clicks,
      ...(s.review ? { review: s.review } : {}),
    };
  }
  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }
  private flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const rec = this.record();
    if (rec) void saveSession(rec);
  }
  /** Forget this recording, here and in storage. */
  private forget() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.session = null;
    void clearSession();
  }

  // ---- recording ----

  /** One recording at a time: only from idle, and never while a review stands on screen. */
  async start() {
    if (this.state.phase !== "idle") return;
    const gen = this.gen;
    this.set({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // no mic, or permission refused: fail silent, never a dialog of our own
      this.set({ phase: "idle" });
      return;
    }
    let first: CapturedPage;
    try {
      first = await capturePage(0);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      if (gen !== this.gen) return;
      this.set({ phase: "idle" });
      this.notify(
        "error",
        "Magic feedback could not capture this screen — nothing was recorded."
      );
      return;
    }
    if (gen !== this.gen) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    this.session = {
      startedAt: Date.now(),
      stopped: false,
      pages: [first],
      clips: [],
      mousePath: [],
      clicks: [],
      review: null,
    };
    this.lastSample = 0;
    this.listen(stream, false);
  }

  /** Opens a new audio clip on `stream` and listens, until stop() or the cap counted from the first start. */
  private listen(stream: MediaStream, resumed: boolean) {
    const s = this.session!;
    this.stream = stream;
    const mime = pickAudioMime();
    let rec: MediaRecorder;
    try {
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      rec = new MediaRecorder(stream);
    }
    const clip: SavedClip = {
      at: Math.max(0, Date.now() - s.startedAt),
      mime: rec.mimeType || mime || "audio/webm",
      chunks: [],
    };
    s.clips.push(clip);
    rec.ondataavailable = e => {
      if (e.data && e.data.size) {
        clip.chunks.push(e.data);
        this.scheduleSave();
      }
    };
    this.recorder = rec;
    rec.start(250);
    this.set({ phase: "recording", startedAt: s.startedAt, resumed });
    window.addEventListener("mousemove", this.onMove, { passive: true });
    window.addEventListener("click", this.onClick, {
      capture: true,
      passive: true,
    });
    const left = MAX_RECORD_MS - (Date.now() - s.startedAt);
    this.capTimer = setTimeout(() => void this.stop(), Math.max(0, left));
    this.watch = { current: location.href, pending: null };
    this.pollTimer = setInterval(this.pollUrl, URL_POLL_MS);
    this.flush();
  }

  /** The address moved and held still: capture the new page, unless five are already in. */
  private pollUrl = () => {
    const s = this.session;
    if (!s || this.capturing || this.state.phase !== "recording") return;
    const step = urlWatchStep(this.watch, location.href, Date.now());
    this.watch = step.watch;
    if (!step.capture) return;
    this.watch = { current: location.href, pending: null };
    if (s.pages.length >= MAX_PAGES) return;
    const gen = this.gen;
    this.capturing = true;
    capturePage(Date.now() - s.startedAt)
      .then(page => {
        if (
          gen !== this.gen ||
          this.session !== s ||
          this.state.phase !== "recording" ||
          s.pages.length >= MAX_PAGES
        )
          return;
        s.pages.push(page);
        this.flush();
      })
      .catch(() => {
        /* this page goes without a picture; the recording carries on */
      })
      .finally(() => {
        this.capturing = false;
      });
  };

  private release() {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("click", this.onClick, { capture: true });
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  async stop() {
    if (this.state.phase !== "recording" || !this.recorder) return;
    this.set({ phase: "reading" });
    const rec = this.recorder;
    await new Promise<void>(resolve => {
      rec.addEventListener("stop", () => resolve(), { once: true });
      try {
        rec.stop();
      } catch {
        resolve();
      }
    });
    this.release();
    this.recorder = null;
    if (this.session) this.session.stopped = true;
    this.flush();
    await this.readBack();
  }

  /** Sends every page and clip gathered so far to be read; the review follows. */
  private async readBack() {
    const s = this.session;
    if (!s) return;
    const gen = this.gen;
    this.set({ phase: "reading", startedAt: s.startedAt });
    let said = "";
    try {
      const clips: { audio: string; at: number }[] = [];
      for (const c of s.clips) {
        if (!c.chunks.length) continue;
        clips.push({
          audio: await blobToDataUrl(new Blob(c.chunks, { type: c.mime })),
          at: c.at,
        });
      }
      const r = await postJson(
        "/api/magic-feedback",
        readBody({
          pages: await modelPages(s.pages),
          clips,
          mousePath: s.mousePath,
          clicks: s.clicks,
          ms: Math.min(Date.now() - s.startedAt, MAX_RECORD_MS),
        })
      );
      if (gen !== this.gen || this.session !== s) return;
      if (!r.ok) {
        said = String(r.body?.error || "the server answered " + r.status);
        throw new Error(said);
      }
      const reply = r.body as ReadReply;
      const notes = notesFromReply(reply.annotations, s.pages);
      s.review = { reply, notes };
      this.flush();
      this.set({
        phase: "review",
        reply,
        notes,
        pages: reviewPages(s.pages),
      });
    } catch {
      if (gen !== this.gen) return;
      // only a sentence the server pronounced is worth showing; "Failed to fetch" is not
      this.set({ ...IDLE });
      this.notify("error", readFailureToast(said));
      this.forget();
    }
  }

  /** On load: what the last page of this tab left behind is resumed, read back or shown again. */
  private async resumeFromStore() {
    if (this.state.phase !== "idle") return;
    const gen = this.gen;
    const raw = await loadSession();
    if (gen !== this.gen || this.state.phase !== "idle") return;
    const { action, record } = resumeDecision(raw, Date.now());
    if (action === "none") return;
    if (action === "drop" || !record) {
      void clearSession();
      return;
    }
    this.session = {
      startedAt: record.startedAt,
      stopped: !!record.stopped,
      pages: record.pages,
      clips: record.clips,
      mousePath: record.mousePath,
      clicks: record.clicks,
      review: record.review ?? null,
    };
    if (action === "review" && record.review) {
      this.set({
        phase: "review",
        startedAt: record.startedAt,
        reply: record.review.reply,
        notes: record.review.notes,
        pages: reviewPages(record.pages),
      });
      return;
    }
    if (action === "readback") {
      this.session.stopped = true;
      await this.readBack();
      return;
    }
    // resume: the mic again, this page as the next one, the clock from the first start
    this.set({ phase: "starting", startedAt: record.startedAt });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (gen !== this.gen) return;
      this.session.stopped = true;
      await this.readBack();
      return;
    }
    if (gen !== this.gen || !this.session) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    const s = this.session;
    if (s.pages.length < MAX_PAGES) {
      try {
        const page = await capturePage(Date.now() - s.startedAt);
        if (gen === this.gen && s.pages.length < MAX_PAGES) s.pages.push(page);
      } catch {
        /* resume without this page's picture */
      }
    }
    if (gen !== this.gen || this.session !== s) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    if (Date.now() - s.startedAt >= MAX_RECORD_MS) {
      stream.getTracks().forEach(t => t.stop());
      s.stopped = true;
      await this.readBack();
      return;
    }
    this.listen(stream, true);
  }

  // ---- review ----

  /** The review's edits, kept so a reload shows them again. */
  setNotes(notes: ReviewNote[]) {
    const s = this.session;
    if (!s?.review) return;
    s.review = { ...s.review, notes };
    this.scheduleSave();
  }

  discard() {
    this.forget();
    this.set({ ...IDLE });
  }

  /** Every page with its pins burned in, numbered exactly as the card's notes are, stacked into one JPEG. */
  private async stitch(pages: CapturedPage[], kept: ReviewNote[]) {
    const imgs = await Promise.all(pages.map(p => loadImage(p.shot)));
    const layout = stitchLayout(
      imgs.map(i => ({ w: i.naturalWidth, h: i.naturalHeight }))
    );
    const c = document.createElement("canvas");
    c.width = layout.width;
    c.height = layout.height;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(layout.scale, layout.scale);
    const rawW = layout.width / layout.scale;
    imgs.forEach((img, k) => {
      const b = layout.blocks[k];
      if (b.labelTop !== null) {
        ctx.fillStyle = "#1b1a2e";
        ctx.fillRect(0, b.labelTop, rawW, 28);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 14px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(pageLabel(k, pages[k].url), 10, b.labelTop + 14);
      }
      ctx.drawImage(img, 0, b.imageTop);
      const sx = img.naturalWidth / (pages[k].vw || img.naturalWidth);
      const sy = img.naturalHeight / (pages[k].vh || img.naturalHeight);
      kept.forEach((p, i) => {
        if (p.page !== k) return;
        const x = p.x * sx;
        const y = b.imageTop + p.y * sy;
        ctx.beginPath();
        ctx.arc(x, y, 13 * sx, 0, Math.PI * 2);
        ctx.fillStyle = "#1b1a2e";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold " + Math.round(12 * sx) + "px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), x, y + 1);
      });
    });
    const out = c.toDataURL("image/jpeg", 0.85);
    return out.length > 8_000_000 ? c.toDataURL("image/jpeg", 0.6) : out;
  }

  /** Burns the pins into the screenshots, then files the card. */
  async send(notes: ReviewNote[]) {
    const reply = this.state.reply;
    const s = this.session;
    if (this.state.phase !== "review" || !reply || !s) return;
    const kept = notes.filter(n => String(n.text || "").trim());
    const pages = s.pages;
    let annotated: string;
    try {
      annotated = await this.stitch(pages, kept);
    } catch {
      this.notify(
        "error",
        "That did not file — the screenshots could not be prepared."
      );
      return;
    }
    // The screen clears before the call lands, so a failure has to say so itself.
    this.discard();
    try {
      const r = await postJson(
        "/api/magic-feedback/confirm",
        confirmBody(reply, kept, annotated, pages)
      );
      if (!r.ok) {
        this.notify(
          "error",
          r.body?.error
            ? "That did not file: " + String(r.body.error).slice(0, 120)
            : "That did not file — try the shortcut again in a moment."
        );
        return;
      }
      this.notify("success", filedToast(!!r.body.folded));
    } catch {
      this.notify(
        "error",
        "That did not file — try the shortcut again in a moment."
      );
    }
  }

  /** Unmount: stop the mic. What was saved stays saved, for the next load of this tab. */
  private abort() {
    this.gen++;
    this.flush();
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.recorder = null;
    this.release();
    this.session = null;
    this.capturing = false;
    this.state = { ...IDLE };
  }
}
