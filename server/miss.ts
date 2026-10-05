// =============================================================================
// Why a practice run never shortlisted the right house.
//
// The run's own checklist only says the house was never on it. This finds the
// house in the federal register — by its fingerprint, so the truth itself is
// never stored — in the communes the run searched and the ones around the
// listing's, and replays the run's shortlist filters on it:
//   wrong commune · not residential in the register · floors · dwellings ·
//   footprint · passed every filter but was beyond the list it was shown.
//
// The reason names the house's own register facts, so it is never shown while
// any practice run is still searching that listing (practice.ts searching()).
// =============================================================================
import { fetchCommuneBuildings, normalizeCommune, resolveCommune, type GwrBuilding } from "./gwr";
import { getJob } from "./jobs";
import { fingerprint, type PracticeResult } from "./practice";
import { homeStatus, inBand, inRange } from "./shortlist";

export type MissCode = "wrong_commune" | "not_residential" | "floors" | "dwellings" | "footprint" | "cut_off" | "not_found";

export interface MissReason {
  code: MissCode;
  text: string;
}

const cache = new Map<string, Promise<MissReason | null>>();
const known = new Map<string, MissReason>(); // finished diagnoses, by job id

// Runs before the ranked shortlist saw existing homes only (category 1020-1059).
const oldResidential = (b: GwrBuilding) =>
  (b.status == null || b.status === 1004) && (b.category == null || (b.category >= 1020 && b.category < 1060));

async function findIn(commune: string, egidKey: string): Promise<GwrBuilding | null> {
  const c = await resolveCommune(commune).catch(() => null);
  if (!c) return null;
  const all = await fetchCommuneBuildings(c).catch(() => [] as GwrBuilding[]);
  return all.find((b) => fingerprint("egid", String(Number(b.egid))) === egidKey) ?? null;
}

async function diagnose(r: PracticeResult): Promise<MissReason | null> {
  const job = r.jobId ? getJob(r.jobId) : undefined;
  const s = job?.search;
  if (!job || !s) return null;
  const searched = s.shortlisted;

  // The house in a commune the run searched?
  let house: GwrBuilding | null = null;
  for (const c of searched) if ((house = await findIn(c, r.truth.egid))) break;

  if (!house) {
    // Around the listing's commune: the one stated, then its nearest neighbours.
    const around = [s.primary ?? s.stated, ...s.ring.slice(0, 6).map((x) => x.commune)].filter(
      (c): c is string => !!c && !searched.some((x) => normalizeCommune(x) === normalizeCommune(c)),
    );
    for (const c of around) {
      if ((house = await findIn(c, r.truth.egid))) {
        return {
          code: "wrong_commune",
          text: `The house is in ${house.commune}, which it never searched${searched.length ? ` (it searched ${searched.join(", ")})` : ""}.`,
        };
      }
    }
    return { code: "not_found", text: "The house is not in the register of the communes it searched or the ones next to the listing's." };
  }

  const calls = (s.calls ?? []).filter((c) => normalizeCommune(c.commune) === normalizeCommune(house!.commune));
  if (calls.some((c) => c.ranked)) {
    if (homeStatus(house) === null)
      return { code: "not_residential", text: `The register does not list the house as a home (category ${house.category ?? "?"}, status ${house.status ?? "?"}), so the shortlist never offers it.` };
    const c = calls.filter((x) => x.ranked).sort((a, b) => b.returned - a.returned)[0];
    const seen = calls.filter((x) => x.ranked).reduce((t, x) => t + x.returned, 0);
    return {
      code: "cut_off",
      text: `It is one of the ${c.survivors} homes of ${house.commune}, ranked beyond the ${seen} the run looked at.`,
    };
  }
  if (!oldResidential(house))
    return {
      code: "not_residential",
      text: `The register does not list the house as an existing residential building (category ${house.category ?? "?"}, status ${house.status ?? "?"}), so the shortlist never offers it.`,
    };

  if (!calls.length)
    return { code: "cut_off", text: `It was in ${house.commune}, but the run's shortlist filters were not recorded (an older run).` };

  // The call that came closest: the fewest filters the house fails.
  const fails = (c: (typeof calls)[number]) => {
    const out: { code: MissCode; text: string }[] = [];
    if (!inRange(house!.floors, c.floors, 1, 1))
      out.push({ code: "floors", text: `floors guessed ${c.floors}, the register says ${house!.floors}` });
    if (!inRange(house!.dwellings, c.dwellings, 1, 1))
      out.push({ code: "dwellings", text: `homes in the building guessed ${c.dwellings}, the register says ${house!.dwellings}` });
    if (!inBand(house!.footprintM2, c.footprintM2))
      out.push({ code: "footprint", text: `footprint guessed ${c.footprintM2} m², the register says ${house!.footprintM2} m²` });
    return out;
  };
  const best = calls.map(fails).sort((a, b) => a.length - b.length)[0];
  if (best.length) return { code: best[0].code, text: `Filtered out: ${best.map((f) => f.text).join("; ")}.` };
  const passed = calls.find((c) => !fails(c).length)!;
  return {
    code: "cut_off",
    text: `It passed the filters, but ${passed.survivors} houses did and the run was shown only ${passed.returned} of them; it never asked for the rest.`,
  };
}

/** Why this missed run never had the right house on its checklist (cached per run). */
export function missReason(r: PracticeResult): Promise<MissReason | null> {
  if (!r.jobId || (r.lostAt !== "not_shortlisted" && r.lostAt !== "commune")) return Promise.resolve(null);
  let hit = cache.get(r.jobId);
  if (!hit) {
    hit = diagnose(r).catch(() => null);
    cache.set(r.jobId, hit);
    void hit.then((v) => {
      if (v) known.set(r.jobId!, v);
      else cache.delete(r.jobId!);
    });
  }
  return hit;
}

/**
 * The reason if it is known; otherwise start working it out (a commune's
 * register can take half a minute) and answer null — the page asks again.
 */
export function missReasonNow(r: PracticeResult): MissReason | null {
  const hit = r.jobId ? known.get(r.jobId) : undefined;
  if (hit) return hit;
  void missReason(r);
  return null;
}
