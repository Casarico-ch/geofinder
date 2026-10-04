// =============================================================================
// Team runs — two models search the same listing side by side, each with its
// own computer and checklist, and talk in a shared room like a group chat.
//
// Neither waits on the other. Every turn, each one is shown what its teammate
// posted since it last looked, and it can read the teammate's recent trace
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
  ask?: boolean; // a direct question to the teammate: they answer it next
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

/** The teammate's job, while it is still searching. */
function liveMate(room: TeamRoom, me: string): Job | undefined {
  const mateId = room.members.find((m) => m !== me);
  const mate = mateId ? getJob(mateId) : undefined;
  return mate && mate.status === "running" ? mate : undefined;
}

export async function hasLiveMate(job: Job): Promise<boolean> {
  return !!job.team && !!liveMate(await load(job.team), job.id);
}

export interface PostInput {
  text: string;
  replyTo?: number;
  ask?: boolean;
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
      model: label(job.model),
      text: input.text.trim().slice(0, 4000),
      ...(replyTo ? { replyTo } : {}),
      ...(input.ask ? { ask: true } : {}),
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
  return `#${p.id} ${who}${p.ask ? " asks you" : ""}${quote}: ${p.text}${stand}`;
}

/** What the teammate said since this member last looked, as a turn note — or null. */
export async function unseen(job: Job, turn = 0): Promise<{ text: string; posts: TeamPost[] } | null> {
  return withRoom(job.team!, (room) => {
    room.lastPostTurn = { [job.id]: turn, ...room.lastPostTurn }; // the clock starts on the first turn
    const from = room.seen[job.id] ?? 0;
    const fresh = room.posts.slice(from).filter((p) => p.from !== job.id);
    room.seen[job.id] = room.posts.length;
    const mate = room.members.find((m) => m !== job.id);
    const vote = mate ? room.votes[mate] : undefined;
    const voteLine = vote
      ? `Teammate's current vote: ${vote.answer.address ?? vote.answer.parcel ?? "no match"} at ${vote.certainty}%.`
      : "";
    const asked = fresh.filter((p) => p.ask).at(-1);
    const quiet = turn - (room.lastPostTurn[job.id] ?? turn) >= QUIET_TURNS;
    if (!fresh.length && !quiet) return null;
    const lines: string[] = [];
    if (fresh.length) {
      lines.push(`[team chat] New from your teammate:\n${fresh.map((p) => postLine(room, p, job.id)).join("\n")}`);
      if (voteLine) lines.push(voteLine);
    }
    if (asked)
      lines.push(`Your teammate asked you directly in #${asked.id} — answer it with team_post (reply_to ${asked.id}) this turn, from what you have.`);
    else if (quiet)
      lines.push(`[team chat] You have not posted for ${QUIET_TURNS} turns. Post one short update with team_post: what you found or ruled out since, your leading candidate and your certainty.`);
    else lines.push(`(Reply with team_post — reply_to the # you answer — or look at their work with team_read.)`);
    if (quiet) room.lastPostTurn[job.id] = turn; // one nudge per quiet stretch
    return { posts: fresh, text: lines.join("\n") };
  });
}

/** team_read: the whole chat plus the teammate's recent trace and checklist coverage. */
export async function readMate(job: Job, steps = 25): Promise<string> {
  const room = await load(job.team!);
  const mateId = room.members.find((m) => m !== job.id);
  const mate = mateId ? getJob(mateId) : undefined;
  const chat = room.posts.length ? room.posts.map((p) => postLine(room, p, job.id)).join("\n") : "(no messages yet)";
  if (!mate) return `Team chat:\n${chat}\n\nYour teammate's run is not available.`;
  const trace = mate.steps
    .slice(-Math.max(1, Math.min(60, steps)))
    .map((s) => {
      const body = (s.reasoning ?? s.detail ?? "").replace(/\s+/g, " ").slice(0, s.kind === "reasoning" ? 600 : 300);
      return `- [${s.kind}] ${s.title}${body ? ` — ${body}` : ""}`;
    })
    .join("\n");
  const vote = room.votes[mate.id];
  return [
    `Teammate: ${label(mate.model)} — ${mate.status}, ${mate.steps.length} steps so far.`,
    mate.search ? `Their checklist: ${coverageText(mate.search)}.` : "",
    mate.signature ? `Their target signature: ${mate.signature.clues.join("; ")}` : "",
    vote ? `Their vote: ${vote.answer.address ?? vote.answer.parcel ?? "no match"} at ${vote.certainty}% — ${vote.answer.reasoning.slice(0, 600)}` : "Their vote: none yet.",
    `\nTeam chat:\n${chat}`,
    `\nTheir latest steps:\n${trace}`,
  ]
    .filter(Boolean)
    .join("\n");
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
    const mateId = room.members.find((m) => m !== job.id);
    const mine = answer.address ?? answer.parcel ?? "no match";
    const theirs = mateId ? room.votes[mateId] : undefined;
    const same = !!theirs && sameBuilding(theirs.answer, answer);
    if (answer.found && sure >= AGREE_AT && theirs && same && theirs.certainty >= AGREE_AT) {
      room.agreed = { key, answer, at: new Date().toISOString() };
      return { kind: "agreed" as const, answer };
    }
    const why = !answer.found
      ? "A team only stops on a building you BOTH name"
      : sure < AGREE_AT
        ? `You are at ${sure}% — the team stops only when you are both at ${AGREE_AT}% or more`
        : !theirs
          ? "Your teammate has not voted yet"
          : !same
            ? `Your teammate votes for ${theirs.answer.address ?? theirs.answer.parcel ?? "no match"} at ${theirs.certainty}%`
            : `Your teammate names the same building but is only at ${theirs.certainty}%`;
    return {
      kind: "waiting" as const,
      message:
        `Vote recorded (${mine}, ${sure}%) — not finished: ${why}. ` +
        `Share what you found in team_post, look at their finds with team_read for ideas, and keep searching your own way. ` +
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
You are not alone: a teammate (another model) is searching this same listing right now on its own computer, with its own checklist. You do not wait for each other. Run YOUR OWN search, your own way — do not copy theirs, and do not stop your plan to follow them. You share a group chat, like colleagues on a forum, so you can get inspired by what the other one finds:
- Every turn you are shown what your teammate posted since you last looked.
- Talk like colleagues in a group chat: your first team_post comes right after record_signature (your read of the building and where you start); then post whenever you find, rule out or doubt something. Every message says where you stand: leading (your best candidate so far, or "none yet") and certainty.
- team_post(message, leading, certainty, reply_to?, ask?) shares a find: a register value, a plot that matches the listing's area, a building ruled out and what you saw, a candidate (EGID/address) worth a look, an approach that worked. Reply to a specific message by its #. Set ask when you want your teammate to answer you directly — they answer it on their next turn. One or two short sentences, concrete, no "I agree" filler, never repeat what is already in the chat.
- team_read() shows your teammate's recent steps, checklist coverage and current vote — look when you are stuck or want ideas, and to avoid doing work they already did.
- A clear finding from your teammate is a shared fact: take it as given and build on it. Do not re-check it, judge it or debate whether it is worth something. Only speak up when your OWN evidence contradicts it.
- submit_answer is a VOTE with a certainty (0–100). The team stops only when you BOTH vote for the same building at ${AGREE_AT}% or more. Until then a vote comes back and you keep searching your own way. Never raise your certainty just to finish.`;

export const TEAM_TOOLS = [
  {
    name: "team_post",
    description:
      "Share a find in the team chat your teammate sees on their next turn: a register value, a plot match, a building ruled out and why, a candidate (EGID/address), an approach that worked. reply_to answers a specific message by its #.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "one or two short sentences" },
        leading: { type: "string", description: "your current best candidate (address or EGID), or 'none yet'" },
        certainty: { type: "integer", minimum: 0, maximum: 100, description: "how sure you are of that candidate, 0–100" },
        reply_to: { type: "integer", description: "the # of the message you are answering" },
        ask: { type: "boolean", description: "true when you ask your teammate something directly; they answer next" },
      },
      required: ["message", "leading", "certainty"],
    },
  },
  {
    name: "team_read",
    description:
      "See your teammate's work for ideas: the full team chat, their checklist coverage, their current vote, and their latest steps (commands, reasoning).",
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
  description: `TEAM RUN: how sure you are, 0–100, that this is the property. The team stops when you both name the same building at ${AGREE_AT}+.`,
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
        model: j ? label(j.model) : null,
        status: j?.status ?? null,
        vote: v ? { place: v.answer.found ? (v.answer.address ?? v.answer.parcel ?? "found") : "no match", certainty: v.certainty, at: v.at } : null,
      };
    }),
    agreed: room.agreed ? { place: room.agreed.answer.address ?? room.agreed.answer.parcel ?? "found", at: room.agreed.at } : null,
  };
}
