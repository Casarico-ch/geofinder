// =============================================================================
// Team runs — two models search the same listing side by side, each with its
// own computer and checklist, and talk in a shared room like a group chat.
//
// Two or more members (Sonnet + Opus, or a crowd of one model). Nobody waits
// on anybody. Every turn, each one is shown what its teammates posted since it
// last looked, and it can read their recent traces
// (team_read) or post / reply (team_post). An answer is a VOTE: the team stops
// only when both have voted for the same building at >= 95 % certainty. If one
// of them stops for any other reason (limit, error, cancel), the other carries
// on and finishes under the normal solo rules.
//
// The room is a file (RUNS_ROOT/_teams/<id>.json), so it outlives a restart.
// =============================================================================
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNS_ROOT } from "./sandbox";
import { getJob, type Answer, type Job } from "./jobs";
import { coverageText } from "./search";
import { sameAddress, type Candidate } from "./consensus";

export const AGREE_AT = 95; // both must be at least this sure of the same building

export interface TeamPost {
  id: number;
  at: string;
  from: string; // job id
  model: string;
  text: string;
  replyTo?: number;
  ask?: boolean; // a direct question: whoever it is addressed to answers it next
  to?: string; // the member asked (their chat name); unset = everyone
  // Like a doctor on the panel, every message carries where its author stands.
  leading?: string; // current best candidate (address / EGID), or "none yet"
  certainty?: number; // 0–100
}

export interface TeamVote {
  key: string; // what identifies the building (EGID, else the normalized address)
  certainty: number; // 0–100
  answer: Answer;
  at: string;
}

export interface TeamRoom {
  id: string;
  members: string[]; // job ids
  posts: TeamPost[];
  seen: Record<string, number>; // job id → last post id it was shown
  votes: Record<string, TeamVote>;
  lastPostTurn?: Record<string, number>; // job id → the turn it last posted on
  agreed?: { key: string; answer: Answer; at: string };
}

// RUNS_ROOT can fall back at boot, so the folder is resolved on each use.
const dir = () => path.join(RUNS_ROOT, "_teams");
const rooms = new Map<string, TeamRoom>();
const queue = new Map<string, Promise<unknown>>();

const file = (id: string) => path.join(dir(), `${id.replace(/[^\w-]/g, "")}.json`);

async function load(id: string): Promise<TeamRoom> {
  const hit = rooms.get(id);
  if (hit) return hit;
  let room: TeamRoom;
  try {
    room = JSON.parse(await readFile(file(id), "utf8")) as TeamRoom;
  } catch {
    room = { id, members: [], posts: [], seen: {}, votes: {} };
  }
  rooms.set(id, room);
  return room;
}

async function save(room: TeamRoom): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const tmp = `${file(room.id)}.tmp`;
  await writeFile(tmp, JSON.stringify(room, null, 2));
  await rename(tmp, file(room.id));
}

// Both members run in the same process, so changes to one room are chained.
function withRoom<T>(id: string, fn: (room: TeamRoom) => T | Promise<T>): Promise<T> {
  const prev = queue.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const room = await load(id);
    const out = await fn(room);
    await save(room);
    return out;
  });
  queue.set(id, next.catch(() => {}));
  return next;
}

export function getRoom(id: string): Promise<TeamRoom> {
  return load(id);
}

export async function joinTeam(id: string, jobId: string): Promise<void> {
  await withRoom(id, (room) => {
    if (!room.members.includes(jobId)) room.members.push(jobId);
  });
}

const label = (model: string) => model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2");

/**
 * A member's name in the chat: its model, numbered when the team has several
 * of the same model ("haiku 4.5 #3"). Numbers follow join order, which is fixed
 * once a member has joined, so a name never changes.
 */
export function memberName(room: TeamRoom, jobId: string): string {
  const model = (id: string) => getJob(id)?.model ?? "";
  const mine = model(jobId);
  const same = room.members.filter((m) => model(m) === mine);
  const base = mine ? label(mine) : "member";
  return same.length > 1 ? `${base} #${same.indexOf(jobId) + 1}` : base;
}

const others = (room: TeamRoom, me: string) => room.members.filter((m) => m !== me);

/** Teammates still searching. */
function liveMates(room: TeamRoom, me: string): Job[] {
  return others(room, me)
    .map((m) => getJob(m))
    .filter((j): j is Job => !!j && j.status === "running");
}

export async function hasLiveMate(job: Job): Promise<boolean> {
  return !!job.team && liveMates(await load(job.team), job.id).length > 0;
}

const fold = (t: string) => t.toLowerCase().replace(/[^a-z0-9#.]+/g, " ").trim();
const voteText = (v: TeamVote) => `${v.answer.found ? (v.answer.address ?? v.answer.parcel ?? "found") : "no match"} at ${v.certainty}%`;

export interface PostInput {
  text: string;
  replyTo?: number;
  ask?: boolean;
  to?: string;
  leading?: string;
  certainty?: number;
}

export async function post(job: Job, input: PostInput, turn = 0): Promise<TeamPost> {
  return withRoom(job.team!, (room) => {
    const replyTo = input.replyTo && input.replyTo <= room.posts.length ? input.replyTo : undefined;
    const certainty = Number.isFinite(input.certainty) ? Math.max(0, Math.min(100, Math.round(input.certainty!))) : undefined;
    const p: TeamPost = {
      id: room.posts.length + 1,
      at: new Date().toISOString(),
      from: job.id,
      model: memberName(room, job.id),
      text: input.text.trim().slice(0, 4000),
      ...(replyTo ? { replyTo } : {}),
      ...(input.ask ? { ask: true } : {}),
      ...(input.ask && input.to?.trim() ? { to: input.to.trim().slice(0, 60) } : {}),
      ...(input.leading?.trim() ? { leading: input.leading.trim().slice(0, 200) } : {}),
      ...(certainty !== undefined ? { certainty } : {}),
    };
    room.posts.push(p);
    room.lastPostTurn = { ...room.lastPostTurn, [job.id]: turn };
    return p;
  });
}

// A member that has not posted for this many turns is asked for an update, so
// the chat keeps moving like the doctors' panel instead of going silent.
export const QUIET_TURNS = 6;

function postLine(room: TeamRoom, p: TeamPost, me: string): string {
  const who = p.from === me ? "you" : p.model;
  const re = p.replyTo ? room.posts[p.replyTo - 1] : undefined;
  const quote = re ? ` (replying to #${re.id} by ${re.from === me ? "you" : re.model}: "${re.text.slice(0, 80)}…")` : "";
  const stand = p.leading ? ` [leading: ${p.leading}${p.certainty !== undefined ? ` · ${p.certainty}%` : ""}]` : "";
  const asks = p.ask ? (p.to ? ` asks ${askedMe(room, p, me) ? "you" : p.to}` : " asks everyone") : "";
  return `#${p.id} ${who}${asks}${quote}: ${p.text}${stand}`;
}

function askedMe(room: TeamRoom, p: TeamPost, me: string): boolean {
  if (!p.ask || p.from === me) return false;
  if (!p.to) return true;
  const want = fold(p.to);
  const name = fold(memberName(room, me));
  return name === want || name.includes(want) || want.includes(name);
}

/** What the teammates said since this member last looked, as a turn note — or null. */
export async function unseen(job: Job, turn = 0): Promise<{ text: string; posts: TeamPost[] } | null> {
  return withRoom(job.team!, (room) => {
    room.lastPostTurn = { [job.id]: turn, ...room.lastPostTurn }; // the clock starts on the first turn
    const from = room.seen[job.id] ?? 0;
    const fresh = room.posts.slice(from).filter((p) => p.from !== job.id);
    room.seen[job.id] = room.posts.length;
    const votes = others(room, job.id)
      .filter((m) => room.votes[m])
      .map((m) => `${memberName(room, m)}: ${voteText(room.votes[m])}`);
    const asked = fresh.filter((p) => askedMe(room, p, job.id)).at(-1);
    const quiet = turn - (room.lastPostTurn[job.id] ?? turn) >= QUIET_TURNS;
    if (!fresh.length && !quiet) return null;
    const lines: string[] = [];
    if (fresh.length) {
      lines.push(`[team chat] New since you last looked (you are ${memberName(room, job.id)}):\n${fresh.map((p) => postLine(room, p, job.id)).join("\n")}`);
      if (votes.length) lines.push(`Current votes — ${votes.join("; ")}.`);
    }
    if (asked)
      lines.push(`${asked.model} asked you directly in #${asked.id} — answer it with team_post (reply_to ${asked.id}) this turn, from what you have.`);
    else if (quiet)
      lines.push(`[team chat] You have not posted for ${QUIET_TURNS} turns. Post one short update with team_post: what you found or ruled out since, your leading candidate and your certainty.`);
    else lines.push(`(Reply with team_post — reply_to the # you answer — or look at their work with team_read.)`);
    if (quiet) room.lastPostTurn[job.id] = turn; // one nudge per quiet stretch
    return { posts: fresh, text: lines.join("\n") };
  });
}

/** team_read: the whole chat plus each teammate's recent trace and checklist coverage. */
export async function readMate(job: Job, steps = 25): Promise<string> {
  const room = await load(job.team!);
  const chat = room.posts.length ? room.posts.map((p) => postLine(room, p, job.id)).join("\n") : "(no messages yet)";
  const mates = others(room, job.id);
  // The trace budget is shared, so a crowd does not flood the context.
  const each = Math.max(4, Math.floor(Math.max(1, Math.min(60, steps)) / Math.max(1, mates.length)));
  const parts = mates.map((id) => {
    const mate = getJob(id);
    const name = memberName(room, id);
    if (!mate) return `${name}: run not available.`;
    const trace = mate.steps
      .slice(-each)
      .map((s) => {
        const body = (s.reasoning ?? s.detail ?? "").replace(/\s+/g, " ").slice(0, s.kind === "reasoning" ? 500 : 250);
        return `  - [${s.kind}] ${s.title}${body ? ` — ${body}` : ""}`;
      })
      .join("\n");
    const vote = room.votes[id];
    return [
      `${name} — ${mate.status}, ${mate.steps.length} steps so far.`,
      mate.search ? `  Checklist: ${coverageText(mate.search)}.` : "",
      mate.signature ? `  Target signature: ${mate.signature.clues.join("; ")}` : "",
      vote ? `  Vote: ${voteText(vote)} — ${vote.answer.reasoning.slice(0, 400)}` : "  Vote: none yet.",
      `  Latest steps:\n${trace}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [`You are ${memberName(room, job.id)}.`, `Team chat:\n${chat}`, ...parts].join("\n\n");
}

/** One building, however the two members wrote it. */
export function answerKey(a: Answer): string {
  if (!a.found) return "none";
  if (a.proof?.egid) return `egid:${a.proof.egid}`;
  const addr = (a.address ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  if (addr) return `addr:${addr}`;
  const plots = a.parcels.map((p) => `${p.commune}/${p.plot}`.toLowerCase()).sort().join("+");
  return plots ? `plots:${plots}` : `ll:${a.latitude?.toFixed(4)},${a.longitude?.toFixed(4)}`;
}

function candidateOf(a: Answer): Candidate {
  const parcel = a.parcels?.length ? a.parcels.map((p) => `${p.commune} ${p.plot}`).join(", ") : a.parcel?.trim() || null;
  return { address: a.address?.trim() || a.commune?.trim() || parcel || "", parcel, latitude: a.latitude, longitude: a.longitude };
}

/**
 * Do two votes name the same building? The models word it differently
 * ("Chemin de la Croix 4 / 4a" vs "4 (and 4a)"), so compare the EGID when both
 * have one, else plot numbers, else street + house number or pins within 40 m
 * (consensus.ts sameAddress) — never the raw text.
 */
export function sameBuilding(a: Answer, b: Answer): boolean {
  if (!a.found || !b.found) return false;
  const ea = a.proof?.egid;
  const eb = b.proof?.egid;
  if (ea && eb) return ea === eb;
  return sameAddress(candidateOf(a), candidateOf(b));
}

export type VoteOutcome =
  | { kind: "agreed"; answer: Answer }
  | { kind: "waiting"; message: string };

/** Record a member's vote; the team agrees when both name the same building at AGREE_AT or more. */
export async function vote(job: Job, answer: Answer, certainty: number): Promise<VoteOutcome> {
  return withRoom(job.team!, (room) => {
    const key = answerKey(answer);
    const sure = Math.max(0, Math.min(100, Math.round(certainty)));
    room.votes[job.id] = { key, certainty: sure, answer, at: new Date().toISOString() };
    const mine = answer.address ?? answer.parcel ?? "no match";
    // Everyone still in the room — searching, or already voted — must name the
    // same building at AGREE_AT or more. A member that stopped without a vote
    // (error, limit) is not waited for.
    const inPlay = others(room, job.id).filter((m) => room.votes[m] || getJob(m)?.status === "running");
    const holdouts = inPlay.filter((m) => {
      const v = room.votes[m];
      return !v || !sameBuilding(v.answer, answer) || v.certainty < AGREE_AT;
    });
    if (answer.found && sure >= AGREE_AT && inPlay.length > 0 && holdouts.length === 0) {
      room.agreed = { key, answer, at: new Date().toISOString() };
      return { kind: "agreed" as const, answer };
    }
    const why = !answer.found
      ? "A team only stops on a building you ALL name"
      : sure < AGREE_AT
        ? `You are at ${sure}% — the team stops only when everyone is at ${AGREE_AT}% or more`
        : `Not everyone agrees yet: ${holdouts
            .map((m) => `${memberName(room, m)} ${room.votes[m] ? `votes ${voteText(room.votes[m])}` : "has not voted"}`)
            .join("; ")}`;
    return {
      kind: "waiting" as const,
      message:
        `Vote recorded (${mine}, ${sure}%) — not finished: ${why}. ` +
        `Share what you found in team_post, look at the others' finds with team_read for ideas, and keep searching your own way. ` +
        `Vote again with submit_answer whenever your view or certainty changes.`,
    };
  });
}

/** The building the team agreed on, once it has. */
export async function agreed(job: Job): Promise<Answer | null> {
  if (!job.team) return null;
  return (await load(job.team)).agreed?.answer ?? null;
}

export const TEAM_BRIEF = `TEAM RUN
You are not alone: one or more teammates are searching this same listing right now, each on its own computer with its own checklist. Nobody waits for anybody. Run YOUR OWN search, your own way — do not copy theirs, and do not stop your plan to follow them. You share a group chat, like colleagues on a forum, so you can get inspired by what the others find:
- Every turn you are shown what your teammates posted since you last looked, and your own name in the chat.
- Talk like colleagues in a group chat: your first team_post comes right after record_signature (your read of the building and where you start); then post whenever you find, rule out or doubt something. Every message says where you stand: leading (your best candidate so far, or "none yet") and certainty.
- team_post(message, leading, certainty, reply_to?, ask?, to?) shares a find: a register value, a plot that matches the listing's area, a building ruled out and what you saw, a candidate (EGID/address) worth a look, an approach that worked. Reply to a specific message by its #. Set ask (and to = a teammate's chat name, or leave to empty for everyone) when you want an answer — they answer it on their next turn. One or two short sentences, concrete, no "I agree" filler, never repeat what is already in the chat.
- team_read() shows your teammates' recent steps, checklist coverage and current votes — look when you are stuck or want ideas, and to avoid doing work someone already did.
- A clear finding from a teammate is a shared fact: take it as given and build on it. Do not re-check it, judge it or debate whether it is worth something. Only speak up when your OWN evidence contradicts it.
- submit_answer is a VOTE with a certainty (0–100). The team stops only when you ALL vote for the same building at ${AGREE_AT}% or more. Until then a vote comes back and you keep searching your own way. Never raise your certainty just to finish.`;

export const TEAM_TOOLS = [
  {
    name: "team_post",
    description:
      "Share a find in the team chat your teammates see on their next turn: a register value, a plot match, a building ruled out and why, a candidate (EGID/address), an approach that worked. reply_to answers a specific message by its #.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "one or two short sentences" },
        leading: { type: "string", description: "your current best candidate (address or EGID), or 'none yet'" },
        certainty: { type: "integer", minimum: 0, maximum: 100, description: "how sure you are of that candidate, 0–100" },
        reply_to: { type: "integer", description: "the # of the message you are answering" },
        ask: { type: "boolean", description: "true when you ask something directly; they answer next" },
        to: { type: "string", description: "with ask: the teammate's chat name (e.g. 'haiku 4.5 #2'); empty asks everyone" },
      },
      required: ["message", "leading", "certainty"],
    },
  },
  {
    name: "team_read",
    description:
      "See your teammates' work for ideas: the full team chat, each one's checklist coverage, current vote, and latest steps (commands, reasoning).",
    input_schema: {
      type: "object",
      properties: { steps: { type: "integer", description: "how many of their latest steps to show (default 25, max 60)" } },
    },
  },
];

export const CERTAINTY_FIELD = {
  type: "integer",
  minimum: 0,
  maximum: 100,
  description: `TEAM RUN: how sure you are, 0–100, that this is the property. The team stops when you all name the same building at ${AGREE_AT}+.`,
};

/** The room as the Requests page shows it: the chat, each member's vote, and the agreement. */
export async function roomView(id: string) {
  const room = await load(id);
  return {
    id: room.id,
    posts: room.posts,
    members: room.members.map((m) => {
      const j = getJob(m);
      const v = room.votes[m];
      return {
        jobId: m,
        model: j ? memberName(room, m) : null,
        status: j?.status ?? null,
        vote: v ? { place: v.answer.found ? (v.answer.address ?? v.answer.parcel ?? "found") : "no match", certainty: v.certainty, at: v.at } : null,
      };
    }),
    agreed: room.agreed ? { place: room.agreed.answer.address ?? room.agreed.answer.parcel ?? "found", at: room.agreed.at } : null,
  };
}
