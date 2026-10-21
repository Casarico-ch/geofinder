# Full answer for one Geneva parcel: every column of the parcel table, the legal
# rules for EVERY zone on it, every overlay/plan that applies (with the parcel's
# sector), exceptions, official links — nothing dropped. Unknowns stay explicit.
import csv, json, re, sys
from collections import defaultdict

import os
# geneva/ in the repo: data/parcels.parquet (from build/parcels/build.py) and rules/ (from build/rules/).
G = os.environ.get("GENEVA_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMPTY = ("", "nan", "None", "n/a")

# Column groups. Every table column must be in exactly one group (checked below).
GROUPS = {
    "parcel": ["egrid", "commune", "no_comm", "no_parcelle", "type_propri", "propri_publique", "area_cadastre_m2", "area_geom_m2"],
    "zoning": ["zones_prim", "zone_main", "zone_main_pct", "zone_count", "zones_dev", "dev_main", "dev_underlying", "dev_pct",
               "zones_prim_remarks", "zones_dev_remarks", "zone_remark_limit", "zone_remark_limit_text"],
    "plans": ["pdzi", "pdzi_pct", "pdzi_id", "pdzi_links", "plq", "plq_pct", "plq_links", "dab_m2", "dab_source", "dab_match",
              "plq_aires_n", "plq_aires_sbp_m2", "plq_aires_sbp_logement_m2", "pus", "plan_de_site", "plan_de_site_ids",
              "plan_de_site_main_id", "reglement_special", "pus_plan"],
    "protection": ["zone_protegee", "protection_rives_pnp", "monument_classe", "monument_inventaire"],
    "density_derogation": ["sit_prog_dens", "densif_accrue"],
    "constraints": ["forest_m2", "forest_distance_band_m2", "water_m2", "si_cours_eau_m2", "si_plq_m2", "lroutes_alignment_strip_m2",
                    "unbuildable_m2", "unbuildable_other_m2", "unbuildable_pct", "plq_alignment_len_m", "static_forest_limit_len_m",
                    "nat_road_bl_area_m2", "nat_road_bl_len_m", "nat_road_bl_ref", "nat_road_bl", "airport_safety_zone_plan",
                    "noise_ds_opb", "groundwater_protection_zone", "polluted_site", "polluted_site_military", "gravel_extraction_plan", "forest_reserve", "lake_shore_cap_m2", "forest_setback_hard_m2", "forest_setback_soft_m2", "forest_setback_default_m2", "plq_no_building_area_m2", "plan_drawn_area_m2", "hazard_flood", "hazard_landslide", "hazard_rockfall"],
    "buildings_today": ["bldg_n", "bldg_egids", "bldg_footprint_m2", "bldg_height_max_m", "bldg_floors_max", "bldg_gfa_approx_m2",
                        "bldg_parts_no_floors", "bldg_surelevable_egids"],
    "status": ["regime", "regime_detail", "regime_share_pct", "buildability", "buildable_m2", "buildable_m2_approx", "buildable_after_plq_m2", "dev_no_plq_pct", "unbuildable_total_m2", "airport_zone_m2", "notice_fr", "notice_en", "plan_sector_status", "plan_unresolved_pct", "plan_forbid_pct", "road_strip_pct", "special_plan_unresolved_flag", "plan_low_confidence", "plan_maintained_bldg_pct"],
    "scores": ["score_location", "location_distances", "location_source", "score_shape", "plot_compactness", "plot_width_m",
               "score_existing", "bldg_year_newest", "bldg_heating_year", "built_gfa_m2", "built_gfa_lo_m2", "built_gfa_hi_m2",
               "built_gfa_range_kind", "allowed_gfa_m2", "allowed_gfa_source", "score_under_exploited", "under_exploited_label",
               "under_exploited_sure", "score_development", "development_room_m2", "development_room_lo_m2",
               "development_room_hi_m2", "development_note", "existing_volume_m3", "rebuild_volume_m3", "rebuild_volume_lo_m3",
               "rebuild_volume_hi_m3", "rebuild_ratio", "score_rebuild", "rebuild_peer_rate_pct", "dense_permits_nearby",
               "dense_refusals_nearby", "permit_rate_pct", "permit_rate_ref", "permit_rate_text"],
    "data_quality": ["zone_sum_m2", "zone_sum_pct", "zone_sum_mismatch_gt2pct", "oereb_synth_zone_prim", "oereb_synth_zone_superp",
                     "oereb_synth_plq", "oereb_synth_ds_opb", "oereb_synth_zone_main", "synth_agrees"],
}

# Which catalogue overlay applies when a column is set (column -> predicate on value -> overlay keys).
def overlays_for(row, overlays):
    keys = set()
    v = lambda c: row.get(c, "") not in EMPTY and row.get(c, "") not in ("0", "0.0", "False")
    if v("zone_protegee"):
        z = row["zone_protegee"].lower()
        for k in overlays:
            if k.startswith(("ZP_", "VIEUX_", "VILLAGES_", "ROTISSERIE", "ENSEMBLES")) and any(w in z for w in k.lower().split("_") if len(w) > 3):
                keys.add(k)
        if not keys & {k for k in overlays if k.startswith(("ZP_", "VIEUX_", "VILLAGES_", "ROTISSERIE", "ENSEMBLES"))}:
            keys.add("VILLAGES_PROTEGES" if "village" in z else "ZP_VIEILLE_VILLE" if "vieille" in z else "ENSEMBLES_XIX" if "ensemble" in z else "VIEUX_CAROUGE" if "carouge" in z else "VILLAGES_PROTEGES")
    if v("plan_de_site"): keys.add("PLANS_DE_SITE")
    if v("reglement_special"):
        # pick the group that actually lists this RS plan number
        for num in re.findall(r"RS (\d+)", row["reglement_special"]):
            for k in ("RS_VILLAGES", "RS_QUARTIER", "RS_VDG"):
                if any(str(it.get("plan", "")).lstrip("0").startswith(num.lstrip("0")) for it in overlays.get(k, {}).get("items", [])):
                    keys.add(k)
    if v("pus"):
        # the table only says 'inside a PUS'; the commune tells which one
        z = (row.get("pus_plan") or "").upper()
        if z:
            if "VILLE DE GENEVE" in z: keys.add("PUS_VDG")
            if "CAROUGE" in z: keys.add("PUS_CAROUGE")
            if "29188" in z: keys.add("PUS_29188")
            if "DELICES" in z: keys.add("PUS_PETITS_DELICES")
        else:
            c = row.get("commune", "")
            keys.update(("PUS_CAROUGE", "PUS_29188") if c == "Carouge" else ("PUS_VDG",) if c.startswith("Genève") else ())
    if v("protection_rives_pnp"):
        z = row["protection_rives_pnp"].lower()
        for k, w in (("LPRLAC", "lac"), ("LPRRHONE", "rhône"), ("LPRARVE", "arve"), ("LPRVERS", "versoix")):
            if w in z or w.replace("ô", "o") in z: keys.add(k)
        if not any(k.startswith("LPR") for k in keys): keys.add("LPRLAC")
    if v("forest_distance_band_m2") or v("forest_m2") or v("static_forest_limit_len_m"): keys.add("FORET_20M")
    if v("si_cours_eau_m2") or v("water_m2"): keys.add("EAUX_SI")
    if v("sit_prog_dens"): keys.add("SIT_PROG_DENS")
    return sorted(k for k in keys if k in overlays)

def zone_codes(s):
    # "5 485m2 (100.00%)"; development zones carry the zone under them: "D3/pre:AG 1470m2 (100.00%)".
    out = []
    for m in re.finditer(r"([0-9A-Z]+)(?:/pre:([0-9A-Z]+))?\s+[\d.]+m2", s or ""):
        out += [c for c in m.groups() if c]
    return out

def load_rows():
    # Every value as the text the CSV build wrote, so answers read the same either way.
    csv_path = f"{G}/data/parcels.csv"
    if os.path.exists(csv_path):
        return {r["egrid"]: r for r in csv.DictReader(open(csv_path))}
    import pandas as pd
    df = pd.read_parquet(f"{G}/data/parcels.parquet")
    # Our own plot scores (build/scores.py), joined by EGRID.
    if os.path.exists(f"{G}/data/scores.parquet"):
        df = df.merge(pd.read_parquet(f"{G}/data/scores.parquet"), on="egrid", how="left")
    out = {}
    for r in df.to_dict("records"):
        out[r["egrid"]] = {k: ("" if v is None or (isinstance(v, float) and v != v) else str(v)) for k, v in r.items()}
    return out

def load():
    rows = load_rows()
    cat = json.load(open(f"{G}/rules/rules_catalogue.json"))
    ps = json.load(open(f"{G}/rules/plans_de_site.json"))["plans"]
    pz = json.load(open(f"{G}/rules/pdzi.json"))["plans"]
    sectors = defaultdict(list)
    for s in csv.DictReader(open(f"{G}/rules/parcel_sectors.csv")):
        sectors[s["egrid"]].append(s)
    return rows, cat, ps, pz, sectors

def plan_rules(plan_label, ps, pz):
    kind, _, num = plan_label.partition(" ")
    base = num.split("-")[0]
    if kind == "PDZI":
        return pz.get(num) or pz.get(base)
    return ps.get(num) or ps.get(base)

def compose(egrid, rows, cat, ps, pz, sectors):
    row = rows[egrid]
    zones = {z["code"]: z for z in cat["zones"]}
    out = {g: {c: row.get(c) for c in cols if c in row} for g, cols in GROUPS.items()}
    grouped = {c for cols in GROUPS.values() for c in cols}
    out["other"] = {c: v for c, v in row.items() if c not in grouped}
    codes = list(dict.fromkeys(zone_codes(row.get("zones_prim")) + zone_codes(row.get("zones_dev"))))
    out["zone_rules"] = {c: zones.get(c, {"code": c, "determined": "MISSING_FROM_CATALOGUE"}) for c in codes}
    if any(c in zones and zones[c]["code"] in ("1", "2", "3", "4A", "4B", "4BP") for c in codes):
        out["zone_rules_common_1_4"] = cat.get("common_rules_zones_1_4")
    ov = overlays_for(row, cat["overlays"])
    out["overlays"] = {}
    rs_nums = [n.lstrip("0") for n in re.findall(r"RS (\d+)", row.get("reglement_special") or "")]
    for k in ov:
        o = cat["overlays"][k]
        if k.startswith("RS_") and isinstance(o.get("items"), list):
            o = {**o, "items": [it for it in o["items"] if any(str(it.get("plan", "")).lstrip("0").startswith(n) for n in rs_nums)]}
        out["overlays"][k] = o
    out["plans_detail"] = []
    for s in sectors.get(egrid, []):
        pr = plan_rules(s["plan"], ps, pz)
        sec = pr.get("sectors", {}).get(s["sector"]) if pr and isinstance(pr.get("sectors"), dict) else None
        out["plans_detail"].append({"plan": s["plan"], "sector": s["sector"], "share": s["share"], "placement": s["method"],
                                    "confidence": s["confidence"], "new_buildings": s.get("new_buildings"),
                                    "build_area_share": s.get("build_area_share"), "build_area_confidence": s.get("build_area_confidence"),
                                    "maintained_bldg_share": s.get("maintained_bldg_share"), "maintained_egids": s.get("maintained_egids"),
                                    "plan_meta": (pr or {}).get("meta"),
                                    "plan_wide_limits": (pr or {}).get("limits"), "sector_limits": sec,
                                    "found_in_rules": pr is not None})
    out["exceptions"] = cat.get("exceptions")
    out["official_links"] = {
        "oereb_extract_pdf": f"https://ge.ch/terecadastrews/RdppfSVC.svc/extract/pdf/?EGRID={egrid}",
        "oereb_extract_json": f"https://ge.ch/terecadastrews/RdppfSVC.svc/extract/json/?EGRID={egrid}",
        "sitg_map": "https://map.sitg.ch/app/?portail=cadastre",
    }
    out["sources"] = {"parcels_built": "geneva/build/parcels/build.py (SITG layers, see layers.json)", "rules": cat.get("meta")}
    return out

def check(n=300, seed=7):
    import random
    rows, cat, ps, pz, sectors = load()
    cols = list(next(iter(rows.values())).keys())
    grouped = {c for g in GROUPS.values() for c in g}
    problems = defaultdict(int); examples = defaultdict(list)
    for c in cols:
        if c not in grouped: problems["column_not_in_answer"] += 1; examples["column_not_in_answer"].append(c)
    flag_cols = ["zone_protegee", "plan_de_site", "reglement_special", "pus", "protection_rives_pnp", "sit_prog_dens"]
    random.seed(seed)
    picks = random.sample(list(rows), n) + [e for e in sectors][:200]
    for e in picks:
        a = compose(e, rows, cat, ps, pz, sectors)
        for c, z in a["zone_rules"].items():
            if z.get("determined") == "MISSING_FROM_CATALOGUE": problems["zone_missing"] += 1; examples["zone_missing"].append((e, c))
        for p in a["plans_detail"]:
            if not p["found_in_rules"]: problems["plan_missing"] += 1; examples["plan_missing"].append((e, p["plan"]))
        r = rows[e]
        for c in flag_cols:
            if r.get(c) not in EMPTY and r.get(c) not in ("0", "False") and not a["overlays"]:
                problems["flag_without_overlay"] += 1; examples["flag_without_overlay"].append((e, c, r[c][:40]))
        if (r.get("plan_de_site_ids") not in EMPTY or r.get("pdzi_id") not in EMPTY) and not a["plans_detail"]:
            problems["plan_without_sector_row"] += 1; examples["plan_without_sector_row"].append(e)
    print(json.dumps({"checked": len(picks), "problems": problems, "examples": {k: v[:8] for k, v in examples.items()}}, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    if sys.argv[1:] and sys.argv[1] != "--check":
        rows, cat, ps, pz, sectors = load()
        print(json.dumps(compose(sys.argv[1], rows, cat, ps, pz, sectors), ensure_ascii=False, indent=1))
    else:
        check()
