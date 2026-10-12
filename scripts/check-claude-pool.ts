// Checks the order the pool spends Claude credentials in (claude-pool.ts): the
// monthly API credit keys first, one used up before the next, then the paid
// ANTHROPIC_API_KEY, never a subscription login next to them — and what goes on
// the wire: the right key, and the beta that lets a run switch keys mid-way.
// Run: pnpm test   (tsx, node:assert — no network: fetch is replaced by a fake)
import assert from "node:assert/strict";

for (const k of Object.keys(process.env)) if (/^CLAUDE_(OAUTH_TOKEN|CREDIT_KEY)/.test(k)) delete process.env[k];
process.env.CLAUDE_CREDIT_KEY_2 = "sk-test-2";
process.env.CLAUDE_CREDIT_KEY_1 = "sk-test-1";
process.env.ANTHROPIC_API_KEY = "sk-paid";
process.env.CLAUDE_OAUTH_TOKEN_1 = "sk-ant-oat01-test"; // must never be used next to credit keys
process.env.CLAUDE_CREDIT_RECHECK_MS = "50";
process.env.CLAUDE_POOL_WAIT_MS = "30"; // never wait in this check

// Anthropic, faked: each key answers what `answer` holds for it (default: a message).
type Reply = { status: number; body: unknown };
const ok: Reply = { status: 200, body: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
const err = (status: number, type: string, message: string, details?: object): Reply => ({ status, body: { type: "error", error: { type, message, ...(details ? { details } : {}) } } });
const broke = err(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
const limit = err(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.");
const cap = err(429, "rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier.", { error_code: "enforced_spend_limit_reached" });
const answer = new Map<string, Reply>();
const sent: { key: string; beta: string; body: { thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } } }[] = [];
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  const key = h.get("x-api-key") ?? h.get("authorization") ?? "";
  sent.push({ key, beta: h.get("anthropic-beta") ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
  const r = answer.get(key) ?? ok;
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { onLogin, poolStatus, isPoolVariable, THINKING } = await import("../server/claude-pool");
const call = async (prefer?: string) =>
  (await onLogin(prefer, async (c, label) => {
    await c.messages.create({ model: "claude-opus-5-5", max_tokens: 10, thinking: THINKING, messages: [{ role: "user", content: "hi" }] });
    return label;
  })).value;
const rest = () => new Promise((r) => setTimeout(r, 60));

// The line: credit keys in their number order, the paid key last, no subscription login.
assert.deepEqual(poolStatus().map((l) => [l.label, l.kind]), [["CLAUDE_CREDIT_KEY_1", "credit"], ["CLAUDE_CREDIT_KEY_2", "credit"], ["ANTHROPIC_API_KEY", "paid"]]);
assert.equal(await call(), "CLAUDE_CREDIT_KEY_1");
assert.equal(await call(), "CLAUDE_CREDIT_KEY_1", "the first key is used up before the second");

// On the wire: that key, the binding beta, and drop_block.
const last = sent.at(-1)!;
assert.equal(last.key, "sk-test-1");
assert.ok(last.beta.includes("thinking-binding-controls-2026-08-01"), "every call carries the binding beta");
assert.equal(last.body.thinking?.block_binding?.prefix_mismatch_behavior, "drop_block");

// Empty → the next key, without failing the call.
answer.set("sk-test-1", broke);
assert.equal(await call("CLAUDE_CREDIT_KEY_1"), "CLAUDE_CREDIT_KEY_2");
assert.equal(poolStatus()[0].state, "out of credit");

// A spend limit set in the Console counts as empty too.
answer.set("sk-test-2", limit);
assert.equal(await call("CLAUDE_CREDIT_KEY_2"), "ANTHROPIC_API_KEY", "the paid key only when every credit key is empty");
assert.equal(poolStatus()[1].state, "out of credit");
assert.ok(!sent.some((s) => s.key.includes("oat01")), "a subscription login is never used next to credit keys");

// A new month: the emptied keys are asked again and win back over the paid key.
answer.clear();
await rest();
assert.equal(await call("ANTHROPIC_API_KEY"), "CLAUDE_CREDIT_KEY_1");
assert.equal(poolStatus()[0].state, "ready");

// The tier's monthly cap: that key rests until the 1st of next month, not 5 minutes.
answer.set("sk-test-1", cap);
assert.equal(await call("CLAUDE_CREDIT_KEY_1"), "CLAUDE_CREDIT_KEY_2");
const back = new Date(poolStatus()[0].restingUntil!);
const now = new Date();
assert.equal(back.toISOString(), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());

// Nobody can pay: the error says so, instead of "usage limit".
answer.set("sk-test-2", broke);
answer.set("sk-paid", broke);
await assert.rejects(call(), /No Claude key can pay for this: .*out of credit/);

assert.ok(isPoolVariable("CLAUDE_CREDIT_KEY_3") && isPoolVariable("CLAUDE_OAUTH_TOKEN_1"));
console.log("claude-pool: credit keys first, in order, then the paid key; drop_block on the wire ✓");
