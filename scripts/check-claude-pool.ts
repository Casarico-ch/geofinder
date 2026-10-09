// Checks the order the pool spends Claude credentials in (claude-pool.ts): the
// monthly API credit keys first, one used up before the next, then the paid
// ANTHROPIC_API_KEY — and that an emptied key is asked again later.
// Run: pnpm test   (tsx, node:assert — no network: the model call is faked)
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

for (const k of Object.keys(process.env)) if (/^CLAUDE_(OAUTH_TOKEN|CREDIT_KEY)/.test(k)) delete process.env[k];
process.env.CLAUDE_CREDIT_KEY_2 = "sk-test-2";
process.env.CLAUDE_CREDIT_KEY_1 = "sk-test-1";
process.env.ANTHROPIC_API_KEY = "sk-paid";
process.env.CLAUDE_CREDIT_RECHECK_MS = "50";
const { onLogin, poolStatus, isPoolVariable } = await import("../server/claude-pool");

const broke = () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "Your credit balance is too low to access the Anthropic API.", new Headers());
const empty = new Set<string>();
const call = async (prefer?: string) =>
  (await onLogin(prefer, async (_c, label) => {
    if (empty.has(label!)) throw broke();
    return label;
  })).value;

assert.deepEqual(poolStatus().map((l) => [l.label, l.kind]), [["CLAUDE_CREDIT_KEY_1", "credit"], ["CLAUDE_CREDIT_KEY_2", "credit"], ["ANTHROPIC_API_KEY", "paid"]]);
assert.equal(await call(), "CLAUDE_CREDIT_KEY_1");
assert.equal(await call(), "CLAUDE_CREDIT_KEY_1", "the first key is used up before the second");
empty.add("CLAUDE_CREDIT_KEY_1");
assert.equal(await call("CLAUDE_CREDIT_KEY_1"), "CLAUDE_CREDIT_KEY_2");
assert.equal(poolStatus()[0].state, "out of credit");
empty.add("CLAUDE_CREDIT_KEY_2");
assert.equal(await call("CLAUDE_CREDIT_KEY_2"), "ANTHROPIC_API_KEY", "the paid key only when every credit key is empty");
// A new month: the emptied key is asked again and wins back over the paid key.
empty.clear();
await new Promise((r) => setTimeout(r, 60));
assert.equal(await call("ANTHROPIC_API_KEY"), "CLAUDE_CREDIT_KEY_1");
assert.equal(poolStatus()[0].state, "ready");
assert.ok(isPoolVariable("CLAUDE_CREDIT_KEY_3") && isPoolVariable("CLAUDE_OAUTH_TOKEN_1"));
console.log("claude-pool: credit keys first, in order, then the paid key ✓");
