// =============================================================================
// Magic feedback — the browser half: the chord listener, the screenshot, the
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
  MAX_RECORD_MS,
  MOUSE_SAMPLE_MS,
  confirmBody,
  createChord,
  filedToast,
  isEditable,
  labelFor,
  maskClone,
  notesFromReply,
  readFailureToast,
  type MappedElement,
  type PathPoint,
  type ReadReply,
  type ReviewNote,
} from "./magic-feedback";

export type Phase = "idle" | "starting" | "recording" | "reading" | "review";

export interface MagicState {
  phase: Phase;
  startedAt: number;
  reply: ReadReply | null;
  notes: ReviewNote[];
}

type Notify = (kind: "error" | "success", message: string) => void;

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
    r.onload = () => resolve(String(r.result || ""));
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
  private state: MagicState = {
    phase: "idle",
    startedAt: 0,
    reply: null,
    notes: [],
  };
  private listeners = new Set<() => void>();
  private chord = createChord();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private mousePath: PathPoint[] = [];
  private clicks: PathPoint[] = [];
  private elements: MappedElement[] = [];
  private cleanShot: HTMLCanvasElement | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSample = 0;

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

  /** Wires the chord. A scripted browser gets no listener at all. Returns the teardown. */
  attach(): () => void {
    if (typeof navigator !== "undefined" && navigator.webdriver)
      return () => {};
    document.addEventListener("keydown", this.onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", this.onKeyDown, true);
      this.abort();
    };
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const { phase } = this.state;
    const action = this.chord.key(e, Date.now(), {
      editable: isEditable(document.activeElement as HTMLElement | null),
      active: phase === "recording",
    });
    if (action === "start" && phase === "idle") void this.start();
    else if (action === "stop" && phase === "recording") void this.stop();
  };

  private onMove = (e: MouseEvent) => {
    const t = Date.now();
    if (t - this.lastSample < MOUSE_SAMPLE_MS) return;
    this.lastSample = t;
    this.mousePath.push({
      x: e.clientX,
      y: e.clientY,
      t: t - this.state.startedAt,
    });
  };
  private onClick = (e: MouseEvent) => {
    if (this.clicks.length < MAX_CLICKS)
      this.clicks.push({
        x: e.clientX,
        y: e.clientY,
        t: Date.now() - this.state.startedAt,
      });
  };

  /** One recording at a time: only from idle, and never while a review stands on screen. */
  async start() {
    if (this.state.phase !== "idle") return;
    this.set({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // no mic, or permission refused: fail silent, never a dialog of our own
      this.set({ phase: "idle" });
      return;
    }
    try {
      const { default: html2canvas } = await import("html2canvas-pro");
      this.elements = buildElementMap();
      // Pinned to the viewport so the canvas and the element map share coordinates.
      this.cleanShot = await html2canvas(document.body, {
        logging: false,
        useCORS: true,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        ignoreElements: el =>
          el instanceof HTMLElement && el.hasAttribute("data-mf-ui"),
        onclone: doc => {
          maskClone(doc);
        },
      });
    } catch {
      stream.getTracks().forEach(t => t.stop());
      this.set({ phase: "idle" });
      this.notify(
        "error",
        "Magic feedback could not capture this screen — nothing was recorded."
      );
      return;
    }

    this.stream = stream;
    this.audioChunks = [];
    this.mousePath = [];
    this.clicks = [];
    this.lastSample = 0;
    const mime = pickAudioMime();
    try {
      this.recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      this.recorder = new MediaRecorder(stream);
    }
    this.recorder.ondataavailable = e => {
      if (e.data && e.data.size) this.audioChunks.push(e.data);
    };
    this.recorder.start(250);
    this.set({ phase: "recording", startedAt: Date.now() });
    window.addEventListener("mousemove", this.onMove, { passive: true });
    window.addEventListener("click", this.onClick, {
      capture: true,
      passive: true,
    });
    this.capTimer = setTimeout(() => void this.stop(), MAX_RECORD_MS);
  }

  private release() {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("click", this.onClick, { capture: true });
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  async stop() {
    if (this.state.phase !== "recording" || !this.recorder) return;
    const ms = Date.now() - this.state.startedAt;
    this.set({ phase: "reading" });
    const rec = this.recorder;
    const audio = await new Promise<Blob>(resolve => {
      rec.addEventListener(
        "stop",
        () =>
          resolve(
            new Blob(this.audioChunks, { type: rec.mimeType || "audio/webm" })
          ),
        {
          once: true,
        }
      );
      try {
        rec.stop();
      } catch {
        resolve(new Blob(this.audioChunks, { type: "audio/webm" }));
      }
    });
    this.release();
    this.recorder = null;

    let said = "";
    try {
      const shot = this.cleanShot!.toDataURL("image/png");
      const r = await postJson("/api/magic-feedback", {
        shot,
        elements: this.elements,
        mousePath: this.mousePath,
        clicks: this.clicks,
        audio: await blobToDataUrl(audio),
        url: location.href,
        ms,
      });
      if (!r.ok) {
        said = String(r.body?.error || "the server answered " + r.status);
        throw new Error(said);
      }
      const reply = r.body as ReadReply;
      const notes = notesFromReply(reply.annotations, this.elements, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      this.set({ phase: "review", reply, notes });
    } catch {
      // only a sentence the server pronounced is worth showing; "Failed to fetch" is not
      this.set({ phase: "idle" });
      this.notify("error", readFailureToast(said));
    }
  }

  discard() {
    this.cleanShot = null;
    this.set({ phase: "idle", reply: null, notes: [] });
  }

  /** Burns the pins into the clean screenshot, numbered exactly as the card's notes are, then files the card. */
  async send(notes: ReviewNote[]) {
    const reply = this.state.reply;
    const clean = this.cleanShot;
    if (this.state.phase !== "review" || !reply || !clean) return;
    const kept = notes.filter(n => String(n.text || "").trim());
    const c = document.createElement("canvas");
    c.width = clean.width;
    c.height = clean.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(clean, 0, 0);
    const sx = clean.width / window.innerWidth;
    const sy = clean.height / window.innerHeight;
    kept.forEach((p, i) => {
      const x = p.x * sx;
      const y = p.y * sy;
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
    const annotated = c.toDataURL("image/png");
    // The screen clears before the call lands, so a failure has to say so itself.
    this.discard();
    try {
      const r = await postJson(
        "/api/magic-feedback/confirm",
        confirmBody(reply, kept, annotated, location.href)
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

  /** Unmount mid-recording: stop the mic, drop everything. */
  private abort() {
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.recorder = null;
    this.release();
    this.cleanShot = null;
    this.state = { phase: "idle", startedAt: 0, reply: null, notes: [] };
  }
}
