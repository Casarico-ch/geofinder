// =============================================================================
// DeepSeek — run an investigation on DeepSeek's models through their
// Anthropic-compatible endpoint, with the same agent loop, tools and prompt.
//
// The endpoint takes the Messages API shape (tools, images, images inside tool
// results, thinking, effort) and ignores cache_control. Pictures go inline:
// they are not uploaded to a Files API there. Needs DEEPSEEK_API_KEY.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic";

export function isDeepSeek(model: string | undefined): boolean {
  return !!model && model.startsWith("deepseek-");
}

export function deepseekConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY?.trim();
}

let client: Anthropic | null = null;
export function deepseekClient(): Anthropic {
  if (!deepseekConfigured()) throw new Error("DeepSeek is not configured. Set DEEPSEEK_API_KEY on the server.");
  client ??= new Anthropic({ baseURL: BASE_URL, apiKey: process.env.DEEPSEEK_API_KEY!.trim(), authToken: null });
  return client;
}
