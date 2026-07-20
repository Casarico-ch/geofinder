// =============================================================================
// Sandbox — the "computer" the model is given instead of pre-built geo tools.
//
// The whole philosophy of this app: we do NOT hand the model a cadastre API or
// an aerial-image tool. We hand it a real shell, a filesystem, and the ability
// to look at image files — exactly the primitives a human analyst (or this
// chat) used to find the property by hand. The model writes its own code to
// reach SITG, swisstopo, Overpass, the GWR register, or anything else it
// invents. There is no domain logic here — only bash / write_file / read_file.
//
// Each investigation runs in its own working directory under RUNS_ROOT so its
// scripts, downloaded aerials and notes are isolated and can be served back to
// the UI as the documented trace.
// =============================================================================
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNS_ROOT = process.env.RUNS_DIR
  ? path.resolve(process.env.RUNS_DIR)
  : path.resolve(process.cwd(), "runs");

export async function ensureRunDir(runId: string): Promise<string> {
  const dir = path.join(RUNS_ROOT, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Resolve a model-supplied path inside the run directory and refuse anything
// that escapes it (path traversal). Absolute paths are only allowed when they
// already point inside the run dir.
export function resolveInRun(runDir: string, p: string): string {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(runDir, p);
  const root = path.resolve(runDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path "${p}" escapes the working directory`);
  }
  return abs;
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const IMG_EXT: Record<string, ImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Sniff common image magic bytes so a file without an extension is still shown
// as an image if that is what it is.
function sniff(buf: Buffer): ImageMediaType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return null;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const OUTPUT_CAP = 200_000; // bytes of stdout/stderr kept per command

// The child inherits the server environment MINUS our Anthropic credentials —
// the model's code has no business reading them, and this keeps the key from
// leaking into logs or outbound requests the model writes.
function sandboxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

export function runBash(runDir: string, command: string, timeoutMs = 180_000): Promise<BashResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: runDir, env: sandboxEnv() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n[spawn error] ${String(err)}`, code: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export async function writeSandboxFile(
  runDir: string,
  p: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const abs = resolveInRun(runDir, p);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return { path: abs, bytes: Buffer.byteLength(content, "utf8") };
}

export type ReadResult =
  | { kind: "image"; mediaType: ImageMediaType; base64: string; bytes: number; relPath: string }
  | { kind: "text"; text: string; bytes: number; relPath: string };

const MAX_IMAGE_BYTES = 8_000_000;
const MAX_TEXT_CHARS = 60_000;

export async function readSandboxFile(runDir: string, p: string): Promise<ReadResult> {
  const abs = resolveInRun(runDir, p);
  const buf = await readFile(abs);
  const relPath = path.relative(path.resolve(runDir), abs) || path.basename(abs);
  const media = IMG_EXT[path.extname(abs).toLowerCase()] ?? sniff(buf);
  if (media) {
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        kind: "text",
        text: `[image ${relPath} is ${buf.length} bytes — too large to view; downscale it first (e.g. fetch a smaller WMS WIDTH/HEIGHT or a tighter bbox)]`,
        bytes: buf.length,
        relPath,
      };
    }
    return { kind: "image", mediaType: media, base64: buf.toString("base64"), bytes: buf.length, relPath };
  }
  let text = buf.toString("utf8");
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + `\n…[truncated, ${buf.length} bytes total]`;
  }
  return { kind: "text", text, bytes: buf.length, relPath };
}
