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
  scores?: Values;
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

// Our own scores (geneva/build/scores.py), each with how it is computed.
function ScoreBar({ label, value, how }: { label: string; value?: string; how: string }) {
  if (value == null || value === "") return null;
  const v = Number(value);
  const tone = v >= 70 ? "bg-emerald-500" : v >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <b className="text-lg tabular-nums text-foreground">{v}</b>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground leading-tight">{how}</p>
    </div>
  );
}

function Scores({ s }: { s: Values }) {
  const sure = s.under_exploited_sure === "True";
  return (
    <Section title="Scores (ours, from official data)">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <ScoreBar label="Location" value={s.score_location} how={`Road distance to everyday services: ${s.location_distances ?? "—"}`} />
        <ScoreBar label="Plot shape" value={s.score_shape} how={`Usable width ${num(s.plot_width_m, " m")}, compactness ${s.plot_compactness ?? "—"}`} />
        <ScoreBar
          label="Existing buildings"
          value={s.score_existing}
          how={`Newest building ${s.bldg_year_newest ?? "—"}${s.bldg_heating_year ? `, heating renewed ${s.bldg_heating_year}` : ""}; higher = more recent`}
        />
        <ScoreBar
          label="Rebuild potential"
          value={s.score_rebuild}
          how={`A new house could be ${s.rebuild_ratio ?? "—"}× today's volume. Among plots scoring like this, ${s.rebuild_peer_rate_pct ?? "—"}% got a demolition or new-build permit within 3 years`}
        />
      </div>
      {isSet(s.rebuild_volume_m3) && (
        <dl className="mt-3">
          <Row
            k="Volume: today vs largest new house"
            v={
              s.existing_volume_m3 === "0"
                ? `Empty plot: a new house of about ${num(s.rebuild_volume_m3, " m³")} (${num(s.rebuild_volume_lo_m3)}–${num(s.rebuild_volume_hi_m3, " m³")})`
                : `${num(s.existing_volume_m3, " m³")} today (canton's 3D model) · about ${num(s.rebuild_volume_m3, " m³")} for a new house allowed by right (${num(s.rebuild_volume_lo_m3)}–${num(s.rebuild_volume_hi_m3, " m³")}, 95% of recent new villas)`
            }
          />
          <Row
            k="Within 300 m since 2015"
            v={`${s.dense_permits_nearby ?? "0"} permits granted at 40% or more · ${s.dense_refusals_nearby ?? "0"} refused`}
          />
        </dl>
      )}
      {isSet(s.permit_rate_pct) && (
        <dl className="mt-1">
          <Row k="Density stated by this plot's permit" v={`${s.permit_rate_pct}% · ${s.permit_rate_ref} · ${s.permit_rate_text}`} />
        </dl>
      )}
      {s.allowed_gfa_m2 ? (
        <dl className="mt-3">
          <Row
            k="Built vs allowed by right"
            v={
              <span className="inline-flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={sure ? "" : "border-transparent bg-amber-500/10 text-amber-700"}>
                  {s.under_exploited_label} · {sure ? "sure" : "likely"}
                </Badge>
                <span className="text-xs text-muted-foreground tabular-nums">
                  built {num(s.built_gfa_lo_m2)}–{num(s.built_gfa_hi_m2, " m²")} (best estimate {num(s.built_gfa_m2, " m²")}) of {num(s.allowed_gfa_m2, " m²")} allowed
                </span>
              </span>
            }
          />
          <Row k="Room left by right" v={`${num(s.development_room_lo_m2)}–${num(s.development_room_hi_m2, " m²")} (best estimate ${num(s.development_room_m2, " m²")})`} />
          <Row k="Allowance from" v={s.allowed_gfa_source} />
          {s.development_note && <Row k="By exception" v={s.development_note} />}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Built vs allowed: not computed, this zone sets no floor-area ratio (its size limits come from shape rules or a plan).
        </p>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Ranges hold 95% of the time, checked against the canton's heated-floor-area register; "sure" when the whole range falls in one band.
        Villas are never "sure": against the densities their own permits state, our villa estimates held only about 4 times in 5.
      </p>
    </Section>
  );
}

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

      {a.scores && Object.keys(a.scores).length > 0 && <Scores s={a.scores} />}

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
