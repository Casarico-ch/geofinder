import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { resumeInvestigation } from "./agent";
import { registerApiRoutes } from "./api";
import { loadPersistedJobs } from "./jobs";
import { resumeRounds } from "./practice";
import { startCleanupLoop } from "./cleanup";
import { startLessonsLoop } from "./lessons";
import { registerMagicFeedbackRoutes } from "./magic-feedback";
import { registerPlatformRoutes } from "./platform";
import { loadPersistedRequests } from "./requests";
import { RUNS_ROOT, initRunsRoot } from "./sandbox";

// Never let a stray async error take the process down (Node 15+ exits on
// unhandled rejections by default) — log it and keep serving.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Resolve a writable runs dir (falls back if the volume is mis-mounted), then
  // recover jobs (and their traces) from previous runs before serving.
  await initRunsRoot();
  const resumable = await loadPersistedJobs();

  await loadPersistedRequests();

  // Railway's health check — always open, even behind ADMIN_PASSWORD.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // The admin website (everything except the platform's /v1 API) sits behind
  // a browser password prompt when ADMIN_PASSWORD is set.
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPassword) {
    app.use((req, res, next) => {
      if (req.path.startsWith("/v1/")) return next();
      const [, encoded] = (req.header("authorization") ?? "").split(" ");
      const password = Buffer.from(encoded ?? "", "base64").toString().split(":").slice(1).join(":");
      if (password === adminPassword) return next();
      res.set("WWW-Authenticate", 'Basic realm="GeoFinder admin"').status(401).send("Password required");
    });
  }

  // Magic feedback (Alt+Shift+M) — behind the same gate as the rest of the
  // website, and before registerApiRoutes so its own 15mb body limit applies.
  registerMagicFeedbackRoutes(app);
  registerApiRoutes(app);
  registerPlatformRoutes(app);

  // Resume any investigation that was still running when the previous process
  // exited (e.g. a redeploy) so the work continues instead of dying with the
  // container. Fire-and-forget — each run drives itself to completion.
  for (const job of resumable) {
    console.log(`[resume] continuing investigation ${job.id} (${job.steps.length} steps so far)`);
    void resumeInvestigation(job).catch((err) => {
      console.error(`[resume] investigation ${job.id} failed to resume:`, err);
    });
  }

  // Carry on any practice round a restart interrupted (practice.ts).
  void resumeRounds().catch((err) => console.error("[practice] resume failed:", err));
  // Learn from finished rounds and test what was learned (lessons.ts).
  startLessonsLoop();
  // Pictures of runs finished over an hour ago are deleted (cleanup.ts).
  startCleanupLoop();

  // Serve run artifacts — the aerials and crops the agent actually looked at,
  // referenced by the documented trace. The internal resume state (the full
  // conversation, with embedded images) is not an artifact and is never served.
  app.use("/runs", (req, res, next) => {
    if (req.path.endsWith("/state.json") || req.path.endsWith("/conversation.json") || req.path.endsWith(".tmp")) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use("/runs", express.static(RUNS_ROOT));

  // Unmatched API paths must not fall through to the SPA catchall below.
  app.use(["/api", "/v1"], (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
