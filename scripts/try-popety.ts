/**
 * Call the Popety.io API from the command line.
 *
 * Usage:
 *   pnpm try:popety "Avenue de la Gare 12, 1003 Lausanne"   # address -> land id + land
 *   pnpm try:popety --path /v1/lands/123056/zoning           # any GET endpoint
 *
 * Requires POPETY_API_KEY (put it in .env).
 */
import { findLandByAddress, getLand, popety } from "../server/popety";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--path") {
    console.log(JSON.stringify(await popety(args[1]), null, 2));
    return;
  }
  const address = args.join(" ") || "Avenue de la Gare 12, 1003 Lausanne";
  const found = await findLandByAddress(address);
  console.log(found);
  console.log(JSON.stringify(await getLand(found.popetyio_land_id), null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
