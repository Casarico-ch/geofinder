// =============================================================================
// Magic feedback — the pure half (no DOM globals, no React, no network).
//
// Press Alt+Shift+M (Mac: Option ⌥ + Shift + M): the mic records, the screen is captured, the
// visible elements are mapped, you talk and point. On stop, the Rico cockpit
// turns what you said into numbered notes pinned on the page; you review them
// and "Send to Rico" files a card on the cockpit board under GeoFinder.
//
// Ported from the Rico cockpit's own widget (rico-ai-coo,
// interface/workspace/src/magic-feedback.js and react/MagicReview.js). This
// file holds every rule that can be checked without a browser, so
// scripts/check-magic-feedback.ts can hold the widget to them; the browser
// half lives in magic-feedback-widget.ts.
// =============================================================================

export const MAX_RECORD_MS = 2 * 60 * 1000;
export const MAX_ELEMENTS = 60;
export const MOUSE_SAMPLE_MS = 100;
export const MAX_CLICKS = 200;
export const POP_W = 300;
/** One recording follows you across at most this many pages; later address changes are ignored. */
export const MAX_PAGES = 5;
/** Audio clips: one per stretch of recording between real page loads. */
export const MAX_CLIPS = 6;
/** How often the address is looked at while recording (no history patching). */
export const URL_POLL_MS = 300;
/** A new address must hold still this long before its page is captured. */
export const URL_SETTLE_MS = 800;
/** A saved recording older than this is dropped on load, never resumed. */
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000;
/** Screenshots travel as JPEG at this quality, so five pages and the audio fit. */
export const SHOT_JPEG_QUALITY = 0.8;
/** The longest edge of a screenshot sent to the model for the read-back (Claude's vision sweet spot). */
export const MODEL_SHOT_MAX = 1568;

/**
 * The size of the copy of a screenshot the model reads: the viewport's own CSS
 * size (a 2x retina capture is halved, so its pixels match the element map's
 * coordinates), and never longer than MODEL_SHOT_MAX on its longest edge.
 * Never enlarges. The full-size shot is still the one the card's picture uses.
 */
export function modelShotSize(
  w: number,
  h: number,
  vw: number,
  vh: number
): { w: number; h: number } {
  if (!(w > 0) || !(h > 0))
    throw new Error("invariant violated: a screenshot has a size");
  let scale = vw > 0 && vh > 0 ? Math.min(1, vw / w, vh / h) : 1;
  scale = Math.min(
    scale,
    (MODEL_SHOT_MAX / Math.max(w * scale, h * scale)) * scale
  );
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}
/** The stitched confirm image: label bar height and the tallest stack before it is scaled down. */
export const LABEL_BAR_PX = 28;
export const MAX_STITCH_PX = 6000;

export interface MappedElement {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PathPoint {
  x: number;
  y: number;
  t: number;
}
export interface Annotation {
  /** 1-based into ITS page's element map. */
  n: number;
  text: string;
  /** 0-based page index; an older cockpit sends none, which means page 0. */
  page?: number;
}
/** One page of a recording: what was on screen when the address settled. */
export interface CapturedPage {
  /** JPEG data URL of the viewport. */
  shot: string;
  elements: MappedElement[];
  url: string;
  /** ms since the recording started. */
  at: number;
  /** The viewport the shot and the element map were measured in. */
  vw: number;
  vh: number;
}
export interface ReadReply {
  ok: true;
  transcript: string;
  annotations: Annotation[];
  summary: string;
  thoughts: string;
  questions: string[];
}
export interface ReviewNote {
  text: string;
  label: string;
  x: number;
  y: number;
  /** 0-based page the pin sits on. */
  page: number;
}

// ---- the shortcut --------------------------------------------------------------

export type ShortcutAction = "start" | "stop" | null;

export interface ShortcutKey {
  code?: string;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

/**
 * Alt+Shift+M (Mac: Option ⌥ + Shift + M) starts a recording; the same combo
 * stops it. Daniel, 09.10.2026: Space-chords fired while typing words starting
 * with f/m; ⌘F/⌘M were rejected because macOS uses them for find/minimize.
 * Matched on event.code, never event.key: Option on a Mac and Swiss layouts
 * change event.key. A modifier combo is never typed by accident, so it fires
 * inside text fields too.
 */
export function shortcutAction(
  e: ShortcutKey,
  active: boolean
): ShortcutAction {
  if (
    e.code !== "KeyM" ||
    !e.altKey ||
    !e.shiftKey ||
    e.metaKey ||
    e.ctrlKey ||
    e.isComposing ||
    e.repeat
  )
    return null;
  return active ? "stop" : "start";
}

// ---- what counts as private on the page ---------------------------------------

/** Elements whose content is the user's own input — blanked in the screenshot, never used as a label. */
const MASK_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-mf-mask]';

/** Input types whose value is the control's own caption, not something the user typed. */
const CAPTION_INPUTS = new Set(["button", "submit", "reset", "image"]);

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  textContent?: string | null;
}

function isEditable(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  const t = (el.tagName || "").toLowerCase();
  return (
    t === "input" ||
    t === "textarea" ||
    t === "select" ||
    !!el.isContentEditable
  );
}

/** Inside something marked private (data-mf-mask) or editable — its text must not leave the page. */
function isPrivate(el: ElementLike): boolean {
  if (isEditable(el)) return true;
  if (el.getAttribute?.("data-mf-mask") != null) return true;
  return !!el.closest?.(
    "[data-mf-mask], [contenteditable]:not([contenteditable='false'])"
  );
}

/** A short, human label for one element: aria-label, title, placeholder, then its own text — never a private value. */
export function labelFor(el: ElementLike): string {
  for (const attr of ["aria-label", "title", "placeholder"]) {
    const v = el.getAttribute?.(attr);
    if (v && v.trim()) return v.trim().slice(0, 60);
  }
  if (isPrivate(el)) return "";
  const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
  return txt ? txt.slice(0, 60) : "";
}

interface MaskableElement extends ElementLike {
  value?: string;
  type?: string;
  options?: ArrayLike<{ text: string }>;
  style?: { visibility?: string };
  setAttribute?(name: string, value: string): void;
}

/**
 * Runs on html2canvas's CLONE of the page (its `onclone` hook), never on the
 * live page: blanks every typed value so the screenshot sent to the cockpit
 * carries the layout, not what was in the fields. Returns how many elements
 * were masked.
 */
export function maskClone(doc: {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}): number {
  const list = doc.querySelectorAll(MASK_SELECTOR);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const el = list[i] as MaskableElement;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input") {
      if (!CAPTION_INPUTS.has(String(el.type || "").toLowerCase())) {
        el.value = "";
        el.setAttribute?.("value", "");
      }
    } else if (tag === "textarea") {
      el.value = "";
      el.textContent = "";
    } else if (tag === "select") {
      const opts = el.options;
      if (opts) for (let k = 0; k < opts.length; k++) opts[k].text = "";
    } else if (
      el.isContentEditable ||
      el.getAttribute?.("contenteditable") != null
    ) {
      el.textContent = "";
    }
    if (el.getAttribute?.("data-mf-mask") != null && el.style)
      el.style.visibility = "hidden";
    n++;
  }
  return n;
}

// ---- the review screen ---------------------------------------------------------

/**
 * The cockpit answers with notes against each page's element map (1-based,
 * local to that page; which is how the old screen ended up numbered 1, 2, 3,
 * 10, 11). The review screen numbers pins 1..N globally in the order they
 * were spoken, each on its own page; two notes on one element sit side by
 * side instead of on top of each other. A missing `page` is page 0 (an older
 * cockpit); a page that does not exist drops the note.
 */
export function notesFromReply(
  annotations: Annotation[],
  pages: Pick<CapturedPage, "elements" | "vw" | "vh">[]
): ReviewNote[] {
  const perEl: Record<string, number> = {};
  const notes: ReviewNote[] = [];
  for (const a of annotations || []) {
    const page = a.page ?? 0;
    if (!Number.isInteger(page) || page < 0 || page >= pages.length) continue;
    const pg = pages[page];
    const el = pg.elements[a.n - 1];
    if (!el) continue;
    const key = page + ":" + a.n;
    const k = (perEl[key] = (perEl[key] || 0) + 1);
    notes.push({
      text: String(a.text || ""),
      label: el.label,
      x: Math.min(pg.vw - 16, el.x + el.w / 2 + (k - 1) * 28),
      y: Math.max(14, el.y),
      page,
    });
  }
  return notes;
}

/** Only notes with words in them are filed, under the numbers burned into the shot. */
export function keptNotes(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter(n => String(n.text || "").trim());
}

export function barCopy(kept: number): { count: string; hint: string } {
  return {
    count: kept + " note" + (kept === 1 ? "" : "s"),
    hint: kept
      ? " · hover a number to read it, click it to edit"
      : " · your words still go to Rico",
  };
}

/** Where a note's box goes: under its pin, or above it near the bottom, always inside the window. */
export function popPlace(
  pin: { x: number; y: number },
  viewport: { width: number; height: number }
): { left: number; top?: number; bottom?: number } {
  const left = Math.max(12, Math.min(pin.x - 24, viewport.width - POP_W - 12));
  return pin.y > viewport.height - 260
    ? { left, bottom: viewport.height - pin.y + 18 }
    : { left, top: pin.y + 18 };
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " / 2:00";
}

/**
 * The body the confirm call sends. `by` is never set here — the server sets
 * it. `url` is the page the recording started on; `pages` lists every page.
 */
export function confirmBody(
  reply: ReadReply,
  notes: ReviewNote[],
  shot: string,
  pages: Pick<CapturedPage, "url">[]
) {
  return {
    shot,
    summary: reply.summary,
    thoughts: reply.thoughts,
    transcript: reply.transcript,
    questions: reply.questions,
    notes: keptNotes(notes).map(n => ({ text: n.text, page: n.page })),
    url: pages[0]?.url ?? "",
    pages: pages.slice(0, MAX_PAGES).map(p => ({ url: p.url })),
  };
}

/** The toast a failed read shows: the server's own sentence, capped, after a plain lead-in. */
export function readFailureToast(said: string): string {
  return (
    "That recording did not come back: " +
    (said ? said.slice(0, 120) : "try the shortcut again in a moment.")
  );
}

export function filedToast(folded: boolean): string {
  return folded
    ? "Added to a card already on the board."
    : "Sent to Rico — in Backlog and started.";
}

// ---- one recording, many pages ------------------------------------------------

export interface UrlWatch {
  /** The address of the last captured page. */
  current: string;
  /** A different address seen, and since when; null while on `current`. */
  pending: { href: string; since: number } | null;
}

/**
 * One poll of the address. Returns the next watch state and whether the new
 * address has held still long enough (URL_SETTLE_MS) to capture its page. The
 * caller sets `current` once it has captured (or decided not to).
 */
export function urlWatchStep(
  w: UrlWatch,
  href: string,
  now: number
): { watch: UrlWatch; capture: boolean } {
  if (href === w.current)
    return { watch: { ...w, pending: null }, capture: false };
  if (!w.pending || w.pending.href !== href)
    return { watch: { ...w, pending: { href, since: now } }, capture: false };
  return { watch: w, capture: now - w.pending.since >= URL_SETTLE_MS };
}

/** "Page 2 · /results?id=4": the label bar over a page in the stitched image. */
export function pageLabel(index: number, url: string): string {
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search + u.hash;
  } catch {
    /* not a full URL: show it as it is */
  }
  return "Page " + (index + 1) + " · " + path.slice(0, 120);
}

export interface StitchLayout {
  /** Final canvas size, after scaling. */
  width: number;
  height: number;
  /** Applied to every coordinate below (they are pre-scale). */
  scale: number;
  blocks: { labelTop: number | null; imageTop: number }[];
}

/**
 * Pages stacked vertically, each preceded by a LABEL_BAR_PX label bar when
 * there is more than one; one page is just its own picture. A stack taller
 * than MAX_STITCH_PX is scaled down proportionally.
 */
export function stitchLayout(sizes: { w: number; h: number }[]): StitchLayout {
  const labelled = sizes.length > 1;
  let y = 0;
  let width = 0;
  const blocks = sizes.map(s => {
    const labelTop = labelled ? y : null;
    if (labelled) y += LABEL_BAR_PX;
    const imageTop = y;
    y += s.h;
    width = Math.max(width, s.w);
    return { labelTop, imageTop };
  });
  const scale = y > MAX_STITCH_PX ? MAX_STITCH_PX / y : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(y * scale)),
    scale,
    blocks,
  };
}

// ---- surviving a real page load -------------------------------------------------

export interface SavedClip {
  /** ms since the recording started. */
  at: number;
  mime: string;
  chunks: Blob[];
}

export interface SessionRecord {
  v: 1;
  startedAt: number;
  phase: "recording" | "review";
  /** Recording ended by the user or the cap; a reload reads it back instead of reopening the mic. */
  stopped?: boolean;
  pages: CapturedPage[];
  clips: SavedClip[];
  mousePath: PathPoint[];
  clicks: PathPoint[];
  review?: { reply: ReadReply; notes: ReviewNote[] };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** A stored value back into a record, or null when it is not one this code wrote. */
export function readRecord(raw: unknown): SessionRecord | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt))
    return null;
  if (raw.phase !== "recording" && raw.phase !== "review") return null;
  const pages = raw.pages;
  if (!Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES)
    return null;
  for (const p of pages) {
    if (
      !isObj(p) ||
      typeof p.shot !== "string" ||
      typeof p.url !== "string" ||
      !Array.isArray(p.elements) ||
      typeof p.at !== "number" ||
      typeof p.vw !== "number" ||
      typeof p.vh !== "number"
    )
      return null;
  }
  const clips = raw.clips;
  if (!Array.isArray(clips) || clips.length > MAX_CLIPS) return null;
  for (const c of clips)
    if (
      !isObj(c) ||
      typeof c.at !== "number" ||
      typeof c.mime !== "string" ||
      !Array.isArray(c.chunks)
    )
      return null;
  let review: SessionRecord["review"];
  if (raw.phase === "review") {
    const r = raw.review;
    if (!isObj(r) || !isObj(r.reply) || !Array.isArray(r.notes)) return null;
    review = {
      reply: r.reply as unknown as ReadReply,
      notes: (r.notes as ReviewNote[]).map(n => ({ ...n, page: n.page ?? 0 })),
    };
  }
  return {
    v: 1,
    startedAt: raw.startedAt,
    phase: raw.phase,
    stopped: raw.stopped === true,
    pages: pages as CapturedPage[],
    clips: clips as SavedClip[],
    mousePath: Array.isArray(raw.mousePath)
      ? (raw.mousePath as PathPoint[])
      : [],
    clicks: Array.isArray(raw.clicks) ? (raw.clicks as PathPoint[]) : [],
    ...(review ? { review } : {}),
  };
}

export type ResumeAction = "none" | "drop" | "resume" | "readback" | "review";

/** What a fresh page does with what the last one left behind. */
export function resumeDecision(
  raw: unknown,
  now: number
): { action: ResumeAction; record: SessionRecord | null } {
  if (raw == null) return { action: "none", record: null };
  const rec = readRecord(raw);
  if (!rec) return { action: "drop", record: null };
  const age = now - rec.startedAt;
  if (age < 0 || age > RESUME_MAX_AGE_MS)
    return { action: "drop", record: null };
  if (rec.phase === "review") return { action: "review", record: rec };
  if (rec.stopped || age >= MAX_RECORD_MS || rec.clips.length >= MAX_CLIPS)
    return { action: "readback", record: rec };
  return { action: "resume", record: rec };
}

export const RESUMED_LINE =
  "Still recording — picked up after the page reloaded.";

/**
 * The read call's body. The legacy single-page fields are always sent, from
 * page 1 and clip 1, so a cockpit that knows nothing of pages still works.
 */
export function readBody(input: {
  pages: CapturedPage[];
  clips: { audio: string; at: number }[];
  mousePath: PathPoint[];
  clicks: PathPoint[];
  ms: number;
}) {
  const pages = input.pages.slice(0, MAX_PAGES);
  const clips = input.clips.slice(0, MAX_CLIPS);
  return {
    shot: pages[0].shot,
    elements: pages[0].elements,
    mousePath: input.mousePath,
    clicks: input.clicks,
    audio: clips[0]?.audio ?? "",
    url: pages[0].url,
    ms: input.ms,
    pages: pages.map(p => ({
      shot: p.shot,
      elements: p.elements,
      url: p.url,
      at: p.at,
      vw: p.vw,
      vh: p.vh,
    })),
    clips: clips.map(c => ({ audio: c.audio, at: c.at })),
  };
}
