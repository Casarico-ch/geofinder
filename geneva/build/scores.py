# Our own plot scores for Geneva, from official data only (Popety publishes no
# formula for its scores; these are ours, each with how it is computed).
#
#   plot shape        compactness + usable width of the plot outline
#   location          road distance to shops, school, doctor, pharmacy, stop, green
#                     (Federal Statistical Office, "accessibility of services", per hectare)
#   existing buildings  how recent the buildings are (building register: year built,
#                     heating renewed), protection noted
#   built share /     built floor area vs the floor area the law allows by right,
#   development room  given as a range that holds 95% of the time; "sure" only when
#                     the whole range falls in one band
#
# Built floor area is our estimate (register footprint x floors), checked against the
# canton's official heated floor area (OCEN IDC register, SRE): no bias, and the
# 95% range per building type is measured here on held-out halves and stored in
# data/scores_qa.json. Run after build/parcels/build.py, before export.py:
#   python3 -I geneva/build/scores.py
import io, json, math, os, sqlite3, ssl, sys, urllib.parse, urllib.request, zipfile
import numpy as np
import pandas as pd
import geopandas as gpd
import shapely

GENEVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("GENEVA_WORK") or os.path.join(GENEVA, "work")
CACHE = os.path.join(WORK, "scores")
os.makedirs(CACHE, exist_ok=True)
CTX = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE")) if os.environ.get("SSL_CERT_FILE") else ssl.create_default_context()

GWR_ZIP = "https://public.madd.bfs.admin.ch/ge.zip"
ACCESS_CSV = "https://data.geo.admin.ch/ch.bfs.erreichbarkeit/erreichbarkeit/erreichbarkeit_2056.csv"
IDC = "https://vector.sitg.ge.ch/arcgis/rest/services/OCEN_ETAT_IDC_PUBLIC/FeatureServer/0/query"


def fetch(url, path, timeout=900):
    if not os.path.exists(path):
        with urllib.request.urlopen(url, timeout=timeout, context=CTX) as r, open(path + ".part", "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        os.replace(path + ".part", path)
    return path


def gwr():
    db = os.path.join(CACHE, "gwr_ge.sqlite")
    if not os.path.exists(db):
        z = zipfile.ZipFile(fetch(GWR_ZIP, os.path.join(CACHE, "ge.zip")))
        with open(db, "wb") as f:
            f.write(z.read("data.sqlite"))
    c = sqlite3.connect(db)
    return pd.read_sql("select EGID, GKLAS, GBAUJ, GBAUP, GAREA, GASTW, GWAERDATH1 from building where GSTAT=1004", c)


def idc():
    path = os.path.join(CACHE, "idc.json")
    if not os.path.exists(path):
        rows, off = [], 0
        while True:
            q = urllib.parse.urlencode({"where": "1=1", "outFields": "EGID,SRE_M2", "returnGeometry": "false",
                                        "resultOffset": off, "resultRecordCount": 2000, "orderByFields": "OBJECTID", "f": "json"})
            d = json.load(urllib.request.urlopen(IDC + "?" + q, timeout=120, context=CTX))
            f = d.get("features", [])
            rows += [x["attributes"] for x in f]
            off += len(f)
            if not f or not d.get("exceededTransferLimit"):
                break
        json.dump(rows, open(path, "w"))
    d = pd.DataFrame(json.load(open(path)))
    d = d[d.SRE_M2 > 0].dropna(subset=["EGID"])
    d["EGID"] = d.EGID.astype("int64")
    return d


def access():
    cols = ["E_COORD", "N_COORD", "YEAR", "D_SMARKET", "D_GROCERY", "D_SCHOOL_O", "D_MEDIC", "D_PHARMA", "D_STOP_TOT", "D_FOREST", "D_LAKE"]
    a = pd.read_csv(fetch(ACCESS_CSV, os.path.join(CACHE, "erreichbarkeit_2056.csv")), sep=";", usecols=cols)
    a = a[a.E_COORD.between(2480000, 2515000) & a.N_COORD.between(1105000, 1140000)]
    # Several survey years per hectare (2011, 2015, 2018, 2021): keep the latest.
    a = a.sort_values("YEAR").drop_duplicates(["E_COORD", "N_COORD"], keep="last")
    return {(int(r.E_COORD), int(r.N_COORD)): r for r in a.itertuples(index=False)}


def lin(d, full, zero):
    """100 at or under `full` metres, 0 at or over `zero`, straight line between."""
    if d is None or (isinstance(d, float) and math.isnan(d)):
        return None
    return float(np.clip((zero - d) / (zero - full), 0, 1) * 100)


# Location: (field(s), full-score distance, zero-score distance, weight). Road distances in metres.
LOCATION = [
    ("shop", ("D_SMARKET", "D_GROCERY"), 300, 2000, 0.25),
    ("stop", ("D_STOP_TOT",), 300, 1500, 0.25),
    ("school", ("D_SCHOOL_O",), 500, 2500, 0.20),
    ("doctor", ("D_MEDIC",), 500, 3000, 0.10),
    ("pharmacy", ("D_PHARMA",), 500, 3000, 0.10),
    ("green", ("D_FOREST", "D_LAKE"), 300, 2000, 0.10),
]


def location(hect, x, y):
    e, n = int(x // 100 * 100), int(y // 100 * 100)
    r = hect.get((e, n))
    used = "own hectare"
    if r is None:  # an empty plot next to homes: the closest inhabited hectare around it
        near = [hect[(e + dx * 100, n + dy * 100)] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (e + dx * 100, n + dy * 100) in hect]
        if not near:
            return None, None, None
        r, used = near[0], "next hectare"
    parts, total, wsum = {}, 0.0, 0.0
    for name, fields, full, zero, w in LOCATION:
        ds = [getattr(r, f) for f in fields if getattr(r, f) == getattr(r, f)]
        if not ds:
            parts[name] = "no data"
            continue
        d = min(ds)
        s = lin(d, full, zero)
        parts[name] = f"{int(d)} m"
        if s is not None:
            total += w * s
            wsum += w
    return (round(total / wsum) if wsum else None), "; ".join(f"{k} {v}" for k, v in parts.items()), used


def shape_score(geom):
    a, p = geom.area, geom.length
    if a <= 0 or p <= 0:
        return None, None, None
    compact = 4 * math.pi * a / p ** 2
    width = 2 * shapely.maximum_inscribed_circle(geom, tolerance=0.5).length if a > 1 else 0.0
    score = 60 * min(width / 25.0, 1) + 40 * min(compact / 0.7, 1)
    return round(score), round(compact, 3), round(width, 1)


def calibrate(g, sre):
    """95% range of (official heated floor area / our estimate) per building type, from held-out halves."""
    m = g.merge(sre[["EGID", "SRE_M2"]], on="EGID").dropna(subset=["GAREA", "GASTW"])
    m["r"] = m.SRE_M2 / (m.GAREA * m.GASTW)
    m = m[np.isfinite(m.r) & (m.r > 0)]
    m["kind"] = np.where(m.GKLAS == 1110, "villa", np.where(m.GKLAS.isin([1121, 1122]), "flats", "other"))
    out, rng = {}, np.random.default_rng(20261021)
    for kind, s in m.groupby("kind"):
        v = s.r.values
        q = 0.015  # tails tuned so the worst of 50 held-out halves still covers >= 95%
        cov = []
        for _ in range(50):
            k = rng.random(len(v)) < 0.5
            lo, hi = np.quantile(v[k], q), np.quantile(v[k], 1 - q)
            cov.append(float(((v[~k] >= lo) & (v[~k] <= hi)).mean()))
        out[kind] = {"lo": float(np.quantile(v, q)), "hi": float(np.quantile(v, 1 - q)), "n": int(len(v)),
                     "heldout_mean": round(float(np.mean(cov)), 3), "heldout_worst": round(float(np.min(cov)), 3)}
    return out


BANDS = [(0.5, "less than half built"), (1.0, "half to fully built"), (float("inf"), "built out")]


def band(u):
    for edge, label in BANDS:
        if u < edge or (edge == 1.0 and u <= 1.0):
            return label
    return BANDS[-1][1]


def allowance(r):
    """Floor area the law allows by right, m², and where the figure comes from; None when the zone sets no ratio."""
    if r.dab_m2 and r.dab_m2 > 0:
        return float(r.dab_m2), "approved plan (PLQ): floor area granted to this plot"
    if r.plq_aires_sbp_m2 and r.plq_aires_sbp_m2 > 0:
        return float(r.plq_aires_sbp_m2), "approved plan (PLQ): floor area of its building areas on this plot"
    zone5 = r.regime == "ordinary_zone5" or (r.regime == "dev_zone_no_plq" and r.dev_underlying == "5")
    if zone5 and r.buildable_m2 and r.buildable_m2 > 0:
        return 0.30 * float(r.buildable_m2), "Zone 5 by right: 30% of the buildable land (LCI art. 59 al. 1, highest energy standard)"
    return None, None


def main():
    df = pd.read_parquet(os.path.join(GENEVA, "data", "parcels.parquet"))
    geo = gpd.read_file(os.path.join(WORK, "parcels.gpkg"), engine="pyogrio")[["egrid", "geometry"]].set_index("egrid")
    g = gwr()
    sre = idc()
    cal = calibrate(g, sre)
    hect = access()
    bykind = dict(zip(g.EGID, np.where(g.GKLAS == 1110, "villa", np.where(g.GKLAS.isin([1121, 1122]), "flats", "other"))))
    year = dict(zip(g.EGID, g.GBAUJ))
    period = dict(zip(g.EGID, g.GBAUP))
    heat = dict(zip(g.EGID, pd.to_datetime(g.GWAERDATH1, errors="coerce").dt.year))
    # GBAUP period codes 8011..8023 -> last year of the period (BFS code list)
    PERIOD_END = {8011: 1918, 8012: 1945, 8013: 1960, 8014: 1970, 8015: 1980, 8016: 1985, 8017: 1990, 8018: 1995,
                  8019: 2000, 8020: 2005, 8021: 2010, 8022: 2015, 8023: 2025}
    rows = []
    for r in df.itertuples(index=False):
        out = {"egrid": r.egrid}
        geom = geo.geometry.get(r.egrid)
        if geom is not None and not geom.is_empty:
            s, comp, width = shape_score(geom)
            out.update(score_shape=s, plot_compactness=comp, plot_width_m=width)
            pt = geom.representative_point()
            loc, parts, used = location(hect, pt.x, pt.y)
            out.update(score_location=loc, location_distances=parts, location_source=used)
        egids = [int(x) for x in str(r.bldg_egids or "").split(",") if x.strip().isdigit()]
        years = [year.get(e) if year.get(e) == year.get(e) and year.get(e) else PERIOD_END.get(period.get(e)) for e in egids]
        years = [int(y) for y in years if y]
        heats = [int(h) for h in (heat.get(e) for e in egids) if h == h and h]
        if years:
            newest = max(years)
            age = float(np.clip((newest - 1950) / (2020 - 1950), 0, 1)) * 100
            ren = float(np.clip((max(heats) - 1990) / (2020 - 1990), 0, 1)) * 100 if heats else None
            out.update(score_existing=round(0.7 * age + 0.3 * ren) if ren is not None else round(age),
                       bldg_year_newest=newest, bldg_heating_year=max(heats) if heats else None)
        # built share / development room
        allowed, source = allowance(r)
        built = float(r.bldg_gfa_approx_m2) if r.bldg_gfa_approx_m2 == r.bldg_gfa_approx_m2 and r.bldg_gfa_approx_m2 else 0.0
        kinds = {bykind.get(e) for e in egids if bykind.get(e)}
        # The range follows the main building type on the plot (a garage beside a villa does not make it "other").
        kind = "flats" if "flats" in kinds else ("villa" if "villa" in kinds else "other")
        lo, hi = (built * cal[kind]["lo"], built * cal[kind]["hi"]) if built > 0 else (0.0, 0.0)
        # Buildings the register gives no floors for still stand there: count their footprint as
        # one to three floors, so a plot with a house is never called empty.
        foot = float(r.bldg_footprint_m2) if r.bldg_footprint_m2 == r.bldg_footprint_m2 and r.bldg_footprint_m2 else 0.0
        if (r.bldg_parts_no_floors or 0) > 0 and foot > 0:
            extra_lo, extra_hi = (foot, 3 * foot) if built == 0 else (0.0, 2 * foot)
            if built == 0:
                built, kind = 2 * foot, "no floors in register"
            lo, hi = lo + extra_lo, hi + extra_hi
        out.update(built_gfa_m2=round(built), built_gfa_lo_m2=round(lo), built_gfa_hi_m2=round(hi),
                   built_gfa_range_kind=kind if built > 0 else "none")
        if allowed:
            u, ulo, uhi = built / allowed, lo / allowed, hi / allowed
            sure = (built == 0 and hi == 0) or band(ulo) == band(uhi)
            out.update(allowed_gfa_m2=round(allowed), allowed_gfa_source=source,
                       score_under_exploited=round(float(np.clip(1 - u, 0, 1)) * 100),
                       under_exploited_label=band(u), under_exploited_sure=bool(sure),
                       development_room_m2=round(max(0.0, allowed - built)),
                       development_room_lo_m2=round(max(0.0, allowed - hi)), development_room_hi_m2=round(max(0.0, allowed - lo)),
                       score_development=round(float(np.clip((allowed - built) / allowed, 0, 1)) * 100))
            if r.regime in ("ordinary_zone5", "dev_zone_no_plq") and r.densif_accrue != "no_derogation_sector":
                out["development_note"] = ("By exception the canton may allow 44–48% (grouped or terraced houses, LCI art. 59 al. 4) "
                                           "or 55–60% on sites over 5,000 m²; many recent houses were built this way.")
        rows.append(out)
    sc = pd.DataFrame(rows)
    for c in ("score_location", "score_existing", "bldg_year_newest", "bldg_heating_year", "allowed_gfa_m2", "score_under_exploited",
              "development_room_m2", "development_room_lo_m2", "development_room_hi_m2", "score_development"):
        sc[c] = sc[c].round().astype("Int64")
    sc.to_parquet(os.path.join(GENEVA, "data", "scores.parquet"), index=False)
    qa = {"plots": len(sc), "calibration_95pct_ranges": cal,
          "coverage": {c: round(float(sc[c].notna().mean()), 3) for c in ("score_shape", "score_location", "score_existing", "score_under_exploited")},
          "under_exploited_sure_share": round(float(sc.under_exploited_sure.dropna().astype(bool).mean()), 3)}
    json.dump(qa, open(os.path.join(GENEVA, "data", "scores_qa.json"), "w"), indent=1)
    print(json.dumps(qa, indent=1))


if __name__ == "__main__":
    main()
