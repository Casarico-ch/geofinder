// =============================================================================
// Popety.io client — Swiss real-estate data (lands, buildings, zoning, …).
// Spec: https://api.popety.io/openapi.json. Needs POPETY_API_KEY in the env.
// Billed in credits (1 credit = CHF 1); a property profile costs 3.80.
// =============================================================================
const BASE_URL = process.env.POPETY_BASE_URL ?? "https://api.popety.io";

export class PopetyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function popety<T = any>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const { status, body } = await popetyRaw(path, init);
  if (status < 200 || status >= 300) {
    throw new PopetyError(status, `Popety ${status} on ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return body as T;
}

// Like popety() but hands back non-2xx answers (e.g. the 300 "ambiguous
// address" list) instead of throwing.
async function popetyRaw(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
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
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text (HTML error pages)
  }
  return { status: res.status, body };
}

export interface LandCandidate {
  landId: string;
  address: string | null;
}

export type LandMatch =
  | { kind: "match"; landId: string; matchedAddress: string | null }
  | { kind: "ambiguous"; candidates: LandCandidate[] }
  | { kind: "none" };

/** Free. Ambiguous addresses come back as a candidate list. */
export async function findLandByAddress(address: string): Promise<LandMatch> {
  const { status, body } = await popetyRaw(`/v1/lands/find-by-address/${encodeURIComponent(address)}`);
  if (status === 300) {
    return {
      kind: "ambiguous",
      candidates: (body.candidates ?? []).map((c: any) => ({
        landId: c.popetyio_land_id,
        address: c.matched_address ?? c.address ?? null,
      })),
    };
  }
  if (status === 404 || (status === 200 && !body.popetyio_land_id)) return { kind: "none" };
  if (status !== 200) throw new PopetyError(status, `Popety ${status} on find-by-address: ${JSON.stringify(body).slice(0, 500)}`);
  return { kind: "match", landId: body.popetyio_land_id, matchedAddress: body.matched_address ?? null };
}

/** Free. */
export async function findLandByCoordinates(lat: number, lon: number): Promise<LandMatch> {
  const { status, body } = await popetyRaw(`/v1/lands/find-by-coordinates/${lat}/${lon}`);
  if (status === 404 || (status === 200 && !body.popetyio_land_id)) return { kind: "none" };
  if (status !== 200) throw new PopetyError(status, `Popety ${status} on find-by-coordinates: ${JSON.stringify(body).slice(0, 500)}`);
  return { kind: "match", landId: body.popetyio_land_id, matchedAddress: body.matched_address ?? null };
}

export type PropertyProfile = ReturnType<typeof toPropertyProfile>;

/** What one profile costs on Popety, in CHF (1 credit = CHF 1). */
export const PROFILE_COST_CHF = 3.8;

/**
 * Popety scores + building + zoning for one address: the plot record (1.50),
 * its buildings (0.30) and its zoning (2.00) — CHF 3.80 in total.
 */
export async function getPropertyProfile(address: string) {
  const match = await findLandByAddress(address);
  if (match.kind !== "match") throw new Error(`No single parcel matches "${address}"`);
  return getProfileByLandId(match.landId, match.matchedAddress ?? address);
}

export async function getProfileByLandId(id: string, matchedAddress: string | null) {
  const enc = encodeURIComponent(id);
  const [land, buildings, zoning] = await Promise.all([
    popety(`/v1/lands/${enc}`),
    popety(`/v1/lands/${enc}/buildings`),
    popety(`/v1/lands/${enc}/zoning`),
  ]);
  return toPropertyProfile(matchedAddress, land, buildings, zoning);
}

// A swisstopo map window around the parcel. Both images are public WMS URLs
// (no key), drawn in plain lat/lon so the outline maps linearly onto them:
// x = (lon - west) / (east - west) * width, y = (north - lat) / (north - south) * height.
// `parcelPixels` is that outline already converted, ready for an SVG overlay.
export function parcelMap(polygon: [number, number][], width = 960, height = 1200) {
  const lons = polygon.map((p) => p[0]);
  const lats = polygon.map((p) => p[1]);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerDegLat = 110_540;
  // Fit the parcel with ~2.5x margin, never tighter than 120 m across.
  const spanM = Math.max(120, 2.5 * Math.max(
    (Math.max(...lons) - Math.min(...lons)) * mPerDegLon,
    ((Math.max(...lats) - Math.min(...lats)) * mPerDegLat * width) / height,
  ));
  const halfW = spanM / 2 / mPerDegLon;
  const halfH = (spanM * height) / width / 2 / mPerDegLat;
  const bbox = { south: lat0 - halfH, west: lon0 - halfW, north: lat0 + halfH, east: lon0 + halfW };
  const wms = (layers: string, format: string) =>
    "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:4326" +
    `&LAYERS=${layers}&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}` +
    `&WIDTH=${width}&HEIGHT=${height}&FORMAT=${encodeURIComponent(format)}&TRANSPARENT=${format === "image/png"}`;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    width,
    height,
    bbox,
    metresPerPixel: spanM / width,
    aerialUrl: wms("ch.swisstopo.swissimage", "image/jpeg"),
    cadastreUrl: wms("ch.kantone.cadastralwebmap-farbe", "image/png"),
    parcelPixels: polygon.map(([lon, lat]) => [
      r1(((lon - bbox.west) / (bbox.east - bbox.west)) * width),
      r1(((bbox.north - lat) / (bbox.north - bbox.south)) * height),
    ]),
  };
}

export function toPropertyProfile(matchedAddress: string | null, land: any, buildings: any, zoning: any) {
  const value = (r: any) => r?.value ?? null;
  const regs = zoning.general_plans?.[0]?.regulations ?? {};
  const plan = zoning.general_plans?.[0];
  const ui = land.current_use_indices ?? {};
  const index = (current: number | null, max: number | null) => ({
    current,
    max,
    usedPct: current != null && max ? Math.round((current / max) * 100) : null,
  });

  const center = land.location?.geo_center ?? null;
  // Outer ring of the first polygon, as [lon, lat] pairs (GeoJSON order).
  const polygon: [number, number][] = land.location?.geo_polygon?.coordinates?.[0]?.[0] ?? [];
  const location = land.location ?? {};

  return {
    address: matchedAddress,
    landId: land.popetyio_land_id as string,
    egrid: land.egrid as string,
    parcelNumber: land.parcel_number as string,
    parcelAreaM2: land.area as number,
    municipality: location.municipality?.name ?? null,
    canton: location.canton?.code ?? null,
    postalCode: location.postal_code?.code ?? null,
    latitude: center?.lat ?? null,
    longitude: center?.lon ?? null,
    parcelPolygon: polygon,
    map: polygon.length ? parcelMap(polygon) : null,
    dataAsOf: land.data_as_of ?? null,
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
