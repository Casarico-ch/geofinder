// The agent's checklist helpers shared by the loop, the tools and the proof:
// the search state of a run, adding a register building to it, and the small
// content builders every message uses.
import Anthropic from "@anthropic-ai/sdk";
import { buildingAt, normalizeCommune } from "./gwr";
import { type LedgerEntry, type SearchState, addCandidates } from "./search";
import { type Job } from "./jobs";

export const text = (t: string): Anthropic.Messages.TextBlockParam => ({ type: "text", text: t });

// Put the register building at a point on the checklist (an answer or a close
// look outside the shortlist). Only into a commune already being searched.
export async function addFromRegister(search: SearchState, lat: number, lon: number): Promise<LedgerEntry | null> {
  const b = await buildingAt(lat, lon).catch(() => null);
  if (!b) return null;
  const commune = search.shortlisted.find((x) => normalizeCommune(x) === normalizeCommune(b.commune));
  if (!commune) return null;
  const key = String(Number(b.egid));
  if (!search.candidates[key]) {
    addCandidates(search, commune, [
      {
        egid: Number(b.egid),
        lat: b.lat,
        lon: b.lon,
        floors: b.floors,
        footprintM2: b.footprintM2,
        dwellings: b.dwellings,
        address: b.address,
      },
    ]);
  }
  return search.candidates[key];
}

// The job's search plan + checklist; runs started before it existed get an
// empty one (no plan, nothing gated) so the tools still work on resume.
export function searchOf(job: Job): SearchState {
  if (!job.search) {
    job.search = {
      stated: job.input.municipality ?? null,
      primary: null,
      confidence: "unknown",
      evidence: [],
      ring: [],
      shortlisted: [],
      candidates: {},
    };
  }
  return job.search;
}

// shortlist_buildings' `near`: {lat, lon} or "lat,lon"; anything else is ignored.
export function nearOf(v: unknown): { lat: number; lon: number } | undefined {
  let lat: unknown, lon: unknown;
  if (typeof v === "string") [lat, lon] = v.split(",").map((x) => Number(x.trim()));
  else if (v && typeof v === "object") ({ lat, lon } = v as { lat?: unknown; lon?: unknown });
  else return undefined;
  const ok = (x: unknown, lo: number, hi: number): x is number =>
    typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
  return ok(lat, 45, 48.5) && ok(lon, 5.5, 11) ? { lat, lon } : undefined;
}
