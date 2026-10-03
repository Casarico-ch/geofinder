// =============================================================================
// search — where to look, and what has actually been looked at.
//
// Run c5bc3cfd lost its house twice over: the listing's commune ("Saint-Sulpice")
// was taken as fact although the text said "à 5 minutes de Saint-Sulpice" (the
// house is in Denges, next door), and nothing recorded which candidates had been
// viewed, so the run gave up with ~170 neighbour candidates never looked at.
//
//   - assessCommune: a deterministic read of the listing — is the commune stated
//     (HIGH: exhaust it first) or only approximate (LOW: search outward, nearest
//     commune first)? Plus the ordered ring of neighbouring communes.
//   - the ledger: every shortlisted candidate, whether it was viewed and the
//     verdict, so "exhausted the commune" is a fact the code can check.
// =============================================================================
import {
  builtCentre,
  fetchCommuneBuildings,
  neighbourCommunes,
  normalizeCommune,
  resolveCommune,
} from "./gwr";

export type CommuneConfidence = "high" | "low" | "unknown";
export type Verdict = "unchecked" | "rejected" | "possible" | "match";

export interface LedgerEntry {
  egid: string;
  order: number; // shortlist rank across the whole run (object keys are EGIDs, which JS orders numerically)
  commune: string;
  address: string | null;
  lat: number;
  lon: number;
  floors: number | null;
  dwellings: number | null;
  footprintM2: number | null;
  viewed: boolean; // shown on a view_candidates contact sheet
  verdict: Verdict;
  reason?: string;
}

export interface SearchState {
  stated: string | null; // the commune as the listing gives it
  primary: string | null; // resolved official name, e.g. "Saint-Sulpice (VD)"
  confidence: CommuneConfidence;
  evidence: string[]; // why: the exact phrases that decided it
  ring: { commune: string; distanceM: number }[]; // nearest first
  shortlisted: string[]; // communes already shortlisted (official names)
  candidates: Record<string, LedgerEntry>; // by EGID; `order` keeps the shortlist ranking
  submitGated?: boolean; // a premature found=false was turned back once
}

// ---------------------------------------------------------------------------
// Commune confidence
// ---------------------------------------------------------------------------

// "Municipality / commune: X" (prepended by the API), else the listing's own
// "Town:" / "Location" lines.
export function statedCommune(municipality: string | undefined, listingText: string | undefined): string | null {
  if (municipality?.trim()) return municipality.trim();
  const t = listingText ?? "";
  const m =
    t.match(/^Municipality \/ commune:\s*(.+)$/m) ??
    t.match(/^Town:\s*(.+)$/m) ??
    t.match(/^Location stated by the listing[^:]*:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Phrases that place the property NEAR a place rather than IN it. The place
// they point at is captured so it can be compared with the stated commune.
const PROXIMITY: RegExp[] = [
  // FR: "à (seulement) 5 minutes (à pied / en voiture) de Saint-Sulpice"
  /\b(?:à\s+)?(?:[Ss]eulement\s+|[Qq]uelques\s+|[Ee]nv(?:iron|\.)?\s+)?\d*\s*(?:min(?:utes?)?|km|kilomètres?)\s+(?:à pied\s+|en voiture\s+|en vélo\s+|en transports?(?: publics)?\s+)?(?:de|du|des|d['’])\s*([A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[\s-][A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)*)/g,
  /\b(?:[Pp]roche|[Pp]rès|[Aa]ux portes|[ÀàAa] deux pas|[ÀàAa] proximité|[Aa]ux environs|[Nn]on loin)\s+(?:de|du|des|d['’])\s*([A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[\s-][A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)*)/g,
  /\b(?:[Dd]ans la région|[Rr]égion|[Ee]nvirons)\s+(?:de|du|d['’])\s*([A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:[\s-][A-ZÀ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)*)/g,
  // DE: "5 Minuten von Zürich", "in der Nähe von Zug", "nahe Baden"
  /\b\d*\s*(?:Min(?:uten|\.)?|km)\s+(?:zu Fuss\s+|mit dem Auto\s+)?(?:von|bis|nach|ab)\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ.-]+(?:[\s-][A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ.-]+)*)/g,
  /\b(?:in der Nähe von|unweit von|nahe(?: bei)?|Region|Umgebung von)\s+([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ.-]+(?:[\s-][A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ.-]+)*)/g,
  // IT: "a pochi minuti da Lugano", "vicino a Locarno"
  /\b(?:a\s+)?(?:pochi\s+)?\d*\s*(?:minuti|km)\s+(?:a piedi\s+|in auto\s+)?da\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:[\s-][A-Z][A-Za-zÀ-ÖØ-öø-ÿ'.-]+)*)/g,
  /\b(?:vicino a|nei pressi di|nelle vicinanze di|regione di)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:[\s-][A-Z][A-Za-zÀ-ÖØ-öø-ÿ'.-]+)*)/g,
];

// True when a captured place refers to the stated commune ("Saint-Sulpice" vs
// "St-Sulpice VD"): same normalised name, or one contains the other's core word.
function samePlace(a: string, b: string): boolean {
  const x = normalizeCommune(a), y = normalizeCommune(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  const core = (s: string) => s.split("-").filter((w) => w.length > 3 && w !== "saint" && w !== "sainte");
  return core(x).some((w) => core(y).includes(w));
}

export function communeConfidence(stated: string | null, listingText: string | undefined): {
  confidence: CommuneConfidence;
  evidence: string[];
} {
  if (!stated) return { confidence: "unknown", evidence: ["No commune is stated — infer it from the text and photos."] };
  // Only the listing's own prose, not the structured lines we prepend.
  const text = (listingText ?? "").replace(/^(?:Municipality \/ commune|Town|Location stated by the listing[^:]*):.*$/gm, " ");
  const evidence: string[] = [];
  for (const re of PROXIMITY) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (samePlace(m[1], stated)) evidence.push(`"${m[0].trim()}"`);
    }
  }
  if (evidence.length) {
    return {
      confidence: "low",
      evidence: [`The listing places the property NEAR ${stated}, not in it: ${evidence.slice(0, 3).join(", ")}.`],
    };
  }
  return { confidence: "high", evidence: [`The listing names ${stated} and nothing in the text places the property outside it.`] };
}

// Confidence + neighbour ring. Network failures degrade to "no ring" — the
// confidence itself is pure text and always available.
export async function assessCommune(municipality: string | undefined, listingText: string | undefined): Promise<SearchState> {
  const stated = statedCommune(municipality, listingText);
  const { confidence, evidence } = communeConfidence(stated, listingText);
  const state: SearchState = {
    stated,
    primary: null,
    confidence,
    evidence,
    ring: [],
    shortlisted: [],
    candidates: {},
  };
  if (!stated) return state;
  try {
    const c = await resolveCommune(stated);
    if (!c) {
      state.evidence.push(`"${stated}" did not resolve to a Swiss commune; check the spelling before shortlisting.`);
      return state;
    }
    state.primary = c.name;
    const anchor = builtCentre(await fetchCommuneBuildings(c));
    if (anchor) {
      state.ring = (await neighbourCommunes(c, anchor)).map((n) => ({ commune: n.commune.name, distanceM: n.distanceM }));
    }
  } catch (err) {
    console.error("[search] commune assessment failed:", err);
  }
  return state;
}

// The block put in front of the model before it starts.
export function searchPlanText(s: SearchState): string {
  const ring = s.ring.length
    ? s.ring.map((r) => `${r.commune} (${(r.distanceM / 1000).toFixed(1)} km)`).join(", ")
    : "(could not be computed — work outward from the commune yourself)";
  const where = s.primary ?? s.stated;
  if (s.confidence === "high" && where) {
    return [
      `SEARCH PLAN — commune confidence: HIGH (${where}).`,
      `Why: ${s.evidence.join(" ")}`,
      `Exhaust ${where} FIRST: shortlist it, view every candidate (view_candidates) and record a verdict for each (mark_candidates). shortlist_buildings refuses other communes until every ${where} candidate has a verdict. If the shortlist misses it, re-shortlist ${where} with wider estimates before leaving.`,
      `Only then, if nothing matched, go outward nearest first: ${ring}.`,
    ].join("\n");
  }
  if (s.confidence === "low" && where) {
    return [
      `SEARCH PLAN — commune confidence: LOW (stated: ${where}).`,
      `Why: ${s.evidence.join(" ")}`,
      `The stated commune is a landmark, not the location. Search the communes around it, nearest first, finishing each before the next: ${ring}; ${where} itself last. Use the listing's other distances (to towns, schools, stations) to re-order this ring when they point clearly one way.`,
    ].join("\n");
  }
  return [
    `SEARCH PLAN — commune confidence: UNKNOWN.`,
    `Why: ${s.evidence.join(" ")}`,
    `Work out the most likely commune from the text and photos, then shortlist and exhaust it before moving outward.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function addCandidates(
  s: SearchState,
  commune: string,
  cands: {
    egid: number;
    lat: number;
    lon: number;
    floors: number | null;
    footprintM2: number | null;
    dwellings?: number | null;
    address?: string | null;
  }[],
): number {
  if (!s.shortlisted.includes(commune)) s.shortlisted.push(commune);
  let added = 0;
  let order = Object.keys(s.candidates).length;
  for (const c of cands) {
    const key = String(c.egid);
    if (s.candidates[key]) continue;
    s.candidates[key] = {
      egid: key,
      order: order++,
      commune,
      address: c.address ?? null,
      lat: c.lat,
      lon: c.lon,
      floors: c.floors,
      dwellings: c.dwellings ?? null,
      footprintM2: c.footprintM2,
      viewed: false,
      verdict: "unchecked",
    };
    added++;
  }
  return added;
}

export function unchecked(s: SearchState, commune?: string): LedgerEntry[] {
  return Object.values(s.candidates)
    .filter((c) => c.verdict === "unchecked" && (!commune || c.commune === commune))
    .sort((a, b) => a.order - b.order);
}

// Next candidates to show: unviewed first, in shortlist order.
export function nextToView(s: SearchState, n: number, commune?: string): LedgerEntry[] {
  return unchecked(s, commune).filter((c) => !c.viewed).slice(0, n);
}

// Per-commune coverage, e.g. "Denges 40/120 checked".
export function coverageText(s: SearchState): string {
  if (!s.shortlisted.length) return "nothing shortlisted yet";
  return s.shortlisted
    .map((commune) => {
      const all = Object.values(s.candidates).filter((c) => c.commune === commune);
      const done = all.filter((c) => c.verdict !== "unchecked").length;
      return `${commune} ${done}/${all.length} checked`;
    })
    .join(", ");
}

// The communes in the order the plan visits them. HIGH: the stated commune,
// then the ring. LOW: the listing says the property is NEAR the stated commune,
// so the ring comes first and the stated commune itself last.
export function planOrder(s: SearchState): string[] {
  const stated = s.primary ?? s.stated;
  const ring = s.ring.map((r) => r.commune);
  const order = s.confidence === "low" ? [...ring, stated] : [stated, ...ring];
  return order.filter((c): c is string => !!c);
}

// Communes of the plan that have not been shortlisted yet, in plan order.
export function pendingCommunes(s: SearchState, limit = 4): string[] {
  if (s.confidence === "unknown") return []; // no plan to hold the model to
  const order = planOrder(s);
  const todo = order.filter((c) => !s.shortlisted.some((x) => samePlace(x, c)));
  return todo.slice(0, limit);
}

// Before leaving the primary commune (HIGH confidence only): null if allowed,
// else the reason to refuse.
export function leavePrimaryBlocked(s: SearchState, requested: string): string | null {
  if (s.confidence !== "high" || !s.primary || samePlace(requested, s.primary)) return null;
  if (!s.shortlisted.includes(s.primary)) {
    return `Commune confidence is HIGH for ${s.primary}: shortlist ${s.primary} first and check its candidates before looking elsewhere.`;
  }
  const left = unchecked(s, s.primary);
  if (left.length) {
    return `Commune confidence is HIGH for ${s.primary} and ${left.length} of its candidates have no verdict yet. View them (view_candidates) and record a verdict (mark_candidates) before shortlisting ${requested}. If ${s.primary}'s shortlist itself looks wrong, re-shortlist ${s.primary} with wider estimates instead.`;
  }
  return null;
}
