// Where does a known answer land in the shortlist's checking order, with and
// without location clues? Uses the live register and swisstopo terrain.
// The "measured" clue is read off the answer's own terrain, so it shows the
// best case (the photos read correctly); "listing" is what the ad text claims.
// Run: pnpm try:locate
import { fetchCommuneBuildings, resolveCommune } from "../server/gwr";
import { compass, terrainAt, type LocationClues } from "../server/locate";
import { shortlistBuildings } from "../server/shortlist";

const CASES: {
  commune: string;
  egid: string;
  listingSlope?: LocationClues["slope"];
  rough?: { floors?: number; footprintM2?: number; dwellings?: number }; // the model's guess instead of the register's own numbers
}[] = [
  { commune: "Zermatt", egid: "960338", listingSlope: { faces: "S", confidence: "likely" } }, // ad: "versant sud"
  { commune: "Zermatt", egid: "960338", listingSlope: { faces: "S", confidence: "likely" }, rough: { floors: 3, footprintM2: 100, dwellings: 1 } },
  { commune: "Denges", egid: "795465" },
  { commune: "Risch", egid: "190174037" },
  { commune: "Gossau (ZH)", egid: "42269" },
  { commune: "Laconnex", egid: "1018745" }, // Geneva: SITG footprints
];

for (const k of CASES) {
  const c = await resolveCommune(k.commune);
  if (!c) { console.log(`${k.commune}: commune not resolved`); continue; }
  const t = (await fetchCommuneBuildings(c)).find((b) => b.egid === k.egid);
  if (!t) { console.log(`${k.commune}: EGID ${k.egid} not in the register`); continue; }
  const est = {
    commune: k.commune,
    maxResults: 150,
    ...(k.rough ?? { floors: t.floors ?? undefined, footprintM2: t.footprintM2 ?? undefined, dwellings: t.dwellings ?? undefined }),
  };
  const terrain = await terrainAt(t.lat, t.lon);
  const measured: LocationClues | undefined =
    terrain?.downhill != null && terrain.grade >= 0.03 ? { slope: { faces: compass(terrain.downhill), confidence: "sure" } } : { slope: { faces: "flat", confidence: "sure" } };
  const scenarios: [string, LocationClues | undefined][] = [["no clues", undefined], [`measured slope ${measured?.slope?.faces}`, measured]];
  if (k.listingSlope) scenarios.push([`listing says ${k.listingSlope.faces}`, { slope: k.listingSlope }]);
  for (const [label, location] of scenarios) {
    const t0 = Date.now();
    const r = await shortlistBuildings({ ...est, location });
    const i = r.candidates.findIndex((x) => String(x.egid) === String(Number(k.egid)));
    const rank = i >= 0 ? `#${i + 1} (sheet ${Math.ceil((i + 1) / 16)})` : `not in the first ${r.candidates.length}`;
    console.log(`${(c.name + (k.rough ? " (rough)" : "")).padEnd(20)} ${String(r.survivors).padStart(4)} survivors | ${label.padEnd(22)} → ${rank}  [${((Date.now() - t0) / 1000).toFixed(1)} s]`);
  }
}
