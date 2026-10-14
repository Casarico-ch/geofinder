// Checks for magic feedback: the pure client rules and the two server routes.
// Run: pnpm test   (tsx, node:assert — no test framework)
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  LABEL_BAR_PX,
  MAX_CLIPS,
  MAX_PAGES,
  MAX_RECORD_MS,
  MAX_STITCH_PX,
  RESUME_MAX_AGE_MS,
  URL_SETTLE_MS,
  barCopy,
  confirmBody,
  filedToast,
  formatClock,
  keptNotes,
  labelFor,
  maskClone,
  notesFromReply,
  pageLabel,
  popPlace,
  readBody,
  readRecord,
  resumeDecision,
  shortcutAction,
  stitchLayout,
  urlWatchStep,
  type CapturedPage,
  type SessionRecord,
  type UrlWatch,
} from "../client/src/lib/magic-feedback";
import {
  CONFIRM_TIMEOUT_MS,
  MAGIC_BY,
  NOT_CONFIGURED,
  READ_TIMEOUT_MS,
  buildForward,
  registerMagicFeedbackRoutes,
  relay,
} from "../server/magic-feedback";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(
      `${name}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const KEY = "test-magic-key-0123456789abcdef";
// AbortSignal.timeout's timer does not hold the process open; this does, until the end.
const keepAlive = setInterval(() => {}, 1000);

// ---- the shortcut ---------------------------------------------------------------
const combo = { code: "KeyM", altKey: true, shiftKey: true };
await check("Alt+Shift+M starts, and the same combo stops", () => {
  assert.equal(shortcutAction(combo, false), "start");
  assert.equal(shortcutAction(combo, true), "stop");
});
await check(
  "matches event.code, not event.key (Option on Mac changes key)",
  () => {
    // what Option+Shift+M reports as event.key on a Mac
    assert.equal(
      shortcutAction({ ...combo, key: "Â" } as typeof combo, false),
      "start"
    );
    assert.equal(shortcutAction({ ...combo, code: "KeyN" }, false), null);
  }
);
await check("needs both Alt and Shift, and no Cmd or Ctrl", () => {
  assert.equal(shortcutAction({ ...combo, altKey: false }, false), null);
  assert.equal(shortcutAction({ ...combo, shiftKey: false }, false), null);
  assert.equal(shortcutAction({ ...combo, metaKey: true }, false), null);
  assert.equal(shortcutAction({ ...combo, ctrlKey: true }, false), null);
});
await check("ignores composition and key repeat", () => {
  assert.equal(shortcutAction({ ...combo, isComposing: true }, false), null);
  assert.equal(shortcutAction({ ...combo, repeat: true }, false), null);
});
await check("Space then M no longer does anything", () => {
  assert.equal(shortcutAction({ code: "Space" }, false), null);
  assert.equal(shortcutAction({ code: "KeyM" }, false), null);
});

// ---- renumbering and the review screen -----------------------------------------
const elements = Array.from({ length: 12 }, (_, i) => ({
  label: "el" + (i + 1),
  x: i * 50,
  y: 100,
  w: 40,
  h: 20,
}));
await check("pins are numbered in spoken order, not by element index", () => {
  const notes = notesFromReply(
    [
      { n: 10, text: "ten" },
      { n: 2, text: "two" },
      { n: 11, text: "eleven" },
    ],
    [{ elements, vw: 1000, vh: 800 }]
  );
  assert.deepEqual(
    notes.map(n => [n.text, n.label]),
    [
      ["ten", "el10"],
      ["two", "el2"],
      ["eleven", "el11"],
    ]
  );
});
await check(
  "two notes on one element sit side by side; unknown elements are dropped; pins stay on screen",
  () => {
    const notes = notesFromReply(
      [
        { n: 1, text: "a" },
        { n: 1, text: "b" },
        { n: 99, text: "nowhere" },
      ],
      [
        {
          elements: [{ label: "top", x: 0, y: 0, w: 40, h: 20 }],
          vw: 1000,
          vh: 800,
        },
      ]
    );
    assert.equal(notes.length, 2);
    assert.equal(notes[1].x - notes[0].x, 28);
    assert.equal(notes[0].y, 14);
    const edge = notesFromReply(
      [{ n: 1, text: "x" }],
      [
        {
          elements: [{ label: "r", x: 990, y: 50, w: 40, h: 20 }],
          vw: 1000,
          vh: 800,
        },
      ]
    );
    assert.equal(edge[0].x, 984);
  }
);
await check("only notes with words are kept and filed", () => {
  const notes = [
    { text: "keep", label: "", x: 0, y: 0, page: 1 },
    { text: "   ", label: "", x: 0, y: 0, page: 0 },
  ];
  assert.equal(keptNotes(notes).length, 1);
  const body = confirmBody(
    {
      ok: true,
      transcript: "t",
      annotations: [],
      summary: "s",
      thoughts: "th",
      questions: ["q"],
    },
    notes,
    "data:image/jpeg;base64,AA",
    [{ url: "https://x/a" }, { url: "https://x/b" }]
  );
  assert.deepEqual(body.notes, [{ text: "keep", page: 1 }]);
  assert.equal(
    body.url,
    "https://x/a",
    "the start page, not the page at send time"
  );
  assert.deepEqual(body.pages, [
    { url: "https://x/a" },
    { url: "https://x/b" },
  ]);
  assert.equal("by" in body, false);
});
await check("bar copy, clock, pop placement and toasts", () => {
  assert.deepEqual(barCopy(1), {
    count: "1 note",
    hint: " · hover a number to read it, click it to edit",
  });
  assert.equal(barCopy(3).count, "3 notes");
  assert.equal(barCopy(0).hint, " · your words still go to Rico");
  assert.equal(formatClock(65_400), "1:05 / 2:00");
  assert.deepEqual(popPlace({ x: 100, y: 100 }, { width: 1000, height: 800 }), {
    left: 76,
    top: 118,
  });
  assert.deepEqual(popPlace({ x: 990, y: 700 }, { width: 1000, height: 800 }), {
    left: 688,
    bottom: 118,
  });
  assert.equal(filedToast(false), "Sent to Rico — in Backlog and started.");
  assert.equal(filedToast(true), "Added to a card already on the board.");
});

// ---- one recording, many pages ---------------------------------------------------
await check(
  "annotations map onto their own page; a missing page is page 0",
  () => {
    const pages = [
      {
        elements: [{ label: "p1a", x: 0, y: 50, w: 40, h: 20 }],
        vw: 1000,
        vh: 800,
      },
      {
        elements: [
          { label: "p2a", x: 100, y: 60, w: 40, h: 20 },
          { label: "p2b", x: 980, y: 70, w: 40, h: 20 },
        ],
        vw: 600,
        vh: 500,
      },
    ];
    const notes = notesFromReply(
      [
        { n: 1, text: "old cockpit" },
        { n: 2, text: "second page", page: 1 },
        { n: 1, text: "first", page: 0 },
        { n: 1, text: "same n, other page", page: 1 },
        { n: 2, text: "not on page 0", page: 0 },
        { n: 1, text: "no such page", page: 5 },
        { n: 1, text: "bad page", page: 0.5 },
      ],
      pages
    );
    assert.deepEqual(
      notes.map(n => [n.text, n.label, n.page]),
      [
        ["old cockpit", "p1a", 0],
        ["second page", "p2b", 1],
        ["first", "p1a", 0],
        ["same n, other page", "p2a", 1],
      ]
    );
    // pins clamp to the viewport the page was captured in, not the current one
    assert.equal(notes[1].x, 584);
    // two notes on page 0 element 1 sit side by side; page 1 element 1 starts fresh
    assert.equal(notes[2].x - notes[0].x, 28);
    assert.equal(notes[3].x, 120);
  }
);
await check(
  "the address must hold still for the settle time before a page is captured",
  () => {
    let w: UrlWatch = { current: "https://g/a", pending: null };
    let step = urlWatchStep(w, "https://g/a", 0);
    assert.equal(step.capture, false);
    step = urlWatchStep(step.watch, "https://g/b", 1000);
    assert.equal(step.capture, false);
    assert.deepEqual(step.watch.pending, { href: "https://g/b", since: 1000 });
    step = urlWatchStep(step.watch, "https://g/b", 1000 + URL_SETTLE_MS - 1);
    assert.equal(step.capture, false);
    // moved on again before settling: the clock restarts on the newest address
    step = urlWatchStep(step.watch, "https://g/c", 1500);
    assert.equal(step.capture, false);
    step = urlWatchStep(step.watch, "https://g/c", 1500 + URL_SETTLE_MS - 100);
    assert.equal(step.capture, false);
    step = urlWatchStep(step.watch, "https://g/c", 1500 + URL_SETTLE_MS);
    assert.equal(step.capture, true);
    // went back before settling: nothing to capture, pending cleared
    w = { current: "https://g/a", pending: { href: "https://g/b", since: 0 } };
    step = urlWatchStep(w, "https://g/a", 5000);
    assert.equal(step.capture, false);
    assert.equal(step.watch.pending, null);
    assert.equal(URL_SETTLE_MS, 800);
    assert.equal(MAX_PAGES, 5);
  }
);
await check(
  "stitch: one page is just its picture; more get label bars; tall stacks scale down",
  () => {
    const one = stitchLayout([{ w: 2000, h: 1200 }]);
    assert.deepEqual(one, {
      width: 2000,
      height: 1200,
      scale: 1,
      blocks: [{ labelTop: null, imageTop: 0 }],
    });
    const two = stitchLayout([
      { w: 1000, h: 800 },
      { w: 1200, h: 600 },
    ]);
    assert.equal(two.width, 1200);
    assert.equal(two.height, 800 + 600 + 2 * LABEL_BAR_PX);
    assert.deepEqual(two.blocks, [
      { labelTop: 0, imageTop: 28 },
      { labelTop: 828, imageTop: 856 },
    ]);
    const tall = stitchLayout(
      Array.from({ length: 5 }, () => ({ w: 2880, h: 1800 }))
    );
    const raw = 5 * (1800 + LABEL_BAR_PX);
    assert.equal(tall.scale, MAX_STITCH_PX / raw);
    assert.equal(tall.height, MAX_STITCH_PX);
    assert.equal(tall.width, Math.round(2880 * (MAX_STITCH_PX / raw)));
  }
);
await check("page label names the page and its path", () => {
  assert.equal(
    pageLabel(0, "https://geo.test/results?id=4#x"),
    "Page 1 · /results?id=4#x"
  );
  assert.equal(pageLabel(2, "not a url"), "Page 3 · not a url");
});
const pg = (url: string, at: number): CapturedPage => ({
  shot: "data:image/jpeg;base64," + url.length,
  elements: [{ label: "x", x: 1, y: 2, w: 10, h: 10 }],
  url,
  at,
  vw: 1000,
  vh: 700,
});
await check(
  "the read body always carries the legacy fields from page 1 and clip 1",
  () => {
    const body = readBody({
      pages: [pg("https://g/a", 0), pg("https://g/bb", 4000)],
      clips: [
        { audio: "data:audio/webm;base64,AA", at: 0 },
        { audio: "data:audio/webm;base64,BB", at: 9000 },
      ],
      mousePath: [{ x: 1, y: 1, t: 5 }],
      clicks: [],
      ms: 12000,
    });
    assert.equal(body.shot, body.pages[0].shot);
    assert.deepEqual(body.elements, body.pages[0].elements);
    assert.equal(body.url, "https://g/a");
    assert.equal(body.audio, body.clips[0].audio);
    assert.equal(body.ms, 12000);
    assert.equal(body.pages.length, 2);
    assert.deepEqual(body.clips, [
      { audio: "data:audio/webm;base64,AA", at: 0 },
      { audio: "data:audio/webm;base64,BB", at: 9000 },
    ]);
    assert.deepEqual(Object.keys(body.pages[1]).sort(), [
      "at",
      "elements",
      "shot",
      "url",
      "vh",
      "vw",
    ]);
    const capped = readBody({
      pages: Array.from({ length: 7 }, (_, i) => pg("https://g/" + i, i)),
      clips: Array.from({ length: 9 }, (_, i) => ({ audio: "a" + i, at: i })),
      mousePath: [],
      clicks: [],
      ms: 1,
    });
    assert.equal(capped.pages.length, MAX_PAGES);
    assert.equal(capped.clips.length, MAX_CLIPS);
  }
);

// ---- surviving a page load (a fake store standing in for IndexedDB) -----------------
await check(
  "a saved recording round-trips through the store and resumes, reads back, or is dropped",
  async () => {
    const store = new Map<string, unknown>();
    // structuredClone is what IndexedDB does to a value it stores
    const put = (k: string, v: unknown) => store.set(k, structuredClone(v));
    const now = 1_000_000;
    const rec: SessionRecord = {
      v: 1,
      startedAt: now - 30_000,
      phase: "recording",
      stopped: false,
      pages: [pg("https://g/a", 0), pg("https://g/b", 8000)],
      clips: [{ at: 0, mime: "audio/webm", chunks: [new Blob(["abc"])] }],
      mousePath: [{ x: 1, y: 2, t: 3 }],
      clicks: [],
    };
    put("tab-1", rec);
    const back = resumeDecision(store.get("tab-1"), now);
    assert.equal(back.action, "resume");
    assert.equal(back.record!.pages[1].url, "https://g/b");
    assert.equal(await back.record!.clips[0].chunks[0].text(), "abc");
    assert.equal(resumeDecision(store.get("tab-2"), now).action, "none");
    // the 2-minute cap counts from the first start, across reloads
    assert.equal(
      resumeDecision(store.get("tab-1"), rec.startedAt + MAX_RECORD_MS).action,
      "readback"
    );
    assert.equal(
      resumeDecision({ ...rec, stopped: true }, now).action,
      "readback"
    );
    assert.equal(
      resumeDecision(
        {
          ...rec,
          clips: Array.from({ length: MAX_CLIPS }, () => rec.clips[0]),
        },
        now
      ).action,
      "readback"
    );
    assert.equal(
      resumeDecision(rec, rec.startedAt + RESUME_MAX_AGE_MS + 1).action,
      "drop"
    );
    // review restores with its reply and notes; a note saved without a page is page 0
    const reply = {
      ok: true as const,
      transcript: "t",
      annotations: [],
      summary: "s",
      thoughts: "",
      questions: [],
    };
    put("tab-1", {
      ...rec,
      phase: "review",
      review: { reply, notes: [{ text: "n", label: "l", x: 1, y: 2 }] },
    });
    const rv = resumeDecision(store.get("tab-1"), now);
    assert.equal(rv.action, "review");
    assert.equal(rv.record!.review!.notes[0].page, 0);
    assert.equal(rv.record!.review!.reply.summary, "s");
    // unreadable is dropped
    for (const bad of [
      "junk",
      { ...rec, v: 2 },
      { ...rec, pages: [] },
      { ...rec, pages: [{ url: "x" }] },
      { ...rec, phase: "review" },
      { ...rec, startedAt: "yesterday" },
      { ...rec, pages: Array.from({ length: 6 }, () => rec.pages[0]) },
    ]) {
      assert.equal(readRecord(bad), null, JSON.stringify(bad).slice(0, 60));
      assert.equal(resumeDecision(bad, now).action, "drop");
    }
  }
);

// ---- masking --------------------------------------------------------------------
function fakeEl(tag: string, extra: Record<string, any> = {}) {
  const attrs: Record<string, string> = { ...(extra.attrs ?? {}) };
  return {
    tagName: tag.toUpperCase(),
    style: {} as { visibility?: string },
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    setAttribute: (n: string, v: string) => {
      attrs[n] = v;
    },
    closest: (_s: string) => extra.inPrivate ?? null,
    ...extra,
    attrs,
  };
}
await check(
  "onclone masking blanks every typed value and leaves captions",
  () => {
    const text = fakeEl("input", {
      type: "text",
      value: "secret address",
      attrs: { value: "secret address" },
    });
    const pass = fakeEl("input", { type: "password", value: "hunter2" });
    const submit = fakeEl("input", { type: "submit", value: "Search" });
    const area = fakeEl("textarea", {
      value: "listing text",
      textContent: "listing text",
    });
    const select = fakeEl("select", {
      options: [{ text: "Zürich" }, { text: "Genève" }],
    });
    const editable = fakeEl("div", {
      isContentEditable: true,
      textContent: "notes",
      attrs: { contenteditable: "true" },
    });
    const marked = fakeEl("div", {
      textContent: "private",
      attrs: { "data-mf-mask": "" },
    });
    const all = [text, pass, submit, area, select, editable, marked];
    let asked = "";
    const n = maskClone({
      querySelectorAll: (s: string) => {
        asked = s;
        return all;
      },
    });
    assert.equal(n, 7);
    for (const part of [
      "input",
      "textarea",
      "select",
      "[contenteditable]",
      "[data-mf-mask]",
    ])
      assert.ok(asked.includes(part), part);
    assert.equal(text.value, "");
    assert.equal(text.attrs.value, "");
    assert.equal(pass.value, "");
    assert.equal(submit.value, "Search");
    assert.equal(area.value, "");
    assert.equal(area.textContent, "");
    assert.deepEqual(
      select.options.map((o: { text: string }) => o.text),
      ["", ""]
    );
    assert.equal(editable.textContent, "");
    assert.equal(marked.style.visibility, "hidden");
  }
);
await check("an element label never carries a private value", () => {
  assert.equal(labelFor(fakeEl("textarea", { textContent: "my listing" })), "");
  assert.equal(
    labelFor(
      fakeEl("textarea", {
        textContent: "x",
        attrs: { placeholder: "Paste the listing" },
      })
    ),
    "Paste the listing"
  );
  assert.equal(
    labelFor(fakeEl("span", { textContent: "in a masked box", inPrivate: {} })),
    ""
  );
  assert.equal(
    labelFor(fakeEl("button", { textContent: "  New \n search " })),
    "New search"
  );
  assert.equal(
    labelFor(
      fakeEl("a", { textContent: "x", attrs: { "aria-label": "Usage" } })
    ),
    "Usage"
  );
});

// ---- the forwarder (pure) ----------------------------------------------------------
await check("no MAGIC_FEEDBACK_KEY → 503 with the sentence", () => {
  const p = buildForward("read", { a: 1 }, {});
  assert.equal(p.ok, false);
  if (!p.ok) {
    assert.equal(p.status, 503);
    assert.deepEqual(p.body, { ok: false, error: NOT_CONFIGURED });
  }
});
await check(
  "read forwards to the cockpit with the bearer and the read timeout",
  () => {
    const p = buildForward(
      "read",
      { shot: "s", by: "browser" },
      { MAGIC_FEEDBACK_KEY: KEY, RICO_COCKPIT_URL: "https://cockpit.test/" }
    );
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(p.url, "https://cockpit.test/api/magic-feedback");
    assert.equal(p.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(p.timeoutMs, READ_TIMEOUT_MS);
    assert.equal(READ_TIMEOUT_MS, 270_000);
    assert.deepEqual(JSON.parse(p.init.body), { shot: "s" });
  }
);
await check(
  "confirm sets `by` server-side, overriding the browser, and defaults the cockpit URL",
  () => {
    const p = buildForward(
      "confirm",
      { summary: "x", by: "Daniel", sender: "daniel" },
      { MAGIC_FEEDBACK_KEY: KEY }
    );
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(
      p.url,
      "https://rico-cockpit-production.up.railway.app/api/magic-feedback/confirm"
    );
    assert.equal(p.timeoutMs, CONFIRM_TIMEOUT_MS);
    assert.deepEqual(JSON.parse(p.init.body), { summary: "x", by: MAGIC_BY });
    assert.equal(MAGIC_BY, "GeoFinder user");
  }
);
await check(
  "a body that is not a JSON object is refused before forwarding",
  () => {
    const p = buildForward("read", [1, 2], { MAGIC_FEEDBACK_KEY: KEY });
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.status, 400);
  }
);
await check("relay: a timeout is 504, a non-JSON reply is 502", async () => {
  const p = buildForward("read", {}, { MAGIC_FEEDBACK_KEY: KEY });
  assert.ok(p.ok);
  if (!p.ok) return;
  const slow = { ...p, timeoutMs: 30 };
  const hang: typeof fetch = (_u, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    );
  assert.equal((await relay(slow, hang)).status, 504);
  const html: typeof fetch = async () =>
    new Response("<html>bad gateway</html>", { status: 502 });
  const out = await relay(p, html);
  assert.equal(out.status, 502);
  assert.equal((out.body as { ok: boolean }).ok, false);
});

// ---- the routes, end to end against a stub cockpit -----------------------------------
type Seen = { path: string; auth: string; body: any };
const seen: Seen[] = [];
const cockpit = express();
cockpit.use(express.json({ limit: "50mb" }));
cockpit.post("/api/magic-feedback", (req, res) => {
  seen.push({
    path: req.path,
    auth: String(req.headers.authorization),
    body: req.body,
  });
  if (req.body.shot === "limit") {
    res.status(429).json({
      ok: false,
      error: "Magic feedback has reached today's 60 recordings for geofinder",
    });
    return;
  }
  res.json({
    ok: true,
    transcript: "t",
    annotations: [{ n: 1, text: "here" }],
    summary: "s",
    thoughts: "",
    questions: [],
  });
});
cockpit.post("/api/magic-feedback/confirm", (req, res) => {
  seen.push({
    path: req.path,
    auth: String(req.headers.authorization),
    body: req.body,
  });
  res.json({ ok: true, id: "b123", folded: false, started: true });
});
const cockpitServer = cockpit.listen(0);
await new Promise(r => cockpitServer.once("listening", r));

const app = express();
registerMagicFeedbackRoutes(app);
app.use(express.json({ limit: "30mb" })); // what registerApiRoutes installs after it
app.post("/api/other", (_req, res) => {
  res.json({ ok: true });
});
const appServer = app.listen(0);
await new Promise(r => appServer.once("listening", r));
const base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const savedKey = process.env.MAGIC_FEEDBACK_KEY;
const savedUrl = process.env.RICO_COCKPIT_URL;
try {
  delete process.env.MAGIC_FEEDBACK_KEY;
  process.env.RICO_COCKPIT_URL = `http://127.0.0.1:${(cockpitServer.address() as AddressInfo).port}`;

  await check("route: unset key → 503 and nothing forwarded", async () => {
    const r = await post("/api/magic-feedback", { shot: "x" });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, error: NOT_CONFIGURED });
    const c = await post("/api/magic-feedback/confirm", { summary: "x" });
    assert.equal(c.status, 503);
    assert.equal(seen.length, 0);
  });

  process.env.MAGIC_FEEDBACK_KEY = KEY;
  await check(
    "route: read forwards with the bearer and relays the reply; key never in the response",
    async () => {
      const r = await post("/api/magic-feedback", {
        shot: "x",
        audio: "a",
        elements: [],
      });
      const text = await r.text();
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(text).annotations[0].text, "here");
      assert.equal(seen.at(-1)!.path, "/api/magic-feedback");
      assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);
      assert.ok(!text.includes(KEY));
      assert.ok(![...r.headers.values()].some(v => v.includes(KEY)));
    }
  );
  await check(
    "route: pages and clips reach the cockpit untouched",
    async () => {
      const body = readBody({
        pages: [pg("https://g/a", 0), pg("https://g/b", 5000)],
        clips: [
          { audio: "A", at: 0 },
          { audio: "B", at: 7000 },
        ],
        mousePath: [],
        clicks: [],
        ms: 9000,
      });
      const r = await post("/api/magic-feedback", body);
      assert.equal(r.status, 200);
      assert.deepEqual(seen.at(-1)!.body, body);
      const c = await post("/api/magic-feedback/confirm", {
        summary: "s",
        notes: [{ text: "n", page: 1 }],
        pages: [{ url: "https://g/a" }, { url: "https://g/b" }],
      });
      assert.equal(c.status, 200);
      assert.deepEqual(seen.at(-1)!.body.pages, [
        { url: "https://g/a" },
        { url: "https://g/b" },
      ]);
      assert.deepEqual(seen.at(-1)!.body.notes, [{ text: "n", page: 1 }]);
    }
  );
  await check("route: confirm sets by server-side", async () => {
    const r = await post("/api/magic-feedback/confirm", {
      summary: "s",
      notes: [{ text: "n" }],
      by: "Someone else",
      sender: "daniel",
    });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(text), {
      ok: true,
      id: "b123",
      folded: false,
      started: true,
    });
    assert.equal(seen.at(-1)!.body.by, MAGIC_BY);
    assert.equal(seen.at(-1)!.body.sender, undefined);
    assert.equal(seen.at(-1)!.auth, `Bearer ${KEY}`);
    assert.ok(!text.includes(KEY));
  });
  await check(
    "route: the cockpit's own status and sentence are relayed",
    async () => {
      const r = await post("/api/magic-feedback", { shot: "limit" });
      assert.equal(r.status, 429);
      const b = await r.json();
      assert.equal(b.ok, false);
      assert.match(b.error, /today's 60 recordings/);
    }
  );
  await check(
    "route: a 22 MB recording passes; over 25 MB is a 413 with a sentence",
    async () => {
      const big = await post("/api/magic-feedback", {
        shot: "x",
        audio: "a".repeat(22 * 1024 * 1024),
      });
      assert.equal(big.status, 200);
      const tooBig = await post("/api/magic-feedback", {
        shot: "x",
        audio: "a".repeat(26 * 1024 * 1024),
      });
      assert.equal(tooBig.status, 413);
      assert.deepEqual(await tooBig.json(), {
        ok: false,
        error: "That recording is too large to send.",
      });
      // the wider parser behind it still serves every other route
      const other = await post("/api/other", {
        audio: "a".repeat(26 * 1024 * 1024),
      });
      assert.equal(other.status, 200);
    }
  );
  await check(
    "route: an unreachable cockpit is a 502 with a sentence",
    async () => {
      process.env.RICO_COCKPIT_URL = "http://127.0.0.1:1";
      const r = await post("/api/magic-feedback/confirm", { summary: "s" });
      assert.equal(r.status, 502);
      const t = await r.text();
      assert.equal(JSON.parse(t).ok, false);
      assert.ok(!t.includes(KEY));
    }
  );
} finally {
  if (savedKey === undefined) delete process.env.MAGIC_FEEDBACK_KEY;
  else process.env.MAGIC_FEEDBACK_KEY = savedKey;
  if (savedUrl === undefined) delete process.env.RICO_COCKPIT_URL;
  else process.env.RICO_COCKPIT_URL = savedUrl;
  appServer.close();
  cockpitServer.close();
}

clearInterval(keepAlive);
if (failures.length) {
  console.error(`magic feedback: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`magic feedback: all ${passed} checks passed`);
