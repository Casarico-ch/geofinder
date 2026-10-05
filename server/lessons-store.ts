// =============================================================================
// Lessons — short rules the test track has proven, read by every search.
//
// A lesson is proposed by a reviewer after a practice round (lessons.ts), then
// tested on the same listings with the same models. It is kept only if it
// meets the goal Daniel set (05.10): accuracy stays at 100% — no wrong address
// — and the searches find more, or get faster and cheaper. Kept lessons go into
// every search's system prompt; the rest are kept on record, never applied.
// =============================================================================
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RUNS_ROOT } from "./sandbox";

export type LessonStatus = "proposed" | "testing" | "kept" | "dropped";

/** A round's score on the goal, for the before/after comparison. */
export interface Kpis {
  runs: number;
  right: number;
  wrong: number;
  notFound: number; // not sure + over limit
  errors: number;
  avgMinutes: number | null;
  avgCostUsd: number | null;
}

export interface Lesson {
  id: string;
  text: string; // what the search model reads
  why: string; // the reviewer's evidence for it
  status: LessonStatus;
  createdAt: string;
  fromRound: string; // the round whose runs it was learned from
  baseRound?: string; // the round it is compared against
  trialRound?: string; // the round that tested it
  pairs?: { propertyId: number; model: string }[]; // the runs its test re-ran (a small batch)
  before?: Kpis;
  after?: Kpis;
  verdict?: string; // the decision in one sentence
  decidedAt?: string;
  decidedBy?: "test" | "admin";
}

const file = () => path.join(RUNS_ROOT, "_lessons.json");
let cache: Lesson[] | null = null;

export async function loadLessons(): Promise<Lesson[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(file(), "utf8")) as Lesson[];
  } catch {
    cache = [];
  }
  return cache;
}

export async function saveLessons(): Promise<void> {
  if (!cache) return;
  await mkdir(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2));
  await rename(tmp, file());
}

export function newLessonId(): string {
  return `l${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

/** The lessons every new search reads (in the order they were kept). */
export async function keptLessons(): Promise<string[]> {
  return (await loadLessons())
    .filter((l) => l.status === "kept")
    .sort((a, b) => (a.decidedAt ?? "").localeCompare(b.decidedAt ?? ""))
    .map((l) => l.text);
}

/** The system-prompt block for a list of lessons ("" when there are none). */
export function lessonsBlock(lessons: string[]): string {
  if (!lessons.length) return "";
  return (
    "\n\n# LESSONS FROM PRACTICE\n" +
    "Each rule below was proven on listings whose building is known: it kept every answer right and made the search find more, or faster and cheaper. Follow them.\n" +
    lessons.map((l) => `- ${l}`).join("\n")
  );
}
