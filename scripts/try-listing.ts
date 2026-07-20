/**
 * Run the GeoFinder pipeline on a listing from the command line — no server needed.
 *
 * Usage:
 *   pnpm try:listing <image...> [--text "listing text"] [--text-file <path>]
 *
 * Examples:
 *   pnpm try:listing garden.jpg bedroom.jpg --text "Propriété au bord du lac à Corsier-Port…"
 *   pnpm try:listing photos/*.jpg --text-file listing.txt
 *
 * Requires ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { investigateListing, type ImageInput } from "../server/api";

const MEDIA_TYPES: Record<string, ImageInput["mediaType"]> = {
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
    if (arg === "--text") {
      listingText = argv[++i];
    } else if (arg === "--text-file") {
      listingText = readFileSync(argv[++i], "utf8");
    } else {
      imagePaths.push(arg);
    }
  }
  return { imagePaths, listingText: listingText?.trim() || undefined };
}

async function main() {
  const { imagePaths, listingText } = parseArgs(process.argv.slice(2));
  if (imagePaths.length === 0) {
    console.error(
      "Usage: pnpm try:listing <image...> [--text \"listing text\"] [--text-file <path>]",
    );
    process.exit(1);
  }

  const images: ImageInput[] = imagePaths.map((path) => {
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${path} (use jpg/png/webp/gif)`);
    return { imageBase64: readFileSync(path).toString("base64"), mediaType };
  });

  console.error(
    `Analyzing ${images.length} image(s)${listingText ? ` + ${listingText.length} chars of listing text` : ""}…\n`,
  );

  const client = new Anthropic();
  const result = await investigateListing(client, { images, listingText });

  if ("refusal" in result) {
    console.error("The model declined to analyze this listing.");
    process.exit(2);
  }

  const { answer, steps } = result;
  console.log("=== INVESTIGATION ===");
  steps.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s}`));

  console.log(`\n=== ANSWER ===`);
  console.log(`found:       ${answer.found}`);
  console.log(`address:     ${answer.address ?? "—"}`);
  console.log(`parcel:      ${answer.parcel ?? "—"}`);
  console.log(`confidence:  ${answer.confidence}`);
  console.log(
    `coordinates: ${answer.latitude !== null && answer.longitude !== null ? `${answer.latitude}, ${answer.longitude}` : "—"}`,
  );
  console.log(`cadastre:    ${answer.cadastre_url ?? "—"}`);
  console.log(`\nreasoning:   ${answer.reasoning}`);
  if (answer.candidates.length)
    console.log(
      `\ncandidates:\n${answer.candidates.map((c) => `  · ${c.parcel} ${c.surface_m2 ?? "?"}m² ${c.address ?? ""} — ${c.note}`).join("\n")}`,
    );
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
