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
// and after numbers, and the decision. PRACTICE_AUTO_LESSONS=0 stops the loop
// from proposing and testing on its own; the page's buttons still work.
// =============================================================================
import { onLogin } from "./claude-pool";
import { streetOf } from "./consensus";
import { getJob } from "./jobs";
import { loadLessons, keptLessons, newLessonId, saveLessons, type Kpis, type Lesson } from "./lessons-store";
import { allRounds, getRound, kpisOf, markReviewed, settleRound, startRound, truthCandidate, type PracticeRound } from "./practice";

const AUTO = process.env.PRACTICE_AUTO_LESSONS !== "0";
const REVIEWER = "claude-opus-5-5";
const TICK_MS = 60_000;
const MAX_RUNS_REVIEWED = 12;

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
function runBrief(round: PracticeRound, i: number): { text: string; streets: string[] } | null {
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
      : `The right building was NEVER in its checklist (lost at: ${r.lostAt ?? "unknown"}).`,
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
  const briefs = pickRuns(round).map((i) => runBrief(round, i)).filter((b): b is NonNullable<typeof b> => !!b);
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

/** Start testing a proposed lesson against its base round. */
export async function testLesson(lesson: Lesson): Promise<void> {
  const base = await getRound(lesson.baseRound ?? lesson.fromRound);
  if (!base) throw new Error("Its base round was deleted.");
  const ids = Array.from(new Set(base.results.map((r) => r.propertyId)));
  const trial = await startRound(base.split, ids.length, base.models, {
    propertyIds: ids,
    lessons: [...(await keptLessons()), lesson.text],
    trialOf: lesson.id,
  });
  Object.assign(lesson, { status: "testing", trialRound: trial.id, before: kpisOf(base) });
  await saveLessons();
}

async function decide(lesson: Lesson, trial: PracticeRound): Promise<void> {
  const base = await getRound(lesson.baseRound ?? lesson.fromRound);
  const before = lesson.before ?? (base ? kpisOf(base) : kpisOf(trial));
  const after = kpisOf(trial);
  const { keep, verdict } = judge(before, after);
  Object.assign(lesson, { status: keep ? "kept" : "dropped", before, after, verdict, decidedAt: new Date().toISOString(), decidedBy: "test" });
  // A kept lesson changes what "before" means: the next lessons from the same
  // listings are compared with this trial, which already read it.
  if (keep)
    for (const l of await loadLessons())
      if (l.status === "proposed" && l.baseRound === lesson.baseRound) l.baseRound = trial.id;
  await saveLessons();
  console.log(`[lessons] ${lesson.id}: ${verdict}`);
}

// ---------------------------------------------------------------------------
// The beat
// ---------------------------------------------------------------------------

let busy = false;

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
      if (!trial) {
        Object.assign(l, { status: "proposed", trialRound: undefined });
        await saveLessons();
      } else if (trial.finishedAt) await decide(l, trial);
    }
    if (!AUTO) return;

    // Learn from every finished ordinary round that has enough real runs.
    for (const r of rounds.filter((x) => x.finishedAt && !x.trialOf && !x.reviewed)) {
      await markReviewed(r);
      const scored = r.results.filter((x) => x.outcome !== "error").length;
      if (scored < r.results.length / 2) continue;
      try {
        const found = await review(r);
        lessons.push(...found);
        await saveLessons();
        console.log(`[lessons] round ${r.id}: ${found.length} lesson(s) proposed`);
      } catch (err) {
        console.error(`[lessons] review of round ${r.id} failed:`, err);
      }
    }

    // One test at a time, oldest proposal first.
    if (!lessons.some((l) => l.status === "testing")) {
      const next = lessons.find((l) => l.status === "proposed");
      if (next) await testLesson(next).catch((err) => console.error(`[lessons] test of ${next.id} failed to start:`, err));
    }
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
    if (lessons.some((x) => x.status === "testing")) throw new Error("Another lesson is being tested; this one waits its turn.");
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
