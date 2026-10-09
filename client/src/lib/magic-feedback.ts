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
  n: number;
  text: string;
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
export const MASK_SELECTOR =
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

export function isEditable(el: ElementLike | null | undefined): boolean {
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
 * The cockpit answers with notes against the element map's 1-based index
 * (which is how the old screen ended up numbered 1, 2, 3, 10, 11). The review
 * screen numbers pins 1..N in the order they were spoken; two notes on one
 * element sit side by side instead of on top of each other.
 */
export function notesFromReply(
  annotations: Annotation[],
  elements: MappedElement[],
  viewport: { width: number; height: number }
): ReviewNote[] {
  const perEl: Record<number, number> = {};
  const notes: ReviewNote[] = [];
  for (const a of annotations || []) {
    const el = elements[a.n - 1];
    if (!el) continue;
    const k = (perEl[a.n] = (perEl[a.n] || 0) + 1);
    notes.push({
      text: String(a.text || ""),
      label: el.label,
      x: Math.min(viewport.width - 16, el.x + el.w / 2 + (k - 1) * 28),
      y: Math.max(14, el.y),
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

/** The body the confirm call sends. `by` is never set here — the server sets it. */
export function confirmBody(
  reply: ReadReply,
  notes: ReviewNote[],
  shot: string,
  url: string
) {
  return {
    shot,
    summary: reply.summary,
    thoughts: reply.thoughts,
    transcript: reply.transcript,
    questions: reply.questions,
    notes: keptNotes(notes).map(n => ({ text: n.text })),
    url,
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
