// =============================================================================
// The lessons loop — how the test track makes GeoFinder better on its own.
//
//   1. A practice round finishes.
//   2. A reviewer (Opus 5.5) reads its failed and slow runs, next to where the
//      right building was in each run's checklist, and proposes up to three
//      general rules.
//   3. Each rule is tested, one at a time: the same listings, the same models,
//      the kept lessons plus this one.
//   4. It is kept only if the goal holds (Daniel, 05.10): accuracy stays at
//      100% — no more wrong answers than before — and the search finds more,
//      or finds as much faster and cheaper. Otherwise it is dropped.
//
// Everything is on the Practice page: each lesson, its evidence, the before
// and after numbers, and the decision. Learning runs only when asked (Daniel,
// 05.10: "let me trigger it if I want"): the round page's "Find lessons" button
// (requestLessons). PRACTICE_AUTO_LESSONS=1 brings back the automatic loop.
// =============================================================================
import { onLogin } from "./claude-pool";
import { missReason } from "./miss";
import { streetOf } from "./consensus";
import { getJob } from "./jobs";
import { loadLessons, keptLessons, newLessonId, saveLessons, type Kpis, type Lesson } from "./lessons-store";
import { allRounds, deleteRound, getRound, kpisOf, markReviewed, pauseRound, resumeRound, saveRound, settleRound, startRound, truthCandidate, type Pair, type PracticeRound } from "./practice";

const AUTO = process.env.PRACTICE_AUTO_LESSONS === "1";
const wanted = (r: PracticeRound | null | undefined) => !!r && (AUTO || !!r.learnRequested);
const REVIEWER = "claude-opus-5-5";
const TICK_MS = 60_000;
const MAX_RUNS_REVIEWED = 12;
// A lesson is tested on a small batch of the base round's runs, not all of it
// (Daniel, 05.10: "otherwise it's a neverending loop").
const TRIAL_RUNS = Number(process.env.PRACTICE_TRIAL_RUNS ?? 12);
// How many lessons are tested at the same time.
const PARALLEL_TESTS = Number(process.env.PRACTICE_PARALLEL_TESTS ?? 3);

/** The decision rule, in one place: never less accurate, and better at something. */
export function judge(before: Kpis, after: Kpis): { keep: boolean; verdict: string } {
  const min = (k: Kpis) => k.avgMinutes ?? Infinity;
  const usd = (k: Kpis) => k.avgCostUsd ?? Infinity;
  const nums = `right ${before.right}→${after.right}, wrong ${before.wrong}→${after.wrong}, ` +
    `${before.avgMinutes ?? "—"}→${after.avgMinutes ?? "—"} min, $${before.avgCostUsd ?? "—"}→$${after.avgCostUsd ?? "—"} per run`;
  if (after.wrong > before.wrong) return { keep: false, verdict: `Dropped: more wrong answers (${nums}).` };
  if (after.right < before.right) return { keep: false, verdict: `Dropped: found fewer houses (${nums}).` };
  if (after.wrong < before.wrong) return { keep: true, verdict: `Kept: fewer wrong answers (${nums}).` };
  if (after.right > before.right) return { keep: true, verdict: `Kept: found more houses, none wrong added (${nums}).` };
  if (min(after) < min(before) && usd(after) <= usd(before))
    return { keep: true, verdict: `Kept: same accuracy, faster and cheaper (${nums}).` };
  return { keep: false, verdict: `Dropped: no better than without it (${nums}).` };
}

// ---------------------------------------------------------------------------
// The reviewer
// ---------------------------------------------------------------------------

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// One run, as the reviewer reads it.
function runBrief(round: PracticeRound, i: number, why?: string | null): { text: string; streets: string[] } | null {
  const r = round.results[i];
  const job = r.jobId ? getJob(r.jobId) : undefined;
  if (!job) return null;
  const truth = truthCandidate(job, r.truth);
  const streets = [truth?.address, job.answer?.address].map((a) => (a ? streetOf(a) : null)).filter((x): x is string => !!x);
  const steps = job.steps
    .filter((s) => s.kind !== "reasoning")
    .slice(-40)
    .map((s) => `  ${s.n}. [${s.kind}] ${clip(s.title, 120)}${s.kind === "note" && s.detail ? ` — ${clip(s.detail, 200)}` : ""}`)
    .join("\n");
  const text = [
    `RUN ${i + 1} — model ${r.model}: ${r.outcome.toUpperCase()} after ${r.minutes ?? "?"} min, $${r.costUsd ?? "?"}, ${r.steps ?? "?"} steps.`,
    `Listing text: ${clip(job.input.listingText, 600)}`,
    `What it answered: ${clip(job.answer?.reasoning, 600) || "(nothing)"}`,
    truth
      ? `The right building WAS in its checklist: ${truth.address ?? "no address"} — verdict "${truth.verdict}"${truth.reason ? `, because: ${clip(truth.reason, 300)}` : ""}${truth.viewed ? "" : " (never looked at)"}.`
      : `The right building was NEVER in its checklist (lost at: ${r.lostAt ?? "unknown"}).${why ? ` Why: ${why}` : ""}`,
    `Last steps:\n${steps}`,
  ].join("\n");
  return { text, streets };
}

// The runs worth learning from: every wrong one, then the ones that missed,
// then the slowest right ones, and the fastest right ones as what works.
function pickRuns(round: PracticeRound): number[] {
  const idx = round.results.map((_, i) => i);
  const by = (o: string) => idx.filter((i) => round.results[i].outcome === o);
  const right = by("right").sort((a, b) => (round.results[b].minutes ?? 0) - (round.results[a].minutes ?? 0));
  const picked = [...by("wrong"), ...by("over_budget"), ...by("unsure"), ...right.slice(0, 2), ...right.slice(-2)];
  return Array.from(new Set(picked)).slice(0, MAX_RUNS_REVIEWED);
}

async function review(round: PracticeRound): Promise<Lesson[]> {
  const picked = pickRuns(round);
  const whys = await Promise.all(picked.map((i) => missReason(round.results[i]).then((w) => w?.text ?? null)));
  const briefs = picked.map((i, k) => runBrief(round, i, whys[k])).filter((b): b is NonNullable<typeof b> => !!b);
  if (!briefs.length) return [];
  const lessons = await loadLessons();
  const kept = lessons.filter((l) => l.status === "kept").map((l) => `- ${l.text}`);
  const tried = lessons.filter((l) => l.status !== "kept").map((l) => `- ${l.text} (${l.status})`);
  const prompt = `You review practice searches of GeoFinder, an agent that finds a Swiss property's exact address from its listing photos and text (address hidden), using the federal building register, aerial images and roof renders.

THE GOAL, in this order:
1. Accuracy 100%: never name a wrong address. A wrong answer is far worse than "not found".
2. Find the right house more often.
3. Faster and cheaper.

Below are runs from one practice round, with where the right building sat in each run's checklist. Propose at most 3 RULES that would have changed these outcomes on OTHER listings too — general method, not facts about these houses.

Each rule: one or two sentences, an instruction the agent can follow, at most 300 characters. NEVER name a street, a commune, an address, an EGID or any number specific to these listings. Do not repeat or rephrase a rule already kept or already tried.

Rules already kept:
${kept.join("\n") || "(none)"}

Rules already tried:
${tried.join("\n") || "(none)"}

${briefs.map((b) => b.text).join("\n\n")}

Answer with JSON only: {"lessons":[{"text":"the rule","why":"which runs show it, in one or two sentences"}]}`;

  const turn = await onLogin(
    undefined,
    (client) =>
      client.messages.create({
        model: REVIEWER,
        max_tokens: 8_000,
        thinking: { type: "adaptive", display: "summarized" },
        messages: [{ role: "user", content: prompt }],
      }),
    REVIEWER,
  );
  const text = turn.value.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("the reviewer gave no JSON");
  const proposed = (JSON.parse(json) as { lessons?: { text?: string; why?: string }[] }).lessons ?? [];

  // A rule must not carry any of these listings' answers into later searches.
  const streets = briefs.flatMap((b) => b.streets).map((s) => s.toLowerCase());
  const leaks = (t: string) => /\d{4,}/.test(t) || streets.some((s) => s.length >= 4 && t.toLowerCase().includes(s));
  const now = new Date().toISOString();
  return proposed
    .filter((p) => p.text && p.text.length <= 400 && !leaks(p.text))
    .slice(0, 3)
    .map((p) => ({
      id: newLessonId(),
      text: p.text!.trim(),
      why: clip(p.why, 500),
      status: "proposed" as const,
      createdAt: now,
      fromRound: round.id,
      baseRound: round.id,
    }));
}

// ---------------------------------------------------------------------------
// Testing and deciding
// ---------------------------------------------------------------------------

/**
 * The small batch a lesson is tested on: the runs it should fix (every wrong
 * one, then the misses) and, as guards, runs that were right — a lesson that
 * breaks a right answer must show it. At most TRIAL_RUNS.
 */
export function trialPairs(base: PracticeRound, max = TRIAL_RUNS): Pair[] {
  const of = (o: string) => base.results.filter((r) => r.outcome === o);
  const guards = Math.max(1, Math.floor(max / 3));
  const right = of("right").slice(0, guards);
  const fix = [...of("wrong"), ...of("over_budget"), ...of("unsure")].slice(0, max - right.length);
  return [...fix, ...right].map((r) => ({ propertyId: r.propertyId, model: r.model }));
}

/** Start testing a proposed lesson against its base round, on a small batch. */
export async function testLesson(lesson: Lesson): Promise<void> {
  const base = await getRound(lesson.baseRound ?? lesson.fromRound);
  if (!base) throw new Error("Its base round was deleted.");
  const pairs = trialPairs(base);
  if (!pairs.length) throw new Error("Its base round has no finished runs to test on.");
  const trial = await startRound(base.split, pairs.length, base.models, {
    pairs,
    lessons: [...(await keptLessons()), lesson.text],
    trialOf: lesson.id,
  });
  Object.assign(lesson, { status: "testing", trialRound: trial.id, pairs, before: kpisOf(base, pairs) });
  await saveLessons();
}

async function decide(lesson: Lesson, trial: PracticeRound): Promise<void> {
  const base = await getRound(lesson.baseRound ?? lesson.fromRound);
  const before = lesson.before ?? (base ? kpisOf(base, lesson.pairs as Pair[] | undefined) : kpisOf(trial));
  const after = kpisOf(trial);
  const { keep, verdict } = judge(before, after);
  Object.assign(lesson, { status: keep ? "kept" : "dropped", before, after, verdict, decidedAt: new Date().toISOString(), decidedBy: "test" });
  await saveLessons();
  console.log(`[lessons] ${lesson.id}: ${verdict}`);
}

// ---------------------------------------------------------------------------
// The beat
// ---------------------------------------------------------------------------

let busy = false;
const reviewing = new Set<string>();

/** Where a round's learning stands, for its row on the Practice page. */
export interface Learning {
  state: "searching" | "paused" | "waiting" | "reviewing" | "testing" | "done" | "failed" | "off";
  proposed: number; // waiting to be tested
  testing: number;
  kept: number;
  dropped: number;
  error?: string;
}

export async function learningOf(round: PracticeRound): Promise<Learning> {
  const mine = (await loadLessons()).filter((l) => l.fromRound === round.id);
  const n = (st: Lesson["status"]) => mine.filter((l) => l.status === st).length;
  const counts = { proposed: n("proposed"), testing: n("testing"), kept: n("kept"), dropped: n("dropped") };
  const state: Learning["state"] = round.paused
    ? "paused"
    : !round.finishedAt
      ? "searching"
      : reviewing.has(round.id)
        ? "reviewing"
        : round.reviewError
          ? "failed"
          : !round.reviewed
            ? wanted(round)
              ? "waiting"
              : "off"
            : counts.proposed + counts.testing
              ? "testing"
              : "done";
  return { state, ...counts, ...(round.reviewError ? { error: round.reviewError } : {}) };
}

/** "Find lessons": review this round and test what it proposes (again, if it was reviewed before). */
export async function requestLessons(id: string): Promise<PracticeRound | null> {
  const round = await getRound(id);
  if (!round || round.trialOf) return null;
  round.learnRequested = true;
  round.reviewed = false;
  delete round.reviewError;
  await saveRound(round);
  void beat().catch((err) => console.error("[lessons] beat failed:", err));
  return round;
}

/**
 * Pausing a round pauses its learning too (Daniel, 05.10): the tests of its
 * lessons stop where they are and no new one starts until it resumes.
 */
export async function pauseLearning(id: string, pause: boolean): Promise<void> {
  for (const l of (await loadLessons()).filter((x) => x.fromRound === id && x.status === "testing" && x.trialRound))
    await (pause ? pauseRound : resumeRound)(l.trialRound!).catch((err) => console.error(`[lessons] ${pause ? "pause" : "resume"} of ${l.trialRound} failed:`, err));
}

/** Deleting a round takes its lessons' tests and the lessons not kept with it. */
export async function forgetRound(id: string): Promise<void> {
  const lessons = await loadLessons();
  for (const l of lessons.filter((x) => x.fromRound === id)) {
    if (l.trialRound) await deleteRound(l.trialRound);
    if (l.status !== "kept") lessons.splice(lessons.indexOf(l), 1);
  }
  await saveLessons();
}

async function beat(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const rounds = await allRounds();
    for (const r of rounds) await settleRound(r);
    const lessons = await loadLessons();

    // Decide every lesson whose test has finished.
    for (const l of lessons.filter((x) => x.status === "testing")) {
      const trial = l.trialRound ? await getRound(l.trialRound) : null;
      // A test started before tests were small re-runs a whole round: stop it and test again, small.
      if (trial && !l.pairs) {
        await deleteRound(trial.id);
        Object.assign(l, { status: "proposed", trialRound: undefined, before: undefined });
        await saveLessons();
      } else if (!trial) {
        Object.assign(l, { status: "proposed", trialRound: undefined });
        await saveLessons();
      } else if (trial.finishedAt) await decide(l, trial);
    }
    // Learn from every finished ordinary round that has enough real runs.
    for (const r of rounds.filter((x) => x.finishedAt && !x.trialOf && !x.reviewed && !x.paused && wanted(x))) {
      const scored = r.results.filter((x) => x.outcome !== "error").length;
      if (scored < r.results.length / 2) {
        await markReviewed(r, "Too many runs ended in an error to learn from.");
        continue;
      }
      reviewing.add(r.id);
      try {
        const found = await review(r);
        lessons.push(...found);
        await saveLessons();
        await markReviewed(r);
        console.log(`[lessons] round ${r.id}: ${found.length} lesson(s) proposed`);
      } catch (err) {
        await markReviewed(r, err instanceof Error ? err.message : String(err));
        console.error(`[lessons] review of round ${r.id} failed:`, err);
      } finally {
        reviewing.delete(r.id);
      }
    }

    // Several tests side by side (each a small batch), oldest proposal first.
    const slots = PARALLEL_TESTS - lessons.filter((l) => l.status === "testing").length;
    const paused = new Set(rounds.filter((x) => x.paused).map((x) => x.id));
    const asked = new Set(rounds.filter(wanted).map((x) => x.id));
    for (const next of lessons.filter((l) => l.status === "proposed" && !paused.has(l.fromRound) && asked.has(l.fromRound)).slice(0, Math.max(0, slots)))
      await testLesson(next).catch((err) => console.error(`[lessons] test of ${next.id} failed to start:`, err));
  } finally {
    busy = false;
  }
}

export function startLessonsLoop(): void {
  setInterval(() => void beat().catch((err) => console.error("[lessons] beat failed:", err)), TICK_MS);
}

// ---------------------------------------------------------------------------
// The page's buttons
// ---------------------------------------------------------------------------

export async function setLesson(id: string, action: "keep" | "drop" | "test" | "delete"): Promise<Lesson | null> {
  const lessons = await loadLessons();
  const l = lessons.find((x) => x.id === id);
  if (!l) return null;
  if (action === "delete") {
    lessons.splice(lessons.indexOf(l), 1);
  } else if (action === "test") {
    if (lessons.filter((x) => x.status === "testing").length >= PARALLEL_TESTS)
      throw new Error(`${PARALLEL_TESTS} lessons are being tested already; this one waits its turn.`);
    await testLesson(l);
  } else {
    Object.assign(l, {
      status: action === "keep" ? "kept" : "dropped",
      verdict: action === "keep" ? "Kept by hand." : "Dropped by hand.",
      decidedAt: new Date().toISOString(),
      decidedBy: "admin",
    });
  }
  await saveLessons();
  return l;
}
