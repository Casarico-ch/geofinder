import { useState } from "react";
import { AlertCircle, ChevronDown, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Mirrors server/geneva.ts GenevaAnswer (geneva/build/compose.py writes the same shape).
type Values = Record<string, string>;
export interface GenevaAnswer {
  parcel: Values;
  zoning: Values;
  plans: Values;
  protection: Values;
  density_derogation: Values;
  constraints: Values;
  buildings_today: Values;
  status: Values;
  data_quality: Values;
  other?: Values;
  zone_rules: Record<string, any>;
  zone_rules_common_1_4?: any;
  overlays: Record<string, any>;
  plans_detail: {
    plan: string;
    sector: string;
    share: string;
    placement: string;
    confidence: string;
    new_buildings: string;
    build_area_share: string;
    build_area_confidence: string;
    maintained_bldg_share: string;
    maintained_egids: string;
    plan_meta: { title?: string; urls?: string[] } | null;
    plan_wide_limits: any;
    sector_limits: any;
    found_in_rules: boolean;
  }[];
  exceptions: any;
  official_links: Record<string, string>;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  buildable: { label: "Buildable", tone: "bg-emerald-500/10 text-emerald-700" },
  partly_buildable: { label: "Partly buildable", tone: "bg-amber-500/10 text-amber-700" },
  buildable_needs_plan: { label: "Limits come from a plan", tone: "bg-amber-500/10 text-amber-700" },
  special_plan_unresolved: { label: "Special plan — check the plan", tone: "bg-amber-500/10 text-amber-700" },
  not_buildable: { label: "Not buildable", tone: "bg-red-500/10 text-red-700" },
};

const NEW_BUILDINGS: Record<string, string> = {
  allowed_per_zone: "as the zone allows",
  only_in_drawn_areas: "only in the areas drawn on the plan",
  forbidden: "no new buildings",
  extensions_only: "extensions only",
  case_by_case: "decided case by case",
  unknown: "unknown",
};

const num = (s: string | undefined, unit = "") => {
  const n = s == null || s === "" ? NaN : Number(s);
  return Number.isFinite(n) ? `${Math.round(n).toLocaleString("de-CH")}${unit}` : "—";
};
const pct = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && s !== "" ? `${Math.round(n * 100)}%` : "—";
};

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-3 py-1.5 border-b last:border-0 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground break-words">{v}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{title}</h4>
      {children}
    </div>
  );
}

// "2 3609m2 (100.00%); 5 12m2 (0.33%)" -> [{ code, m2, pct }]; a development zone
// carries the zone under it: "D3/pre:AG 1470m2 (100.00%)".
function zoneShares(s: string | undefined) {
  return Array.from((s ?? "").matchAll(/([0-9A-Z]+)(?:\/pre:([0-9A-Z]+))?\s+([\d.]+)m2\s+\(([\d.]+)%\)/g), (m) => ({
    code: m[1],
    over: m[2] ?? null,
    m2: m[3],
    pct: m[4],
  }));
}

function heightText(h: any): string {
  if (!h || typeof h !== "object") return h ? String(h) : "—";
  const parts = [h.absolute_max_m != null && `max ${h.absolute_max_m} m`, h.street_formula, h.boundary_formula, h.text].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

function densityText(d: any): string {
  if (!d || typeof d !== "object") return d ? String(d) : "—";
  const right = d.by_right;
  const r =
    right && typeof right === "object"
      ? Object.entries(right)
          .filter(([k, v]) => k !== "cite" && typeof v !== "object")
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")
      : right != null ? String(right) : "";
  const der = Array.isArray(d.by_derogation) && d.by_derogation.length ? ` · by derogation up to ${d.by_derogation.map((x: any) => x.max).filter(Boolean).join(" / ")}` : "";
  const min = d.minimum != null ? ` · minimum ${typeof d.minimum === "object" ? d.minimum.value ?? JSON.stringify(d.minimum) : d.minimum}` : "";
  return (r ? `by right ${r}` : d.text ?? "no statutory figure") + der + min;
}

// Restriction columns worth a line when set (value > 0 or text).
const RESTRICTIONS: [string, string, string][] = [
  ["forest_m2", "Forest", "m²"],
  ["forest_setback_hard_m2", "Forest setback 0–10 m (unbuildable)", "m²"],
  ["forest_setback_soft_m2", "Forest setback 10–20 m (needs derogation)", "m²"],
  ["forest_setback_default_m2", "Forest setback from the forest cadastre", "m²"],
  ["water_m2", "Water", "m²"],
  ["si_cours_eau_m2", "River-bank strip (LEaux-GE art. 16)", "m²"],
  ["lroutes_alignment_strip_m2", "Road building-line strip (LRoutes art. 11)", "m²"],
  ["nat_road_bl_area_m2", "National-road building line", "m²"],
  ["plq_no_building_area_m2", "PLQ: outside its building areas", "m²"],
  ["lake_shore_cap_m2", "Lake-shore cap (LPRLac art. 3)", "m²"],
  ["unbuildable_total_m2", "Unbuildable in total", "m²"],
];
const FLAGS: [string, string][] = [
  ["groundwater_protection_zone", "Groundwater protection zone"],
  ["polluted_site", "Polluted site"],
  ["polluted_site_military", "Military polluted site"],
  ["gravel_extraction_plan", "Gravel extraction plan"],
  ["forest_reserve", "Forest reserve"],
  ["airport_safety_zone_plan", "Airport safety zone plan"],
  ["noise_ds_opb", "Noise sensitivity level"],
  ["hazard_flood", "Flood hazard"],
  ["hazard_landslide", "Landslide hazard"],
  ["hazard_rockfall", "Rockfall hazard"],
  ["zone_protegee", "Protected zone"],
  ["protection_rives_pnp", "Shore / nature protection"],
  ["monument_classe", "Classified monument"],
  ["monument_inventaire", "Inventoried monument"],
  ["pus_plan", "Land-use plan (PUS)"],
];

const isSet = (v: string | undefined) => v != null && v !== "" && v !== "0" && v !== "0.0" && v !== "False";

export function GenevaView({ a }: { a: GenevaAnswer }) {
  const [lang, setLang] = useState<"en" | "fr">("en");
  const s = a.status;
  const st = STATUS[s.buildability] ?? { label: s.buildability, tone: "bg-muted text-muted-foreground" };
  const unresolved = s.special_plan_unresolved_flag === "True" || s.buildability === "special_plan_unresolved";
  const zones = [...zoneShares(a.zoning.zones_prim), ...zoneShares(a.zoning.zones_dev)];
  const all = { ...a.constraints, ...a.protection, ...a.plans };
  const restrictions = RESTRICTIONS.filter(([k]) => Number(all[k]) > 0);
  const flags = FLAGS.filter(([k]) => isSet(all[k]));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {a.parcel.commune} · parcel {a.parcel.no_parcelle}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          EGRID {a.parcel.egrid} · {num(a.parcel.area_cadastre_m2, " m²")} · answered from Geneva's official data, no Popety call
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={`border-transparent ${st.tone}`}>
          {st.label}
        </Badge>
        {s.buildable_m2 && (
          <span className="text-sm tabular-nums">
            {num(s.buildable_m2, " m²")} buildable
            {s.buildable_m2_approx === "True" ? " (approximate)" : ""}
            {unresolved ? " before the special plan's own limits" : ""}
          </span>
        )}
        {isSet(s.buildable_after_plq_m2) && s.buildable_after_plq_m2 !== s.buildable_m2 && (
          <span className="text-sm text-muted-foreground tabular-nums">· {num(s.buildable_after_plq_m2, " m²")} once a PLQ is adopted</span>
        )}
      </div>

      {unresolved && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            This plot lies in a special plan we could not resolve automatically for this plot: check the plan before relying on the
            limits below.
          </span>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm leading-relaxed">{lang === "en" ? s.notice_en : s.notice_fr}</p>
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setLang(lang === "en" ? "fr" : "en")}>
          {lang === "en" ? "Version française" : "English version"}
        </button>
      </div>

      {zones.length > 0 && (
        <Section title="Zones and their legal limits">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Zone</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead>Height</TableHead>
                <TableHead>Floor area</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zones.map((z) => {
                const rule = a.zone_rules[z.code];
                return (
                  <TableRow key={`${z.code}-${z.over}`} className="hover:bg-transparent align-top">
                    <TableCell>
                      <span className="font-medium">{z.code}</span> <span className="text-muted-foreground">{rule?.label}</span>
                      {z.over && <span className="text-xs text-muted-foreground"> · over {z.over} (applies until a PLQ)</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Math.round(Number(z.pct))}%</TableCell>
                    <TableCell className="text-xs">{heightText(rule?.height)}</TableCell>
                    <TableCell className="text-xs">{densityText(rule?.density)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      )}

      {a.plans_detail.length > 0 && (
        <Section title="Plans on this plot">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Plan</TableHead>
                <TableHead>Part of the plan</TableHead>
                <TableHead>New buildings</TableHead>
                <TableHead>Placement</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.plans_detail.map((p, i) => (
                <TableRow key={`${p.plan}-${i}`} className="hover:bg-transparent align-top">
                  <TableCell>
                    <div className="font-medium">{p.plan}</div>
                    <div className="text-xs text-muted-foreground">{p.plan_meta?.title}</div>
                    {p.plan_meta?.urls?.slice(0, 2).map((u) => (
                      <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
                        {u.split("/").pop()} <ExternalLink className="h-3 w-3" />
                      </a>
                    ))}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.sector}
                    {p.share && p.share !== "1.0" ? ` (${pct(p.share)})` : ""}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.sector.startsWith("UNPLACED") || p.sector.startsWith("unidentified")
                      ? "unknown for this plot — see the plan"
                      : NEW_BUILDINGS[p.new_buildings] ?? (p.new_buildings || "—")}
                    {p.build_area_share ? ` · ${pct(p.build_area_share)} inside drawn areas` : ""}
                    {p.maintained_bldg_share && Number(p.maintained_bldg_share) > 0 ? ` · ${pct(p.maintained_bldg_share)} covered by maintained buildings` : ""}
                  </TableCell>
                  <TableCell className="text-xs">
                    <Badge variant="outline" className={p.confidence === "low" || !p.confidence ? "border-transparent bg-amber-500/10 text-amber-700" : ""}>
                      {p.confidence || "unplaced"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {(restrictions.length > 0 || flags.length > 0) && (
        <Section title="Restrictions on the plot">
          <dl>
            {restrictions.map(([k, label, unit]) => (
              <Row key={k} k={label} v={num(all[k], ` ${unit}`)} />
            ))}
            {flags.map(([k, label]) => (
              <Row key={k} k={label} v={all[k]} />
            ))}
          </dl>
        </Section>
      )}

      {Number(a.buildings_today.bldg_n) > 0 && (
        <Section title="Built today">
          <dl>
            <Row k="Buildings" v={`${a.buildings_today.bldg_n} (EGID ${a.buildings_today.bldg_egids})`} />
            <Row k="Footprint" v={num(a.buildings_today.bldg_footprint_m2, " m²")} />
            <Row k="Height / floors" v={`${num(a.buildings_today.bldg_height_max_m, " m")} · ${num(a.buildings_today.bldg_floors_max)} floors`} />
            <Row k="Floor area (approx.)" v={num(a.buildings_today.bldg_gfa_approx_m2, " m²")} />
          </dl>
        </Section>
      )}

      <Section title="Official sources">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a href={a.official_links.oereb_extract_pdf} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
            Land-register extract (PDF) <ExternalLink className="h-3 w-3" />
          </a>
          <a href={a.official_links.sitg_map} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center gap-1 hover:underline">
            SITG map <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </Section>

      <Collapsible>
        <CollapsibleTrigger className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
          <ChevronDown className="h-3 w-3" /> All data for this plot
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-snug whitespace-pre-wrap break-all">
            {JSON.stringify(a, null, 1)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
