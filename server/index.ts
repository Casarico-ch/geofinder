import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { registerApiRoutes } from "./api";
import { loadPersistedJobs } from "./jobs";
import { RUNS_ROOT } from "./sandbox";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Recover jobs (and their traces) from previous runs before serving.
  await loadPersistedJobs();

  registerApiRoutes(app);

  // Serve run artifacts — the aerials and crops the agent actually looked at,
  // referenced by the documented trace.
  app.use("/runs", express.static(RUNS_ROOT));

  // Unmatched API paths must not fall through to the SPA catchall below.
  app.use("/api", (_req, res) => {
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
