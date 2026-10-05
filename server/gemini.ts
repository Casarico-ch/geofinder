// =============================================================================
// Gemini — run an investigation on Google's Gemini models with the same agent
// loop, tools and prompt as Claude.
//
// The loop speaks the Anthropic Messages shape; Gemini speaks generateContent.
// geminiClient() is a stand-in for the Anthropic client that translates one
// turn each way:
//   system blocks        → systemInstruction
//   tools                → functionDeclarations (parametersJsonSchema)
//   text / base64 image  → text / inlineData parts
//   tool_use             → functionCall (with its thoughtSignature, kept on the
//                          block so the next turn can send it back — Gemini 3
//                          rejects a function call returned without it)
//   tool_result          → functionResponse, and any picture it carried as
//                          inlineData parts right after it
//   thought summaries    → thinking blocks (the trace)
// Pictures always go inline (no Files API there). Needs GEMINI_API_KEY.
// =============================================================================
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const RETRIES = 4; // 429 / 5xx

export function isGemini(model: string | undefined): boolean {
  return !!model && model.startsWith("gemini-");
}

function apiKey(): string | undefined {
  return (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)?.trim() || undefined;
}

export function geminiConfigured(): boolean {
  return !!apiKey();
}

// What a Gemini part carries that the Anthropic block has no field for.
type Carried = { _g?: string; _noid?: boolean };

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

function toolResultText(content: Anthropic.Messages.ToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((c): c is Anthropic.Messages.TextBlockParam => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function imagePart(b: Anthropic.Messages.ImageBlockParam): GPart | null {
  return b.source.type === "base64" ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : null;
}

function toContents(messages: Anthropic.Messages.MessageParam[]) {
  const calls = new Map<string, { name: string; noid: boolean }>();
  const contents: { role: "user" | "model"; parts: GPart[] }[] = [];
  for (const m of messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content } as const] : m.content;
    if (m.role === "assistant") {
      const parts: GPart[] = [];
      for (const b of blocks as (Anthropic.Messages.ContentBlockParam & Carried)[]) {
        if (b.type === "text" && b.text) parts.push({ text: b.text, ...(b._g ? { thoughtSignature: b._g } : {}) });
        if (b.type === "tool_use") {
          calls.set(b.id, { name: b.name, noid: !!b._noid });
          parts.push({
            functionCall: { ...(b._noid ? {} : { id: b.id }), name: b.name, args: (b.input ?? {}) as Record<string, unknown> },
            ...(b._g ? { thoughtSignature: b._g } : {}),
          });
        }
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: " " }] });
      continue;
    }
    const responses: GPart[] = [];
    const rest: GPart[] = [];
    for (const b of blocks as Anthropic.Messages.ContentBlockParam[]) {
      if (b.type === "text" && b.text) rest.push({ text: b.text });
      else if (b.type === "image") {
        const p = imagePart(b);
        if (p) rest.push(p);
      } else if (b.type === "tool_result") {
        const call = calls.get(b.tool_use_id) ?? { name: "tool", noid: true };
        const text = toolResultText(b.content);
        responses.push({
          functionResponse: {
            ...(call.noid ? {} : { id: b.tool_use_id }),
            name: call.name,
            response: b.is_error ? { error: text } : { result: text },
          },
        });
        const pics = Array.isArray(b.content) ? b.content.filter((c) => c.type === "image") : [];
        if (pics.length) {
          rest.push({ text: `Picture(s) returned by ${call.name}:` });
          for (const c of pics) {
            const p = imagePart(c as Anthropic.Messages.ImageBlockParam);
            if (p) rest.push(p);
          }
        }
      }
    }
    contents.push({ role: "user", parts: [...responses, ...rest].length ? [...responses, ...rest] : [{ text: " " }] });
  }
  return contents;
}

function systemText(system: Anthropic.Messages.MessageCreateParams["system"]): string {
  if (!system) return "";
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(model: string, body: unknown): Promise<any> {
  const key = apiKey();
  if (!key) throw new Error("Gemini is not configured. Set GEMINI_API_KEY on the server.");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE_URL}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 800);
    if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(after > 0 ? after * 1000 : 2_000 * 2 ** attempt);
      continue;
    }
    throw new Error(`Gemini ${model} answered ${res.status}: ${text}`);
  }
}

async function create(params: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Messages.Message> {
  const tools = (params.tools ?? []) as { name: string; description?: string; input_schema: unknown }[];
  const data = await generate(params.model, {
    systemInstruction: { parts: [{ text: systemText(params.system) }] },
    contents: toContents(params.messages),
    ...(tools.length
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.input_schema })) }] }
      : {}),
    generationConfig: {
      maxOutputTokens: params.max_tokens,
      thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
    },
  });

  const cand = data?.candidates?.[0];
  const parts: GPart[] = cand?.content?.parts ?? [];
  const content: (Anthropic.Messages.ContentBlock & Carried)[] = [];
  let pending: string | undefined; // a signature that arrived on a part with no block of its own
  for (const p of parts) {
    const sig = p.thoughtSignature ?? pending;
    if (p.thought) {
      if (p.text) content.push({ type: "thinking", thinking: p.text, signature: "" });
      if (p.thoughtSignature) pending = p.thoughtSignature;
      continue;
    }
    if (p.functionCall) {
      content.push({
        type: "tool_use",
        id: p.functionCall.id ?? `toolu_g_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
        ...(p.functionCall.id ? {} : { _noid: true }),
        ...(sig ? { _g: sig } : {}),
      } as Anthropic.Messages.ToolUseBlock & Carried);
      pending = undefined;
    } else if (p.text !== undefined) {
      content.push({ type: "text", text: p.text, citations: null, ...(sig ? { _g: sig } : {}) } as Anthropic.Messages.TextBlock & Carried);
      pending = undefined;
    }
  }

  const finish: string = cand?.finishReason ?? (data?.promptFeedback?.blockReason ? "SAFETY" : "STOP");
  const usage = data?.usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    id: `msg_g_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: params.model,
    content,
    stop_reason: content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : finish === "MAX_TOKENS"
        ? "max_tokens"
        : /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)
          ? "refusal"
          : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    },
  } as unknown as Anthropic.Messages.Message;
}

/** A stand-in for the Anthropic client: only messages.create is used for a Gemini run. */
export function geminiClient(): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}
