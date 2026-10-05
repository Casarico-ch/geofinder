// =============================================================================
// Attached twins: the two halves of a semi-detached pair (or two units of one
// terrace) that are the same house. Naming either one serves the purpose — the
// value check (online tools, zoning rules) comes out the same (Daniel, 05.10:
// "ONLY IF EXACTLY TWIN AND STUCK TOGETHER"). In round rmuvmodoa2bc9, 4 of 6
// wrong answers were the house next door.
//
// Twins: both homes, the same homes in the register, footprints within 15%
// and the same floors (one floor apart allowed when the footprints are within
// 5%: Steinweg 21/23, Aesch, 72 m² each, the register gives 2 and 1), and attached — the 3D outlines touch, or swissBUILDINGS3D draws
// both halves as one building.
// =============================================================================
import { buildingByEgid, fetchCommuneBuildings, resolveCommune, type GwrBuilding } from "./gwr";
import { homeStatus } from "./shortlist";
import { outlineGap, shapeAt } from "./neighbours";

const NEAR_M = 40; // registry points further apart than this are never one pair
const TOUCH_M = 1.0; // outlines this close count as one wall

function metres(a: GwrBuilding, b: GwrBuilding): number {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function sameFacts(a: GwrBuilding, b: GwrBuilding): boolean {
  if (a.dwellings !== b.dwellings || a.footprintM2 == null || b.footprintM2 == null) return false;
  const off = Math.abs(a.footprintM2 - b.footprintM2) / Math.max(a.footprintM2, b.footprintM2);
  if (off > 0.15) return false;
  if (a.floors === b.floors) return true;
  return a.floors != null && b.floors != null && Math.abs(a.floors - b.floors) <= 1 && off <= 0.05;
}

async function attached(a: GwrBuilding, b: GwrBuilding): Promise<boolean> {
  const [sa, sb] = await Promise.all([shapeAt(a.lat, a.lon).catch(() => null), shapeAt(b.lat, b.lon).catch(() => null)]);
  if (!sa || !sb) return false;
  return sa === sb || outlineGap(sa, sb) <= TOUCH_M;
}

/** The EGIDs of the house's attached twins (usually zero or one). */
export async function twinsOf(egid: string | number): Promise<string[]> {
  const b = await buildingByEgid(egid).catch(() => null);
  if (!b || homeStatus(b) === null) return [];
  const c = await resolveCommune(b.commune).catch(() => null);
  if (!c) return [];
  const all = await fetchCommuneBuildings(c).catch(() => [] as GwrBuilding[]);
  const out: string[] = [];
  for (const o of all) {
    if (String(Number(o.egid)) === String(Number(b.egid)) || homeStatus(o) === null) continue;
    if (metres(b, o) > NEAR_M || !sameFacts(b, o)) continue;
    if (await attached(b, o)) out.push(String(Number(o.egid)));
  }
  return out;
}
