// =============================================================================
// Files — send pictures to the model by reference instead of inline.
//
// The whole conversation is re-sent every turn, and with every picture inline
// as base64 a long search outgrows the API's 32 MB request limit (run 24ecb2b9
// died with 413 after 77 pictures, ~35 MB). Each distinct picture is uploaded
// once to the Files API and every request carries only its file_id, so the body
// stays small however many pictures the model has looked at — and nothing is
// ever removed from the conversation: the model keeps seeing every picture, the
// prompt cache holds, and earlier turns stay byte-identical (Opus 5.5, Sonnet
// 5.5 and Fable 5.1 reject or drop their reasoning when earlier turns change).
//
// The conversation itself keeps the base64 (state.json, the export); only the
// copy sent to the API is rewritten. The picture → file_id map is saved in the
// run dir so a resumed run sends exactly the same references. A picture whose
// upload failed is sent inline from then on, never switched later — switching
// would change an earlier turn.
//
// An uploaded picture belongs to the account that uploaded it. A run on the
// subscription pool (claude-pool.ts) that moves to another login keeps one map
// per login (files.<login>.json) and uploads its pictures again there.
// =============================================================================
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FILES_FILE = "files.json";
const INLINE = "inline";
// Deleted when the run finishes; the expiry only cleans up after a crash.
const EXPIRES_SECONDS = 90 * 24 * 3600;
const PARALLEL_UPLOADS = 4;

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

const keyOf = (base64: string) => createHash("sha1").update(base64).digest("hex");

function isBase64Image(b: unknown): b is Anthropic.Messages.ImageBlockParam & { source: Anthropic.Messages.Base64ImageSource } {
  const x = b as Anthropic.Messages.ImageBlockParam;
  return x?.type === "image" && x.source?.type === "base64";
}

// Every base64 image the model is sent: in user turns and inside tool results.
function images(messages: Anthropic.Messages.MessageParam[]) {
  const out: (Anthropic.Messages.ImageBlockParam & { source: Anthropic.Messages.Base64ImageSource })[] = [];
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (isBase64Image(b)) out.push(b);
      if (b.type === "tool_result" && Array.isArray(b.content)) for (const c of b.content) if (isBase64Image(c)) out.push(c);
    }
  }
  return out;
}

export class RunFiles {
  private constructor(
    private client: Anthropic,
    private runDir: string,
    private ids: Record<string, string>,
    private file: string,
  ) {}

  /** `login` is the pool login the pictures go to; none for the API key. */
  static async load(client: Anthropic, runDir: string, login?: string | null): Promise<RunFiles> {
    const file = login ? `files.${login}.json` : FILES_FILE;
    let ids: Record<string, string> = {};
    try {
      ids = JSON.parse(await readFile(path.join(runDir, file), "utf8"));
    } catch {
      /* first turn */
    }
    return new RunFiles(client, runDir, ids, file);
  }

  /** True when this picture goes to the API inline (its upload failed). */
  isInline = (base64: string): boolean => this.ids[keyOf(base64)] === INLINE;

  /** Upload the pictures not seen before; each is decided once, for the whole run. */
  async upload(messages: Anthropic.Messages.MessageParam[]): Promise<void> {
    const todo = new Map<string, Anthropic.Messages.Base64ImageSource>();
    for (const img of images(messages)) {
      const key = keyOf(img.source.data);
      if (!(key in this.ids)) todo.set(key, img.source);
    }
    if (todo.size === 0) return;
    const queue = Array.from(todo.entries());
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, src] = next;
        try {
          const file = await this.client.files.upload({
            file: await toFile(Buffer.from(src.data, "base64"), `${key.slice(0, 16)}.${EXT[src.media_type] ?? "img"}`, {
              type: src.media_type,
            }),
            expires_in_seconds: EXPIRES_SECONDS,
          });
          this.ids[key] = file.id;
        } catch (err) {
          console.error(`[files] upload failed, sending the picture inline:`, err);
          this.ids[key] = INLINE;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, todo.size) }, worker));
    await this.save();
  }

  /** The conversation as sent to the API: every uploaded picture by file_id. */
  wire(messages: Anthropic.Messages.MessageParam[]): Anthropic.Messages.MessageParam[] {
    const swap = <T>(b: T): T => {
      if (!isBase64Image(b)) return b;
      const id = this.ids[keyOf(b.source.data)];
      if (!id || id === INLINE) return b;
      return { ...b, source: { type: "file", file_id: id } } as T;
    };
    return messages.map((m) =>
      m.role !== "user" || !Array.isArray(m.content)
        ? m
        : {
            ...m,
            content: m.content.map((b) =>
              b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: b.content.map(swap) } : swap(b),
            ),
          },
    );
  }

  /** On resume: forget references that no longer exist, so they are uploaded again. */
  async verify(): Promise<number> {
    const known = Object.entries(this.ids).filter(([, id]) => id !== INLINE);
    let lost = 0;
    for (let i = 0; i < known.length; i += 100) {
      const chunk = known.slice(i, i + 100);
      try {
        const page = await this.client.files.list({ ids: chunk.map(([, id]) => id) });
        const live = new Set(page.data.filter((f) => !f.expires_at || Date.parse(f.expires_at) > Date.now()).map((f) => f.id));
        for (const [key, id] of chunk) {
          if (!live.has(id)) {
            delete this.ids[key];
            lost++;
          }
        }
      } catch (err) {
        console.error("[files] could not check the uploaded pictures:", err);
      }
    }
    if (lost > 0) await this.save();
    return lost;
  }

  /** Remove the run's uploads once it is over (best effort; they expire anyway). */
  async deleteAll(): Promise<void> {
    for (const id of Object.values(this.ids)) {
      if (id === INLINE) continue;
      await this.client.files.delete(id).catch(() => {});
    }
  }

  private async save(): Promise<void> {
    try {
      const abs = path.join(this.runDir, this.file);
      await writeFile(`${abs}.tmp`, JSON.stringify(this.ids));
      await rename(`${abs}.tmp`, abs);
    } catch (err) {
      console.error("[files] could not save the picture references:", err);
    }
  }
}
