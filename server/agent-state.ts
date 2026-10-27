// What a run keeps on disk: the resumable conversation (state.json), the full
// conversation for export, and the listing photos.
import Anthropic from "@anthropic-ai/sdk";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Job } from "./jobs";
import { type AgentImage } from "./agent-prompt";

// ---------------------------------------------------------------------------
// Resume state — the full conversation, persisted so a running investigation
// outlives the process. Written atomically (tmp + rename) so a crash mid-write
// can never leave a half-written, unparseable state file.
// ---------------------------------------------------------------------------
const STATE_FILE = "state.json";

interface ResumeState {
  turn: number;
  messages: Anthropic.Messages.MessageParam[];
}

export async function saveState(job: Job, turn: number, messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  try {
    const abs = path.join(job.runDir, STATE_FILE);
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, JSON.stringify({ turn, messages } satisfies ResumeState));
    await rename(tmp, abs);
  } catch (err) {
    console.error(`[agent] could not save resume state for ${job.id}:`, err);
  }
}

export async function loadState(runDir: string): Promise<ResumeState | null> {
  try {
    const raw = await readFile(path.join(runDir, STATE_FILE), "utf8");
    const parsed = JSON.parse(raw) as ResumeState;
    if (!Array.isArray(parsed.messages) || typeof parsed.turn !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

// The finished run's full conversation, kept for the export (never served raw).
export const CONVERSATION_FILE = "conversation.json";

export async function saveConversation(job: Job, messages: Anthropic.Messages.MessageParam[]): Promise<void> {
  try {
    await writeFile(path.join(job.runDir, CONVERSATION_FILE), JSON.stringify({ messages }));
  } catch (err) {
    console.error(`[agent] could not save the conversation for ${job.id}:`, err);
  }
}

/** The run's conversation: the kept one when finished, the live one while running/paused. */
export async function loadConversation(runDir: string): Promise<Anthropic.Messages.MessageParam[] | null> {
  for (const file of [CONVERSATION_FILE, STATE_FILE]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(runDir, file), "utf8")) as { messages?: unknown };
      if (Array.isArray(parsed.messages)) return parsed.messages as Anthropic.Messages.MessageParam[];
    } catch {
      /* try the next */
    }
  }
  return null;
}

export async function clearState(job: Job): Promise<void> {
  try {
    await rm(path.join(job.runDir, STATE_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

// Persist the listing photos into the run dir so the model can crop/inspect
// them as files (photo1.jpg, …), matching what it's shown inline.
export async function saveListingPhotos(runDir: string, images: AgentImage[]): Promise<void> {
  await Promise.all(
    images.map((img, i) => {
      const ext = img.mediaType.split("/")[1].replace("jpeg", "jpg");
      return writeFile(path.join(runDir, `photo${i + 1}.${ext}`), Buffer.from(img.base64, "base64"));
    }),
  );
}

const EXT_MEDIA: Record<string, AgentImage["mediaType"]> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

// Read the saved listing photos (photo1.jpg, …) back out of a run dir, in order.
// Used to relaunch a past investigation from its original photos.
export async function loadListingPhotos(runDir: string): Promise<AgentImage[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch {
    return [];
  }
  const photos = names
    .map((n) => n.match(/^photo(\d+)\.(jpe?g|png|webp|gif)$/i))
    .filter((m): m is RegExpMatchArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const images: AgentImage[] = [];
  for (const m of photos) {
    const buf = await readFile(path.join(runDir, m[0]));
    images.push({ base64: buf.toString("base64"), mediaType: EXT_MEDIA[m[2].toLowerCase()] ?? "image/jpeg" });
  }
  return images;
}
