// =============================================================================
// consensus — when a listing's models disagree, who checks what.
//
// Every listing search — Radar's through /v1, the website's New search and Run
// again — gets these cross-checks here (platform.ts crossCheckIfSplit). Radar
// used to run its own copy (radar: server/address-search/consensus.ts); that
// copy is being removed, so GeoFinder is the one place they are decided:
//   * neither found an exact address      → nothing to check
//   * both found the same address         → agreed, nothing to check
//   * one found it, the other did not     → the other checks it
//   * both found DIFFERENT addresses      → each checks the other's
// "Found" means street or building confidence with a house number, or the
// cadastral plot number(s).
// =============================================================================
import { runnableModel, type Answer, type KnownModel, type ModelId } from "./jobs";

export interface Candidate {
  /** Street address, or the commune when only the plot is known. */
  address: string;
  parcel: string | null;
  latitude: number | null;
  longitude: number | null;
}

const EXACT_CONFIDENCE = new Set(["street", "building"]);

function parcelOf(a: Answer): string | null {
  if (a.parcels?.length) return a.parcels.map((p) => `${p.commune} ${p.plot}`).join(", ");
  return a.parcel?.trim() || null;
}

/** The exact address a run found, or null when it found none. */
export function exactAddressOf(answer: Answer | null): Candidate | null {
  if (!answer || !answer.found) return null;
  if (!EXACT_CONFIDENCE.has(answer.confidence)) return null;
  const address = answer.address?.trim() || null;
  const parcel = parcelOf(answer);
  const numbered = !!address && !!houseNumberOf(address);
  if (!numbered && !(parcel && plotNumbersOf(parcel).length)) return null;
  return {
    address: address ?? answer.commune?.trim() ?? parcel!,
    parcel,
    latitude: answer.latitude,
    longitude: answer.longitude,
  };
}

/** "Horgen 1234, 1235" → ["1234", "1235"]: the plot numbers, sorted. */
export function plotNumbersOf(parcel: string | null | undefined): string[] {
  if (!parcel) return [];
  // A postcode in front of a town ("8810 Horgen") is not a plot number.
  const text = parcel.replace(/\b\d{4}\s+(?=[A-Za-zÀ-ÿ])/g, " ");
  return Array.from(new Set(text.match(/\d+/g) ?? [])).sort();
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "Seestrasse 12a, 8002 Zürich" → "12a". Postcodes are not house numbers. */
export function houseNumberOf(address: string): string | null {
  const street = fold(address.split(",")[0] ?? "");
  const m = street.match(/(?:^|\s)(\d{1,4})\s?([a-z])?(?=$|[\s\-/])/);
  if (!m) return null;
  return `${m[1]}${m[2] ?? ""}`;
}

const STREET_WORDS: Array<[RegExp, string]> = [
  // German compounds: "Seestr." is "Seestrasse".
  [/str\.?(?=\s|$)/g, "strasse"],
  [/\bch\.?(?=\s)/g, "chemin"],
  [/\bav\.?(?=\s)/g, "avenue"],
  [/\brte\.?(?=\s)/g, "route"],
  [/\bpl\.?(?=\s)/g, "place"],
  [/\bbd\.?(?=\s)/g, "boulevard"],
];

/** The street name alone, folded: "Ch. des Roses 4" → "chemin des roses". */
export function streetOf(address: string): string {
  let s = fold(address.split(",")[0] ?? "").replace(/ß/g, "ss");
  s = s.replace(/\d{1,4}\s?[a-z]?(?=$|[\s\-/])/g, " ");
  for (const [re, to] of STREET_WORDS) s = s.replace(re, to);
  return s.replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

function metresBetween(a: Candidate, b: Candidate): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) return null;
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Same building? The house number must match, and then either the street name
 * matches or the two pins sit within 40 m of each other (the same street
 * spelled in two languages, "Seestrasse" vs "Seestr.").
 */
export function sameAddress(a: Candidate, b: Candidate): boolean {
  // Both name plots: the same plot numbers are the same place.
  const pa = plotNumbersOf(a.parcel);
  const pb = plotNumbersOf(b.parcel);
  if (pa.length && pb.length) return pa.join(",") === pb.join(",");
  const na = houseNumberOf(a.address);
  const nb = houseNumberOf(b.address);
  if (!na || !nb) {
    // One names only a plot, the other only a street: same place only when
    // their pins sit within 40 m.
    const d = metresBetween(a, b);
    return d != null && d <= 40;
  }
  if (na !== nb) return false;
  const sa = streetOf(a.address);
  const sb = streetOf(b.address);
  if (sa && sa === sb) return true;
  const d = metresBetween(a, b);
  return d != null && d <= 40;
}

export interface Check {
  verifier: ModelId;
  candidate: Candidate;
  candidateFrom: KnownModel;
}

/** After the searches finished: the checks to run (none when they agree or nobody found it). */
export function planChecks(searches: { model: KnownModel; answer: Answer | null }[]): Check[] {
  const found = searches.map((s) => ({ ...s, at: exactAddressOf(s.answer) }));
  const checks: Check[] = [];
  for (const claim of found) {
    if (!claim.at) continue;
    for (const other of found) {
      if (other === claim || other.model === claim.model) continue;
      if (other.at && sameAddress(other.at, claim.at)) continue;
      checks.push({ verifier: runnableModel(other.model), candidate: claim.at, candidateFrom: claim.model });
    }
  }
  return checks;
}

/** Did a check confirm the address it was asked about? */
export function confirms(candidate: Candidate, answer: Answer | null): boolean {
  const at = exactAddressOf(answer);
  return !!at && sameAddress(at, candidate);
}
