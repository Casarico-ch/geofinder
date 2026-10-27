// =============================================================================
// geneva — every Geneva plot answered from free official data, no Popety call.
//
// geneva/build/ turns the canton's own sources (SITG zone plan, plans de site,
// PLQ/PDZI, forest/water/road limits, the building law) into one record per
// plot, checked against the official ÖREB extract in seven audits (Daniel,
// 14.10: "100% coverage of the canton"). This module ships those records:
// geneva/data/communes/<no>.json.gz (one per commune, loaded on first use) and
// the rules in geneva/rules/, joined here per request, so an answer carries
// every column we have, the rules of every zone on the plot, every plan with
// the plot's part of it, and the official links — nothing held back.
// geneva/build/compose.py is the reference; scripts/check-geneva.ts checks this
// file gives exactly its answers.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { plotByEgrid } from "./proof";

const DIR = process.env.GENEVA_DIR ?? path.resolve(process.cwd(), "geneva");
const SEARCH = "https://api3.geo.admin.ch/rest/services/api/SearchServer";

type Values = Record<string, string>;
interface PlanRow {
  plan: string;
  sector: string;
  share: string;
  placement: string;
  confidence: string;
  new_buildings?: string;
  build_area_share?: string;
  build_area_confidence?: string;
  maintained_bldg_share?: string;
  maintained_egids?: string;
  ref?: ["ps" | "pdzi", string];
}
interface GenevaRecord {
  values: Values;
  zones: string[];
  common_1_4: boolean;
  overlays: string[];
  overlay_items: Record<string, string[]>;
  plans: PlanRow[];
}

/** One Geneva plot, as geneva/build/compose.py writes it. */
export type GenevaAnswer = Record<string, any> & {
  parcel: Values;
  status: Values;
  official_links: Record<string, string>;
};

const readJson = (file: string) => JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
const readGz = (file: string) => JSON.parse(gunzipSync(readFileSync(path.join(DIR, file))).toString("utf8"));

let shared: {
  groups: Record<string, string[]>;
  catalogue: any;
  zones: Map<string, any>;
  sites: Record<string, any>;
  pdzi: Record<string, any>;
  index: { egrid: Record<string, string>; plot: Record<string, string> };
} | null = null;

function rules() {
  if (!shared) {
    const catalogue = readJson("rules/rules_catalogue.json");
    shared = {
      groups: readJson("data/schema.json").groups,
      catalogue,
      zones: new Map(catalogue.zones.map((z: any) => [z.code, z])),
      sites: readJson("rules/plans_de_site.json").plans,
      pdzi: readJson("rules/pdzi.json").plans,
      index: readGz("data/index.json.gz"),
    };
  }
  return shared;
}

// A commune file is a few hundred kB to ~2 MB unpacked; keep the recent ones.
const communes = new Map<string, Record<string, GenevaRecord>>();
function commune(no: string): Record<string, GenevaRecord> {
  let c = communes.get(no);
  if (c) {
    communes.delete(no);
  } else {
    c = readGz(`data/communes/${no}.json.gz`) as Record<string, GenevaRecord>;
    if (communes.size >= 12) communes.delete(communes.keys().next().value!);
  }
  communes.set(no, c);
  return c;
}

/** True when the EGRID is a Geneva plot (all 73,120 are in the data). */
export function isGenevaEgrid(egrid: string): boolean {
  return egrid in rules().index.egrid;
}

/** The answer for one Geneva plot, or null when the EGRID is not in Geneva. */
export function genevaAnswer(egrid: string): GenevaAnswer | null {
  const r = rules();
  const no = r.index.egrid[egrid];
  if (!no) return null;
  const rec = commune(no)[egrid];
  if (!rec) return null;
  const grouped = new Set(Object.values(r.groups).flat());
  const out: Record<string, any> = {};
  for (const [g, cols] of Object.entries(r.groups)) {
    out[g] = Object.fromEntries(cols.filter((c) => c in rec.values).map((c) => [c, rec.values[c]]));
  }
  out.other = Object.fromEntries(Object.entries(rec.values).filter(([c]) => !grouped.has(c)));
  out.zone_rules = Object.fromEntries(
    rec.zones.map((c) => [c, r.zones.get(c) ?? { code: c, determined: "MISSING_FROM_CATALOGUE" }]),
  );
  if (rec.common_1_4) out.zone_rules_common_1_4 = r.catalogue.common_rules_zones_1_4;
  out.overlays = Object.fromEntries(
    rec.overlays.map((k) => {
      const o = r.catalogue.overlays[k];
      const keep = rec.overlay_items[k];
      return [k, keep && Array.isArray(o?.items) ? { ...o, items: o.items.filter((it: any) => keep.includes(String(it.plan))) } : o];
    }),
  );
  out.plans_detail = rec.plans.map((p) => {
    const plan = p.ref ? (p.ref[0] === "pdzi" ? r.pdzi : r.sites)[p.ref[1]] : null;
    const sectors = plan && plan.sectors && typeof plan.sectors === "object" && !Array.isArray(plan.sectors) ? plan.sectors : null;
    return {
      plan: p.plan,
      sector: p.sector,
      share: p.share,
      placement: p.placement,
      confidence: p.confidence,
      new_buildings: p.new_buildings ?? "",
      build_area_share: p.build_area_share ?? "",
      build_area_confidence: p.build_area_confidence ?? "",
      maintained_bldg_share: p.maintained_bldg_share ?? "",
      maintained_egids: p.maintained_egids ?? "",
      plan_meta: plan?.meta ?? null,
      plan_wide_limits: plan?.limits ?? null,
      sector_limits: sectors?.[p.sector] ?? null,
      found_in_rules: plan != null,
    };
  });
  out.exceptions = r.catalogue.exceptions;
  out.official_links = {
    oereb_extract_pdf: `https://ge.ch/terecadastrews/RdppfSVC.svc/extract/pdf/?EGRID=${egrid}`,
    oereb_extract_json: `https://ge.ch/terecadastrews/RdppfSVC.svc/extract/json/?EGRID=${egrid}`,
    sitg_map: "https://map.sitg.ch/app/?portail=cadastre",
  };
  out.sources = { parcels_built: "geneva/build/parcels/build.py (SITG layers, see layers.json)", rules: r.catalogue.meta };
  return out as GenevaAnswer;
}

// The City of Geneva is four cadastral communes; "Genève" alone can mean any of them.
const CITY = ["Genève-Cité", "Genève-Eaux-Vives", "Genève-Petit-Saconnex", "Genève-Plainpalais"];

/** EGRIDs for a Geneva commune + plot number (several when "Genève" alone matches more than one section). */
export function genevaEgridsByPlot(communeName: string, plot: string): string[] {
  const idx = rules().index.plot;
  const n = plot.trim().replace(/^0+/, "");
  const name = communeName.trim();
  const names = /^gen[eè]ve$/i.test(name) ? CITY : [name];
  return names.map((c) => idx[`${c}|${n}`]).filter(Boolean);
}

// Geneva's cantonal outline, loosely: a point outside it never needs a lookup.
const inGenevaBox = (lat: number, lon: number) => lat > 46.12 && lat < 46.37 && lon > 5.95 && lon < 6.32;

const IDENTIFY = "https://api3.geo.admin.ch/rest/services/api/MapServer/identify";

/** The Geneva plot under a point, or null (outside Geneva, or no plot there). */
export async function genevaEgridAt(lat: number, lon: number): Promise<string | null> {
  if (!inGenevaBox(lat, lon)) return null;
  // A building right (DDP) is its own register entry over the plot, often listed
  // first (Genève-Cité 3901 over 3900, 15.10): take the entry that is a plot.
  try {
    const d = 0.001;
    const res = await fetch(
      `${IDENTIFY}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&layers=all:ch.kantone.cadastralwebmap-farbe&tolerance=0&sr=4326` +
        `&returnGeometry=false&mapExtent=${lon - d},${lat - d},${lon + d},${lat + d}&imageDisplay=800,600,96`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const hits: string[] = ((await res.json()).results ?? []).map((r: any) => r.attributes?.egris_egrid).filter(Boolean);
    return hits.find(isGenevaEgrid) ?? null;
  } catch {
    return null;
  }
}

/** A Geneva EGRID that is not a plot (a building right, DDP): the plot it stands on. */
export async function genevaPlotOfEgrid(egrid: string): Promise<string | null> {
  if (isGenevaEgrid(egrid)) return egrid;
  const p = await plotByEgrid(egrid).catch(() => null);
  if (!p?.bbox) return null;
  const [w, s, e, n] = p.bbox;
  return genevaEgridAt((s + n) / 2, (w + e) / 2);
}

const GWR_FIND = "https://api3.geo.admin.ch/rest/services/api/MapServer/find?layer=ch.bfs.gebaeude_wohnungs_register&searchField=egid&returnGeometry=false&searchText=";

// The EGRID the building register records for a building.
async function registerEgrid(egid: string): Promise<string | null> {
  try {
    const res = await fetch(GWR_FIND + encodeURIComponent(egid), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const hit = ((await res.json()).results ?? []).find((r: any) => String(r.attributes?.egid) === egid);
    return hit?.attributes?.egrid ?? null;
  } catch {
    return null;
  }
}

/** The Geneva plot at an address (swisstopo's address search, free), or null. */
export async function genevaEgridAtAddress(address: string): Promise<{ egrid: string; label: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(
      `${SEARCH}?searchText=${encodeURIComponent(address.trim())}&type=locations&origins=address&sr=4326&limit=1`,
      { signal: ctl.signal },
    );
    if (!res.ok) return null;
    const hit = ((await res.json()).results ?? [])[0]?.attrs;
    if (!hit || typeof hit.lat !== "number" || typeof hit.lon !== "number") return null;
    const label = String(hit.label ?? address).replace(/<[^>]+>/g, "");
    // The building register names the plot a building stands on; an address point can
    // sit on a neighbouring access-road plot (3 of 200 Geneva addresses, 15.10).
    const egid = String(hit.featureId ?? "").split("_")[0];
    const registered = /^\d+$/.test(egid) ? await registerEgrid(egid) : null;
    if (registered && isGenevaEgrid(registered)) return { egrid: registered, label };
    const egrid = await genevaEgridAt(hit.lat, hit.lon);
    return egrid ? { egrid, label } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
