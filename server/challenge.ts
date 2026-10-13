// =============================================================================
// challenge — "is THIS the house?" for an address someone suggests.
//
// Daniel, 13.10: "submit an address to review it … suggest a challenger and get
// a clear response on if it's the one or no". The address is looked up in the
// federal address register (its EGID), and the building is checked against the
// listing's own numbers with the same rules a search answer must pass
// (proof.ts factRows / decisive / strongFit). No model runs: it is free and
// takes a few seconds. The photos are not compared, so a "fits" that the facts
// cannot prove on their own says so.
// =============================================================================
import { buildingAt, buildingByEgid, flatsOf, type GwrBuilding } from "./gwr";
import { decisive, factRows, listingFacts, plotAt, plotGroupFor, strongFit, type FactRow } from "./proof";

const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";

export type ChallengeVerdict = "yes" | "likely" | "no" | "unsure";

export interface ChallengeResult {
  query: string;
  address: string | null;
  commune: string | null;
  egid: string;
  verdict: ChallengeVerdict;
  reason: string; // one sentence: why
  facts: Pick<FactRow, "fact" | "listing" | "building" | "verdict">[];
  /** The challenger is the very building the search already answered. */
  sameAsAnswer: boolean;
}

async function getJson(url: string, ms = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "geofinder" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// An EGID typed as is, else the first hit of the address search (its featureId is "EGID_EDID").
async function findBuilding(query: string): Promise<GwrBuilding | null> {
  const q = query.trim();
  if (/^\d{4,10}$/.test(q)) return buildingByEgid(q);
  const j = await getJson(`${SEARCH}?searchText=${encodeURIComponent(q)}&type=locations&origins=address&sr=4326&limit=1`);
  const hit = (j.results ?? [])[0]?.attrs;
  if (!hit) return null;
  const egid = String(hit.featureId ?? "").split("_")[0];
  const byEgid = /^\d+$/.test(egid) ? await buildingByEgid(egid).catch(() => null) : null;
  if (byEgid) return byEgid;
  return typeof hit.lat === "number" && typeof hit.lon === "number" ? buildingAt(hit.lat, hit.lon) : null;
}

export async function challenge(listingText: string, query: string, answerEgid?: string | null): Promise<ChallengeResult> {
  const b = await findBuilding(query);
  if (!b) throw new Error("No building found at that address. Try street, number and postcode, or an EGID.");
  const l = listingFacts(listingText);
  const own = await plotAt(b.lat, b.lon).catch(() => null);
  const group = own && l.landM2 != null && !l.sharedLand ? await plotGroupFor(own, l.landM2).catch(() => null) : null;
  const plots = group ?? (own ? [own] : []);
  const flats = l.livingM2 != null && l.dwellings !== 1 ? await flatsOf(b.egid).catch(() => undefined) : undefined;
  const rows = factRows(l, { floors: b.floors, dwellings: b.dwellings, footprintM2: b.footprintM2, plots, flats });
  const sameAsAnswer = answerEgid != null && String(Number(answerEgid)) === String(Number(b.egid));

  const miss = rows.find((r) => r.verdict === "mismatch");
  let verdict: ChallengeVerdict, reason: string;
  if (miss) {
    verdict = "no";
    reason = `Not the one — ${miss.fact.toLowerCase()}: listing ${miss.listing}, this building ${miss.building}.`;
  } else if (!l.sharedLand && decisive(rows, plots, l.landM2, l.landAltM2)) {
    verdict = "yes";
    reason = "Yes: its plot matches the listed land within 2% and nothing in the register contradicts it.";
  } else if (strongFit(rows)) {
    verdict = "likely";
    reason = "Probably: every fact fits, but they don't prove it alone — compare it with the photos.";
  } else {
    verdict = "unsure";
    reason = rows.length
      ? "Can't tell: nothing rules it out, but no fact separates it from its neighbours."
      : "Can't tell: the listing states no size or home count to check against.";
  }
  return {
    query,
    address: b.address,
    commune: b.commune || null,
    egid: b.egid,
    verdict,
    reason,
    facts: rows.map(({ fact, listing, building, verdict: v }) => ({ fact, listing, building, verdict: v })),
    sameAsAnswer,
  };
}
