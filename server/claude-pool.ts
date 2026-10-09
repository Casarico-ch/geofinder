// =============================================================================
// Claude pool — run investigations on Claude subscription logins instead of an
// API key, switching login when one reaches its usage limit.
//
// For Daniel's own product development (05.10): the tokens are Railway
// variables CLAUDE_OAUTH_TOKEN, CLAUDE_OAUTH_TOKEN_1, _2, … each minted with
// `claude setup-token`. With none set, nothing changes: every call goes out on
// the SDK's default credential (ANTHROPIC_API_KEY) exactly as before.
//
//   - A run stays on one login while it can (its pictures are uploaded to that
//     account, and its prompt cache lives there).
//   - 429 → that login rests until Anthropic's reset time (or a cooldown when
//     none is given) and the same request goes out on the next login.
//   - 401/403 → that login is set aside until the next restart.
//   - Every login resting → wait for the soonest reset, up to CLAUDE_POOL_WAIT_MS.
//
// API credits first (09.10): a Max subscription now pays a monthly API credit
// into a Console organization linked to it, and those credits expire at the end
// of each cycle. CLAUDE_CREDIT_KEY_1, _2, … are API keys from those credit-only
// organizations (no payment method on them), and they are used before anything
// else, one after the other: a key is used until Anthropic answers "credit
// balance is too low", then the next one takes over; then ANTHROPIC_API_KEY,
// the paid key, last. With credit keys set the subscription logins above are
// ignored, so GeoFinder never spends the Claude Code usage. The paid key
// only joins the line when credit keys are set, so a setup without them runs
// exactly as before.
//
//   - Out of credit → that key is asked again after CLAUDE_CREDIT_RECHECK_MS
//     (6 h), so next month's credit is picked up without a restart.
//
// Nothing here logs, returns or stores a token value — only the variable name.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { geminiClient, isGemini } from "./gemini";

const OAUTH_BETA = "oauth-2025-04-20"; // an OAuth bearer is refused without it
const COOLDOWN_MS = Number(process.env.CLAUDE_POOL_COOLDOWN_MS ?? 5 * 60_000);
const MAX_WAIT_MS = Number(process.env.CLAUDE_POOL_WAIT_MS ?? 20 * 60_000);
const CREDIT_RECHECK_MS = Number(process.env.CLAUDE_CREDIT_RECHECK_MS ?? 6 * 3600_000);
const OUTAGE_RETRIES = 3;
export const GEMINI_LABEL = "gemini";

type Kind = "credit" | "subscription" | "paid";
const TIER: Record<Kind, number> = { credit: 0, subscription: 1, paid: 2 };

interface Login {
  label: string; // the Railway variable's name, never its value
  kind: Kind;
  client: Anthropic;
  restUntil: number;
  dead: boolean;
  outOfCredit: boolean;
  uses: number;
  // Anthropic's own words for the last refusal, so the status page says WHY.
  lastRefusal?: { at: string; status: number | undefined; message: string; headers: Record<string, string> };
}

// Variables named NAME, NAME_1, NAME_2, … in their numeric order.
function numbered(env: NodeJS.ProcessEnv, re: RegExp): string[] {
  return Object.keys(env)
    .map((k) => ({ k, m: k.match(re) }))
    .filter((x) => x.m && env[x.k]?.trim())
    .sort((a, b) => Number(a.m![1] ?? 0) - Number(b.m![1] ?? 0))
    .map(({ k }) => k);
}

// A limit switches login at once; the SDK's own retries would knock on the
// resting one first. Outages are retried below, on the same login.
const makeLogin = (label: string, kind: Kind, client: Anthropic): Login => ({ label, kind, client, restUntil: 0, dead: false, outOfCredit: false, uses: 0 });

function loginsFromEnv(env: NodeJS.ProcessEnv): Login[] {
  const credits = numbered(env, /^CLAUDE_CREDIT_KEY(?:_(\d+))?$/).map((k) =>
    makeLogin(k, "credit", new Anthropic({ apiKey: env[k]!.trim(), authToken: null, maxRetries: 0 })),
  );
  // With credit keys set, the subscription logins are never used: they are the
  // Claude Code usage Daniel works with, and GeoFinder would drain it (09.10).
  const subscriptions = (credits.length ? [] : numbered(env, /^CLAUDE_OAUTH_TOKEN(?:_(\d+))?$/).map((k) =>
    makeLogin(
      k,
      "subscription",
      new Anthropic({ apiKey: null, authToken: env[k]!.trim(), defaultHeaders: { "anthropic-beta": OAUTH_BETA }, maxRetries: 0 }),
    ),
  ));
  const paid =
    credits.length && env.ANTHROPIC_API_KEY?.trim()
      ? [makeLogin("ANTHROPIC_API_KEY", "paid", new Anthropic({ apiKey: env.ANTHROPIC_API_KEY.trim(), authToken: null, maxRetries: 0 }))]
      : [];
  return [...credits, ...subscriptions, ...paid];
}

const logins = loginsFromEnv(process.env);
let fallback: Anthropic | null = null;

/** True when investigations run on subscription logins rather than an API key. */
export function poolOn(): boolean {
  return logins.length > 0;
}

/** Whether the server has any way to reach Claude. */
export function claudeConfigured(): boolean {
  return poolOn() || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
}

/** Names that the sandbox must never inherit. */
export function isPoolVariable(name: string): boolean {
  return /^CLAUDE_(?:OAUTH_TOKEN|CREDIT_KEY)(?:_\d+)?$/.test(name);
}

// What a refusal said, minus anything secret: the error text and the limit headers.
function refusalOf(err: InstanceType<typeof Anthropic.APIError>): NonNullable<Login["lastRefusal"]> {
  const headers: Record<string, string> = {};
  const h = err.headers as Headers | undefined;
  h?.forEach?.((v, k) => {
    if (/^anthropic-ratelimit-|^retry-after$|^request-id$/.test(k)) headers[k] = v;
  });
  return { at: new Date().toISOString(), status: err.status, message: String(err.message ?? "").slice(0, 500), headers };
}

function usable(l: Login, now: number): boolean {
  return !l.dead && l.restUntil <= now;
}

// The cheapest kind free first: credit, then subscription, then paid. Within
// it, the run's own login while it can serve; otherwise credit keys in their
// order (each is used up before the next) and logins least-used first.
function pick(prefer: string | undefined, now: number): Login | null {
  const free = logins.filter((l) => usable(l, now));
  if (!free.length) return null;
  const tier = Math.min(...free.map((l) => TIER[l.kind]));
  const best = free.filter((l) => TIER[l.kind] === tier);
  const own = best.find((l) => l.label === prefer);
  if (own) return own;
  return tier === TIER.credit ? best[0] : best.sort((a, b) => a.uses - b.uses)[0];
}

// Anthropic's refusal when an organization's credit has run out (400, or 402).
function outOfCredit(err: InstanceType<typeof Anthropic.APIError>): boolean {
  return (err.status === 400 || err.status === 402) && /credit balance/i.test(String(err.message ?? ""));
}

function soonestReset(): number | null {
  const resting = logins.filter((l) => !l.dead).map((l) => l.restUntil);
  return resting.length ? Math.min(...resting) : null;
}

// Anthropic's own reset time for the limit that refused us.
function resetAt(err: InstanceType<typeof Anthropic.APIError>, now: number): number {
  const h = err.headers as Headers | undefined;
  const unified = Number(h?.get?.("anthropic-ratelimit-unified-reset"));
  if (unified > 0) return unified * 1000;
  const after = Number(h?.get?.("retry-after"));
  if (after > 0) return now + after * 1000;
  return now + COOLDOWN_MS;
}

export interface PoolTurn<T> {
  value: T;
  label: string | null; // which login served it (null: the API key)
  switchedFrom: string | null; // the run's login when another one had to take over
  waitedMs: number; // time spent waiting for a login to come back
}

/**
 * Run one model call on a login. `prefer` is the run's current login, so a run
 * stays put while it can. `fn` gets the client and the login's label (pictures
 * uploaded through one account are not visible from another).
 */
export async function onLogin<T>(
  prefer: string | undefined,
  fn: (client: Anthropic, label: string | null) => Promise<T>,
  model?: string,
): Promise<PoolTurn<T>> {
  // Gemini has its own key and endpoint; the Claude logins never serve it.
  if (isGemini(model)) return { value: await fn(geminiClient(), GEMINI_LABEL), label: GEMINI_LABEL, switchedFrom: null, waitedMs: 0 };
  if (!poolOn()) {
    fallback ??= new Anthropic();
    return { value: await fn(fallback, null), label: null, switchedFrom: null, waitedMs: 0 };
  }
  let waitedMs = 0;
  let outages = 0;
  for (;;) {
    const now = Date.now();
    const login = pick(prefer, now);
    if (!login) {
      const soonest = soonestReset();
      if (soonest === null) throw new Error("Every Claude login was refused (401/403) — mint new ones with `claude setup-token`.");
      const wait = Math.max(1_000, soonest - now);
      if (waitedMs + wait > MAX_WAIT_MS)
        throw new Error(`Every Claude login is at its usage limit; the soonest is back at ${new Date(soonest).toISOString()}.`);
      await new Promise((r) => setTimeout(r, wait));
      waitedMs += wait;
      continue;
    }
    try {
      login.uses++;
      login.outOfCredit = false;
      const value = await fn(login.client, login.label);
      return { value, label: login.label, switchedFrom: prefer && prefer !== login.label ? prefer : null, waitedMs };
    } catch (err) {
      if (err instanceof Anthropic.APIError && outOfCredit(err)) {
        login.lastRefusal = refusalOf(err);
        login.outOfCredit = true;
        login.restUntil = Date.now() + CREDIT_RECHECK_MS;
        console.warn(`[claude-pool] ${login.label} is out of credit; asked again at ${new Date(login.restUntil).toISOString()}`);
        continue;
      }
      if (err instanceof Anthropic.RateLimitError) {
        login.lastRefusal = refusalOf(err);
        login.restUntil = resetAt(err, Date.now());
        console.warn(`[claude-pool] ${login.label} is resting until ${new Date(login.restUntil).toISOString()}`);
        continue;
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        login.lastRefusal = refusalOf(err);
        login.dead = true;
        console.warn(`[claude-pool] ${login.label} was refused (${err.status}); set aside until the next restart`);
        continue;
      }
      // Anthropic overloaded or a dropped connection: the same login, after a pause.
      if ((err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) && outages < OUTAGE_RETRIES) {
        outages++;
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** outages));
        continue;
      }
      throw err;
    }
  }
}

/** Names and states only, never values. */
export function poolStatus() {
  const now = Date.now();
  return logins.map((l) => ({
    label: l.label,
    kind: l.kind,
    state: l.dead ? "refused" : l.restUntil > now ? (l.outOfCredit ? "out of credit" : "resting") : "ready",
    restingUntil: l.restUntil > now ? new Date(l.restUntil).toISOString() : null,
    uses: l.uses,
    lastRefusal: l.lastRefusal ?? null,
  }));
}
