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
import { analyzeListing, type ImageInput } from "../server/api";

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
  const result = await analyzeListing(client, { images, listingText });

  if ("refusal" in result) {
    console.error("The model declined to analyze this listing.");
    process.exit(2);
  }

  const { estimate, landVerification } = result;
  console.log("=== ESTIMATE ===");
  console.log(`confidence:  ${estimate.confidence}`);
  console.log(`place:       ${estimate.place}`);
  console.log(`address:     ${estimate.address ?? "—"}`);
  console.log(`city/region: ${[estimate.city, estimate.country].filter(Boolean).join(", ") || "—"}`);
  console.log(
    `coordinates: ${estimate.latitude !== null && estimate.longitude !== null ? `${estimate.latitude}, ${estimate.longitude}` : "—"}`,
  );
  console.log(`\nreasoning:   ${estimate.reasoning}`);
  if (estimate.clues.length) console.log(`\nclues:\n${estimate.clues.map((c) => `  · ${c}`).join("\n")}`);
  if (estimate.text_read.length) console.log(`\ntext read:   ${estimate.text_read.join(" | ")}`);

  console.log(`\n=== MAP THE LAND (${landVerification.status}) ===`);
  console.log(`sources:  ${landVerification.sources.join(", ") || "—"}${landVerification.aerialUsed ? " [aerial used]" : ""}`);
  if (landVerification.matched_address) console.log(`matched:  ${landVerification.matched_address}`);
  if (landVerification.matches.length)
    console.log(`matches:\n${landVerification.matches.map((m) => `  · ${m.evidence} (${m.source})`).join("\n")}`);
  if (landVerification.mismatches.length)
    console.log(`mismatches:\n${landVerification.mismatches.map((m) => `  · ${m}`).join("\n")}`);
  if (landVerification.notes) console.log(`notes:    ${landVerification.notes}`);

  console.log(`\n=== RAW JSON ===`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
