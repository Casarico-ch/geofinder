// =============================================================================
// Enrich — an OPTIONAL, manual post-answer stage.
//
// The address is found by pure deduction (the agent). This is separate: once a
// parcel is known, pull the AUTHORITATIVE public layers around it to build a
// buyer's dossier — cadastre, building, zone, build potential (Geneva's own
// surélévation cadastre + the by-right density with honest flags), energy and
// environment. Every number is a real lookup; the one genuinely discretionary
// item (the art. 59 zone-5 derogation) is flagged, not invented.
// Geneva (SITG) is the rich case; elsewhere only the federal layers apply.
// =============================================================================

const SITG = "https://vector.sitg.ge.ch/arcgis/rest/services";
const GEOADMIN = "https://api3.geo.admin.ch/rest/services";
const UA = "geofinder/1.0 (dossier)";

export interface DossierLink {
  label: string;
  url: string;
}
export interface Dossier {
  generatedAt: string;
  coverage: "geneva" | "partial";
  parcel: {
    number: number | null;
    commune: string | null;
    area_m2: number | null;
    egrid: string | null;
    ownership: string | null;
  } | null;
  building: {
    year: number | null;
    floorsAbove: number | null;
    floorsBelow: number | null;
    footprint_m2: number | null;
    height_m: number | null;
    dwellings: number | null;
    destination: string | null;
  } | null;
  zone: { code: string | null; name: string | null } | null;
  buildPotential: {
    existingSbp_m2: number | null;
    scenarios: { key: string; label: string; ius: number; allowedSbp_m2: number; headroom_m2: number }[];
    surelevation: { applies: boolean; sector: string | null; legalBasis: string | null; note: string | null };
    caveat: string | null;
  } | null;
  energy: { idc: string | null; heatingDemand_kWh: number | null; hotWaterDemand_kWh: number | null; solarRoofSurfaces: number | null } | null;
  environment: { noise: string | null; waterProtection: string | null } | null;
  links: DossierLink[];
  notes: string[];
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Attrs = Record<string, unknown>;

async function sitgPoint(service: string, lat: number, lon: number, outFields = "*", layer = 0): Promise<Attrs[]> {
  const p = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: "false",
    f: "json",
  });
  const d = await fetchJson(`${SITG}/${service}/MapServer/${layer}/query?${p}`);
  const feats = (d?.features as Array<{ attributes: Attrs }> | undefined) ?? [];
  return feats.map((f) => f.attributes);
}

async function geoIdentify(layer: string, lat: number, lon: number, tol = 3): Promise<Attrs[]> {
  const p = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    layers: `all:${layer}`,
    mapExtent: `${lon - 0.01},${lat - 0.008},${lon + 0.01},${lat + 0.008}`,
    imageDisplay: "800,600,96",
    tolerance: String(tol),
    sr: "4326",
    geometryFormat: "geojson",
    lang: "fr",
    returnGeometry: "false",
  });
  const d = await fetchJson(`${GEOADMIN}/all/MapServer/identify?${p}`);
  const results = (d?.results as Array<{ properties?: Attrs }> | undefined) ?? [];
  return results.map((r) => r.properties ?? {});
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// first truthy string value whose field NAME matches the pattern
function pick(a: Attrs | undefined, re: RegExp): string | null {
  if (!a) return null;
  for (const [k, v] of Object.entries(a)) {
    if (re.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim()) return String(v);
  }
  return null;
}

// Geneva zone-5 density rates (art. 59 LCI): 0.25 by right; HPE/THPE derogations
// are discretionary (restricted since loi 12920, 2023) — labelled as such.
const ZONE5 = [
  { key: "byRight", label: "By right", ius: 0.25 },
  { key: "hpe", label: "HPE derogation*", ius: 0.4 },
  { key: "thpe", label: "THPE derogation*", ius: 0.48 },
];

export async function buildDossier(lat: number, lon: number): Promise<Dossier> {
  const [parcelA, batA, zoneA, surZoneA, surBatA, idcA, noiseA, waterA, gwrA, solarA] = await Promise.all([
    sitgPoint("CAD_PARCELLE_MENSU", lat, lon, "NO_PARCELLE,COMMUNE,SURFACE,EGRID,TYPE_PROPRI,LIEN_WWW,EXTRAIT_RDPPF_PDF"),
    sitgPoint("CAD_BATIMENT_HORSOL", lat, lon, "SURFACE,NIVEAUX_HORSOL,NIVEAUX_SSOL,HAUTEUR,ANNEE_CONSTRUCTION,DESTINATION"),
    sitgPoint("SIT_ZONE_AMENAG", lat, lon, "ZONE,NOM_ZONE,LIEN_WWW"),
    sitgPoint("SIT_SURELEVATION_ZONE", lat, lon, "SECTEUR,ZONES,ADOPTION,LIEN_CARTE"),
    sitgPoint("SIT_SURELEVATION_BATIMENT", lat, lon, "REMARQUE,LIEN_CARTE,DESTINATION"),
    sitgPoint("SCANE_INDICE_MOYENNES_3_ANS", lat, lon, "*"),
    sitgPoint("SPBR_SECTEUR_EXPOSE_AU_BRUIT", lat, lon, "*"),
    sitgPoint("GOL_SECTEURS_PROTECT_EAUX", lat, lon, "*"),
    geoIdentify("ch.bfs.gebaeude_wohnungs_register", lat, lon, 6),
    geoIdentify("ch.bfe.solarenergie-eignung-daecher", lat, lon, 1),
  ]);

  const parcel = parcelA[0];
  const bat = batA[0];
  const zone = zoneA[0];
  const gwr = gwrA[0];
  const coverage: Dossier["coverage"] = parcel ? "geneva" : "partial";

  const links: DossierLink[] = [];
  const notes: string[] = [];

  // Parcel
  const parcelOut = parcel
    ? {
        number: num(parcel.NO_PARCELLE),
        commune: str(parcel.COMMUNE),
        area_m2: num(parcel.SURFACE),
        egrid: str(parcel.EGRID),
        ownership: str(parcel.TYPE_PROPRI),
      }
    : null;
  if (str(parcel?.LIEN_WWW)) links.push({ label: "Cadastre extract", url: String(parcel!.LIEN_WWW) });
  if (str(parcel?.EXTRAIT_RDPPF_PDF))
    links.push({ label: "RDPPF / public-law restrictions (PDF)", url: String(parcel!.EXTRAIT_RDPPF_PDF) });

  // Building (footprint/height from SITG, dwellings/heat source from GWR)
  const building = bat
    ? {
        year: num(bat.ANNEE_CONSTRUCTION) ?? num(gwr?.gbauj),
        floorsAbove: num(bat.NIVEAUX_HORSOL),
        floorsBelow: num(bat.NIVEAUX_SSOL),
        footprint_m2: bat.SURFACE != null ? Math.round(Number(bat.SURFACE)) : null,
        height_m: num(bat.HAUTEUR),
        dwellings: num(gwr?.ganzwhg),
        destination: str(bat.DESTINATION),
      }
    : null;

  // Zone
  const zoneOut = zone ? { code: str(zone.ZONE), name: str(zone.NOM_ZONE) } : null;
  if (str(zone?.LIEN_WWW)) links.push({ label: "Zoning plan", url: String(zone!.LIEN_WWW) });

  // Build potential
  let buildPotential: Dossier["buildPotential"] = null;
  const surZone = surZoneA[0];
  const surBat = surBatA[0];
  const surelevApplies = Boolean(surZone || surBat);
  const surChart = str(surZone?.LIEN_CARTE) ?? str(surBat?.LIEN_CARTE);
  if (surChart) links.push({ label: "Surélévation gabarit chart", url: surChart });

  const footprint = building?.footprint_m2 ?? null;
  const floors = building?.floorsAbove ?? null;
  const area = parcelOut?.area_m2 ?? null;
  const existingSbp = footprint != null && floors != null ? footprint * floors : null;

  if (zoneOut?.code === "5" && area != null && existingSbp != null) {
    buildPotential = {
      existingSbp_m2: Math.round(existingSbp),
      scenarios: ZONE5.map((s) => ({
        ...s,
        allowedSbp_m2: Math.round(area * s.ius),
        headroom_m2: Math.max(0, Math.round(area * s.ius - existingSbp)),
      })),
      surelevation: {
        applies: false,
        sector: null,
        legalBasis: null,
        note: "Villa zone (5) — added area comes from an extension or a demolition-rebuild, not from raising floors.",
      },
      caveat:
        "* HPE/THPE rates need high energy performance AND communal approval, and were restricted by loi 12920 (2023) — the derogation is decided by communal préavis at permit stage, not guaranteed.",
    };
  } else if (surelevApplies) {
    // urban zone with an official surélévation record — that's the authoritative build-up answer
    buildPotential = {
      existingSbp_m2: existingSbp != null ? Math.round(existingSbp) : null,
      scenarios: [],
      surelevation: {
        applies: true,
        sector: str(surZone?.SECTEUR),
        legalBasis: str(surZone?.ADOPTION) ?? str(surBat?.REMARQUE),
        note: "Official surélévation cadastre — the permitted added height/levels are given in the gabarit chart (link).",
      },
      caveat: "Density in urban zones follows the zone plan / any PLQ — see the RDPPF and the zoning plan.",
    };
  } else if (zoneOut) {
    buildPotential = {
      existingSbp_m2: existingSbp != null ? Math.round(existingSbp) : null,
      scenarios: [],
      surelevation: { applies: false, sector: null, legalBasis: null, note: "No surélévation record at this location." },
      caveat: `Density for zone ${zoneOut.code ?? "?"} follows the zone regulations / any PLQ — see the RDPPF.`,
    };
  }

  // Energy (IDC + solar demand)
  const solar = solarA[0];
  const energy =
    idcA[0] || solar
      ? {
          idc: pick(idcA[0], /indice|idc|kwh|mj/i),
          heatingDemand_kWh: num(solar?.bedarf_heizung),
          hotWaterDemand_kWh: num(solar?.bedarf_warmwasser),
          solarRoofSurfaces: solarA.length || null,
        }
      : null;

  // Environment
  const noise = noiseA[0];
  const water = waterA[0];
  const environment =
    noise || water
      ? {
          noise: pick(noise, /ds|degre|sens|bruit|lib|nom/i),
          waterProtection: pick(water, /secteur|zone|type|lib|nom/i),
        }
      : null;

  if (coverage === "partial")
    notes.push("Outside canton Geneva — only federal data (building register, solar). Cadastre, zone and build-potential layers are Geneva-only.");
  if (buildPotential?.caveat) notes.push(buildPotential.caveat);

  return {
    generatedAt: new Date().toISOString(),
    coverage,
    parcel: parcelOut,
    building,
    zone: zoneOut,
    buildPotential,
    energy,
    environment,
    links,
    notes,
  };
}
