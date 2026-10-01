// =============================================================================
// Popety.io client — Swiss real-estate data (lands, buildings, zoning, …).
// Spec: https://api.popety.io/openapi.json. Needs POPETY_API_KEY in the env.
// Billed in credits (1 credit = CHF 1); a property profile costs 3.80.
// =============================================================================
const BASE_URL = process.env.POPETY_BASE_URL ?? "https://api.popety.io";

export async function popety<T = any>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const key = process.env.POPETY_API_KEY;
  if (!key) throw new Error("POPETY_API_KEY is not set");
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${key}`,
      "X-Popety-Locale": "fr-CH",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Popety ${res.status} on ${path}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

/** Free. */
export const findLandByAddress = (address: string) =>
  popety<{ popetyio_land_id: string; matched_address: string }>(
    `/v1/lands/find-by-address/${encodeURIComponent(address)}`,
  );

export type PropertyProfile = ReturnType<typeof toPropertyProfile>;

/**
 * Popety scores + building + zoning for one address: the plot record (1.50),
 * its buildings (0.30) and its zoning (2.00) — CHF 3.80 in total.
 */
export async function getPropertyProfile(address: string) {
  const { popetyio_land_id: id, matched_address } = await findLandByAddress(address);
  const enc = encodeURIComponent(id);
  const [land, buildings, zoning] = await Promise.all([
    popety(`/v1/lands/${enc}`),
    popety(`/v1/lands/${enc}/buildings`),
    popety(`/v1/lands/${enc}/zoning`),
  ]);
  return toPropertyProfile(matched_address, land, buildings, zoning);
}

export function toPropertyProfile(matchedAddress: string, land: any, buildings: any, zoning: any) {
  const value = (r: any) => r?.value ?? null;
  const regs = zoning.general_plans?.[0]?.regulations ?? {};
  const plan = zoning.general_plans?.[0];
  const ui = land.current_use_indices ?? {};
  const index = (current: number | null, max: number | null) => ({
    current,
    max,
    usedPct: current != null && max ? Math.round((current / max) * 100) : null,
  });

  return {
    address: matchedAddress,
    landId: land.popetyio_land_id as string,
    egrid: land.egrid as string,
    parcelNumber: land.parcel_number as string,
    parcelAreaM2: land.area as number,
    scores: land.popetyio_scores as Record<string, number>,
    buildings: (buildings.buildings ?? []).map((b: any) => ({
      id: b.popetyio_building_id,
      egid: b.egid,
      address: b.address,
      use: b.building_class,
      floors: b.floor_nb ?? null,
      heightM: b.max_height_m,
      builtYear: b.construction_year ?? null,
      heritageProtected: b.is_heritage_protected,
      footprintM2: b.ground_floor_area_m2,
      floorAreaM2: b.gross_floor_area_m2,
      volumeM3: b.volume_m3,
      shareOnParcelPct: b.share_on_parcel_pct,
      views: b.views ?? null,
    })),
    heritageRank: land.highest_building_protected_rank ?? null,
    zoning: {
      cantonalZone: land.zoning?.cantonal_main_zone_name ?? null,
      municipalPlan: plan ? `${plan.lup_name} · ${plan.lupa_name}` : null,
      planAdopted: plan?.adoption_date ?? null,
      federalZone: land.zoning?.federal_harmonized_zone_name ?? null,
      allowedUse: value(regs.allowed_use),
      maxHeightM: value(regs.max_height_m),
      maxFacadeHeightM: value(regs.max_facade_height_m),
      maxLengthM: value(regs.max_length_m),
    },
    builtVsAllowed: {
      siteCoverage: index(ui.cos ?? null, value(regs.max_cos)),
      floorAreaRatio: index(ui.cus ?? null, value(regs.max_cus)),
      grossFloorRatio: index(ui.ibus_gfz ?? null, value(regs.max_ibus_gfz)),
      volumeRatio: index(ui.im_bmz ?? null, value(regs.max_im_bmz)),
    },
  };
}
