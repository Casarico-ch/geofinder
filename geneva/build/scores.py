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
#                     the whole range falls in one band (never for villas, see below)
#   rebuild potential Zone 5: the volume of the largest new house the law allows
#                     against today's houses, measured in the canton's 3D model, with
#                     plot size, house age and width; checked on what owners did next
#                     (demolition / new-build permits filed after the 3D survey)
#
# Built floor area is our estimate (register footprint x floors), checked against the
# canton's official heated floor area (OCEN IDC register, SRE): no bias, and the
# 95% range per building type is measured here on held-out halves and stored in
# data/scores_qa.json. Run after build/parcels/build.py, before export.py:
#   python3 -I geneva/build/scores.py
import io, json, math, os, re, sqlite3, ssl, sys, time, urllib.parse, urllib.request, zipfile
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
SITG = "https://vector.sitg.ge.ch/arcgis/rest/services/{}/FeatureServer/0/query"


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


def arcgis(layer, fields, path, geometry=False):
    """Every row of a SITG layer (paged, retried), cached as JSON; with geometry, a point's x/y in LV95."""
    if not os.path.exists(path):
        rows, off = [], 0
        while True:
            q = urllib.parse.urlencode({"where": "1=1", "outFields": fields, "returnGeometry": str(geometry).lower(), "outSR": "2056",
                                        "resultOffset": off, "resultRecordCount": 1000, "orderByFields": "OBJECTID", "f": "json"})
            for t in range(8):
                try:
                    d = json.load(urllib.request.urlopen(SITG.format(layer) + "?" + q, timeout=180, context=CTX))
                    break
                except Exception:
                    if t == 7:
                        raise
                    time.sleep(2 ** t)
            f = d.get("features", [])
            for x in f:
                a = x["attributes"]
                if geometry:
                    a["x"], a["y"] = (x.get("geometry") or {}).get("x"), (x.get("geometry") or {}).get("y")
                rows.append(a)
            off += len(f)
            if not f or not d.get("exceededTransferLimit"):
                break
        json.dump(rows, open(path + ".part", "w"))
        os.replace(path + ".part", path)
    return pd.DataFrame(json.load(open(path)))


def volumes():
    """Each building's volume in the canton's 3D model (footprint x height from the lowest ground to the
    roof top) and the date it was surveyed."""
    b = arcgis("CAD_BATI3D_BASE", "EGID,ALTITUDE_REF,SURFACE_SOL,DATE_LEVE", os.path.join(CACHE, "bati3d_base.json"))
    t = arcgis("CAD_BATI3D_BASIC_TOIT", "EGID,ALTITUDE_MAX", os.path.join(CACHE, "bati3d_toit.json"))
    v = b.dropna(subset=["EGID"]).groupby("EGID").agg(z0=("ALTITUDE_REF", "min"), sol=("SURFACE_SOL", "sum"), date=("DATE_LEVE", "max"))
    v = v.join(t.dropna(subset=["EGID"]).groupby("EGID").agg(z1=("ALTITUDE_MAX", "max")))
    v["vol"] = v.sol * (v.z1 - v.z0).clip(lower=0)
    v.index = v.index.astype("int64")
    return v.dropna(subset=["vol"])


# A density the permit itself states: "(0,48 THPE)", "THPE (30%)", "agrandissement (25 %)".
RATE = re.compile(r"(\d{1,2}(?:[.,]\d{1,2})?)\s*%|\b0[.,](\d{1,3})\b")
GRANTED = ("TERMINE", "ACCEPTE", "CHANTIER", "ARCHIVE", "CLOTURE ADMIN")
FINISHED = ("TERMINE", "ARCHIVE", "CLOTURE ADMIN")


def rate_of(text):
    if not re.search(r"HPE|THPE|IUS|rapport|%|densit", text, re.I):
        return None
    for m in RATE.finditer(text):
        v = float(m.group(1).replace(",", ".")) / 100 if m.group(1) else float("0." + m.group(2))
        if 0.1 <= v <= 0.7:
            return v
    return None


def permits(geo):
    """Building permits since 1995 (SITG SIT_AUTOR_DOSSIER), each on the plot its point falls in."""
    d = arcgis("SIT_AUTOR_DOSSIER", "ID_DOSSIER,TYPE_DOSSIER,STATUT,DATE_DEPOT,DESCRIPTION", os.path.join(CACHE, "permits.json"), geometry=True)
    d = d.dropna(subset=["x", "y"])
    d["DESCRIPTION"] = d.DESCRIPTION.fillna("").astype(str)
    d["date"] = pd.to_datetime(d.DATE_DEPOT, unit="ms", errors="coerce")
    d["rate"] = d.DESCRIPTION.map(rate_of)
    pts = gpd.GeoDataFrame(d, geometry=gpd.points_from_xy(d.x, d.y), crs=2056)
    plots = gpd.GeoDataFrame(geo.reset_index(), geometry="geometry", crs=2056)
    return pd.DataFrame(gpd.sjoin(pts, plots, predicate="within", how="inner").drop(columns=["index_right", "geometry"]))


def logistic(A, y, lam=1e-3):
    w = np.zeros(A.shape[1])
    for _ in range(50):
        p = 1 / (1 + np.exp(-A @ w))
        w -= np.linalg.solve((A * (p * (1 - p))[:, None]).T @ A + lam * np.eye(A.shape[1]), A.T @ (p - y) + lam * w)
    return w


def auc(score, y):
    r = pd.Series(score).rank().values
    n1 = y.sum()
    return float((r[y].sum() - n1 * (n1 + 1) / 2) / (n1 * (len(y) - n1)))


def rebuild(sc, df, geo, vol, pm):
    """Rebuild potential for Zone 5 plots (see the header); returns per-plot columns and its QA."""
    z = sc.merge(df[["egrid", "area_cadastre_m2", "bldg_egids", "densif_accrue"]], on="egrid")
    z = z[z.allowed_gfa_source.fillna("").str.startswith("Zone 5")].copy()
    ids = z.bldg_egids.fillna("").map(lambda e: [int(x) for x in str(e).split(",") if x.strip().isdigit()])
    z["existing_volume_m3"] = ids.map(lambda l: float(vol.vol.reindex(l).sum()) if l else 0.0)
    z["measured"] = ids.map(lambda l: all(e in vol.index for e in l))
    surveyed = pd.to_datetime(vol.date.max(), unit="ms")
    # m3 of a new house per m2 of floor area the law counts, from new villas whose permit states the rate
    # and which the 3D model already shows (surveyed 2 years or more after the permit).
    d3 = ids.map(lambda l: pd.to_datetime(vol.date.reindex(l).max(), unit="ms") if l else pd.NaT)
    z["surveyed"] = d3
    nb = pm[pm.rate.notna() & pm.STATUT.isin(FINISHED) & pm.TYPE_DOSSIER.eq("DD") & pm.DESCRIPTION.str.contains("construction", case=False)
            & ~pm.DESCRIPTION.str.contains("agrandiss|transform|surél|véranda|extension", case=False)]
    nb = nb.merge(z[["egrid", "existing_volume_m3", "surveyed", "area_cadastre_m2", "bldg_year_newest", "measured"]], on="egrid")
    nb = nb[(nb.existing_volume_m3 > 0) & nb.measured & (nb.surveyed > nb.date + pd.Timedelta(days=730))
            & (pd.to_numeric(nb.bldg_year_newest, errors="coerce") >= nb.date.dt.year)]
    nb = nb.sort_values("date").groupby("egrid").tail(1)
    lk = np.log(nb.existing_volume_m3 / (nb.rate * nb.area_cadastre_m2)).values
    k = float(np.exp(np.median(lk)))
    allowed = z.allowed_gfa_m2.astype(float)
    z["rebuild_volume_m3"] = k * allowed
    z["rebuild_volume_lo_m3"], z["rebuild_volume_hi_m3"] = np.exp(np.quantile(lk, 0.025)) * allowed, np.exp(np.quantile(lk, 0.975)) * allowed
    built = z[(z.existing_volume_m3 > 0) & z.measured & (z.area_cadastre_m2.astype(float) > 0)].copy()
    built["rebuild_ratio"] = built.rebuild_volume_m3 / built.existing_volume_m3
    # What owners did after the 3D survey: a demolition, or a permit for new houses.
    since = surveyed + pd.Timedelta(days=1)
    red = pm[(pm.date >= since) & (pm.TYPE_DOSSIER.isin(["M", "MPA"]) | (pm.TYPE_DOSSIER.isin(["DD", "APA"]) & pm.DESCRIPTION.str.contains(
        r"construction d.{0,3}(?:une|deux|trois|quatre|cinq|six|\d+)?\s*(?:villa|maison|habitat|logement)", case=False, regex=True)))]
    yr = pd.to_numeric(built.bldg_year_newest, errors="coerce")
    X = np.c_[np.ones(len(built)), np.log(built.rebuild_ratio), np.log(built.area_cadastre_m2.astype(float)),
              (surveyed.year - yr.fillna(yr.median())).clip(0, 120) / 50, np.log(built.plot_width_m.astype(float).fillna(built.plot_width_m.astype(float).median()).clip(lower=1))]
    keep = np.isfinite(X).all(axis=1)
    built, X = built[keep], X[keep]
    y = built.egrid.isin(set(red.egrid)).values
    rng = np.random.default_rng(20261021)
    fold = rng.integers(0, 5, len(y))
    aucs, lifts = [], []
    for f in range(5):
        w = logistic(X[fold != f], y[fold != f])
        p = X[fold == f] @ w
        aucs.append(auc(p, y[fold == f]))
        lifts.append(float(y[fold == f][p >= np.quantile(p, 0.9)].mean() / y[fold == f].mean()))
    w = logistic(X, y)
    p = X @ w
    built["score_rebuild"] = (pd.Series(p, index=built.index).rank(pct=True) * 100).round().clip(0, 100)
    dec = pd.qcut(p, 10, labels=False)
    rate = pd.Series(y).groupby(dec).mean()
    built["rebuild_peer_rate_pct"] = np.round(rate.reindex(dec).values * 100, 1)
    # Plots around (300 m) where the canton granted, or refused, 40% and more since 2015.
    dense = pm[(pm.date >= "2015-01-01") & (pm.rate >= 0.4)]
    cent = geo.geometry.reindex(z.egrid).representative_point()
    ring = gpd.GeoDataFrame({"egrid": z.egrid.values}, geometry=cent.buffer(300).values, crs=2056)
    def near(rows):
        hit = gpd.sjoin(gpd.GeoDataFrame(geometry=gpd.points_from_xy(rows.x, rows.y), crs=2056), ring, predicate="within", how="inner")
        return hit.groupby("egrid").size()
    z["dense_permits_nearby"] = z.egrid.map(near(dense[dense.STATUT.isin(GRANTED)])).fillna(0).astype(int)
    z["dense_refusals_nearby"] = z.egrid.map(near(dense[dense.STATUT.eq("REFUSE")])).fillna(0).astype(int)
    z = z.merge(built[["egrid", "rebuild_ratio", "score_rebuild", "rebuild_peer_rate_pct"]], on="egrid", how="left")
    cols = ["egrid", "existing_volume_m3", "rebuild_volume_m3", "rebuild_volume_lo_m3", "rebuild_volume_hi_m3", "rebuild_ratio",
            "score_rebuild", "rebuild_peer_rate_pct", "dense_permits_nearby", "dense_refusals_nearby"]
    out = z[cols].copy()
    out.loc[~z.measured.values, ["existing_volume_m3", "rebuild_ratio"]] = np.nan
    for c in ("existing_volume_m3", "rebuild_volume_m3", "rebuild_volume_lo_m3", "rebuild_volume_hi_m3"):
        out[c] = out[c].round().astype("Int64")
    out["rebuild_ratio"] = out.rebuild_ratio.round(2)
    out["score_rebuild"] = out.score_rebuild.astype("Int64")
    qa = {"volume_per_legal_m2": {"median": round(k, 2), "lo": round(float(np.exp(np.quantile(lk, 0.025))), 2),
                                  "hi": round(float(np.exp(np.quantile(lk, 0.975))), 2), "new_builds": int(len(lk))},
          "backtest": {"plots": int(len(y)), "redeveloped": int(y.sum()), "since": since.date().isoformat(),
                       "heldout_auc_mean": round(float(np.mean(aucs)), 3), "heldout_auc_worst": round(float(np.min(aucs)), 3),
                       "top_decile_lift": round(float(np.mean(lifts)), 2), "rate_by_decile_pct": [round(float(x) * 100, 1) for x in rate.values]},
          "weights": dict(zip(["const", "log_rebuild_ratio", "log_plot_area", "house_age_50y", "log_plot_width"], [round(float(x), 3) for x in w]))}
    return out, qa


def permit_rates(pm):
    """The latest granted permit on a plot that states its density: rate, reference and text."""
    r = pm[pm.rate.notna() & pm.STATUT.isin(GRANTED)].sort_values("date").groupby("egrid").tail(1)
    return pd.DataFrame({"egrid": r.egrid, "permit_rate_pct": (r.rate * 100).round(1),
                         "permit_rate_ref": r.ID_DOSSIER.astype(str) + ", filed " + r.date.dt.year.astype("Int64").astype(str) + ", " + r.STATUT.str.lower(),
                         "permit_rate_text": r.DESCRIPTION.str.slice(0, 300)})


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
            # Villas: checked against the densities their own permits state (the law's measure, above-ground
            # floor area, LCI art. 59 al. 2), "sure" bands held only ~79% of the time (21.10): never sure.
            sure = (built == 0 and hi == 0) or (band(ulo) == band(uhi) and kind != "villa")
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
    geo2056 = geo.to_crs(2056) if geo.crs and geo.crs.to_epsg() != 2056 else geo
    pm = permits(geo2056[["geometry"]])
    rb, rqa = rebuild(sc, df, geo2056, volumes(), pm)
    sc = sc.merge(rb, on="egrid", how="left").merge(permit_rates(pm), on="egrid", how="left")
    for c in ("dense_permits_nearby", "dense_refusals_nearby"):
        sc[c] = sc[c].astype("Int64")
    for c in ("score_location", "score_existing", "bldg_year_newest", "bldg_heating_year", "allowed_gfa_m2", "score_under_exploited",
              "development_room_m2", "development_room_lo_m2", "development_room_hi_m2", "score_development"):
        sc[c] = sc[c].round().astype("Int64")
    sc.to_parquet(os.path.join(GENEVA, "data", "scores.parquet"), index=False)
    qa = {"plots": len(sc), "calibration_95pct_ranges": cal, "rebuild": rqa,
          "coverage": {c: round(float(sc[c].notna().mean()), 3) for c in ("score_shape", "score_location", "score_existing", "score_under_exploited", "score_rebuild", "permit_rate_pct")},
          "under_exploited_sure_share": round(float(sc.under_exploited_sure.dropna().astype(bool).mean()), 3)}
    json.dump(qa, open(os.path.join(GENEVA, "data", "scores_qa.json"), "w"), indent=1)
    print(json.dumps(qa, indent=1))


if __name__ == "__main__":
    main()
