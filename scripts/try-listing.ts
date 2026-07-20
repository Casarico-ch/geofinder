/**
 * Run a GeoFinder investigation from the command line — same background agent,
 * run to completion synchronously and printed.
 *
 * Usage:
 *   pnpm try:listing <image...> [--text "listing text"] [--text-file <path>]
 *
 * Requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { runInvestigation, saveListingPhotos, type AgentImage } from "../server/agent";
import { createJob } from "../server/jobs";

const MEDIA_TYPES: Record<string, AgentImage["mediaType"]> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function parseArgs(argv: string[]): { imagePaths: string[]; listingText?: string } {
  const imagePaths: string[] = [];
  let listingText: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--text") listingText = argv[++i];
    else if (arg === "--text-file") listingText = readFileSync(argv[++i], "utf8");
    else imagePaths.push(arg);
  }
  return { imagePaths, listingText: listingText?.trim() || undefined };
}

async function main() {
  const { imagePaths, listingText } = parseArgs(process.argv.slice(2));
  if (imagePaths.length === 0) {
    console.error('Usage: pnpm try:listing <image...> [--text "…"] [--text-file <path>]');
    process.exit(1);
  }

  const images: AgentImage[] = imagePaths.map((path) => {
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${path}`);
    return { base64: readFileSync(path).toString("base64"), mediaType };
  });

  console.error(`Investigating ${images.length} image(s)${listingText ? ` + listing text` : ""}…\n`);

  const job = await createJob({ listingText, imageCount: images.length });
  await saveListingPhotos(job.runDir, images);

  // Mirror the live trace to the console as steps land.
  let printed = 0;
  const timer = setInterval(() => {
    for (; printed < job.steps.length; printed++) {
      const s = job.steps[printed];
      console.log(`${String(s.n).padStart(2)}. [${s.kind}] ${s.title}`);
      if (s.reasoning) console.log(`    ${s.reasoning.replace(/\n/g, "\n    ").slice(0, 800)}`);
    }
  }, 500);

  await runInvestigation(job, images, listingText);
  clearInterval(timer);
  for (; printed < job.steps.length; printed++) {
    const s = job.steps[printed];
    console.log(`${String(s.n).padStart(2)}. [${s.kind}] ${s.title}`);
  }

  const a = job.answer;
  console.log(`\n=== ANSWER (${job.status}) ===`);
  console.log(`found:       ${a?.found}`);
  console.log(`address:     ${a?.address ?? "—"}`);
  console.log(`parcel:      ${a?.parcel ?? "—"}`);
  console.log(`confidence:  ${a?.confidence}`);
  console.log(`coordinates: ${a?.latitude != null && a?.longitude != null ? `${a.latitude}, ${a.longitude}` : "—"}`);
  console.log(`links:       ${a?.links.join("  ") ?? "—"}`);
  console.log(`\nreasoning:   ${a?.reasoning ?? "—"}`);
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
