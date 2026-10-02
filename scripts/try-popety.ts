/**
 * Call the Popety.io API from the command line.
 *
 * Usage:
 *   pnpm try:popety "Avenue de la Gare 12, 1003 Lausanne"   # property profile (CHF 3.80)
 *   pnpm try:popety --path /v1/lands/123056/zoning           # any GET endpoint
 *
 * Requires POPETY_API_KEY (put it in .env).
 */
import { getPropertyProfile, popety } from "../server/popety";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--path") {
    console.log(JSON.stringify(await popety(args[1]), null, 2));
    return;
  }
  const address = args.join(" ") || "Avenue de la Gare 12, 1003 Lausanne";
  console.log(JSON.stringify(await getPropertyProfile(address), null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
