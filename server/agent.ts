// =============================================================================
// Agent — an autonomous investigator with a computer, not a toolbox.
//
// There is no cadastre function, no aerial function, no triangulation logic in
// this codebase. The model is given bash / write_file / read_file (and one
// submit_answer terminator) and it writes its OWN access to public data —
// SITG, swisstopo, Overpass, the GWR register — reasoning and iterating exactly
// like a human analyst. Every turn's thinking and every command is recorded as
// the documented trace the user asked for.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { RunFiles } from "./files";
import { seedGeoHelper } from "./geo-helper";
import { buildingByEgid } from "./gwr";
import { listingFacts } from "./proof";
import {
  type LedgerEntry,
  type SearchState,
  assessCommune,
  claimedEntry,
  coverageText,
  mustCheck,
  pendingCommunes,
  searchPlanText,
  topCheckText,
} from "./search";
import {
  type Answer,
  type Confidence,
  type Job,
  type Signature,
  addStep,
  addUsage,
  finishJob,
  markStarted,
  saveSearch,
  setPromptVersion,
  setSignature,
  setAccount,
  costUsd,
  DEFAULT_MODEL,
  VARIANTS,
  apiModel,
} from "./jobs";
import { cluesText, coerceLocation } from "./locate";
import { BINDING_BETA, GEMINI_LABEL, onLogin, poolOn, THINKING } from "./claude-pool";
import { keptLessons } from "./lessons-store";
import { houseNumberOf, streetOf } from "./consensus";
import { twinsOf } from "./twins";
import { asText } from "./text";
import { searchOf } from "./agent-ledger";
import {
  type AgentImage,
  initialContent,
  isPlain,
  PLAIN_TASK,
  PROMPT_VERSION,
  pruneOldImages,
  systemOf,
  TASK,
} from "./agent-prompt";
import { clearState, loadState, saveConversation, saveState } from "./agent-state";
import { clip, dispatchTool, TOOLS } from "./agent-tools";
import { proveAnswer, unprovenAsShortlist } from "./prove";

export const MODEL = DEFAULT_MODEL;
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 150);
// Turns a run may end with no tool call before its text is taken as the conclusion.
const MAX_STALLS = 2;
// Wall-clock budget for one investigation. Checking every candidate takes longer
// than giving up early, so the cap is what keeps a hopeless search bounded.
const MAX_MINUTES = Number(process.env.AGENT_MAX_MINUTES ?? 45);
// Speed. Fast mode runs the same model at up to 2.5x the output speed for 2x the
// price; only some models offer it. AGENT_FAST=0 turns it off.
const FAST_MODELS = new Set(["claude-opus-4-8", "claude-opus-5-5"]); // 4.8: resumed old runs
const FAST_MODE = process.env.AGENT_FAST !== "0";
// Thinking depth per turn — the biggest single lever on how long a turn takes.
// "medium" or "low" is faster but looks less carefully.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT: (typeof EFFORTS)[number] = (EFFORTS as readonly string[]).includes(process.env.AGENT_EFFORT ?? "")
  ? (process.env.AGENT_EFFORT as (typeof EFFORTS)[number])
  : "high";
// Tools that only read or fetch, and touch no search state: several of them in
// one turn run at the same time. write_file and the checklist tools run alone,
// in order, so "write fetch.mjs, then run it" still works.
const PARALLEL_TOOLS = new Set(["bash", "read_file", "render_roofs", "view_from"]);

// Periodic anti-over-search nudge. Escalates as the step (or time) budget runs
// down so the model reviews its best candidate and commits instead of scanning
// forever. While the search plan still has candidates without a verdict (or
// planned communes not yet shortlisted), the periodic nudge points at THAT work
// instead of inviting an early "conclude honestly": in run c5bc3cfd the
// turn-24 nudge was followed, word for word, by giving up with ~170 neighbour
// candidates never looked at.
function convergeReminder(step: number, max: number, search?: SearchState, nearTimeLimit = false): string | null {
  if (step >= max - 15 || nearTimeLimit)
    return `[system-reminder] You are near the ${nearTimeLimit ? "time" : `${max}-step`} limit. Reach a conclusion now — an HONEST one. If the evidence has converged on one property, submit_answer with it. If it has not, submit your tightest defensible area with found=false and your ranked candidates. Do NOT fabricate a precise address just to finish, and do not open new searches.`;
  if (step >= 24 && (step - 24) % 12 === 0) {
    const open = search ? mustCheck(search).length : 0;
    const todo = search ? pendingCommunes(search, 3) : [];
    if (search && (open > 0 || todo.length > 0)) {
      return (
        `[system-reminder] ${step} steps in. Coverage: ${coverageText(search)}.` +
        (open > 0
          ? ` ${open} of ${topCheckText(search)} still have no verdict — view them (view_candidates) and mark them (mark_candidates) before anything else.`
          : "") +
        (todo.length > 0 ? ` Not yet shortlisted, in plan order: ${todo.join(", ")}.` : "") +
        ` If a candidate already matches EVERY hard signal, confirm it and submit_answer.`
      );
    }
    return `[system-reminder] ${step} steps in. Stop and assess your strongest candidate: does it match EVERY hard signal in the listing (area/footprint, era, floors, orientation, background landmarks, amenity distances)? If the signals CONVERGE, that is confirmation — submit_answer now and do not reopen the search (re-searching after convergence is how the right property gets discarded). If they do NOT converge, name the single check that would resolve it and do only that — or conclude honestly (found=false + candidates). Do not keep scanning the same way, and do not commit just because a candidate is the "best" of a weak field.`;
  }
  return null;
}

// Pull the model's own reasoning (thinking + any visible text) out of a turn.
export function extractReasoning(content: Anthropic.Messages.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === "thinking" && b.thinking) parts.push(b.thinking);
    else if (b.type === "text" && b.text) parts.push(b.text);
  }
  return clip(parts.join("\n\n").trim(), 20_000);
}

function coerceSignature(input: Record<string, unknown>): Signature {
  const raw = Array.isArray(input.clues) ? input.clues : [];
  const clues = raw
    .map((c) => (typeof c === "string" ? c.trim() : String(c ?? "").trim()))
    .filter(Boolean)
    .slice(0, 30);
  const svg =
    typeof input.schematic_svg === "string" && input.schematic_svg.trim()
      ? clip(input.schematic_svg, 20_000)
      : undefined;
  return { clues, schematicSvg: svg, location: coerceLocation(input.location) };
}

function coerceAnswer(input: Record<string, unknown>): Answer {
  const conf = asText(input.confidence, "unknown") as Confidence;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const candsRaw = Array.isArray(input.candidates) ? input.candidates : [];
  return {
    found: Boolean(input.found),
    address: str(input.address),
    parcel: str(input.parcel),
    parcels: (Array.isArray(input.parcels) ? input.parcels : [])
      .map((p) => (p ?? {}) as Record<string, unknown>)
      .filter((p) => str(p.commune) && str(p.plot))
      .map((p) => ({ commune: String(p.commune).trim(), plot: String(p.plot).trim(), egrid: str(p.egrid) })),
    commune: str(input.commune),
    confidence: conf,
    latitude: num(input.latitude),
    longitude: num(input.longitude),
    reasoning: asText(input.reasoning),
    candidates: candsRaw.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return { parcel: str(o.parcel), address: str(o.address), note: asText(o.note) };
    }),
    links: Array.isArray(input.links) ? input.links.filter((l): l is string => typeof l === "string") : [],
  };
}

// Start a fresh investigation. The whole conversation is persisted every turn
// (see runLoop) so the run survives a process restart.
export async function runInvestigation(
  job: Job,
  images: AgentImage[],
  listingText: string | undefined,
  // A cross-check starts from the checklist of the search it checks.
  seed?: Pick<SearchState, "shortlisted" | "candidates">,
): Promise<void> {
  // Attribute this run to the exact prompt it will use: stamp the version and
  // save the full prompt text next to the trace. This is what lets a later
  // post-mortem know which prompt produced these costs and this reasoning.
  // The lessons are fixed at the start, so a resumed run keeps reading the same ones.
  job.lessons ??= isPlain(job) ? [] : (job.input.lessons ?? (await keptLessons()));
  await stampPrompt(job);
  await seedGeoHelper(job.runDir); // drop the tested geo.mjs into the working dir
  await markStarted(job); // start the elapsed-time clock
  // Where to look: commune confidence + neighbour ring, decided in code from the
  // listing before the model starts, and handed to it as the SEARCH PLAN.
  const search = await assessCommune(job.input.municipality, listingText);
  if (job.input.topCheck) search.topCheck = job.input.topCheck;
  if (seed) {
    search.shortlisted = [...seed.shortlisted];
    search.candidates = structuredClone(seed.candidates);
  }
  await saveSearch(job, search);
  const plan = searchPlanText(search);
  await addStep(job, { kind: "note", title: `Search plan: commune confidence ${search.confidence}`, detail: plan });
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: initialContent(images, listingText, plan, isPlain(job)) },
  ];
  await saveState(job, 0, messages);
  await runLoop(job, messages, 0);
}

// Record which prompt governs a run: the version hash on the job (persisted in
// job.json) and the verbatim prompt in prompt.txt (served via /:id/prompt).
async function stampPrompt(job: Job): Promise<void> {
  try {
    await writeFile(
      path.join(job.runDir, "prompt.txt"),
      `# SYSTEM (version ${PROMPT_VERSION})\n\n${systemOf(job)}\n\n# TASK\n\n${isPlain(job) ? PLAIN_TASK : TASK}\n`,
      "utf8",
    );
  } catch (err) {
    console.error(`[agent] failed to save prompt for ${job.id}:`, err);
  }
  await setPromptVersion(job, PROMPT_VERSION);
}

// Why a found=false is premature, or null when the plan's work is done.
function prematureGiveUp(search: SearchState | undefined): string | null {
  if (!search || search.submitGated) return null;
  const open = mustCheck(search).length;
  const todo = pendingCommunes(search, 3);
  if (open === 0 && todo.length === 0) return null;
  return (
    `Not recorded — the search plan is not finished. Coverage: ${coverageText(search)}.` +
    (open > 0
      ? ` ${open} of ${topCheckText(search)} have never been given a verdict: view them (view_candidates) and mark them (mark_candidates).`
      : "") +
    (todo.length > 0 ? ` Planned communes not yet shortlisted: ${todo.join(", ")}.` : "") +
    ` Continue the plan; submit found=false only once it is done (or if you can name a concrete reason the rest cannot hold the property).`
  );
}

// Continue an investigation from its saved conversation — used both to recover a
// run that was mid-flight when the process died (a redeploy or crash) and to
// resume a run the user paused. The next process reloads the state and picks up
// exactly where it left off.
export async function resumeInvestigation(job: Job): Promise<void> {
  const state = await loadState(job.runDir);
  if (!state) {
    await finishJob(job, {
      status: "error",
      error: "Could not resume — no saved state was found.",
    });
    return;
  }
  // A paused job is not "running" until now; clear any stale flags and mark it
  // running so the client starts polling again.
  job.pauseRequested = false;
  job.cancelRequested = false;
  await finishJob(job, { status: "running" });
  // The prompt is read live each turn, so a run resumed after a redeploy will
  // finish under whatever prompt is now deployed. If that differs from the one
  // it started under, record the switch in the trace and re-stamp, so the
  // post-mortem isn't misled about which prompt governed the later turns.
  const changed = job.promptVersion && job.promptVersion !== PROMPT_VERSION;
  await addStep(job, {
    kind: "note",
    title: "Resumed",
    detail: changed
      ? `Continuing from turn ${state.turn}. Prompt changed since start (${job.promptVersion} → ${PROMPT_VERSION}); remaining turns run under the new prompt.`
      : `Continuing from turn ${state.turn}.`,
  });
  if (changed) await stampPrompt(job);
  await runLoop(job, state.messages, state.turn);
}

// The investigation loop, shared by fresh and resumed runs. `startTurn` is the
// number of model turns already completed, so the step budget and the
// convergence nudges stay consistent across a restart.
async function runLoop(job: Job, messages: Anthropic.Messages.MessageParam[], startTurn: number): Promise<void> {
  // Which Claude login the run is on (claude-pool.ts; null = the API key) and
  // the picture uploads made through each one — pictures belong to an account.
  let login: string | null = job.account ?? null;
  const filesByLogin = new Map<string | null, RunFiles>();
  const filesFor = async (client: Anthropic, label: string | null): Promise<RunFiles> => {
    let f = filesByLogin.get(label);
    if (!f) {
      f = await RunFiles.load(client, job.runDir, label, label === GEMINI_LABEL);
      filesByLogin.set(label, f);
      const lost = await f.verify(); // a map left by a resumed run may hold expired references
      if (lost > 0)
        await addStep(job, { kind: "note", title: `${lost} uploaded picture(s) had expired and are sent again` });
    }
    return f;
  };
  let waitedMs = 0; // time spent waiting for a login to come back; not counted as working time

  try {
    // Active running time only: a run paused for a day, or resumed after a
    // redeploy, must not trip the time limit on its first turn.
    const activeBefore = job.activeMs ?? 0;
    const loopStart = Date.now();
    const elapsedMinutes = () => {
      job.activeMs = activeBefore + (Date.now() - loopStart - waitedMs);
      return job.activeMs / 60_000;
    };
    const maxMinutes = job.input.maxMinutes ?? MAX_MINUTES;
    const nearTimeLimit = () => elapsedMinutes() >= maxMinutes * 0.85;
    const nearLimit = (step: number) => step >= MAX_STEPS - 15 || nearTimeLimit();
    let fastUnavailable = false;
    let stalls = 0; // turns that ended with no tool call and no answer
    for (let i = startTurn; i < MAX_STEPS; i++) {
      if (elapsedMinutes() >= maxMinutes) {
        if (await answerAtLimit(job, `the ${maxMinutes}-minute limit`)) return;
        if (job.input.maxMinutes != null) job.overBudget = true;
        await finishJob(job, {
          status: "done",
          answer: coerceAnswer({
            found: false,
            confidence: "unknown",
            reasoning:
              `Did not converge within the ${maxMinutes}-minute limit.` +
              (job.search ? ` Coverage: ${coverageText(job.search)}.` : ""),
          }),
        });
        return;
      }
      const budget = job.input.budgetUsd;
      if (budget != null && costUsd(job.tokens, job.model) >= budget) {
        if (await answerAtLimit(job, `its $${budget.toFixed(2)} budget`)) return;
        job.overBudget = true;
        await addStep(job, { kind: "note", title: `Stopped at its $${budget.toFixed(2)} budget` });
        await finishJob(job, {
          status: "done",
          answer: coerceAnswer({
            found: false,
            confidence: "unknown",
            reasoning:
              `Stopped at its $${budget.toFixed(2)} budget after ${i} steps.` +
              (job.search ? ` Coverage: ${coverageText(job.search)}.` : ""),
          }),
        });
        return;
      }
      if (job.cancelRequested) {
        await addStep(job, { kind: "note", title: "Stopped by the user" });
        await finishJob(job, {
          status: "cancelled",
          answer: coerceAnswer({
            found: false,
            confidence: "unknown",
            reasoning: `Stopped by the user after ${i} steps.`,
          }),
        });
        return;
      }
      // Pause boundary: `messages` currently ends on a user turn (a clean resume
      // point) and state.json is up to date, so the run can continue later. Keep
      // the saved state (the finally only clears it on a TERMINAL status).
      if (job.pauseRequested) {
        job.pauseRequested = false;
        await addStep(job, { kind: "note", title: "Paused by the user" });
        await finishJob(job, { status: "paused" });
        return;
      }

      const model = apiModel(job.model ?? MODEL);
      const request = (files: RunFiles): Anthropic.Messages.MessageCreateParamsNonStreaming => ({
        model,
        max_tokens: 16_000,
        // display: "summarized" so the model's reasoning is actually returned
        // (Opus 5.5 / Fable 5 omit thinking text by default) — that's the trace.
        // adaptive thinking is valid on both models (Fable rejects only
        // disabled/budget_tokens, which we never send).
        thinking: THINKING, // adaptive, summarized; survives a switch of key (claude-pool.ts)
        // Pin effort so every model runs at the same depth — Opus 5.5 would
        // otherwise default to "medium" while the others default to "high".
        output_config: { effort: (job.model && VARIANTS[job.model]?.effort) || EFFORT },
        // Cache the static tools + system prompt (re-sent every turn). The
        // breakpoint on the system block covers tools + system together.
        system: [{ type: "text", text: systemOf(job), cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        // Top-level auto-caching rolls a second breakpoint over the growing
        // conversation — so the re-sent listing photos and the aerials the
        // model has already downloaded are read from cache, not reprocessed.
        cache_control: { type: "ephemeral" },
        messages: files.wire(messages),
      });
      // Fast mode is an API-key feature; subscription logins run at standard speed.
      let fast = FAST_MODE && FAST_MODELS.has(model) && !fastUnavailable && !poolOn();
      const turn = await onLogin(
        login ?? undefined,
        async (client, label) => {
          const files = await filesFor(client, label);
          await files.upload(messages);
          if (pruneOldImages(messages, files.isInline)) await saveState(job, i, messages);
          const params = request(files);
          try {
            return fast
              ? ((await client.beta.messages.create({
                  ...(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
                  speed: "fast",
                  betas: ["fast-mode-2026-02-01", BINDING_BETA], // betas replace the client's own beta header
                })) as unknown as Anthropic.Messages.Message)
              : await client.messages.create(params);
          } catch (err) {
            // Fast mode has its own rate limit: when it is exhausted (or refused),
            // finish the run at standard speed instead of failing it.
            if (!fast || !(err instanceof Anthropic.RateLimitError || err instanceof Anthropic.BadRequestError))
              throw err;
            fastUnavailable = true;
            fast = false;
            await addStep(job, { kind: "note", title: "Fast mode unavailable — continuing at standard speed" });
            return await client.messages.create(params);
          }
        },
        model,
      );
      const resp = turn.value;
      waitedMs += turn.waitedMs;
      if (turn.label !== login) {
        if (login && turn.label && turn.label !== GEMINI_LABEL)
          await addStep(job, {
            kind: "note",
            title: `Claude login ${login} is unavailable (limit reached or refused) — continuing on ${turn.label}`,
          });
        login = turn.label;
        await setAccount(job, login);
      }

      // Record token usage for this turn (input includes cache traffic so the
      // total reflects what actually moved through the model).
      const u = resp.usage;
      if (u) {
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        const inTok = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
        await addUsage(job, inTok, u.output_tokens ?? 0, cacheRead, cacheWrite, fast);
      }

      if (resp.stop_reason === "refusal") {
        await finishJob(job, { status: "error", error: "The model declined to analyze this listing." });
        return;
      }

      const reasoning = extractReasoning(resp.content);
      if (reasoning) await addStep(job, { kind: "reasoning", title: "Reasoning", reasoning });

      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0 && stalls < MAX_STALLS) {
        // A turn with no tool call is not an answer: Gemini 3.1 Pro sometimes
        // ends a turn by echoing a tool's output, or by looping on one token
        // ("ststst…"), after a minute or two. Send it back to work instead of
        // recording that text as its conclusion.
        stalls++;
        await addStep(job, { kind: "note", title: "No tool call and no answer — sent back to work" });
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "[system] Your last turn called no tool and gave no answer, so nothing was recorded. Continue the search with your tools, or call submit_answer — an answer exists only through submit_answer.",
            },
          ],
        });
        await saveState(job, i + 1, messages);
        continue;
      }
      if (toolUses.length === 0) {
        // Still no tool call after being sent back: treat its text as the conclusion.
        await finishJob(job, {
          status: "done",
          answer: coerceAnswer({ found: false, confidence: "unknown", reasoning }),
        });
        return;
      }

      // A run of consecutive read/fetch-only calls is started together when the
      // loop reaches its first call — after every call before it has finished —
      // and its outputs are then used in order, as if run one by one.
      const early = new Map<string, Promise<Anthropic.Messages.ToolResultBlockParam["content"]>>();
      const startGroup = (from: number) => {
        for (let k = from; k < toolUses.length && PARALLEL_TOOLS.has(toolUses[k].name); k++) {
          const tu = toolUses[k];
          const out = dispatchTool(job, tu.name, tu.input as Record<string, unknown>);
          // Awaited in order below; if an earlier one throws, the run ends and
          // a later failure must not surface as an unhandled rejection.
          out.catch(() => {});
          early.set(tu.id, out);
        }
      };

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (let idx = 0; idx < toolUses.length; idx++) {
        const tu = toolUses[idx];
        if (PARALLEL_TOOLS.has(tu.name) && !early.has(tu.id)) startGroup(idx);
        if (tu.name === "submit_answer") {
          const answer = coerceAnswer(tu.input as Record<string, unknown>);
          // A "not found" while the plan still has unchecked candidates (or
          // planned communes never shortlisted) is turned back ONCE — giving up
          // with the answer still unviewed is how run c5bc3cfd was lost. Near
          // the step/time limit it always goes through.
          // A tie-breaker compares two houses; its "neither" is an answer, not giving up.
          const gate =
            !answer.found && !nearLimit(i + 1) && !isPlain(job) && !job.input.tieBreak
              ? prematureGiveUp(job.search)
              : null;
          if (gate && job.search) {
            job.search.submitGated = true;
            await saveSearch(job, job.search);
            await addStep(job, { kind: "note", title: "Not finished yet — search plan incomplete", detail: gate });
            results.push({ type: "tool_result", tool_use_id: tu.id, content: gate, is_error: true });
            continue;
          }
          // The tie-breaker may name another house only once it rejected every named one (tiebreak.ts).
          if (job.input.tieBreak && answer.found && EXACT.has(answer.confidence) && !nearLimit(i + 1)) {
            const search = searchOf(job);
            const picked = claimedEntry(search, {
              lat: answer.latitude,
              lon: answer.longitude,
              address: answer.address,
            });
            const named = (job.input.tieBreakEgids ?? [])
              .map((e) => search.candidates[e])
              .filter((c): c is LedgerEntry => !!c);
            const other = !picked || !named.some((c) => c.egid === picked.egid);
            const open = named.filter((c) => c.verdict !== "rejected");
            if (other && open.length && (search.thirdGates ?? 0) < 2) {
              search.thirdGates = (search.thirdGates ?? 0) + 1;
              await saveSearch(job, search);
              const msg = `Not recorded — you named another house while ${open.map((c) => c.address ?? `EGID ${c.egid}`).join(" and ")} ${open.length > 1 ? "are" : "is"} not rejected. Inspect ${open.length > 1 ? "them" : "it"} and mark each match or rejected with the visible difference; another house counts only once every named one is rejected.`;
              await addStep(job, {
                kind: "note",
                title: "Answer sent back — named houses not all rejected",
                detail: msg,
              });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
              continue;
            }
          }
          // The tie-breaker's pick does not count while the register contradicts
          // the listing (Daniel, 09.10): it is recorded as a candidate, not found.
          if (job.input.tieBreak && answer.found && EXACT.has(answer.confidence)) {
            const search = searchOf(job);
            const picked = claimedEntry(search, {
              lat: answer.latitude,
              lon: answer.longitude,
              address: answer.address,
            });
            const why = picked ? await registerContradiction(job, picked).catch(() => null) : null;
            if (why) {
              Object.assign(answer, {
                found: false,
                confidence: "block",
                reasoning: `${answer.reasoning}\n\nNot confirmed: the register contradicts the listing — ${why}.`,
              });
              await addStep(job, {
                kind: "note",
                title: "Pick not confirmed — the register contradicts it",
                detail: why,
              });
            }
          }
          // An exact address is recorded only once it is proven (proveAnswer).
          // Unproven, it goes back with what is missing (up to 3 times); near
          // the limit, or after that, it is recorded as a ranked shortlist.
          let final = answer;
          // Practice: an answer short of an exact house is first tried as a
          // twin pick, then sent back while the top of the ranked list is unseen.
          if (
            job.input.noProof &&
            !(answer.found && EXACT.has(answer.confidence)) &&
            !isPlain(job) &&
            !job.input.tieBreak
          ) {
            const pick = await twinPick(job, answer).catch(() => null);
            if (pick) {
              final = pick;
              await addStep(job, {
                kind: "note",
                title: "Twin pick",
                detail: `${pick.address} and ${pick.twinPick!.other} are attached twins at one street number; the plot closest to the listing was named.`,
              });
            } else {
              const search = searchOf(job);
              const gap = unseenTop(search);
              if (gap && !nearLimit(i + 1) && (search.unsureGates ?? 0) < 3) {
                search.unsureGates = (search.unsureGates ?? 0) + 1;
                await saveSearch(job, search);
                await addStep(job, { kind: "note", title: "Not finished yet — top of the list unseen", detail: gap });
                results.push({ type: "tool_result", tool_use_id: tu.id, content: gap, is_error: true });
                continue;
              }
            }
          }
          if (final === answer && answer.found && EXACT.has(answer.confidence) && job.input.noProof) {
            // No proof gate: recorded as given, with the register facts beside it for the reader.
            const pr = await proveAnswer(job, answer).catch(() => null);
            if (pr?.proof) final = { ...answer, proof: pr.proof };
            // Two sanity checks, each answer turned back at most twice in all (05.10:
            // a run answered "2036"; two answered houses whose plot was 3x and 8x
            // the listed land, and said so themselves).
            const search = searchOf(job);
            const problem = sanityProblem(job, answer, pr?.proof?.egid ?? undefined);
            if (problem && !nearLimit(i + 1) && (search.sanityGates ?? 0) < 2) {
              search.sanityGates = (search.sanityGates ?? 0) + 1;
              await saveSearch(job, search);
              await addStep(job, { kind: "note", title: "Answer sent back", detail: problem });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: problem, is_error: true });
              continue;
            }
          } else if (answer.found && EXACT.has(answer.confidence)) {
            const search = searchOf(job);
            const pr = await proveAnswer(job, answer);
            const asks = [...pr.blocking, ...((search.foundGates ?? 0) === 0 ? pr.soft : [])];
            if (asks.length && !nearLimit(i + 1) && (search.foundGates ?? 0) < 3) {
              search.foundGates = (search.foundGates ?? 0) + 1;
              await saveSearch(job, search);
              const msg =
                `Not recorded — this address is not proven yet:\n${asks.map((x) => `- ${x}`).join("\n")}\n` +
                `Do that and submit again, or submit found=false at block confidence with your ranked candidates.`;
              await addStep(job, { kind: "note", title: "Not proven yet — answer sent back", detail: msg });
              results.push({ type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true });
              continue;
            }
            final = pr.blocking.length ? unprovenAsShortlist(answer, pr.blocking) : answer;
            if (pr.proof) final = { ...final, proof: pr.proof };
          }
          const rankNote = job.search ? answerRank(job.search, final) : null;
          if (rankNote) await addStep(job, { kind: "note", title: "Checking order", detail: rankNote });
          await addStep(job, {
            kind: "answer",
            title: final.found ? (final.address ?? final.parcel ?? "Answer") : "No proven match",
            detail: final.reasoning,
          });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          await finishJob(job, { status: "done", answer: final });
          return;
        }
        if (tu.name === "record_signature") {
          const sig = coerceSignature(tu.input as Record<string, unknown>);
          await setSignature(job, sig);
          await addStep(job, {
            kind: "note",
            title: "Target signature",
            detail:
              sig.clues.map((c, i) => `${i + 1}. ${c}`).join("\n") +
              (sig.location ? `\nLocation clues: ${cluesText(sig.location)}` : ""),
          });
          // The neighbours were never filled at low effort (0 of 98 practice
          // runs, 05.10): asked for once, since they single a house out.
          const search = searchOf(job);
          if (!sig.location?.neighbours?.length && !search.neighboursAsked && !isPlain(job)) {
            search.neighboursAsked = true;
            await saveSearch(job, search);
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content:
                "Recorded, but location.neighbours is empty. Look at the photos again: which buildings stand next to the house (side, gap, size, height, roof) and which sides are open (none: true)? Call record_signature once more with them filled — they are what tells look-alike houses apart.",
            });
            continue;
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "recorded" });
          continue;
        }
        const out = await (early.get(tu.id) ?? dispatchTool(job, tu.name, tu.input as Record<string, unknown>));
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      const content: Anthropic.Messages.ContentBlockParam[] = [...results];
      const nudge = convergeReminder(i + 1, MAX_STEPS, job.search, nearTimeLimit());
      if (nudge) content.push({ type: "text", text: nudge });
      messages.push({ role: "user", content });
      // Checkpoint: the conversation now ends on a user turn — a clean point to
      // resume from if the process dies before the next model turn.
      await saveState(job, i + 1, messages);
    }

    await finishJob(job, {
      status: "done",
      answer: coerceAnswer({
        found: false,
        confidence: "unknown",
        reasoning: `Did not converge within ${MAX_STEPS} steps.`,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addStep(job, { kind: "error", title: "Investigation error", detail: message });
    await finishJob(job, { status: "error", error: message });
  } finally {
    // Drop the saved conversation only on a TERMINAL status. A "paused" job keeps
    // its state so it can be resumed; "running" would be a live loop.
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      // Keep the whole thread — photos, text, every tool call and result, the
      // model's reasoning — exactly as the model saw it, for the export.
      await saveConversation(job, messages);
      await clearState(job);
      for (const f of Array.from(filesByLogin.values())) await f.deleteAll();
    }
  }
}

const EXACT: ReadonlySet<Confidence> = new Set<Confidence>(["street", "building"]);

// Practice (Daniel, 05.10): of 7 runs that ended "not sure" with time left, 6
// had the right house in the top 150 of their ranked list, unseen. A run may
// not stop short of an exact answer before it has viewed or judged them.
const TOP_LOOK = 150;
// Big communes (Daniel, 09.10): past 2000 homes the top 300 must be seen.
const TOP_LOOK_BIG = 300,
  BIG_LIST = 2000;
function unseenTop(search: SearchState): string | null {
  const calls = (search.calls ?? []).filter((c) => c.order?.length);
  if (!calls.length) return null;
  const commune = calls[0].commune;
  const list = [...calls].reverse().find((c) => c.commune === commune)!.order!;
  const seen = new Set(
    Object.values(search.candidates)
      .filter((c) => c.viewed || c.verdict !== "unchecked")
      .map((c) => String(Number(c.egid))),
  );
  const top = list.slice(0, list.length > BIG_LIST ? TOP_LOOK_BIG : TOP_LOOK);
  const unseen = top.filter((e) => !seen.has(String(e)));
  if (!unseen.length) return null;
  const first = top.findIndex((e) => !seen.has(String(e))) + 1;
  return (
    `Not recorded — ${unseen.length} of the top ${top.length} homes on the ${commune} ranked list have not been viewed yet (the first is #${first}). ` +
    `In past searches the right house was usually there. Get them with shortlist_buildings (same commune, next page), view them (view_candidates) and mark the ones that fit; then answer.`
  );
}

/**
 * A tie-breaker's pick the building register contradicts, or null (Daniel,
 * 09.10): more than 3 homes for a single house, a living area more than 35%
 * off, rooms more than 2.5 off, or a plot more than 15% off the listed land.
 */
async function registerContradiction(job: Job, e: LedgerEntry): Promise<string | null> {
  const l = listingFacts(job.input.listingText);
  const b = await buildingByEgid(e.egid).catch(() => null);
  const out: string[] = [];
  if (l.kind === "house" && b?.dwellings != null && b.dwellings > 3)
    out.push(`${b.dwellings} homes in the building for a single house`);
  if (l.kind === "house" && l.livingM2 && b?.livingM2 && Math.abs(b.livingM2 - l.livingM2) / l.livingM2 > 0.35)
    out.push(`a living area of ${b.livingM2} m² for ${l.livingM2} m² listed`);
  if (l.kind === "house" && l.rooms && b?.rooms && Math.abs(l.rooms - b.rooms) > 2.5)
    out.push(`${b.rooms} rooms for ${l.rooms} listed`);
  const plot = e.plotGroup?.length ? e.plotGroup.reduce((t, p) => t + p.areaM2, 0) : e.plot?.areaM2;
  if (l.kind === "house" && l.landM2 && !l.sharedLand && plot && Math.abs(plot - l.landM2) / l.landM2 > 0.15)
    out.push(`a plot of ${Math.round(plot)} m² for ${l.landM2} m² listed`);
  return out.length ? out.join("; ") : null;
}

/**
 * Practice: an answer that could not choose between two attached twins at one
 * street number ("Via Muraccio 61b" or "61c") names the one whose plot is
 * closest to the listed land, flagged as a twin pick (Daniel, 05.10: "ONLY IF
 * EXACTLY TWIN AND STUCK TOGETHER", never at another address).
 */
async function twinPick(job: Job, a: Answer): Promise<Answer | null> {
  const land = listingFacts(job.input.listingText).landM2;
  const search = job.search;
  if (!land || !search) return null;
  const named = [a.address, ...a.candidates.map((c) => c.address)].filter((x): x is string => !!x);
  const byAddress = (addr: string) => {
    const st = streetOf(addr),
      no = houseNumberOf(addr);
    return Object.values(search.candidates).find(
      (c) => c.address && streetOf(c.address) === st && houseNumberOf(c.address) === no,
    );
  };
  const entries = Array.from(new Set(named.map(byAddress).filter((c): c is NonNullable<typeof c> => !!c && !!c.plot)));
  if (entries.length !== 2) return null;
  const [x, y] = entries;
  const base = (addr: string) => `${streetOf(addr)} ${(houseNumberOf(addr) ?? "").replace(/[a-z]$/, "")}`;
  if (!x.address || !y.address || base(x.address) !== base(y.address) || !houseNumberOf(x.address)) return null;
  if (!(await twinsOf(x.egid)).includes(String(Number(y.egid)))) return null;
  const [best, other] = Math.abs(x.plot!.areaM2 - land) <= Math.abs(y.plot!.areaM2 - land) ? [x, y] : [y, x];
  const picked: Answer = {
    ...a,
    found: true,
    confidence: "building",
    address: best.address,
    parcel: best.plot!.number,
    reasoning: `${a.reasoning}\n\nTwin pick: ${best.address} (plot ${Math.round(best.plot!.areaM2)} m²) and ${other.address} (plot ${Math.round(other.plot!.areaM2)} m²) are attached twins; the plot closest to the listed ${land} m² was named.`,
    twinPick: { other: other.address! },
  };
  const pr = await proveAnswer(job, picked).catch(() => null);
  return pr?.proof ? { ...picked, proof: pr.proof } : picked;
}

/** Practice: why an exact answer cannot stand as given, or null. */
function sanityProblem(job: Job, a: Answer, egid: string | number | undefined): string | null {
  const first = (a.address ?? "").split(",")[0];
  if (!/[A-Za-zÀ-ÿ]{3}/.test(first) || !/\d/.test(first))
    return 'Not recorded — an answer must be a street address with a house number ("Steinweg 21, Aesch"). Give the building\'s address, or submit found=false with your ranked candidates.';
  const facts = listingFacts(job.input.listingText);
  // A flat's "land" is its garden share of a co-owned plot, never the plot
  // (Saladin 9a, Chêne-Bougeries, 16.10: 308 m² of private garden on a 1,489 m²
  // PPE plot — the right house, sent back twice and lost).
  const land = facts.kind === "flat" || facts.sharedLand ? null : facts.landM2;
  const e = egid != null ? searchOf(job).candidates[String(Number(egid))] : undefined;
  const plot = e?.plotGroup?.length ? e.plotGroup.reduce((t, p) => t + p.areaM2, 0) : e?.plot?.areaM2;
  if (land && plot && (plot > 2 * land || plot < land / 2))
    return `Not recorded — this house's plot is ${Math.round(plot)} m² and the listing states ${land} m² of land: that is not the same property. Keep looking (the next candidates on your list), or submit found=false with your ranked candidates.`;
  return null;
}

/**
 * At a time or spend limit: if the run already marked exactly one candidate as
 * its match and that match passes the proof (PROOF: decisive, or everything
 * settled), record it instead of "not found". In the first practice rounds 7
 * runs ended over the limit holding the right house as their match.
 */
async function answerAtLimit(job: Job, limit: string): Promise<boolean> {
  const search = job.search;
  if (!search) return false;
  const matches = Object.values(search.candidates).filter((c) => c.verdict === "match");
  if (matches.length !== 1) return false;
  const m = matches[0];
  const answer = coerceAnswer({
    found: true,
    confidence: "building",
    address: m.address ?? undefined,
    latitude: m.lat,
    longitude: m.lon,
    reasoning: `Recorded at ${limit}: the one candidate marked match, ${m.address ?? m.egid}, passes the proof.`,
  });
  const pr = await proveAnswer(job, answer).catch(() => null);
  if (!pr || pr.blocking.length || !pr.proof) return false;
  const final = { ...answer, proof: pr.proof };
  await addStep(job, { kind: "answer", title: final.address ?? "Answer", detail: final.reasoning });
  await finishJob(job, { status: "done", answer: final });
  return true;
}

// Where the answer stood in the checking order of its commune — the measure of
// whether the shortlist's ordering (location clues, footprint) put it early.
function answerRank(search: SearchState, answer: Answer): string | null {
  const claim = claimedEntry(search, { lat: answer.latitude, lon: answer.longitude, address: answer.address });
  if (!claim) return null;
  const line = Object.values(search.candidates)
    .filter((c) => c.commune === claim.commune)
    .sort((a, b) => a.order - b.order);
  const k = line.indexOf(claim) + 1;
  return (
    `The answer (${claim.address ?? claim.egid}) was #${k} of ${line.length} in ${claim.commune}'s checking order` +
    ` (contact sheet ${Math.ceil(k / 16)})` +
    (claim.loc ? `; location fit ${claim.loc.score.toFixed(2)}: ${claim.loc.why}.` : "; no location score.")
  );
}
