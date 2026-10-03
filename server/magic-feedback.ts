// =============================================================================
// Magic feedback — the two routes the browser widget calls, forwarded to the
// Rico cockpit (client/src/lib/magic-feedback-widget.ts is the other half).
//
//   POST /api/magic-feedback          → <cockpit>/api/magic-feedback          (the vision read)
//   POST /api/magic-feedback/confirm  → <cockpit>/api/magic-feedback/confirm  (files the card)
//
// The browser never talks to the cockpit and never sees the key: this server
// adds `Authorization: Bearer $MAGIC_FEEDBACK_KEY` (the cockpit's
// MAGIC_FEEDBACK_KEY_GEOFINDER), which also names the product the card is
// filed under. Everyone who reaches the website may send one (Daniel, 03.10),
// so the routes sit behind whatever the ADMIN_PASSWORD gate in index.ts does
// and add no check of their own. `by` on the confirm is always set here, to a
// fixed string — nothing the browser sends is trusted for it.
// =============================================================================
import type { ErrorRequestHandler, Express, Request, Response } from "express";
import express from "express";

export const MAGIC_BY = "GeoFinder user";
export const DEFAULT_COCKPIT_URL =
  "https://rico-cockpit-production.up.railway.app";
export const READ_TIMEOUT_MS = 270_000; // ~4.5 min: the cockpit transcribes, then runs a vision call
export const CONFIRM_TIMEOUT_MS = 60_000;
export const BODY_LIMIT = "15mb";
export const NOT_CONFIGURED =
  "Magic feedback is not configured on this server.";

export type MagicKind = "read" | "confirm";

type Env = Record<string, string | undefined>;

export type ForwardPlan =
  | {
      ok: true;
      url: string;
      init: { method: "POST"; headers: Record<string, string>; body: string };
      timeoutMs: number;
    }
  | { ok: false; status: number; body: { ok: false; error: string } };

/** Pure: what this server would send to the cockpit for one browser request, or why it will not. */
export function buildForward(
  kind: MagicKind,
  body: unknown,
  env: Env = process.env
): ForwardPlan {
  const key = env.MAGIC_FEEDBACK_KEY;
  if (!key)
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: NOT_CONFIGURED },
    };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: "the request body must be a JSON object" },
    };
  }
  const base = (env.RICO_COCKPIT_URL || DEFAULT_COCKPIT_URL).replace(
    /\/+$/,
    ""
  );
  const path =
    kind === "read" ? "/api/magic-feedback" : "/api/magic-feedback/confirm";
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (kind === "confirm") {
    delete out.sender;
    out.by = MAGIC_BY;
  } else {
    delete out.by;
  }
  return {
    ok: true,
    url: base + path,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(out),
    },
    timeoutMs: kind === "read" ? READ_TIMEOUT_MS : CONFIRM_TIMEOUT_MS,
  };
}

/** Sends a plan and turns whatever happens into a status and a JSON body for the browser. */
export async function relay(
  plan: Extract<ForwardPlan, { ok: true }>,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: unknown }> {
  let r: globalThis.Response;
  try {
    r = await fetchImpl(plan.url, {
      ...plan.init,
      signal: AbortSignal.timeout(plan.timeoutMs),
    });
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      status: timedOut ? 504 : 502,
      body: {
        ok: false,
        error: timedOut
          ? "The Rico cockpit did not answer in time — try again."
          : "Could not reach the Rico cockpit — try again in a moment.",
      },
    };
  }
  const text = await r.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object")
      return { status: r.status, body: parsed };
  } catch {
    /* fall through */
  }
  return {
    status: 502,
    body: {
      ok: false,
      error: `The Rico cockpit answered ${r.status} with no readable reply.`,
    },
  };
}

export function registerMagicFeedbackRoutes(
  app: Express,
  opts: { fetch?: typeof fetch } = {}
) {
  // Its own parser, registered before registerApiRoutes' global one so this
  // limit (not that one) is what applies to these two paths.
  const json = express.json({ limit: BODY_LIMIT });

  const handler = (kind: MagicKind) => async (req: Request, res: Response) => {
    const plan = buildForward(kind, req.body);
    if (!plan.ok) {
      res.status(plan.status).json(plan.body);
      return;
    }
    const out = await relay(plan, opts.fetch ?? fetch);
    if (out.status >= 500)
      console.error(
        `[magic-feedback] ${kind} → cockpit answered ${out.status}`
      );
    res.status(out.status).json(out.body);
  };

  app.post("/api/magic-feedback", json, handler("read"));
  app.post("/api/magic-feedback/confirm", json, handler("confirm"));

  // A body the parser refuses (too large, not JSON) gets a sentence, not Express's HTML page.
  const onParseError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const tooLarge = err?.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({
      ok: false,
      error: tooLarge
        ? "That recording is too large to send."
        : "the request body must be JSON",
    });
  };
  app.use("/api/magic-feedback", onParseError);
}
