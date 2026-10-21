#!/usr/bin/env python3
"""Canton of Geneva: one row per land parcel (CAD_PARCELLE_MENSU) with zoning, PLQ/DAB, protections,
unbuildable surfaces, noise, hazards, buildings and a 'regime' class.  Free SITG ArcGIS REST only.

Usage:  python3 -I build.py [--refresh] [--no-oereb] [--oereb-n 30]
  --refresh   re-download every layer (otherwise raw/ page cache is reused)
Outputs (next to this file):
  parcels.csv / parcels.parquet  main table, no geometry
  parcels.gpkg                    same columns + parcel polygon (LV95, EPSG:2056)
  layers.json                     exact layers, filters, fields and feature counts used
  qa.json, qa_no_zone.csv, qa_zone_mismatch.csv, qa_synth_disagree.csv, qa_regime_changes.csv (vs the
  previous parcels.parquet), oereb_check.csv, by_commune.csv
Federal sources (not on SITG): national-road building lines and airport safety-zone plan from geo.admin.ch.
Requires: shapely>=2, numpy, pandas, geopandas, pyogrio, pyarrow.
"""
import argparse, collections, datetime, hashlib, json, os, random, re, shutil, ssl, sys, time
import urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import geopandas as gpd
import shapely
from shapely.geometry import Polygon, MultiLineString

# Work folder (downloads cache, QA files, full outputs): geneva/work, not committed.
# The parcel table the app ships from is also written to geneva/data/parcels.parquet.
GENEVA = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.environ.get("GENEVA_WORK") or os.path.join(GENEVA, "work")
os.makedirs(OUT, exist_ok=True)
RAW = os.path.join(OUT, "raw")
# A proxy CA bundle when one is set (CA_BUNDLE / SSL_CERT_FILE), else the system roots (GitHub runners).
CTX = ssl.create_default_context(cafile=os.environ.get("CA_BUNDLE") or os.environ.get("SSL_CERT_FILE"))
SITG = "https://vector.sitg.ge.ch/arcgis/rest/services/{}/FeatureServer/0/query"
OEREB = "https://ge.ch/terecadastrews/RdppfSVC.svc/extract/json/?EGRID={}&GEOMETRY=true"
PAGE = 4000
MIN_PIECE = 0.5          # m2: intersections smaller than this are treated as digitising slivers
LIST_MIN_PCT = 1.0       # zones/overlays below this share are kept in sums but not listed
DOMINANT = 0.80          # a regime must cover >= 80 % of the zoned parcel area, else 'mixed'

# key: (SITG layer, where, outFields, geometry kind)
LAYERS = {
    "parcels": ("CAD_PARCELLE_MENSU", "1=1",
                "OBJECTID,EGRID,COMMUNE,NO_COMM,NO_PARCELLE,SURFACE,TYPE_PROPRI,PROPRI_PUBLIQUE,VALIDITE", "poly"),
    "zprim": ("RDPPF_ZONES_PRIM", "1=1", "OBJECTID,ABRV_ZONE,NOM_ZONE,NO_PLAN,DSOPB,STATUT_JUR,CAFFCOMP,AFFCOMP,RESTRIC", "poly"),
    "zdev": ("RDPPF_ZONES_DEV", "1=1", "OBJECTID,ABRV_ZONE,NOM_ZONE,ZONE_PREEX,NO_PLAN,STATUT_JUR,CAFFCOMP,AFFCOMP,RESTRIC", "poly"),
    "pdzi": ("RDPPF_PDZI", "1=1",
             "OBJECTID,NO_PLAN,INDICE,STATUT_JUR,DATE_ADOP_CE,LIEU,LIEN_PLAN,LIEN_REGLEMENT,LIEN_ACE", "poly"),
    "limite_foret": ("RDPPF_LIMITE_FORET", "1=1", "OBJECTID,NO_PLAN,STATUT_JUR,ZONE_A_BATIR", "line"),
    "plq": ("RDPPF_PLQ", "1=1",
            "OBJECTID,NO_PLAN,INDICE,STATUT_JUR,DATE_ADOP_CE,LIEU,LIEN_PLAN,LIEN_REGLEMENT,LIEN_ACE", "poly"),
    "dab": ("RPU_DAB_ADOPT", "1=1",
            "OBJECTID,COMMUNE,NO_PARCELLE,SURFACE,DAB,NO_PLAN,INDICE,STATUT_RPU,ID_UNIQUE_CAD,REMARQUE_V", "poly"),
    "aires": ("RPU_AIRE_IMPLANTATION_ADOPT", "1=1",
              "OBJECTID,NO_PLAN,ID_AIRE,SBP_LOGEMENT,SBP_EQUIPEMENT,SBP_ACTIVITES,SBP_COMMERCES,SBP_ADMINISTRATIF,"
              "SBP_ARTISANAT,SBP_INDETERMINE,NIVEAU_HS,HAUTEUR", "poly"),
    "pus": ("RDPPF_PUS", "1=1", "OBJECTID,NO_PLAN,LIEU,LIEN_REGLEMENT", "poly"),
    "ps": ("RDPPF_PS", "1=1", "OBJECTID,NO_PLAN,TITRE_DU_PLAN,TYPE_DE_PLAN,LIEU,LIEN_PLAN,LIEN_REGLEMENT", "poly"),
    "zp": ("RDPPF_ZP", "1=1", "OBJECTID,NO_PLAN,TITRE_DU_PLAN,LIEU", "poly"),
    "pnp": ("RDPPF_PNP", "1=1", "OBJECTID,NO_PLAN,INDICE,NOM_ZONE,TITRE_DU_PLAN,LIEN_PLAN", "poly"),
    "rs": ("RDPPF_RS", "1=1", "OBJECTID,NO_PLAN,TITRE_DU_PLAN,LIEU,LIEN_REGLEMENT", "poly"),
    "classement": ("DPS_CLASSEMENT", "1=1", "OBJECTID,NO_CLASSEMENT,NOM", "poly"),
    "inventaire": ("DPS_INVENTAIRE", "1=1", "OBJECTID,CODE_MSI,NOM", "poly"),
    "progdens": ("SIT_PROG_DENS", "1=1", "OBJECTID,NOM,COMMUNE,TYPE", "poly"),
    "forest": ("FFP_CADASTRE_FORET", "1=1", "OBJECTID", "poly"),
    "forest_dist": ("RDPPF_DISTANCES_FORET_S", "1=1", "OBJECTID,STATUT_JURIDIQUE", "poly"),
    "water": ("CAD_NATURE_SOL", "TYPE='eau' AND GENRE<>'cours d''eau enterré'", "OBJECTID,GENRE", "poly"),
    "si": ("RDPPF_SI", "1=1", "OBJECTID,NOM_PLAN,DISTANCE_INCONSTR", "poly"),
    "si_rpu": ("RPU_SURF_INCONSTRUCT_S_ADOPT", "1=1", "OBJECTID,NO_PLAN,STYPE,SOUS_TYPE", "poly"),
    "align_lroutes": ("OTC_ALIGN_CONST_LROUTES_S", "1=1", "OBJECTID,CLASSIFICATION,STATUT_JUR", "poly"),
    "align_rpu": ("RPU_ALIGNEMENT_ADOPT", "1=1", "OBJECTID,NO_PLAN", "line"),
    "dsopb": ("RDPPF_DSOPB", "1=1", "OBJECTID,DSOPB,DECLASSEMENT", "poly"),
    "crues": ("LCE_DANGERS_CRUES", "1=1", "OBJECTID,DEGRE,TYPE", "poly"),
    "glp": ("GOL_DANGERS_GLP", "1=1", "OBJECTID,DEGDANGER", "poly"),
    "cpb": ("GOL_DANGERS_CPB", "1=1", "OBJECTID,DEGDANGER", "poly"),
    "bldg": ("CAD_BATIMENT_HORSOL", "1=1",
             "OBJECTID,EGID,HAUTEUR,NIVEAUX_HORSOL,SURFACE,EGRID_CENTROIDE,DESTINATION,ANNEE_CONSTRUCTION", "poly"),
    "polluted": ("RDPPF_CADASTRE_SITES_POLLUES", "1=1", "OBJECTID,NO_OFFICIEL,NOM,TYPE_SITE,INVESTIGATION,STATUT_JUR", "poly"),
    "gravel": ("RDPPF_EXTRACTION_GRAVIERES", "1=1", "OBJECTID,NO_PLAN,COMMUNE,STATUT_JUR,LIEN_PLAN", "poly"),
    "gwz": ("RDPPF_ZONES_PROTECTION_EAUX", "1=1", "OBJECTID,TYPE_ZONE,NOM_ZONE,NOM_PUITS,STATUT_JUR,LIEN_PLAN", "poly"),
    "freserve": ("RDPPF_RESERVES_FORESTIERES", "1=1", "OBJECTID,LIEU,TYPE_RES_FORET,TYPE_PROTECTION,STATUT_JUR", "poly"),
    "surel": ("SIT_SURELEVATION_BATIMENT", "1=1", "OBJECTID,EGID", "none"),
    "synth": ("RDPPF_SYNTH_DYN_EXTRACT", "1=1",
              "OBJECTID,EGRID,GENRE,ID73_ZONES_AFFECT_PRIM,ID73_ZONES_AFFECT_SUPERP,ID73_PLQ,ID73_PS,ID73_ZP,"
              "ID73_PUS,ID145_DSOPB", "none"),
}

# Federal OEREB themes not published by SITG (geo.admin.ch, free):
GE_BBOX = "2480000,1106000,2516000,1138000"
NSBL_LAYER = "ch.astra.baulinien-nationalstrassen"        # Baulinien Nationalstrassen (OFROU/ASTRA)
SZP_URL = ("https://data.geo.admin.ch/ch.bazl.sicherheitszonenplan/sicherheitszonenplan/"
           "sicherheitszonenplan_2056.gpkg")                # Sicherheitszonenplan (OFAC/BAZL), perimeters
# zone remarks (AFFCOMP / RESTRIC) that set a limit
LIMIT_RE = {
    "height": re.compile(r"HAUTEUR|GABARIT|ETAGES|R\+\d|CORNICHE|FAITAGE", re.I),
    "floor_area": re.compile(r"SURFACE BRUTE|PLANCHER|INDICE D.UTILISATION|\bM2\b", re.I),
    "no_build": re.compile(r"INTERDICTION DE BATIR|INSTALLATIONS INTERDITES|AUCUNE CONSTRUCTION", re.I),
}

# primary zone -> class used for the regime
ZCLASS = {"5": "z5", "2": "dense", "3": "dense", "4A": "dense", "4B": "dense",
          "1": "prot", "4BP": "prot", "H": "prot",
          "AG": "nb", "BF": "nb", "ER": "nb", "V": "nb", "S": "nb", "PNP": "nb", "JF": "nb", "EP": "nb",
          "AE": "nb", "FE": "nb", "IA": "ind"}
CLASS2REGIME = {"plq": "plq", "pdzi": "dev_zone_pdzi", "dev": "dev_zone_no_plq", "prot": "zone_1_or_protected", "z5": "ordinary_zone5",
                "dense": "ordinary_dense_2_3_4", "nb": "non_building", "ind": "industrial_IA"}
ROADTYPES = {"DP communal", "DP cantonal", "DP communal (hors indice)", "chemin vicinal"}


# ------------------------------------------------------------------ download
def http_json(url, params=None, tries=8):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode() if params else None)
            with urllib.request.urlopen(req, timeout=180, context=CTX) as r:
                d = json.loads(r.read().decode("utf-8-sig"))
            if isinstance(d, dict) and "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(1.5 * (k + 1) + random.random())


def fetch_layer(key):
    layer, where, fields, gkind = LAYERS[key]
    d = os.path.join(RAW, key)
    os.makedirs(d, exist_ok=True)
    sig = hashlib.sha1(json.dumps(LAYERS[key]).encode()).hexdigest()[:10]
    man = os.path.join(d, "manifest.json")
    if os.path.exists(man):
        m = json.load(open(man))
        if m.get("sig") == sig:
            feats = []
            for f in m["pages"]:
                feats += json.load(open(os.path.join(d, f)))["features"]
            return feats, m
    n = http_json(SITG.format(layer), dict(where=where, returnCountOnly="true", f="json"))["count"]

    def page(off):
        prm = dict(where=where, outFields=fields, returnGeometry="false" if gkind == "none" else "true",
                   outSR=2056, f="json", orderByFields="OBJECTID", resultOffset=off, resultRecordCount=PAGE)
        res = http_json(SITG.format(layer), prm)
        fn = f"p{off:07d}.json"
        json.dump(res, open(os.path.join(d, fn), "w"))
        return fn, len(res["features"])

    with ThreadPoolExecutor(6) as ex:
        pages = list(ex.map(page, range(0, max(n, 1), PAGE)))
    feats = []
    for fn, _ in pages:
        feats += json.load(open(os.path.join(d, fn)))["features"]
    oids = [f["attributes"]["OBJECTID"] for f in feats]
    if len(set(oids)) != n:
        raise RuntimeError(f"{layer}: got {len(set(oids))} unique of {n}")
    m = dict(sig=sig, layer=layer, where=where, fields=fields, count=n, pages=[p for p, _ in pages],
             fetched=datetime.datetime.now().isoformat(timespec="seconds"))
    json.dump(m, open(man, "w"))
    return feats, m


def fetch_federal():
    """National-road building lines (api3 identify, paged) and airport safety-zone plan perimeters (GPKG)."""
    d = os.path.join(RAW, "federal"); os.makedirs(d, exist_ok=True)
    fn = os.path.join(d, "nsbl.json")
    if not os.path.exists(fn):
        feats, off = [], 0
        while True:
            u = ("https://api3.geo.admin.ch/rest/services/api/MapServer/identify?"
                 f"geometry={GE_BBOX}&geometryType=esriGeometryEnvelope&layers=all:{NSBL_LAYER}&sr=2056"
                 f"&returnGeometry=true&geometryFormat=geojson&tolerance=0&limit=200&offset={off}&lang=fr")
            r = http_json(u)["results"]
            feats += r; off += len(r)
            if len(r) < 200:
                break
        json.dump(feats, open(fn, "w"))
    nsbl = json.load(open(fn))
    fm = os.path.join(d, "mil_sites.json")
    if not os.path.exists(fm):
        u = ("https://api3.geo.admin.ch/rest/services/api/MapServer/identify?"
             f"geometry={GE_BBOX}&geometryType=esriGeometryEnvelope&layers=all:ch.vbs.kataster-belasteter-standorte-militaer"
             "&sr=2056&returnGeometry=true&geometryFormat=geojson&tolerance=0&limit=200&lang=fr")
        json.dump(http_json(u)["results"], open(fm, "w"))
    gp = os.path.join(d, "szp.gpkg")
    if not os.path.exists(gp):
        with urllib.request.urlopen(SZP_URL, timeout=180, context=CTX) as r, open(gp, "wb") as f:
            f.write(r.read())
    szp = gpd.read_file(gp)
    szp = szp[(szp.Canton == "GE") | szp.Municipality.fillna("").str.contains(r"\(GE\)")].reset_index(drop=True)
    return nsbl, szp, json.load(open(fm))


# ------------------------------------------------------------------ geometry
EMPTY = shapely.from_wkt("POLYGON EMPTY")


def esri_poly(g):
    if not g or not g.get("rings"):
        return None
    outers, holes = [], []
    for ring in g["rings"]:
        if len(ring) < 4:
            continue
        p = shapely.make_valid(Polygon([c[:2] for c in ring]))
        p = polygonal(p)
        if p is None or p.is_empty:
            continue
        # Esri: outer rings clockwise, holes counter-clockwise (shapely: CW ring -> not is_ccw)
        (holes if Polygon([c[:2] for c in ring]).exterior.is_ccw else outers).append(p)
    if not outers:
        return None
    o = shapely.union_all(outers)
    return polygonal(shapely.make_valid(o.difference(shapely.union_all(holes)))) if holes else o


def polygonal(g):
    if g is None or g.is_empty:
        return g
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else EMPTY


def esri_line(g):
    if not g or not g.get("paths"):
        return None
    return MultiLineString([[c[:2] for c in p] for p in g["paths"] if len(p) >= 2])


def to_frame(feats, gkind):
    attrs = pd.DataFrame([f["attributes"] for f in feats])
    if gkind == "none":
        return attrs, None
    conv = esri_poly if gkind == "poly" else esri_line
    geoms = np.array([conv(f.get("geometry")) for f in feats], dtype=object)
    ok = np.array([g is not None and not g.is_empty for g in geoms])
    return attrs[ok].reset_index(drop=True), geoms[ok]


def safe(fn, a, b):
    """Vectorised shapely set operation; falls back element-wise with snapping on GEOS robustness errors."""
    try:
        return fn(a, b)
    except shapely.errors.GEOSException:
        if np.ndim(a) == 0 and np.ndim(b) == 0:
            return safe(fn, np.array([a], dtype=object), np.array([b], dtype=object))[0]
        a = np.broadcast_to(np.asarray(a, dtype=object), np.broadcast(a, b).shape)
        b = np.broadcast_to(np.asarray(b, dtype=object), a.shape)
        out = np.empty(a.shape, dtype=object)
        for i, (x, y) in enumerate(zip(a, b)):
            try:
                out[i] = fn(x, y)
            except shapely.errors.GEOSException:
                try:
                    out[i] = fn(x, y, grid_size=0.001)
                except shapely.errors.GEOSException:
                    out[i] = fn(x.buffer(0), y.buffer(0), grid_size=0.01)
        return out


def overlay(P, G, min_area=MIN_PIECE):
    """All (parcel index, layer index, clipped geometry, area) with area >= min_area."""
    tree = shapely.STRtree(G)
    pi, li = tree.query(P, predicate="intersects")
    if len(pi) == 0:
        return pi, li, np.array([], object), np.array([])
    # cheap path: layer polygon fully contains the parcel
    cont = shapely.contains_properly(G[li], P[pi]) if len(pi) else np.array([], bool)
    g = np.empty(len(pi), dtype=object)
    g[cont] = P[pi[cont]]
    rest = ~cont
    if rest.any():
        g[rest] = safe(shapely.intersection, P[pi[rest]], G[li[rest]])
    a = shapely.area(g)
    # sliver threshold, relative for tiny parcels (some cadastral parcels are < 1 m2)
    k = a >= np.minimum(min_area, 0.05 * shapely.area(P[pi]))
    return pi[k], li[k], g[k], a[k]


def line_overlay(P, G):
    tree = shapely.STRtree(G)
    pi, li = tree.query(P, predicate="intersects")
    # lines lying on the parcel boundary (shared with a neighbour) do not count: use a 0.2 m inner buffer
    ln = shapely.length(safe(shapely.intersection, shapely.buffer(P[pi], -0.2), G[li])) if len(pi) else np.array([])
    k = ln > 0.5
    return pi[k], li[k], ln[k]


def safe_union(gs):
    try:
        return shapely.union_all(gs)
    except shapely.errors.GEOSException:
        return shapely.union_all([shapely.make_valid(x) for x in gs], grid_size=0.001)


def union_by(n, pi, g):
    out = np.full(n, None, dtype=object)
    if len(pi) == 0:
        return out
    order = np.argsort(pi, kind="stable")
    pi_s, g_s = pi[order], g[order]
    bounds = np.flatnonzero(np.diff(pi_s)) + 1
    for idx in np.split(np.arange(len(pi_s)), bounds):
        p = pi_s[idx[0]]
        out[p] = g_s[idx[0]] if len(idx) == 1 else polygonal(shapely.make_valid(safe_union(g_s[idx])))
    return out


def area_of(arr):
    return np.array([0.0 if g is None else g.area for g in arr])


def nz(arr):
    return np.array([EMPTY if g is None else g for g in arr], dtype=object)


def group_text(n, pi, labels, areas, parea, min_pct=LIST_MIN_PCT, fmt="{l} {a:.0f}m2 ({p:.1f}%)"):
    """Per parcel: aggregate area per label, list labels >= min_pct sorted by area."""
    acc = collections.defaultdict(lambda: collections.defaultdict(float))
    for p, l, a in zip(pi, labels, areas):
        acc[p][l] += a
    txt = np.full(n, "", dtype=object)
    main = np.full(n, "", dtype=object)
    main_pct = np.zeros(n)
    tot = np.zeros(n)
    for p, d in acc.items():
        items = sorted(d.items(), key=lambda x: -x[1])
        tot[p] = sum(d.values())
        pa = parea[p] or 1
        txt[p] = "; ".join(fmt.format(l=l, a=a, p=min(100.0, 100 * a / pa)) for l, a in items if 100 * a / pa >= min_pct)
        main[p], main_pct[p] = items[0][0], round(100 * items[0][1] / pa, 2)
    return txt, main, main_pct, tot


def s(v):
    return "" if v is None or (isinstance(v, float) and np.isnan(v)) else str(v).strip()


# ------------------------------------------------------------------ OEREB sample
def oereb_zones(egrid):
    d = http_json(OEREB.format(egrid), tries=4)
    re_ = d["Item"]["RealEstate"]
    out = collections.defaultdict(list)
    for r in re_.get("RestrictionOnLandownership") or []:
        sub = (r.get("Theme") or {}).get("SubCode") or (r.get("Theme") or {}).get("Code")
        txt = (r.get("LegendText") or [{}])[0].get("Text", "")
        out[sub].append((txt.strip(), float(r.get("PartInPercent") or 0)))
    return out, re_.get("LandRegistryArea")


def norm(t):
    t = re.sub(r"\s+", " ", t.replace("’", "'")).strip().lower()
    # OEREB vs SITG legend wording
    return t.replace("zone de bois et forêts", "zone des bois et forêts").replace(
        "zone protection de la nature", "zone de protection de la nature")


# ------------------------------------------------------------------ buildability
RULE_FILES = ("parcel_sectors.csv", "plans_de_site.json", "pdzi.json")
FORBID_RE = re.compile(r"no new construction|no building outside|no construction at all|free of (any )?(new )?construction|"
                       r"only minor constructions|buildings and gardens maintained", re.I)
EXCEPT_RE = re.compile(r"outside (the )?(implantation|new-building|new-construction|area|the area)|except (the )?areas|"
                       r"except art|only outside|outside .*areas|view cones|except .*parcels", re.I)
GRAPH_RE = re.compile(r"graphical|graphically|drawn on the plan|on plan\b|fixed by (the )?plan", re.I)
OUTSIDE_SECTOR_RE = re.compile(r"^outside (building|implantation|new-building|aires|densification)", re.I)
NB_EN = {"AG": "agricultural zone (LaLAT art. 20)", "BF": "forest zone (zone des bois et forêts)",
         "ER": "water and shore zone", "V": "green zone (zone de verdure)", "S": "sports zone",
         "PNP": "nature and landscape protection zone", "JF": "allotment-garden zone", "EP": "public-equipment zone",
         "AE": "airport zone", "FE": "railway zone"}
NB_FR = {"AG": "zone agricole (LaLAT art. 20)", "BF": "zone des bois et forêts", "ER": "zone des eaux et des rives",
         "V": "zone de verdure", "S": "zone sportive", "PNP": "zone de protection de la nature et du paysage",
         "JF": "zone de jardins familiaux", "EP": "zone d'équipement public", "AE": "zone aéroportuaire",
         "FE": "zone ferroviaire"}
HARD_TXT = {  # hard (non-derogable here) unbuildable components -> (en, fr)
    "forest": ("forest (LForêts)", "forêt (LForêts)"),
    "forest_setback": ("forest setback within 10 m of the forest edge (LForêts art. 11)",
                       "distance de 10 m à la lisière de la forêt (LForêts art. 11)"),
    "water": ("water", "eaux"),
    "river_setback": ("unbuildable river-bank strip (LEaux-GE art. 16)", "surface inconstructible au bord des cours d'eau (LEaux-GE art. 16)"),
    "plq_unbuildable": ("unbuildable area of the PLQ", "surface inconstructible du PLQ"),
    "plq_no_aire": ("part of the PLQ without a building area", "partie du PLQ sans aire d'implantation"),
    "zone_no_build": ("zone restriction forbidding building", "restriction de zone interdisant de bâtir"),
    "groundwater_s12": ("groundwater protection zone S1/S2 (OEaux annex 4 ch. 222-223: no new buildings)",
                        "zone de protection des eaux souterraines S1/S2 (OEaux annexe 4 ch. 222-223 : pas de nouvelles constructions)"),
    "classified_monument": ("classified monument building (LPMNS art. 15: no demolition or alteration without authorisation)",
                            "bâtiment classé (LPMNS art. 15 : ni démolition ni modification sans autorisation)"),
}
PLAN_EN = {"PS": "plan de site", "RS": "special regulation", "PDZI": "industrial-zone master plan"}
PLAN_FR = {"PS": "plan de site", "RS": "règlement spécial", "PDZI": "plan directeur de zone industrielle"}
NEWB = {"forbidden": "forbid", "extensions_only": "forbid", "only_in_drawn_areas": "drawn", "case_by_case": "case",
        "allowed_per_zone": "ok", "unknown": "unresolved"}
SHORE_LAW = {"lac": ("lake-shore protection law (LPRLac)", "loi sur la protection des rives du lac (LPRLac)"),
             "Rhône": ("Rhône shore protection law (LPRRhône)", "loi sur la protection des rives du Rhône (LPRRhône)"),
             "Arve": ("Arve shore protection law (LPRArve)", "loi sur la protection des rives de l'Arve (LPRArve)"),
             "Versoix": ("Versoix shore protection law (LPRVers)", "loi sur la protection des rives de la Versoix (LPRVers)")}


def read_lv95(f):
    """GeoJSON written in LV95 is often tagged (or defaulted) as EPSG:4326: trust the coordinates, not the tag."""
    g = gpd.read_file(f)
    if len(g) and g.total_bounds[0] > 1e5:
        return g.set_crs(2056, allow_override=True)
    return g.to_crs(2056) if g.crs is not None else g.set_crs(2056)


def load_rules(folder, wait=True, stable_s=600):
    """Load ge_rules (another worker writes them): wait until every file's mtime is >= stable_s old."""
    paths = [os.path.join(folder, f) for f in RULE_FILES]
    if not all(os.path.exists(p) for p in paths):
        print(f"WARNING: ge_rules files missing in {folder}: every plan parcel will be 'special_plan_unresolved'", flush=True)
        return dict(rows=collections.defaultdict(list), plans={}, ok=False, mtimes={}, areas={}, sectors={}, maintained={})
    import glob as _glob
    while wait:
        allp = paths + _glob.glob(os.path.join(folder, "georef", "build_areas_*.geojson")) \
            + _glob.glob(os.path.join(folder, "georef", "maintained_*.geojson")) \
            + _glob.glob(os.path.join(folder, "georef", "sectors_*.geojson"))
        age = min(time.time() - os.path.getmtime(p) for p in allp)
        if age >= stable_s:
            break
        print(f"waiting for ge_rules to be stable ({age:.0f}s < {stable_s}s)", flush=True)
        time.sleep(min(60, stable_s - age + 1))
    rows = collections.defaultdict(list)
    for r in pd.read_csv(paths[0], dtype=str).fillna("").to_dict("records"):
        rows[r["egrid"]].append(r)
    plans = {}
    for k, e in json.load(open(paths[1]))["plans"].items():
        plans[("RS " if e.get("meta", {}).get("layer") == "RDPPF_RS" else "PS ") + k] = e
    for k, e in json.load(open(paths[2]))["plans"].items():
        plans["PDZI " + k] = e
    # drawn building areas: georef/build_areas_<plan>.geojson  (plan = NO_PLAN, PDZI key, optionally prefixed)
    areas = {}
    ba_files = sorted(_glob.glob(os.path.join(folder, "georef", "build_areas_*.geojson")))
    for f in ba_files:
        stem = os.path.basename(f)[len("build_areas_"):-len(".geojson")]
        num = re.sub(r"^(PS|RS|PDZI)[ _-]?", "", stem, flags=re.I)
        try:
            g = read_lv95(f)
            kind = g["kind"].fillna("build_area") if "kind" in g.columns else pd.Series("build_area", index=g.index)
            ent = {}
            for kd in ("build_area", "free_area"):   # build_area = new buildings allowed; free_area = must stay unbuilt
                gg = g.geometry[kind == kd]
                if len(gg):
                    ent[kd] = polygonal(shapely.make_valid(shapely.union_all(np.array(gg.values, dtype=object))))
            ent["confidence"] = (json.load(open(f)).get("properties") or {}).get("confidence", "")
        except Exception as ex:
            print(f"WARNING: cannot read {f}: {ex}", flush=True)
            continue
        for k in plans:
            if k.split(" ", 1)[1] == num:
                areas[k] = ent
    # georeferenced sector polygons: georef/sectors_<plan>.geojson (property "sector")
    sectors = {}
    for f in sorted(_glob.glob(os.path.join(folder, "georef", "sectors_*.geojson"))):
        num = os.path.basename(f)[len("sectors_"):-len(".geojson")]
        try:
            g = read_lv95(f)
        except Exception as ex:
            print(f"WARNING: cannot read {f}: {ex}", flush=True)
            continue
        for sec, gg in g.groupby(g["sector"].astype(str)):
            geom = polygonal(shapely.make_valid(shapely.union_all(np.array(gg.geometry.values, dtype=object))))
            for k in plans:
                if k.split(" ", 1)[1] == num:
                    sectors[(k, sec)] = geom
    # maintained / existing-building categories: georef/maintained_<plan>.geojson (optional, rules worker)
    maintained = {}
    mfiles = sorted(_glob.glob(os.path.join(folder, "georef", "maintained_*.geojson")))
    for f in mfiles:
        num = os.path.basename(f)[len("maintained_"):-len(".geojson")]
        try:
            g = read_lv95(f)
        except Exception as ex:
            print(f"WARNING: cannot read {f}: {ex}", flush=True)
            continue
        catcol = next((c for c in ("category", "categorie", "kind", "label", "status") if c in g.columns), None)
        items = [(s(r[catcol]) if catcol else "maintained", r.geometry) for _, r in g.iterrows() if r.geometry is not None]
        for k in plans:
            if k.split(" ", 1)[1] == num:
                maintained[k] = items
    mt = {os.path.basename(p): datetime.datetime.fromtimestamp(os.path.getmtime(p)).isoformat(timespec="seconds")
          for p in paths + ba_files + mfiles}
    return dict(rows=rows, plans=plans, ok=True, mtimes=mt, areas=areas, sectors=sectors, maintained=maintained)


def fn(x):
    return f"{x:,.0f}".replace(",", "’")


def plan_url(e, fallback=""):
    urls = (e or {}).get("meta", {}).get("urls") or []
    for u in urls:
        if re.search(r"R\.pdf$|REGLEMENT|RE\.pdf$", u, re.I):
            return u
    return urls[0] if urls else fallback


def short_value(v):
    if isinstance(v, dict):
        return ", ".join(f"{k.replace('_', ' ')} {x}" for k, x in v.items() if x not in (None, ""))
    return str(v or "")


def plan_eval(plans, key, sector):
    """-> (status, detail): forbid / drawn / case / ok / unresolved.  Uses the per-sector `new_buildings`
    field when the rules file has it, else a text heuristic on new_construction / unbuilt_land."""
    e = plans.get(key)
    if e is None:
        return "unresolved", "no rules entry for this plan"
    if not sector or sector.startswith("UNPLACED") or sector.lower().startswith("unidentified"):
        return "unresolved", sector.replace("UNPLACED: ", "") or "sector not placed"
    lim = e.get("limits") or {}
    sec = (e.get("sectors") or {}).get(sector) or {}
    nbv = sec.get("new_buildings", lim.get("new_buildings"))
    if nbv is not None:
        code = nbv.get("value") if isinstance(nbv, dict) else nbv
        note = ""
        if isinstance(nbv, dict):
            note = short_value(nbv.get("note") or nbv.get("allowed") or nbv.get("detail") or nbv.get("reason") or "")
        if not note:
            ncv = (sec.get("new_construction") or lim.get("new_construction") or {})
            note = short_value(ncv.get("value") if isinstance(ncv, dict) else ncv)
        st = NEWB.get(str(code), "unresolved")
        if code == "extensions_only":
            note = "only extensions of existing buildings" + (f": {note}" if note else "")
        return st, note
    val = lambda b, f: json.dumps((b.get(f) or {}).get("value"), ensure_ascii=False) if isinstance(b.get(f), dict) else ""
    for f in ("new_construction", "unbuilt_land"):
        v = val(sec, f)
        if v and FORBID_RE.search(v) and not EXCEPT_RE.search(v):
            return "forbid", v.strip('"')
    if OUTSIDE_SECTOR_RE.search(sector):
        return "forbid", f"outside the plan's building areas ({sector})"
    nc_all = val(lim, "new_construction") + val(sec, "new_construction")
    for f in ("unbuilt_land", "new_construction"):
        v = val(lim, f)
        if v and FORBID_RE.search(v) and not EXCEPT_RE.search(v) and not GRAPH_RE.search(nc_all):
            return "forbid", v.strip('"')
    allv = [val(b, f) for b in (lim, sec) for f in b]
    if any("unknown" in v.lower() for v in allv):
        return "unresolved", "the plan fixes some limits only graphically or illegibly"
    if any(GRAPH_RE.search(v) for v in allv):
        return "drawn", "new buildings only in the areas drawn on the plan"
    return "ok", ""


def buildability(df, n, parea, rules, data, A, ctx):
    P = ctx["P"]
    pieces = ctx["pieces"]
    z_pi, z_li, z_g = ctx["z"]
    d_pi, d_li, d_g = ctx["d"]
    q_pi, q_li, q_g = ctx["q"]
    a_pi, a_li, a_g = ctx["aires"]
    zp_attrs, zd_attrs, plq_attrs = data["zprim"][0], data["zdev"][0], data["plq"][0]
    # ---- hard components (geometry per parcel)
    zcode = np.array([s(zp_attrs.ABRV_ZONE.iloc[l]) for l in z_li])
    nbm = np.array([ZCLASS.get(c, "nb") == "nb" and c != "AE" for c in zcode], dtype=bool)   # AE: LaLAT 19 al. 6
    aem = zcode == "AE"
    ae_area = np.bincount(z_pi[aem], weights=shapely.area(z_g[aem]), minlength=n) if aem.any() else np.zeros(n)
    df["airport_zone_m2"] = ae_area.round(1)   # buildable only for airport facilities (included in buildable_m2)
    # Non-building land stays unbuildable TODAY unless a development zone covers it AND a PLQ (or PDZI) applies there;
    # a PLQ alone never makes a non-building zone buildable, a dev zone alone needs a PLQ first (LGZD art. 2).
    nb_all = nz(union_by(n, z_pi[nbm], z_g[nbm]))
    dev_plan = safe(shapely.union, safe(shapely.intersection, nz(ctx["plq_u"]), nz(ctx["dev_u"])), nz(ctx["pdzi_dev"]))
    nbz = safe(shapely.difference, nb_all, dev_plan)                    # today
    nbz_after = safe(shapely.difference, nb_all, nz(ctx["dev_u"]))      # once a PLQ is adopted on the dev zone
    nbcode = collections.defaultdict(lambda: collections.defaultdict(float))
    _nb_today = shapely.area(safe(shapely.difference, z_g[nbm], dev_plan[z_pi[nbm]])) if nbm.any() else []
    for p, c, a in zip(z_pi[nbm], zcode[nbm], _nb_today):
        nbcode[p][c] += a

    def nobuild_mask(li, attrs):
        return np.array([bool(LIMIT_RE["no_build"].search(s(attrs.RESTRIC.iloc[l]) + " " + s(attrs.AFFCOMP.iloc[l])))
                         for l in li], dtype=bool)
    m1, m2 = nobuild_mask(z_li, zp_attrs), nobuild_mask(d_li, zd_attrs)
    # forest setback: only the first 10 m from the forest are unbuildable in a building zone (LForêts art. 11 al. 2)
    # Forest distance (LForêts art. 11): the recorded RDPPF band where one exists; elsewhere the default 20 m from the
    # forest cadastre (SITG: "la distance de 20 m par rapport au cadastre forestier est à prendre en compte lorsqu'aucune
    # restriction ne figure"). Within 10 m: unbuildable; 10-20 m: needs a derogation (al. 2).
    F10 = shapely.buffer(data["forest"][1], 10.0)
    fpi, fli, fg, fa = overlay(P, F10)
    f10_u = nz(union_by(n, fpi, fg))
    fpi, fli, fg, fa = overlay(P, shapely.buffer(data["forest"][1], 20.0))
    f20_u = nz(union_by(n, fpi, fg))
    fpi, fli, fg, fa = overlay(P, shapely.buffer(data["forest_dist"][1], 25.0))
    rec_near = nz(union_by(n, fpi, fg))          # where a recorded band exists, it governs
    # default 20 m wherever the plot is not covered by a recorded band polygon (audit 6: subtract the polygons,
    # not a proximity buffer)
    band_default = safe(shapely.difference, safe(shapely.difference, f20_u, nz(pieces["forest_dist"])), nz(pieces["forest"]))
    df["forest_setback_default_m2"] = shapely.area(band_default).round(1)
    band = safe(shapely.union, nz(pieces["forest_dist"]), band_default)
    band_hard = safe(shapely.intersection, band, f10_u)
    band_soft = safe(shapely.difference, band, f10_u)
    # PLQs digitised in RefPU (RPU_AIRE_IMPLANTATION_ADOPT): outside their building areas nothing new is built
    rpu_plans = set(int(x) for x in data["aires"][0].NO_PLAN.dropna())
    qm = np.array([pd.notna(plq_attrs.NO_PLAN.iloc[l]) and int(plq_attrs.NO_PLAN.iloc[l]) in rpu_plans for l in q_li], dtype=bool)
    plq_rpu_u = nz(union_by(n, q_pi[qm], q_g[qm]))
    aires_u = nz(union_by(n, a_pi, a_g))
    plq_no_aire = safe(shapely.difference, plq_rpu_u, aires_u)
    comps = {
        "nonbuilding_zone": nbz, "forest": nz(pieces["forest"]), "forest_setback": band_hard, "water": nz(pieces["water"]),
        "river_setback": nz(pieces["si"]), "plq_unbuildable": nz(pieces["si_rpu"]), "plq_no_aire": plq_no_aire,
        "zone_no_build": nz(union_by(n, np.concatenate([z_pi[m1], d_pi[m2]]), np.concatenate([z_g[m1], d_g[m2]]))),
        "groundwater_s12": nz(union_by(n, ctx["gw"][0], ctx["gw"][1])),
        # the classified buildings themselves (classification perimeter ∩ building footprints) cannot be replaced
        "classified_monument": safe(shapely.intersection, nz(union_by(n, ctx["classe"][0], ctx["classe"][1])),
                                    nz(union_by(n, ctx["bldg"][0], ctx["bldg"][1]))),
    }
    classe_perim = shapely.area(nz(union_by(n, ctx["classe"][0], ctx["classe"][1])))
    comp_area = {k: shapely.area(v) for k, v in comps.items()}
    acc = nz(np.full(n, None, dtype=object))
    for v in comps.values():
        acc = safe(shapely.union, acc, v)
    ugeo = np.minimum(shapely.area(acc), parea)
    acc_after = nz(np.full(n, None, dtype=object))
    for k_, v in comps.items():
        acc_after = safe(shapely.union, acc_after, nbz_after if k_ == "nonbuilding_zone" else v)
    soft_band = shapely.area(band_soft)
    band_total = shapely.area(band)
    road_strip = shapely.area(nz(pieces["align_lroutes"]))
    df["forest_setback_hard_m2"] = shapely.area(band_hard).round(1)
    df["forest_setback_soft_m2"] = shapely.area(band_soft).round(1)
    df["plq_no_building_area_m2"] = shapely.area(plq_no_aire).round(1)

    # ---- plan perimeters per parcel
    plan_area = collections.defaultdict(dict)
    plan_geom = collections.defaultdict(lambda: collections.defaultdict(list))
    for tag, (pi, li, a, g_), attrs, keyf in (
            ("PS", ctx["ps"], data["ps"][0], lambda r: s(r.NO_PLAN).split(".")[0]),
            ("RS", ctx["rs"], data["rs"][0], lambda r: s(r.NO_PLAN).split(".")[0]),
            ("PDZI", ctx["pdzi"], data["pdzi"][0],
             lambda r: str(int(r.NO_PLAN)) + ("" if s(r.INDICE) in ("", "-") else "-" + s(r.INDICE)))):
        for p, l, ar, gg in zip(pi, li, a, g_):
            k = f"{tag} {keyf(attrs.iloc[l])}"
            plan_area[p][k] = plan_area[p].get(k, 0) + ar
            plan_geom[p][k].append(gg)
    plans, srows, bareas = rules["plans"], rules["rows"], rules.get("areas", {})
    secgeo, maint = rules.get("sectors", {}), rules.get("maintained", {})
    geo_stats = collections.Counter()
    _pn = data["pnp"][0]
    arve_link = next((s(u) for no, u in zip(_pn.NO_PLAN, _pn.LIEN_PLAN) if s(no).split(".")[0] == "28616" and s(u)),
                     "https://ge.ch/sitg/RDPPF/")
    titles = {}
    for tag, key in (("ps", "PS"), ("rs", "RS")):
        for r in data[tag][0].itertuples():
            tt = s(r.TITRE_DU_PLAN)
            if len(tt) < 30 and re.match(r"(plan|règlement)", tt, re.I) and s(r.LIEU):
                tt = s(r.LIEU).title()     # generic title ("Plan de site") -> place name, e.g. Le Lignon
            titles[f"{key} {s(r.NO_PLAN).split('.')[0]}"] = (tt, s(getattr(r, "LIEN_REGLEMENT", "")))
    for r in data["pdzi"][0].itertuples():
        k = "PDZI " + str(int(r.NO_PLAN)) + ("" if s(r.INDICE) in ("", "-") else "-" + s(r.INDICE))
        titles[k] = (s(r.LIEU).title(), s(r.LIEN_REGLEMENT) or s(r.LIEN_PLAN))

    def link(k):
        return plan_url(plans.get(k), titles.get(k, ("", ""))[1])

    def pname(k, fr=False):
        tag, no = k.split(" ", 1)
        t_ = titles.get(k, ("", ""))[0] or (plans.get(k) or {}).get("meta", {}).get("lieu", "")
        t_ = re.split(r"\s*-\s*Abroge| et son règlement|\s*\(", t_)[0].strip()[:70]
        return f"{(PLAN_FR if fr else PLAN_EN)[tag]} {tag} {no}" + (f" ({t_})" if t_ else "")

    def join(xs, word):
        return "" if not xs else xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + f" {word} " + xs[-1]

    # PLQ list per parcel (all pieces, slivers included) with share and link
    plq_list = collections.defaultdict(list)
    for p, l, a in zip(q_pi, q_li, shapely.area(q_g)):
        r = plq_attrs.iloc[l]
        no = f"{int(r.NO_PLAN)}{'' if s(r.INDICE) in ('', '-') else '-' + s(r.INDICE)}"
        plq_list[p].append((a, no, s(r.LIEN_PLAN)))
    dev_list = collections.defaultdict(lambda: collections.defaultdict(float))
    for p, l, a in zip(d_pi, d_li, shapely.area(d_g)):
        dev_list[p][(s(zd_attrs.ABRV_ZONE.iloc[l]), s(zd_attrs.ZONE_PREEX.iloc[l]))] += a

    cols = {c: [] for c in ("buildability", "buildable_m2", "unbuildable_total_m2", "plan_sector_status",
                            "plan_unresolved_pct", "plan_forbid_pct", "plan_drawn_area_m2", "road_strip_pct",
                            "special_plan_unresolved_flag", "buildable_after_plq_m2", "plan_low_confidence",
                            "plan_maintained_bldg_pct", "dev_no_plq_pct", "buildable_m2_approx", "notice_en", "notice_fr")}
    reg, ptype = df.regime.values, df.type_propri.values
    for i in range(n):
        pa = max(parea[i], 1e-9)
        eg = df.egrid.iat[i]
        rows_i = collections.defaultdict(list)
        for r in srows.get(eg, []):
            rows_i[r["plan"]].append(r)
        st = []   # (status, frac, plan, detail, sector)
        drawn_in = 0.0
        approx = []
        fgeoms, fallback_f = [], 0.0     # plan no-build geometries; share-only remainder (no geometry available)
        lowconf, maint_share = [], collections.defaultdict(float)
        inside_geoms = []
        for k, area_k in plan_area.get(i, {}).items():
            if 100 * area_k / pa < LIST_MIN_PCT:
                continue
            perim = polygonal(shapely.make_valid(safe_union(plan_geom[i][k]))) if len(plan_geom[i][k]) > 1 else plan_geom[i][k][0]
            rows_k = rows_i.get(k) or [dict(sector="UNPLACED: parcel missing from parcel_sectors.csv", share="1")]
            # rows of this plan that are 'drawn' but have no sector geometry share the drawn-area surface in proportion
            nog_tot = 0.0
            for r in rows_k:
                try:
                    sh_ = float(r["share"] or 1)
                except ValueError:
                    sh_ = 1.0
                st_ = NEWB.get(r.get("new_buildings", ""), None) or plan_eval(plans, k, r["sector"])[0]
                if st_ == "drawn" and sh_ < 0.98 and (k, r["sector"]) not in secgeo:
                    nog_tot += min(1.0, sh_ * area_k / pa)
            ins_added = False
            for r in rows_k:
                try:
                    sh = float(r["share"] or 1)
                except ValueError:
                    sh = 1.0
                f = min(1.0, sh * area_k / pa)
                sector = r["sector"]
                if r.get("confidence", "") == "low" and not sector.startswith("UNPLACED"):
                    lowconf.append((k, sector))
                try:
                    msh = float(r.get("maintained_bldg_share", "") or 0)
                except ValueError:
                    msh = 0.0
                if msh > 0:
                    maint_share[k] += msh * f
                    if k not in maint:     # no footprint geometry for this plan: keep the share (disjoint assumption)
                        fallback_f += msh * f
                        st.append(("forbid", msh * f, k, "footprint of a building the plan keeps (maintained)", sector))
                status, det = plan_eval(plans, k, sector)
                csv_nb = r.get("new_buildings", "")
                if csv_nb and not sector.startswith("UNPLACED") and not sector.lower().startswith("unidentified"):
                    status = NEWB.get(csv_nb, "unresolved")       # parcel_sectors.csv is authoritative when it has the field
                    if csv_nb == "extensions_only" and not det.startswith("only extensions"):
                        det = "only extensions of existing buildings" + (f": {det}" if det else "")
                    if csv_nb == "unknown":
                        det = "the rules for this part of the plan are unknown (graphic only or illegible)"
                    elif csv_nb == "case_by_case" and ("graphically" in det or "illegib" in det or not det):
                        _nv = ((plans.get(k) or {}).get("limits") or {}).get("new_buildings")
                        det = (short_value(_nv.get("note")) if isinstance(_nv, dict) and _nv.get("note") else
                               "the department decides case by case under the plan's rules")
                # geometry of this (plan, sector) part of the parcel
                if sh >= 0.98:
                    part = perim
                elif (k, sector) in secgeo:
                    part = safe(shapely.intersection, perim, secgeo[(k, sector)])
                else:
                    part = None
                if status == "drawn" and r.get("build_area_confidence", "") == "low":
                    approx.append(k)
                if status == "drawn" and k in bareas and part is None:
                    ba = bareas[k]
                    if "build_area" in ba:
                        ins = safe(shapely.intersection, perim, ba["build_area"])
                        if "free_area" in ba:
                            ins = safe(shapely.difference, ins, ba["free_area"])
                        if not ins_added:
                            inside_geoms.append(ins)
                            ins_added = True
                        fi = min(f, ins.area / pa * (f / nog_tot if nog_tot > 0 else 1.0))
                        geo_stats["drawn_area_geom_sector_share"] += 1
                        if ba.get("confidence") == "low":
                            approx.append(k)
                        if fi > 1e-6:
                            st.append(("drawn_in", fi, k, det, sector))
                        if f - fi > 1e-6:
                            st.append(("forbid", f - fi, k, "outside the building areas drawn on the plan", sector))
                            fallback_f += f - fi
                        continue
                if status == "drawn":
                    if k in bareas and part is not None:
                        ba = bareas[k]
                        if "build_area" in ba:
                            ins = safe(shapely.intersection, part, ba["build_area"])
                            if "free_area" in ba:
                                ins = safe(shapely.difference, ins, ba["free_area"])
                        else:
                            ins = safe(shapely.difference, part, ba["free_area"])
                        out_ = safe(shapely.difference, part, ins)
                        inside_geoms.append(ins)
                        if ba.get("confidence") == "low":
                            approx.append(k)
                        fi, fo = ins.area / pa, out_.area / pa
                        geo_stats["drawn_geometric"] += 1
                        bas = r.get("build_area_share", "")
                        if bas not in ("", None) and 0.02 < float(bas) < 0.98 and r.get("confidence", "") in ("low", "medium"):
                            approx.append(k)
                        if fi > 1e-6:
                            st.append(("drawn_in", fi, k, det, sector))
                        if fo > 1e-6:
                            st.append(("forbid", fo, k, "outside the building areas drawn on the plan", sector))
                            fgeoms.append(out_)
                        continue
                    bas = r.get("build_area_share", "")
                    if bas not in ("", None):          # share known, no usable geometry: fallback
                        inside = min(f, f * float(bas))
                        drawn_in += inside * pa
                        geo_stats["drawn_share_only"] += 1
                        if 0.02 < float(bas) < 0.98 and r.get("confidence", "") in ("low", "medium"):
                            approx.append(k)
                        if inside > 0:
                            st.append(("drawn_in", inside, k, det, sector))
                        if f - inside > 1e-6:
                            st.append(("forbid", f - inside, k, "outside the building areas drawn on the plan", sector))
                            fallback_f += f - inside
                        continue
                    status, det = "unresolved", "new buildings are only allowed in the areas drawn on the plan, which could not be placed on the cadastre"
                if status == "forbid":
                    if part is not None:
                        fgeoms.append(part)
                        geo_stats["forbid_geometric"] += 1
                    else:
                        fallback_f += f
                        geo_stats["forbid_share_only"] += 1
                st.append((status, f, k, det, sector))
        # footprints of buildings the plan keeps ("bâtiments maintenus"): no new building in their place
        for k in plan_area.get(i, {}):
            for cat, gm in maint.get(k, []):
                if cat == "maintained" and gm is not None:
                    gx = safe(shapely.intersection, P[i], gm)
                    if gx.area >= 1:
                        fgeoms.append(gx)
                        st.append(("forbid", gx.area / pa, k, "footprint of a building the plan keeps (maintained)", "maintained building"))
        frac = collections.defaultdict(float)
        for x in st:
            frac[x[0]] += x[1]
        forbid_f, unres_f = min(1, frac["forbid"]), min(1, frac["unresolved"])
        # unbuildable = parcel ∩ UNION(hard components, plan no-build geometries); share-only parts added on the remainder
        U = safe_union([acc[i]] + fgeoms) if fgeoms else acc[i]
        U = polygonal(shapely.make_valid(shapely.intersection(U, P[i]))) if not U.is_empty else U
        Ua = U.area
        Uafter = safe_union([acc_after[i]] + fgeoms) if fgeoms else acc_after[i]
        Uafter = polygonal(shapely.make_valid(shapely.intersection(Uafter, P[i]))) if not Uafter.is_empty else Uafter
        # share-only no-build parts (sector not available as geometry) are assumed disjoint from the geometric
        # unbuildable area (never overstates the buildable area)
        utot = min(pa, Ua + fallback_f * pa)
        utot_after = min(pa, Uafter.area + fallback_f * pa)
        if inside_geoms:
            drawn_in += safe(shapely.difference, safe_union(inside_geoms), U).area
        rem = shapely.difference(P[i], U) if not U.is_empty else P[i]
        rem_after = shapely.difference(P[i], Uafter) if not Uafter.is_empty else P[i]

        def meaningful(rg, ra):   # a real building plot remains: >= 200 m2 and not just a strip (3 m inner buffer)
            return ra >= 200 and shapely.buffer(rg, -3.0).area >= 50
        mean_today = meaningful(rem, pa - utot)
        mean_after = meaningful(rem_after, pa - utot_after)
        dev_noplq = A["dev"][i] >= 0.5 * pa
        # ---- reasons
        rs = []
        for c, a_ in (nbcode.get(i) or {}).items():      # each non-building zone with its own share
            if a_ >= 0.01 * pa:
                rs.append((a_, NB_EN.get(c, c), NB_FR.get(c, c)))
        for k_, (en, fr) in HARD_TXT.items():
            if comp_area[k_][i] >= 0.01 * pa:
                rs.append((comp_area[k_][i], en, fr))
        for sname, f, k, det, sec in st:
            if sname == "forbid":
                d_ = f": {det}" if det else ""
                rs.append((min(f * pa, pa), f"area where {pname(k)} allows no new building{d_} ({link(k)})",
                           f"secteur où le {pname(k, True)} n'admet aucune nouvelle construction{d_} ({link(k)})"))
        merged = collections.OrderedDict()
        for a_, e_, f_ in rs:
            if e_ in merged:
                merged[e_] = (merged[e_][0] + a_, e_, f_)
            else:
                merged[e_] = (a_, e_, f_)
        rs = sorted(((min(a_, pa), e_, f_) for a_, e_, f_ in merged.values()), key=lambda x: -x[0])
        reason_en = join([f"{100*a/pa:.0f}% {en}" for a, en, _ in rs[:4]], "and")
        reason_fr = join([f"{100*a/pa:.0f} % {fr}" for a, _, fr in rs[:4]], "et")
        unres = sorted([x for x in st if x[0] == "unresolved"], key=lambda x: -x[1])
        cases = sorted([x for x in st if x[0] == "case"], key=lambda x: -x[1])
        sts = "; ".join(f"{k}:{sec[:40]}={sname}" for sname, f, k, det, sec in st)
        dmain, dpre = df.dev_main.iat[i], df.dev_underlying.iat[i]
        plq_items = sorted(plq_list.get(i, []), key=lambda x: -x[0])
        plan_driven = reg[i] in ("plq_dab", "plq_no_dab", "dev_zone_pdzi", "dev_zone_no_plq") or (
            reg[i] == "mixed" and (A["plq"][i] + A["pdzi"][i] + A["dev"][i]) >= 0.5 * pa) or frac["drawn_in"] > 0 or cases
        zm = df.zone_main.iat[i]
        zn = ctx["zone_names"].get(zm, zm)
        dab = df.dab_m2.iat[i]
        if ptype[i] in ROADTYPES:
            b = "not_buildable"
            en = f"Not buildable: public road or public domain ({ptype[i]})."
            fr = f"Non constructible : route ou domaine public ({ptype[i]})."
        elif (utot_after >= 0.8 * pa and not mean_after) if dev_noplq else (utot >= 0.8 * pa and not mean_today):
            b = "not_buildable"
            en = f"Not buildable: {reason_en or 'unbuildable surfaces'}."
            fr = f"Non constructible : {reason_fr or 'surfaces inconstructibles'}."
            if comp_area["plq_no_aire"][i] >= 0.5 * pa and not np.isnan(dab):
                en = en[:-1] + f"; the PLQ places its buildings on other plots, this plot carries {fn(dab)} m² of floor-area rights (DAB)."
                fr = fr[:-1] + f" ; le PLQ implante ses bâtiments sur d'autres parcelles, cette parcelle porte {fn(dab)} m² de droits à bâtir (DAB)."
        elif unres and unres_f >= 0.1:
            b = "special_plan_unresolved"
            k, det, sec = unres[0][2], unres[0][3], unres[0][4]
            if sec.startswith("UNPLACED") or sec.lower().startswith("unidentified") or "missing" in sec:
                en = (f"Inside {pname(k)}: building limits depend on the part of the plan; check the plan ({link(k)}) "
                      f"— we could not place this plot automatically.")
                fr = (f"Dans le {pname(k, True)} : les limites de construction dépendent du secteur du plan ; consultez le plan "
                      f"({link(k)}) — nous n'avons pas pu situer cette parcelle automatiquement.")
            else:
                en = (f"Inside {pname(k)}: {det}; check the plan ({link(k)}) — we could not resolve this automatically.")
                det_fr = ("les nouvelles constructions ne sont admises que dans les aires dessinées sur le plan, que nous n'avons "
                          "pas pu situer sur le cadastre" if det.startswith("new buildings are only allowed") else
                          "les règles de cette partie du plan sont inconnues (seulement graphiques ou illisibles)"
                          if det.startswith("the rules for this part") else
                          "limites fixées seulement sur les dessins du plan ou illisibles")
                fr = (f"Dans le {pname(k, True)} : {det_fr} ; consultez le plan ({link(k)}) — nous n'avons pas pu le résoudre automatiquement.")
        elif dev_noplq:
            b = "buildable_needs_plan"
            parts_en, parts_fr = [], []
            for (dz, pre), a_ in sorted(dev_list.get(i, {}).items(), key=lambda x: -x[1]):
                if a_ < 0.01 * pa:
                    continue
                pre_n = ctx["zone_names"].get(pre, pre)
                if ZCLASS.get(pre) == "nb":
                    parts_en.append(f"{NB_EN.get(pre, pre_n)} on {100*a_/pa:.0f}% (not buildable today)")
                    parts_fr.append(f"{NB_FR.get(pre, pre_n)} sur {100*a_/pa:.0f} % (inconstructible aujourd'hui)")
                else:
                    parts_en.append(f"{pre_n} rules on {100*a_/pa:.0f}%")
                    parts_fr.append(f"règles de la {pre_n.lower()} sur {100*a_/pa:.0f} %")
            dnames = join(list(dict.fromkeys(ctx["dev_names"].get(dz, dz) for (dz, pre), a_ in dev_list.get(i, {}).items()
                                             if a_ >= 0.01 * pa)), "and") or ctx["dev_names"].get(dmain, dmain)
            d5 = dmain == "D5"
            en = (f"{dnames} without a PLQ: building to development-zone norms needs an approved PLQ (LGZD art. 2)"
                  + (" — in a 5th-zone development perimeter the Conseil d'État may waive it (LGZD art. 2 al. 2 let. a)" if d5 else "")
                  + f"; until then the underlying zone applies: {join(parts_en, 'and')}. Today about {fn(pa - utot)} m² can be built"
                  + (f"; with a PLQ about {fn(pa - utot_after)} m²." if abs(utot_after - utot) >= 1 else "."))
            fr = (f"{dnames} sans PLQ : construire selon les normes de la zone de développement exige un PLQ approuvé (LGZD art. 2)"
                  + (" — dans un périmètre de développement de 5e zone le Conseil d'État peut y renoncer (LGZD art. 2 al. 2 let. a)" if d5 else "")
                  + f" ; d'ici là, la zone sous-jacente s'applique : {join(parts_fr, 'et')}. Aujourd'hui environ {fn(pa - utot)} m² constructibles"
                  + (f" ; avec un PLQ environ {fn(pa - utot_after)} m²." if abs(utot_after - utot) >= 1 else "."))
        elif utot >= max(10.0, 0.02 * pa):
            b = "partly_buildable"
            en = f"Partly buildable: about {fn(pa - utot)} m² of {fn(pa)} m² can be built; the rest is {reason_en or 'unbuildable'}."
            fr = (f"Partiellement constructible : environ {fn(pa - utot)} m² sur {fn(pa)} m² ; le reste est "
                  f"{reason_fr or 'inconstructible'}.")
        elif plan_driven:
            b = "buildable_needs_plan"
            if plq_items and A["plq"][i] >= 0.05 * pa and (reg[i] == "plq_dab" or A["plq"][i] >= max(A["pdzi"][i], A["dev"][i])):
                a_, no, url = plq_items[0]
                part = "" if a_ >= 0.98 * pa else f" (the PLQ covers {100*a_/pa:.0f}% of the plot)"
                if not np.isnan(dab):
                    en = f"Buildable under PLQ {no} ({url}){part}: the plan grants this plot {fn(dab)} m² of floor area (DAB)."
                    fr = f"Constructible selon le PLQ {no} ({url}){part.replace('the PLQ covers', 'le PLQ couvre').replace('of the plot', 'de la parcelle')} : le plan attribue à cette parcelle {fn(dab)} m² de surface brute de plancher (DAB)."
                else:
                    en = f"Buildable under PLQ {no} ({url}){part}: floor area and building positions are set by the PLQ."
                    fr = f"Constructible selon le PLQ {no} ({url}){part.replace('the PLQ covers', 'le PLQ couvre').replace('of the plot', 'de la parcelle')} : surfaces et implantations fixées par le PLQ."
            elif df.pdzi_id.iat[i] and A["pdzi"][i] >= 0.05 * pa and A["pdzi"][i] >= A["dev"][i]:
                k = "PDZI " + df.pdzi_id.iat[i]
                en = (f"Industrial development zone with approved PDZI {df.pdzi_id.iat[i]} ({link(k)}): "
                      f"building limits come from the PDZI and its regulation (LZIAM art. 4).")
                fr = (f"Zone de développement industriel avec PDZI {df.pdzi_id.iat[i]} approuvé ({link(k)}) : "
                      f"les limites de construction découlent du PDZI et de son règlement (LZIAM art. 4).")
            elif dmain and A["dev"][i] >= 0.05 * pa:
                dname = ctx["dev_names"].get(dmain, dmain)
                pre_n = ctx["zone_names"].get(dpre, dpre)
                pre_nb = ZCLASS.get(dpre) == "nb"
                if dmain == "D5":
                    en = (f"{dname} over {pre_n}: in a 5th-zone development perimeter the Conseil d'État may waive the PLQ "
                          f"(LGZD art. 2 al. 2 let. a) and authorise villas to zone-5 norms; otherwise a PLQ is needed"
                          + (f", and until then the {NB_EN.get(dpre, pre_n)} rules apply." if pre_nb else "."))
                    fr = (f"{dname} sur {pre_n.lower()} : dans un périmètre de développement de 5e zone, le Conseil d'État peut "
                          f"renoncer au PLQ (LGZD art. 2 al. 2 let. a) et autoriser des villas selon les normes de la 5e zone ; "
                          f"sinon un PLQ est nécessaire" + (f", et d'ici là les règles de la {NB_FR.get(dpre, pre_n)} s'appliquent." if pre_nb else "."))
                else:
                    tail_en = (f"until then the {NB_EN.get(dpre, pre_n)} rules apply and it cannot be built on"
                               if pre_nb else f"until then the rules of {pre_n} apply")
                    tail_fr = (f"d'ici là, les règles de la {NB_FR.get(dpre, pre_n)} s'appliquent et elle n'est pas constructible"
                               if pre_nb else f"d'ici là, les règles de la {pre_n.lower()} s'appliquent")
                    en = f"{dname} without a PLQ: building to development-zone norms needs an approved PLQ (LGZD art. 2); {tail_en}."
                    fr = f"{dname} sans PLQ : construire selon les normes de la zone de développement exige un PLQ approuvé (LGZD art. 2) ; {tail_fr}."
            elif frac["drawn_in"] > 0:
                k = [x for x in st if x[0] == "drawn_in"][0][2]
                en = (f"Buildable only inside the building areas drawn on {pname(k)} ({link(k)}): about {fn(drawn_in)} m² of the "
                      f"plot lies in them.")
                fr = (f"Constructible seulement dans les aires dessinées sur le {pname(k, True)} ({link(k)}) : environ "
                      f"{fn(drawn_in)} m² de la parcelle s'y trouvent.")
            elif cases:
                k, det = cases[0][2], cases[0][3]
                en = f"Buildable case by case under {pname(k)} ({link(k)})" + (f": {det}." if det else ".")
                fr = f"Constructible au cas par cas selon le {pname(k, True)} ({link(k)})" + (f" : {det}." if det else ".")
            else:
                en = "Buildable, but the building limits come from a special plan (see the plq / pdzi / zones_dev columns)."
                fr = "Constructible, mais les limites découlent d'un plan spécial (voir les colonnes plq / pdzi / zones_dev)."
        else:
            b = "buildable"
            en = f"Buildable under {zn} rules (LCI)."
            fr = f"Constructible selon les règles de la {zn.lower() if zn.lower().startswith('zone') else zn} (LCI)."
        # ---- every other limit-changing restriction on the parcel (never omitted)
        ex = []   # (token, en, fr)
        for a_, no, url in plq_items:
            ex.append((f"PLQ {no}", f"PLQ {no} covers {max(100*a_/pa, 0.01):.2f}% ({url})",
                       f"PLQ {no} couvre {max(100*a_/pa, 0.01):.2f} % ({url})"))
        if not np.isnan(dab):
            ex.append(("DAB", f"floor-area rights of {fn(dab)} m² (DAB, {df.dab_source.iat[i]})",
                       f"droits à bâtir de {fn(dab)} m² (DAB, {df.dab_source.iat[i]})"))
        if df.pdzi.iat[i]:
            for m in re.finditer(r"PDZI (\S+)", df.pdzi.iat[i]):
                k = "PDZI " + m.group(1)
                ex.append((k, f"{pname(k)} ({link(k)})", f"{pname(k, True)} ({link(k)})"))
        for (dz, pre), a_ in sorted(dev_list.get(i, {}).items(), key=lambda x: -x[1]):
            dname = ctx["dev_names"].get(dz, dz)
            ex.append((dname, f"{dname} over {pre} on {100*a_/pa:.{0 if a_ >= 0.01 * pa else 2}f}% of the plot"
                       + (" (PLQ can be waived, LGZD art. 2 al. 2 let. a)" if dz == "D5" else ""),
                       f"{dname} sur {pre} sur {100*a_/pa:.{0 if a_ >= 0.01 * pa else 2}f} % de la parcelle"
                       + (" (renonciation au PLQ possible, LGZD art. 2 al. 2 let. a)" if dz == "D5" else "")))
        if round(100 * A["dev"][i] / pa, 1) >= 1:
            pres = join(list(dict.fromkeys(ctx["zone_names"].get(pre, pre) for (dz, pre), a_ in dev_list.get(i, {}).items()
                                           if a_ >= 0.01 * pa)), "and")
            ex.append(("needs an approved PLQ", f"on {100*A['dev'][i]/pa:.0f}% of the plot the development zone has no PLQ: building to "
                                                f"development-zone norms needs an approved PLQ (LGZD art. 2); until then the {pres} rules apply",
                       f"sur {100*A['dev'][i]/pa:.0f} % de la parcelle la zone de développement n'a pas de PLQ : construire selon ses "
                       f"normes exige un PLQ approuvé (LGZD art. 2) ; d'ici là les règles de la {pres.lower()} s'appliquent"))
        for k in sorted(plan_area.get(i, {}), key=lambda k: -plan_area[i][k]):
            if 100 * plan_area[i][k] / pa >= LIST_MIN_PCT and not k.startswith("PDZI"):
                pst = sorted({x[0] for x in st if x[2] == k})
                ex.append((k, f"{pname(k)} ({link(k)}) on {100*plan_area[i][k]/pa:.0f}% of the plot"
                           + (f", status: {'/'.join(pst)}" if pst else ""),
                           f"{pname(k, True)} ({link(k)}) sur {100*plan_area[i][k]/pa:.0f} % de la parcelle"))
        if df.zone_protegee.iat[i]:
            ex.append(("protected zone", f"protected zone {df.zone_protegee.iat[i]} (LaLAT art. 28)",
                       f"zone protégée {df.zone_protegee.iat[i]} (LaLAT art. 28)"))
        arve_flag = False
        for kk, (len_, lfr) in SHORE_LAW.items():
            if kk in df.protection_rives_pnp.iat[i]:
                ex.append(("shore protection", len_, lfr))
        # LPRArve plan 28616A: its 'secteurs inconstructibles' are not mapped -> flag (status unchanged)
        if "Arve" in df.protection_rives_pnp.iat[i] and b in ("buildable", "partly_buildable", "buildable_needs_plan"):
            arve_flag = True
            ex.append(("Arve shore-protection plan", f"Inside the Arve shore-protection plan (LPRArve, plan 28616A): parts of this "
                       f"perimeter are no-build sectors not yet mapped by us — check the plan ({arve_link})",
                       f"Dans le plan de protection des rives de l'Arve (LPRArve, plan 28616A) : certaines parties de ce périmètre "
                       f"sont des secteurs inconstructibles que nous n'avons pas encore cartographiés — consultez le plan ({arve_link})"))
        if df.lake_shore_cap_m2.iat[i] > 0:
            ex.append(("20%", f"LPRLac art. 3: floor area at most 20% of the zone-5 land, i.e. about {fn(df.lake_shore_cap_m2.iat[i])} m², "
                              f"no LCI 59 al. 4 derogation",
                       f"LPRLac art. 3 : surface de plancher au plus 20 % du terrain en 5e zone, soit environ "
                       f"{fn(df.lake_shore_cap_m2.iat[i])} m², sans dérogation LCI 59 al. 4"))
        if df.monument_classe.iat[i]:
            ex.append(("classified monument", f"classified monument: {df.monument_classe.iat[i]} (LPMNS)",
                       f"monument classé : {df.monument_classe.iat[i]} (LPMNS)"))
        if df.monument_inventaire.iat[i]:
            ex.append(("heritage inventory", f"listed in the heritage inventory: {df.monument_inventaire.iat[i]} (LPMNS art. 7-9)",
                       f"inscrit à l'inventaire : {df.monument_inventaire.iat[i]} (LPMNS art. 7-9)"))
        if df.polluted_site.iat[i]:
            ex.append(("polluted site", f"polluted site: {df.polluted_site.iat[i]} (OSites)",
                       f"site pollué : {df.polluted_site.iat[i]} (OSites)"))
        if df.polluted_site_military.iat[i]:
            ex.append(("military polluted site", f"military polluted site (DDPS cadastre): {df.polluted_site_military.iat[i]} (OSites)",
                       f"site pollué militaire (cadastre DDPS) : {df.polluted_site_military.iat[i]} (OSites)"))
        if df.gravel_extraction_plan.iat[i]:
            ex.append(("gravel", f"gravel extraction plan {df.gravel_extraction_plan.iat[i]}",
                       f"plan d'extraction de gravier {df.gravel_extraction_plan.iat[i]}"))
        if df.groundwater_protection_zone.iat[i]:
            ex.append(("groundwater protection zone", f"groundwater protection zone {df.groundwater_protection_zone.iat[i]} "
                       f"(OEaux annex 4: S1/S2 no new buildings; S3 no deep construction below the water table)",
                       f"zone de protection des eaux souterraines {df.groundwater_protection_zone.iat[i]} (OEaux annexe 4)"))
        if df.forest_reserve.iat[i]:
            ex.append(("forest reserve", f"forest reserve {df.forest_reserve.iat[i]}", f"réserve forestière {df.forest_reserve.iat[i]}"))
        for k_, (en_, fr_) in HARD_TXT.items():
            if comp_area[k_][i] >= 0.01 * pa:
                ex.append((en_, f"{100*comp_area[k_][i]/pa:.0f}% {en_}", f"{100*comp_area[k_][i]/pa:.0f} % {fr_}"))
        if comp_area["nonbuilding_zone"][i] >= 0.01 * pa and nbcode.get(i):
            for c, a_ in nbcode[i].items():
                ex.append((NB_EN.get(c, c), f"{100*a_/pa:.0f}% {NB_EN.get(c, c)}", f"{100*a_/pa:.0f} % {NB_FR.get(c, c)}"))
        if band_total[i] >= 0.009 * pa:
            ex.append(("forest setback", f"{100*band_total[i]/pa:.0f}% within the forest setback distance (20 m from the forest cadastre "
                                         f"or the recorded band, LForêts art. 11)",
                       f"{100*band_total[i]/pa:.0f} % dans la distance à la forêt (20 m du cadastre forestier ou bande "
                       f"inscrite, LForêts art. 11)"))
        if soft_band[i] >= 0.009 * pa:
            ex.append(("forest setback band 10", f"{100*soft_band[i]/pa:.0f}% in the forest setback band 10–20 m from the forest "
                                                 f"(LForêts art. 11 al. 2 let. c: building needs a derogation)",
                       f"{100*soft_band[i]/pa:.0f} % dans la bande de 10 à 20 m de la forêt (LForêts art. 11 al. 2 let. c : dérogation nécessaire)"))
        road_pct = round(100 * road_strip[i] / pa, 1)
        if road_pct >= 5:
            ex.append(("road building-line strip", f"{road_pct:.0f}% in the road building-line strip (LRoutes art. 11 al. 2; derogation under al. 3)",
                       f"{road_pct:.0f} % dans la bande d'alignement routier (LRoutes art. 11 al. 2 ; dérogation selon l'al. 3)"))
        if df.nat_road_bl.iat[i]:
            ex.append(("national-road building line", f"a national-road building line crosses the plot (LRN art. 22; ref. {df.nat_road_bl_ref.iat[i]})",
                       f"un alignement de route nationale traverse la parcelle (LRN art. 22 ; réf. {df.nat_road_bl_ref.iat[i]})"))
        if df.airport_safety_zone_plan.iat[i]:
            ex.append(("airport safety-zone plan", "airport safety-zone plan (height limits, OSIA)",
                       "plan de la zone de sécurité de l'aéroport (limites de hauteur, OSIA)"))
        if df.static_forest_limit_len_m.iat[i] > 0:
            ex.append(("static forest boundary", "static forest boundary (LFo art. 13)", "limite forestière statique (LFo art. 13)"))
        if df.zone_remark_limit.iat[i]:
            lt = df.zone_remark_limit_text.iat[i].split(" | ")[0].capitalize()
            ex.append(("Zone restriction", f"Zone restriction: “{lt}”", f"Restriction de zone : « {lt} »"))
        if df.densif_accrue.iat[i] in ("no_derogation_sector", "zone_change_pending"):
            ex.append(("59", "zone-5 sector where no LCI art. 59 al. 4 density derogation is granted"
                       if df.densif_accrue.iat[i] == "no_derogation_sector" else "zone change pending (no LCI art. 59 al. 4 derogation)",
                       "secteur de 5e zone sans dérogation LCI art. 59 al. 4" if df.densif_accrue.iat[i] == "no_derogation_sector"
                       else "modification de zone en cours (pas de dérogation LCI art. 59 al. 4)"))
        if df.pus_plan.iat[i]:
            ex.append(("PUS", f"land-use plan {df.pus_plan.iat[i]} (housing / activity shares)",
                       f"plan d'utilisation du sol {df.pus_plan.iat[i]} (parts logement / activités)"))
        for col, en_, fr_ in (("hazard_flood", "flood", "crues"), ("hazard_landslide", "landslide", "glissement"),
                              ("hazard_rockfall", "rockfall", "chutes de pierres")):
            v = df[col].iat[i]
            if re.search(r"moyen|lev", v, re.I):
                ex.append(("hazard", f"{en_} hazard: {v}", f"danger de {fr_} : {v}"))
        # existing buildings in a plan de site / RS: what the plan says about them (maintained, rebuilt in volume, ...)
        exist_by_txt = collections.OrderedDict()
        if df.bldg_n.iat[i] > 0:
            for k in sorted(plan_area.get(i, {}), key=lambda k: -plan_area[i][k]):
                if 100 * plan_area[i][k] / pa < LIST_MIN_PCT:
                    continue
                e_ = plans.get(k) or {}
                txts = []
                for r in rows_i.get(k, []):
                    sv = ((e_.get("sectors") or {}).get(r["sector"]) or {}).get("maintained")
                    if isinstance(sv, dict) and sv.get("value"):
                        txts.append(short_value(sv["value"]))
                lv = (e_.get("limits") or {}).get("maintained")
                if not txts and isinstance(lv, dict) and lv.get("value"):
                    txts.append(short_value(lv["value"]))
                cats = []
                for cat, gm in maint.get(k, []):
                    if gm is not None and shapely.intersection(P[i], gm).area >= 10:
                        cats.append(cat)
                if txts or cats:
                    key_ = ("; ".join(dict.fromkeys(txts)) or "", ", ".join(dict.fromkeys(cats)))
                    exist_by_txt.setdefault(key_, []).append(k)
        for (tx_, ct_), ks in exist_by_txt.items():
            kl = ", ".join(ks)
            ctxt = f" (building category on the plan: {ct_})" if ct_ else ""
            ex.append(("Existing buildings", f"Existing buildings ({kl}): {tx_ or 'see plan'}{ctxt}",
                       f"Bâtiments existants ({kl}) : {tx_ or 'voir le plan'}" + (f" (catégorie sur le plan : {ct_})" if ct_ else "")))
        for col_ in ("zones_prim_remarks", "zones_dev_remarks"):
            for item in filter(None, df[col_].iat[i].split("; ")):
                m_ = re.match(r"^(\w+): (.*) \(([\d.]+)%\)$", item)
                if m_ and float(m_.group(3)) >= 1:
                    tx = m_.group(2).capitalize()
                    ex.append(("Zone use", f"Zone use ({m_.group(1)}, {m_.group(3)}%): “{tx}”",
                               f"Affectation de zone ({m_.group(1)}, {m_.group(3)} %) : « {tx} »"))
        for k, sh_ in maint_share.items():
            if sh_ >= 0.05:
                ex.append(("Existing buildings", f"Existing buildings ({k}): about {100*sh_:.0f}% of the plot is covered by a building the plan "
                                                 f"maintains — it may be kept and renovated within its volume, not replaced by a new one",
                           f"Bâtiments existants ({k}) : environ {100*sh_:.0f} % de la parcelle est couverte par un bâtiment maintenu par "
                           f"le plan — il peut être conservé et rénové dans son volume, pas remplacé par une construction nouvelle"))
        for k, sec in dict.fromkeys(lowconf):
            ex.append(("approximate placement", f"{k} sector “{sec[:60]}” (approximate placement)",
                       f"{k} secteur « {sec[:60]} » (emplacement approximatif)"))
        for k in dict.fromkeys(approx):
            if drawn_in >= 1:
                ex.append(("approximate", f"the plot is partly inside the building areas of {pname(k)} (approximate tracing, ±5-8 m)",
                           f"la parcelle est en partie dans les aires de construction du {pname(k, True)} (tracé approximatif, ±5-8 m)"))
            else:
                ex.append(("approximate", f"the building areas of {pname(k)} are traced approximately (±5-8 m); none falls on this plot",
                           f"les aires de construction du {pname(k, True)} sont tracées approximativement (±5-8 m) ; aucune sur cette parcelle"))
        if drawn_in >= 1 and (b == "not_buildable" or drawn_in < 200):
            kk = next((x[2] for x in st if x[0] == "drawn_in"), "")
            ex.append(("inside the building areas", f"about {fn(drawn_in)} m² of the plot lies inside a building area drawn on "
                       f"{pname(kk) if kk else 'the plan'} (a planned building footprint; usually buildable only together with the neighbouring plots)",
                       f"environ {fn(drawn_in)} m² de la parcelle se trouvent dans une aire d'implantation dessinée sur "
                       f"{pname(kk, True) if kk else 'le plan'} (bâtiment projeté ; en général constructible seulement avec les parcelles voisines)"))
        if b == "not_buildable" and ptype[i] not in ROADTYPES:
            exb = [x for x in ex if x[0] == "Existing buildings"]
            if exb:
                en = en[:-1] + f". {exb[0][1]}."
                fr = fr[:-1] + f". {exb[0][2]}."
        if ae_area[i] >= 0.01 * pa:
            ex.append(("airport zone", f"{100*ae_area[i]/pa:.0f}% airport zone (LaLAT art. 19 al. 6: reserved for airport constructions "
                                       f"and installations)", f"{100*ae_area[i]/pa:.0f} % zone aéroportuaire (LaLAT art. 19 al. 6 : "
                                       f"réservée aux constructions et installations aéroportuaires)"))
        if ae_area[i] >= 0.5 * pa and ptype[i] not in ROADTYPES and b != "not_buildable":
            en = (f"Buildable only for airport facilities: {100*ae_area[i]/pa:.0f}% airport zone (LaLAT art. 19 al. 6). " + en)
            fr = (f"Constructible uniquement pour des installations aéroportuaires : {100*ae_area[i]/pa:.0f} % zone aéroportuaire "
                  f"(LaLAT art. 19 al. 6). " + fr)
        if road_pct >= 99 and b in ("buildable", "partly_buildable", "buildable_needs_plan"):
            en = (f"Needs a derogation (road building-line strip): {road_pct:.0f}% of the plot lies in the LRoutes art. 11 al. 2 strip, "
                  f"where any new building needs a derogation (al. 3). " + en)
            fr = (f"Dérogation nécessaire (bande d'alignement routier) : {road_pct:.0f} % de la parcelle est dans la bande de "
                  f"l'art. 11 al. 2 LRoutes, où toute nouvelle construction exige une dérogation (al. 3). " + fr)
        if classe_perim[i] >= 0.5 * pa and ptype[i] not in ROADTYPES:
            names = re.sub(r"\s*\(\d+%\)", "", df.monument_classe.iat[i])
            cpct = 100 * classe_perim[i] / pa
            en = (f"Protected building — classified monument on {cpct:.0f}% of the plot ({names}): no demolition or alteration "
                  f"without authorisation (LPMNS art. 15); only the unbuilt remainder could take a new building. " + en)
            fr = (f"Bâtiment protégé — monument classé sur {cpct:.0f} % de la parcelle ({names}) : ni démolition ni modification "
                  f"sans autorisation (LPMNS art. 15) ; seul le reste non bâti pourrait recevoir une construction. " + fr)
        extra_en = [e for t_, e, _ in ex if t_ not in en]
        extra_fr = [f for t_, e, f in ex if t_ not in en]
        if extra_en:
            en += " Also: " + "; ".join(dict.fromkeys(extra_en)) + "."
            fr += " Aussi : " + "; ".join(dict.fromkeys(extra_fr)) + "."
        if b == "not_buildable" and unres and unres_f >= 0.1:
            k = unres[0][2]
            en += f" Its sector of {k} could not be placed."
            fr += f" Son secteur du {k} n'a pas pu être situé."
        cols["buildability"].append(b)
        cols["buildable_m2"].append(round(0.0 if ptype[i] in ROADTYPES else pa - utot, 0))
        cols["buildable_after_plq_m2"].append(round(0.0 if ptype[i] in ROADTYPES else pa - utot_after, 0))
        cols["plan_low_confidence"].append("; ".join(f"{k}:{s_}" for k, s_ in dict.fromkeys(lowconf)))
        cols["plan_maintained_bldg_pct"].append(round(100 * sum(maint_share.values()), 1))
        cols["dev_no_plq_pct"].append(round(100 * A["dev"][i] / pa, 1))
        cols["buildable_m2_approx"].append(bool(approx))
        cols["unbuildable_total_m2"].append(round(utot, 1))
        cols["plan_sector_status"].append(sts)
        cols["plan_unresolved_pct"].append(round(100 * unres_f, 1))
        cols["plan_forbid_pct"].append(round(100 * forbid_f, 1))
        cols["plan_drawn_area_m2"].append(round(drawn_in, 1))
        cols["road_strip_pct"].append(round(road_pct, 1))
        cols["special_plan_unresolved_flag"].append((bool(unres) and unres_f >= 0.1) or arve_flag)
        cols["notice_en"].append(en)
        cols["notice_fr"].append(fr)
    for c, v in cols.items():
        df[c] = v
    return dict(geo_stats)


def notice_flag_test(df, dev_names):
    """Every set restriction column must be named in notice_en.  Returns (failures dataframe, counts per flag)."""
    tests = [
        ("plq", lambda r: [f"PLQ {m}" for m in re.findall(r"PLQ (\S+)", r.plq)]),
        ("pdzi", lambda r: [f"PDZI {m}" for m in re.findall(r"PDZI (\S+)", r.pdzi)]),
        ("plan_de_site_ids", lambda r: [f"PS {x}" for x in r.plan_de_site_ids.split(";") if x]),
        ("reglement_special", lambda r: [f"RS {m}" for m in re.findall(r"RS (\d+)", r.reglement_special)]),
        ("zones_dev", lambda r: [dev_names.get(m, m) for m in re.findall(r"(D\w+)/pre:", r.zones_dev)]),
        ("dab_m2", lambda r: ["DAB"] if not np.isnan(r.dab_m2) else []),
        ("zone_protegee", lambda r: ["protected zone"] if r.zone_protegee else []),
        ("protection_rives_pnp", lambda r: ["shore protection"] if r.protection_rives_pnp else []),
        ("lake_shore_cap_m2", lambda r: ["20%"] if r.lake_shore_cap_m2 > 0 else []),
        ("monument_classe", lambda r: ["classified monument"] if r.monument_classe else []),
        ("monument_inventaire", lambda r: ["heritage inventory"] if r.monument_inventaire else []),
        ("polluted_site", lambda r: ["polluted site"] if r.polluted_site else []),
        ("gravel_extraction_plan", lambda r: ["gravel"] if r.gravel_extraction_plan else []),
        ("forest_reserve", lambda r: ["forest reserve"] if r.forest_reserve else []),
        ("forest_m2", lambda r: ["forest"] if r.forest_m2 >= 0.01 * r.area_geom_m2 else []),
        ("water_m2", lambda r: ["water"] if r.water_m2 >= 0.01 * r.area_geom_m2 else []),
        ("si_cours_eau_m2", lambda r: ["river-bank"] if r.si_cours_eau_m2 >= 0.01 * r.area_geom_m2 else []),
        ("forest_setback_soft_m2", lambda r: ["forest setback"] if r.forest_setback_soft_m2 >= 0.01 * r.area_geom_m2 else []),
        ("road_strip_pct", lambda r: ["road building-line strip"] if r.road_strip_pct >= 5 else []),
        ("nat_road_bl", lambda r: ["national-road building line"] if r.nat_road_bl else []),
        ("airport_safety_zone_plan", lambda r: ["airport safety-zone plan"] if r.airport_safety_zone_plan else []),
        ("static_forest_limit_len_m", lambda r: ["static forest boundary"] if r.static_forest_limit_len_m > 0 else []),
        ("zone_remark_limit", lambda r: ["Zone restriction"] if r.zone_remark_limit else []),
        ("densif_accrue", lambda r: ["59"] if r.densif_accrue in ("no_derogation_sector", "zone_change_pending") else []),
        ("pus", lambda r: ["PUS"] if r.pus else []),
        ("zone_use_remarks", lambda r: ["Zone use"] if any(float(m) >= 1 for m in re.findall(r"\(([\d.]+)%\)", r.zones_prim_remarks + " " + r.zones_dev_remarks)) else []),
        ("plan_low_confidence", lambda r: ["approximate placement"] if r.plan_low_confidence else []),
        ("plan_maintained_bldg_pct", lambda r: ["Existing buildings"] if r.plan_maintained_bldg_pct >= 5 else []),
        ("dev_no_plq_pct", lambda r: ["needs an approved PLQ"] if r.dev_no_plq_pct >= 1 else []),
        ("buildable_m2_approx", lambda r: ["approximate"] if r.buildable_m2_approx else []),
        ("forest_setback_default_m2", lambda r: ["forest setback"] if r.forest_setback_default_m2 >= 0.01 * r.area_geom_m2 else []),
        ("groundwater_protection_zone", lambda r: ["groundwater protection zone"] if r.groundwater_protection_zone else []),
        ("arve", lambda r: ["Arve shore-protection plan"] if ("Arve" in r.protection_rives_pnp and r.buildability in
                                                                ("buildable", "partly_buildable", "buildable_needs_plan")) else []),
        ("polluted_site_military", lambda r: ["military polluted site"] if r.polluted_site_military else []),
        ("airport_zone", lambda r: ["airport zone"] if re.search(r"\bAE (\d+)m2 \(([\d.]+)%\)", r.zones_prim) and
                                    float(re.search(r"\bAE (\d+)m2 \(([\d.]+)%\)", r.zones_prim).group(2)) >= 1.01 else []),
        ("hazards", lambda r: ["hazard"] if re.search(r"moyen|lev", r.hazard_flood + r.hazard_landslide + r.hazard_rockfall, re.I) else []),
    ]
    fails, counts = [], collections.Counter()
    for r in df.itertuples():
        for name, f in tests:
            toks = f(r)
            if toks:
                counts[name] += 1
            for t_ in toks:
                if t_ not in r.notice_en:
                    fails.append(dict(egrid=r.egrid, flag=name, token=t_, notice_en=r.notice_en[:300]))
    return pd.DataFrame(fails), counts


# ------------------------------------------------------------------ regression tests (audited parcels)
REGRESSION = [
    # audit 4
    ("CH608063146566", "Plan-les-Ouates 4865: 4BP outside implantation areas + AG -> ~0 m2",
     lambda r: r.buildability == "not_buildable" and r.buildable_m2 < 100),
    ("CH157665866395", "Vernier 5444: at most a few hundred m2 inside PDZI 29975-B building areas (audit ~237 m2 on the "
     "first trace; the re-traced areas give less; the airport-zone part is buildable for airport facilities only)",
     lambda r: r.buildable_m2 - r.airport_zone_m2 <= 400 and r.buildability != "buildable"),
    ("CH716364659227", "Plan-les-Ouates 7502: D3 over AG without PLQ -> needs a PLQ",
     lambda r: r.buildability == "buildable_needs_plan" and "needs an approved PLQ" in r.notice_en),
    ("CH246365851955", "Onex 1611: D3 over 5 and AG -> AG part not buildable today, not 'Zone 5 rules' only",
     lambda r: "agricultural zone" in r.notice_en and "until then the rules of Zone 5 apply" not in r.notice_en),
    ("CH852765856319", "Collex-Bossy 216: 4,108 m2 of 4B protégée -> partly buildable",
     lambda r: r.buildability == "partly_buildable" and r.buildable_m2 >= 3000),
    ("CH836580636455", "Eaux-Vives 2664 (PS 30151): existing building may be maintained",
     lambda r: "Existing buildings" in r.notice_en),
    ("CH985965638190", "Eaux-Vives 1981 (PS 29559): maintain / rebuild in initial gabarit",
     lambda r: "Existing buildings" in r.notice_en),
    ("CH628519656314", "Bernex 8365: zone use remark (artisanat) shown",
     lambda r: "Zone use" in r.notice_en and "artisanat" in r.notice_en.lower()),
    # audits 2-3
    ("CH589265638510", "Collex-Bossy 960: no national-road line, agricultural", lambda r: r.buildability == "not_buildable" and not r.nat_road_bl),
    ("CH389265638380", "Vernier 2867: zone 5, buildable (no false national-road line)", lambda r: r.buildability == "buildable"),
    ("CH396585136339", "Vernier 1523: zone 5, buildable", lambda r: r.buildability == "buildable"),
    ("CH796585106309", "Versoix 6073: PNP + PLQ 28295 -> not buildable", lambda r: r.buildability == "not_buildable"),
    ("CH155865816314", "Eaux-Vives 2689: PS 29559 squares -> not buildable", lambda r: r.buildability == "not_buildable"),
    ("CH308363666528", "Lancy 660: PS 29866 verandas only -> not buildable", lambda r: r.buildability == "not_buildable"),
    ("CH716310658139", "Laconnex 2407: garden area -> not buildable", lambda r: r.buildability == "not_buildable"),
    ("CH896584646316", "Meyrin DIA with PDZI 26615-N", lambda r: r.regime == "dev_zone_pdzi"),
    ("CH276382856501", "Aire-la-Ville 451: D5 PLQ waiver mentioned", lambda r: "let. a" in r.notice_en),
    ("CH446365821597", "Bernex 6059 (RS 27425): sector C, not A", lambda r: "RS 27425:C=" in r.plan_sector_status
     and "RS 27425:A=" not in r.plan_sector_status),
    # audit 5
    ("CH676380346536", "Veyrier 5222: 20 m forest distance from the forest cadastre (no RDPPF band): <=232 m2, forest named",
     lambda r: r.buildable_m2 <= 240 and "forest" in r.notice_en),
    ("CH128592656312", "Versoix 5137: default 20 m forest distance mentioned", lambda r: "forest setback" in r.notice_en),
    ("CH468365639848", "Vernier 1810 (PDZI 29976): ~225 m2 inside drawn areas, not 343",
     lambda r: r.buildable_m2 <= 260),
    ("CH768465633579", "Vernier 4288 (PDZI 29976 B/D): ~3,543 m2, not 4,036",
     lambda r: 3300 <= r.buildable_m2 <= 3700),
    ("CH576397156571", "Grand Théâtre: classified monument leads the notice",
     lambda r: r.notice_en.startswith("Protected building — classified monument")),
    ("CH128444656383", "Carouge 3006: development zone without PLQ states the PLQ requirement",
     lambda r: "needs an approved PLQ" in r.notice_en),
    ("CH916359659501", "Grand-Saconnex 2634: D3 without PLQ states the PLQ requirement",
     lambda r: "needs an approved PLQ" in r.notice_en),
    ("CH196594806319", "Carouge 3562: forest band worded 10–20 m", lambda r: "10–20 m" in r.notice_en and "10-30" not in r.notice_en),
    ("CH116321658840", "Satigny 7739 (PDZI 29292): flagged approximate while the trace is low-confidence; after the "
     "re-trace the eastern ~22,000 m2 gap is inside the building areas",
     lambda r: (bool(r.buildable_m2_approx) and "approximate" in r.notice_en) or r.buildable_m2 >= 40000),
    # audit 6
    ("CH596587656388", "Versoix 5715: default 20 m forest band applied (recorded band elsewhere) -> ~945 m2",
     lambda r: r.forest_setback_default_m2 >= 300 and r.buildable_m2 <= 1050),
    ("CH546365889859", "Versoix 5817: default band where the recorded band does not cover -> ~261 m2",
     lambda r: r.buildable_m2 <= 330),
    ("CH781465638115", "Gy 218: river-bank surface cited LEaux-GE art. 16", lambda r: "LEaux art. 15" not in r.notice_en),
    ("CH168565631978", "Versoix 142: each non-building zone with its own share",
     lambda r: len(re.findall(r"\d+% (?:agricultural|forest zone|green zone|water and shore|nature and landscape)", r.notice_en.split(" Also:")[0])) >= 1),
    ("CH636587635965", "Plan-les-Ouates 6208: no 'partly inside' when 0 m2 inside", lambda r: "partly inside the building areas" not in r.notice_en),
    ("CH596586826346", "Collonge-Bellerive 9542: 100% in road strip -> derogation headline",
     lambda r: r.notice_en.startswith("Needs a derogation (road building-line strip)")),
    ("CH336580638411", "Carouge 2093: groundwater protection zone S3 mentioned", lambda r: "groundwater protection zone" in r.notice_en),
    ("CH668465637573", "Cartigny 2913: planned building footprint sliver mentioned", lambda r: "inside a building area drawn" in r.notice_en),
    ("CH468365639848", "Vernier 1810: PDZI 29976 'outside the building areas' clause not repeated",
     lambda r: r.notice_en.count("outside the building areas drawn on the plan") <= 1),
    ("CH236582638229", "Bernex 4863: RS 27425 sector D forbids new buildings",
     lambda r: r.buildability in ("not_buildable", "partly_buildable") and "RS 27425" in r.notice_en),
    ("CH946365949208", "Confignon 11905: PDZI 29968 placed, ~97% inside aire A1a",
     lambda r: r.buildability != "special_plan_unresolved" and r.plan_drawn_area_m2 >= 0.85 * r.area_geom_m2),
    # audit 7
    ("CH768265634625", "Bernex 6036 (RS 27425): 4BP part in sectors A/C, ~1,639 m2 buildable",
     lambda r: 1400 <= r.buildable_m2 <= 1800),
    ("CH228156656322", "Bernex 3141 (RS 27425, 4BP): not forced into sector D", lambda r: r.buildability != "not_buildable"),
    ("CH368365636716", "Carouge 85: polluted-site share never above 100%",
     lambda r: not re.search(r"\((?:1\d\d|[2-9]\d\d)(?:\.\d+)?%\)", r.notice_en.replace("(100%)", ""))),
    ("CH736586635445", "Meyrin 14691: airport zone -> buildable only for airport facilities, not 'Not buildable'",
     lambda r: r.notice_en.startswith("Buildable only for airport facilities")),
    ("CH346365833412", "Plainpalais 2120 (Vernets): military polluted site with its status", lambda r: "military polluted site" in r.notice_en),
    ("CH676383196554", "Carouge 445: headline not led by a 3% D3 sliver", lambda r: not r.notice_en.startswith("Zone de développement")),
    ("CH982565638930", "Rade 5474: 'Existing buildings' clause printed once", lambda r: r.notice_en.count("Existing buildings") <= 1),
    ("CH483965638025", "Thônex 5126 (PS 29376): almost fully covered by a maintained building",
     lambda r: r.buildable_m2 < 200 and "maintained" in r.notice_en),
]


def run_regression(df):
    out = []
    idx = df.set_index("egrid")
    for eg, desc, fn_ in REGRESSION:
        if eg not in idx.index:
            out.append(dict(egrid=eg, test=desc, ok=False, got="missing"))
            continue
        r = idx.loc[eg]
        r = r.copy(); r["egrid"] = eg
        ok = bool(fn_(r))
        out.append(dict(egrid=eg, test=desc, ok=ok, got=f"{r.buildability} {r.buildable_m2:.0f} m2 | {r.notice_en[:160]}"))
    return pd.DataFrame(out)


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-oereb", action="store_true")
    ap.add_argument("--oereb-n", type=int, default=30)
    ap.add_argument("--rules", default=os.path.join(GENEVA, "rules"),
                    help="ge_rules folder (parcel_sectors.csv, plans_de_site.json, pdzi.json)")
    ap.add_argument("--no-wait", action="store_true", help="do not wait for the ge_rules files to be stable")
    ap.add_argument("--prev", default=None, help="previous parcels.parquet for regime-change QA (default: ./parcels.parquet)")
    args = ap.parse_args()
    if args.refresh and os.path.isdir(RAW):
        shutil.rmtree(RAW)
    t0 = time.time()
    rules = load_rules(args.rules, wait=not args.no_wait)

    data, meta = {}, {}
    with ThreadPoolExecutor(4) as ex:
        futs = {k: ex.submit(fetch_layer, k) for k in LAYERS}
        for k, f in futs.items():
            feats, m = f.result()
            data[k] = to_frame(feats, LAYERS[k][3])
            meta[k] = {kk: m[kk] for kk in ("layer", "where", "fields", "count", "fetched")}
            meta[k]["usable_geometries"] = int(len(data[k][0]))
            print(f"[{time.time()-t0:6.0f}s] {k:14s} {m['layer']:30s} {m['count']:6d} feats", flush=True)
    nsbl, szp, mil = fetch_federal()
    ma = pd.DataFrame([f["properties"] for f in mil])
    mg = np.array([polygonal(shapely.make_valid(shapely.geometry.shape(f["geometry"]))) for f in mil], dtype=object)
    okm = np.array([g is not None and not g.is_empty for g in mg], dtype=bool)
    data["milsites"] = (ma[okm].reset_index(drop=True), mg[okm])
    meta["milsites"] = dict(layer="geo.admin.ch ch.vbs.kataster-belasteter-standorte-militaer (api3 identify)", count=len(mil))
    nb_attrs = pd.DataFrame([dict(f["properties"], featureId=f.get("featureId")) for f in nsbl])
    nb_geom = np.array([shapely.geometry.shape(f["geometry"]) for f in nsbl], dtype=object)
    is_poly = np.array([g.geom_type in ("Polygon", "MultiPolygon") for g in nb_geom])
    # keep only building lines with an approval reference in force; the polygons of this layer are
    # vertical-limit features without approval and do not show in the OEREB extract (audit 3)
    ok_line = np.array([(not ip) and s(a.get("status")) == "inForce" and bool(s(a.get("planning_approval_name")))
                        for ip, a in zip(is_poly, nb_attrs.to_dict("records"))])
    data["nsbl_line"] = (nb_attrs[ok_line].reset_index(drop=True), nb_geom[ok_line])
    data["szp"] = (szp.drop(columns="geometry"), np.array([polygonal(shapely.make_valid(g)) for g in szp.geometry], dtype=object))
    meta["nsbl"] = dict(layer=f"geo.admin.ch {NSBL_LAYER} (api3 identify, bbox {GE_BBOX})", count=len(nsbl),
                        polygons_dropped=int(is_poly.sum()), lines_used=int(ok_line.sum()),
                        filter="line geometry, status inForce, planning_approval_name set")
    meta["szp"] = dict(layer=f"geo.admin.ch ch.bazl.sicherheitszonenplan ({SZP_URL})", count=int(len(szp)),
                       names=sorted(set(szp.name.astype(str))))
    json.dump(meta, open(os.path.join(OUT, "layers.json"), "w"), indent=1, ensure_ascii=False)
    prev, prev_path = None, args.prev or os.path.join(OUT, "parcels.parquet")
    if os.path.exists(prev_path):
        _pv = pd.read_parquet(prev_path)
        prev = _pv[[c for c in ("egrid", "regime", "buildability", "buildable_m2") if c in _pv.columns]].set_index("egrid")

    pa_df, P = data["parcels"]
    n_cad = meta["parcels"]["count"]
    n = len(pa_df)
    parea = shapely.area(P)
    df = pd.DataFrame({
        "egrid": pa_df.EGRID, "commune": pa_df.COMMUNE, "no_comm": pa_df.NO_COMM, "no_parcelle": pa_df.NO_PARCELLE,
        "type_propri": pa_df.TYPE_PROPRI, "propri_publique": pa_df.PROPRI_PUBLIQUE,
        "area_cadastre_m2": pa_df.SURFACE, "area_geom_m2": parea.round(1)})

    def ov(key, label_fn, prefix, min_pct=LIST_MIN_PCT, fmt="{l} {a:.0f}m2 ({p:.1f}%)"):
        attrs, G = data[key]
        pi, li, g, a = overlay(P, G)
        labels = [label_fn(attrs.iloc[i]) for i in li]
        # duplicated / overlapping features with the same label are measured as one geometric union
        grp = collections.defaultdict(list)
        for j, (p_, l_) in enumerate(zip(pi, labels)):
            grp[(p_, l_)].append(j)
        upi, ulab, uar = [], [], []
        for (p_, l_), js in grp.items():
            upi.append(p_); ulab.append(l_)
            uar.append(a[js[0]] if len(js) == 1 else min(safe_union(list(g[js])).area, parea[p_]))
        txt, main, mpct, tot = group_text(n, np.array(upi, dtype=int), ulab, np.array(uar), parea, min_pct, fmt)
        df[prefix] = txt
        print(f"[{time.time()-t0:6.0f}s] overlay {key}: {len(pi)} pieces", flush=True)
        return pi, li, g, a, main, mpct, tot

    # --- primary zones
    zp_attrs, _ = data["zprim"]
    z_pi, z_li, z_g, z_a, zmain, zmpct, ztot = ov("zprim", lambda r: s(r.ABRV_ZONE), "zones_prim", min_pct=0.0,
                                                  fmt="{l} {a:.0f}m2 ({p:.2f}%)")
    df["zone_main"], df["zone_main_pct"] = zmain, zmpct
    df["zone_count"] = pd.Series(z_pi).value_counts().reindex(range(n), fill_value=0).values if len(z_pi) else 0
    df["zone_sum_m2"] = ztot.round(1)
    df["zone_sum_pct"] = np.where(parea > 0, 100 * ztot / np.maximum(parea, 1e-9), 0).round(2)
    df["zone_sum_mismatch_gt2pct"] = np.abs(df.zone_sum_pct - 100) > 2
    zone_names = {s(r.ABRV_ZONE): s(r.NOM_ZONE) for r in zp_attrs.itertuples()}
    dev_names = {s(r.ABRV_ZONE): s(r.NOM_ZONE) for r in data["zdev"][0].itertuples()}

    # --- development zones (+ underlying zone)
    zd_attrs, _ = data["zdev"]
    d_pi, d_li, d_g, d_a, dmain, dmpct, dtot = ov(
        "zdev", lambda r: f"{s(r.ABRV_ZONE)}/pre:{s(r.ZONE_PREEX)}", "zones_dev", min_pct=0.0,
        fmt="{l} {a:.0f}m2 ({p:.2f}%)")
    df["dev_main"] = [m.split("/")[0] for m in dmain]
    df["dev_underlying"] = [m.split("pre:")[1] if "pre:" in m else "" for m in dmain]
    df["dev_pct"] = (100 * dtot / np.maximum(parea, 1e-9)).round(2)

    # --- zone remarks (AFFCOMP = complementary designation, RESTRIC = restriction) per zone piece
    rem = collections.defaultdict(dict); lim = collections.defaultdict(set); limtxt = collections.defaultdict(list)
    for tag, pis, lis, ars, attrs in (("prim", z_pi, z_li, z_a, zp_attrs), ("dev", d_pi, d_li, d_a, zd_attrs)):
        for p, l, a in zip(pis, lis, ars):
            r = attrs.iloc[l]
            parts = [x for x in (s(r.AFFCOMP), s(r.RESTRIC)) if x]
            if not parts:
                continue
            txt = " / ".join(dict.fromkeys(parts))
            key = (tag, s(r.ABRV_ZONE), txt)
            rem[p][key] = rem[p].get(key, 0) + a
            for kind, rx in LIMIT_RE.items():
                if rx.search(txt) and a >= 0.01 * parea[p]:
                    lim[p].add(kind)
                    if txt not in limtxt[p]:
                        limtxt[p].append(txt)
    df["zones_prim_remarks"] = ["; ".join(f"{z}: {x} ({100*a/max(parea[i],1e-9):.1f}%)" for (tg, z, x), a in rem[i].items() if tg == "prim") if i in rem else "" for i in range(n)]
    df["zones_dev_remarks"] = ["; ".join(f"{z}: {x} ({100*a/max(parea[i],1e-9):.1f}%)" for (tg, z, x), a in rem[i].items() if tg == "dev") if i in rem else "" for i in range(n)]
    df["zone_remark_limit"] = [",".join(sorted(lim[i])) if i in lim else "" for i in range(n)]
    df["zone_remark_limit_text"] = [" | ".join(limtxt[i]) if i in limtxt else "" for i in range(n)]

    # --- PDZI (plans directeurs de zone de developpement industriel / d'activites mixtes, LZIAM)
    pz_attrs, _ = data["pdzi"]

    def pdzi_label(r):
        dt = ""
        if pd.notna(r.DATE_ADOP_CE):
            dt = datetime.datetime.fromtimestamp(r.DATE_ADOP_CE / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
        return f"PDZI {int(r.NO_PLAN)}{'' if s(r.INDICE) in ('', '-') else '-' + s(r.INDICE)} {s(r.LIEU)} [{s(r.STATUT_JUR)} {dt}]"
    x_pi, x_li, x_g, x_a, xmain, xmpct, xtot = ov("pdzi", pdzi_label, "pdzi")
    df["pdzi_pct"] = (100 * xtot / np.maximum(parea, 1e-9)).round(2)
    df["pdzi_id"] = [m.split(" ")[1] if m else "" for m in xmain]
    plinks = collections.defaultdict(list)
    for p, l, a in zip(x_pi, x_li, x_a):
        r = pz_attrs.iloc[l]
        for c in ("LIEN_PLAN", "LIEN_REGLEMENT", "LIEN_ACE"):
            u = s(r[c])
            if u and u not in plinks[p]:
                plinks[p].append(u)
    df["pdzi_links"] = [" | ".join(plinks.get(i, [])) for i in range(n)]

    # --- PLQ
    plq_attrs, _ = data["plq"]

    def plq_label(r):
        dt = ""
        if pd.notna(r.DATE_ADOP_CE):
            dt = datetime.datetime.fromtimestamp(r.DATE_ADOP_CE / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")
        return f"PLQ {int(r.NO_PLAN)}{'' if s(r.INDICE) in ('', '-') else '-' + s(r.INDICE)} [{s(r.STATUT_JUR)} {dt}]"
    q_pi, q_li, q_g, q_a, qmain, qmpct, qtot = ov("plq", plq_label, "plq", min_pct=0.0, fmt="{l} {a:.0f}m2 ({p:.2f}%)")
    df["plq_pct"] = (100 * qtot / np.maximum(parea, 1e-9)).round(2)
    links = collections.defaultdict(list)
    for p, l, a in zip(q_pi, q_li, q_a):
        if 100 * a / max(parea[p], 1e-9) >= LIST_MIN_PCT:
            r = plq_attrs.iloc[l]
            for c in ("LIEN_PLAN", "LIEN_REGLEMENT", "LIEN_ACE"):
                u = s(r[c])
                if u and u not in links[p]:
                    links[p].append(u)
    df["plq_links"] = [" | ".join(links.get(i, [])) for i in range(n)]

    # --- DAB (RPU_DAB_ADOPT): geometric match (>= 50 % of the smaller of the two surfaces)
    dab_attrs, DG = data["dab"]
    b_pi, b_li, b_g, b_a = overlay(P, DG)
    dab_sum, dab_src, dab_how = np.full(n, np.nan), np.full(n, "", object), np.full(n, "", object)
    darea = shapely.area(DG)
    for p, l, a in zip(b_pi, b_li, b_a):
        if a < 0.5 * min(parea[p], darea[l]):
            continue
        r = dab_attrs.iloc[l]
        if pd.isna(r.DAB):
            continue
        same = s(r.COMMUNE) == s(df.commune[p]) and pd.notna(r.NO_PARCELLE) and int(r.NO_PARCELLE) == int(df.no_parcelle[p])
        dab_sum[p] = (0 if np.isnan(dab_sum[p]) else dab_sum[p]) + float(r.DAB)
        dab_src[p] += ("; " if dab_src[p] else "") + f"PLQ {int(r.NO_PLAN)} {s(r.REMARQUE_V)}: {r.DAB:.0f} m2 ({s(r.STATUT_RPU) or 'n/a'})"
        dab_how[p] = "number+geometry" if same else (dab_how[p] or "geometry_only")
    df["dab_m2"], df["dab_source"], df["dab_match"] = dab_sum, dab_src, dab_how

    # --- PLQ building areas (RPU_AIRE_IMPLANTATION_ADOPT): SBP pro-rata to the overlap
    ai_attrs, AG = data["aires"]
    a_pi, a_li, a_g, a_a = overlay(P, AG)
    aarea = shapely.area(AG)
    sbpc = [c for c in ai_attrs.columns if c.startswith("SBP_")]
    sbp_df = ai_attrs[sbpc].apply(pd.to_numeric, errors="coerce").fillna(0).astype(float)
    sbp_tot = sbp_df.sum(axis=1).values
    sbp_log = sbp_df["SBP_LOGEMENT"].values
    df["plq_aires_n"] = np.bincount(a_pi, minlength=n)
    df["plq_aires_sbp_m2"] = np.bincount(a_pi, weights=sbp_tot[a_li] * a_a / aarea[a_li], minlength=n).round(0)
    df["plq_aires_sbp_logement_m2"] = np.bincount(a_pi, weights=sbp_log[a_li] * a_a / aarea[a_li], minlength=n).round(0)

    # --- PUS, protections
    ov("pus", lambda r: re.sub(r"\s+", " ", f"PUS {s(r.NO_PLAN)} {s(r.LIEU)}").strip(), "pus_plan", fmt="{l} ({p:.0f}%)")
    df["pus"] = df["pus_plan"] != ""
    ov("polluted", lambda r: f"{s(r.NO_OFFICIEL)} {s(r.NOM)} [{s(r.TYPE_SITE)}]", "polluted_site", fmt="{l} ({p:.0f}%)")
    ov("milsites", lambda r: f"{s(r.get('katasternummer'))} {s(r.get('standorttyp_fr'))} [{s(r.get('statusaltlv_fr'))}]",
       "polluted_site_military", fmt="{l} ({p:.0f}%)")
    ov("gravel", lambda r: f"{s(r.NO_PLAN)} ({s(r.COMMUNE)}, {s(r.STATUT_JUR)}, {s(r.LIEN_PLAN)})", "gravel_extraction_plan",
       fmt="{l} ({p:.0f}%)")
    gw_pi, gw_li, gw_g, *_ = ov("gwz", lambda r: f"{s(r.TYPE_ZONE).replace('Zone de protection ', '')} {s(r.NOM_PUITS) or s(r.NOM_ZONE)}",
                                "groundwater_protection_zone", fmt="{l} ({p:.0f}%)")
    ov("freserve", lambda r: f"{s(r.LIEU)} [{s(r.TYPE_RES_FORET) or s(r.TYPE_PROTECTION)}]", "forest_reserve", fmt="{l} ({p:.0f}%)")
    ps_attrs = data["ps"][0]
    ps_pi, ps_li, ps_g, ps_a, psmain, *_ = ov("ps", lambda r: f"PS {s(r.NO_PLAN)} {s(r.TITRE_DU_PLAN)}", "plan_de_site")
    # join key for ge_rules/plans_de_site.json: RDPPF_PS.NO_PLAN as string, ';'-separated by decreasing share
    psid = collections.defaultdict(lambda: collections.defaultdict(float))
    for p, l, a in zip(ps_pi, ps_li, ps_a):
        psid[p][s(ps_attrs.NO_PLAN.iloc[l]).split(".")[0]] += a
    df["plan_de_site_ids"] = [";".join(k for k, v in sorted(psid[i].items(), key=lambda x: -x[1])
                                       if 100 * v / max(parea[i], 1e-9) >= LIST_MIN_PCT) if i in psid else ""
                              for i in range(n)]
    df["plan_de_site_main_id"] = [x.split(";")[0] for x in df.plan_de_site_ids]
    zpp_pi, zpp_li, zpp_g, zpp_a, *_ = ov("zp", lambda r: f"ZP {s(r.TITRE_DU_PLAN) or s(r.LIEU)}", "zone_protegee")
    pn_pi, pn_li, pn_g, *_ = ov("pnp", lambda r: f"{s(r.NOM_ZONE) or s(r.TITRE_DU_PLAN)}", "protection_rives_pnp")
    # LPRLac art. 3: floor area <= 20 % of the zone-5 land inside the lake-shore perimeter
    lac = np.array(["rives du lac" in s(data["pnp"][0].NOM_ZONE.iloc[l]).lower() for l in pn_li], dtype=bool)
    z5m = np.array([s(zp_attrs.ABRV_ZONE.iloc[l]) == "5" for l in z_li], dtype=bool)
    lac_z5 = safe(shapely.intersection, nz(union_by(n, pn_pi[lac], pn_g[lac])), nz(union_by(n, z_pi[z5m], z_g[z5m])))
    _lz = shapely.area(lac_z5)
    df["lake_shore_cap_m2"] = np.where(_lz >= 0.01 * parea, 0.2 * _lz, 0).round(0)
    rs_pi, rs_li, rs_g, rs_a, *_ = ov("rs", lambda r: f"RS {s(r.NO_PLAN)} {s(r.TITRE_DU_PLAN)}", "reglement_special")
    cl_pi, cl_li, cl_g, *_ = ov("classement", lambda r: f"{s(r.NO_CLASSEMENT)} {s(r.NOM)}", "monument_classe", min_pct=0.0,
       fmt="{l} ({p:.0f}%)")
    ov("inventaire", lambda r: f"{s(r.CODE_MSI)} {s(r.NOM)}", "monument_inventaire", min_pct=0.0, fmt="{l} ({p:.0f}%)")
    _, _, _, _, pdm, pdp, _ = ov("progdens", lambda r: f"{s(r.NOM)} [{s(r.TYPE)}]", "sit_prog_dens")
    # densification accrue (LCI 59 al.4): perimeters are only in communal master-plan PDFs; SITG publishes the
    # complement (SIT_PROG_DENS = zone-5 sectors where the canton grants NO art. 59 al.4 derogation / zone change).
    # zone-5 relevant = main primary zone 5, or a dev zone D5 / dev zone whose underlying (ZONE_PREEX) zone is 5
    z5 = (df.zone_main.values == "5") | (df.dev_main.values == "D5") | (df.dev_underlying.values == "5")
    pdm = pdm.astype(str)
    insec = pdp >= 50
    dflag = np.where(z5, "unknown_not_in_SITG", "n/a")
    dflag = np.where(insec & (np.char.find(pdm, "Pas de dérogations") >= 0), "no_derogation_sector", dflag)
    dflag = np.where(insec & (np.char.find(pdm, "Modification de Zone") >= 0), "zone_change_pending", dflag)
    df["densif_accrue"] = dflag

    # --- unbuildable surfaces
    pieces = {}
    for key, col in (("forest", "forest_m2"), ("forest_dist", "forest_distance_band_m2"), ("water", "water_m2"),
                     ("si", "si_cours_eau_m2"), ("si_rpu", "si_plq_m2"), ("align_lroutes", "lroutes_alignment_strip_m2")):
        attrs, G = data[key]
        pi, li, g, a = overlay(P, G)
        u = union_by(n, pi, g)
        df[col] = area_of(u).round(1)
        pieces[key] = u
        print(f"[{time.time()-t0:6.0f}s] overlay {key}: {len(pi)} pieces", flush=True)
    unb = []
    for i in range(n):
        gs = [pieces[k][i] for k in ("forest", "water", "si", "si_rpu") if pieces[k][i] is not None]
        unb.append(0.0 if not gs else (gs[0].area if len(gs) == 1 else safe_union(gs).area))
    df["unbuildable_m2"] = np.round(unb, 1)  # union of forest, water, river setback (SI), PLQ unbuildable
    df["unbuildable_other_m2"] = (df.unbuildable_m2 - np.maximum(df.forest_m2, 0)).clip(lower=0).round(1)
    df["unbuildable_pct"] = (100 * df.unbuildable_m2 / np.maximum(parea, 1e-9)).round(2)
    pi, li, ln = line_overlay(P, data["align_rpu"][1])
    df["plq_alignment_len_m"] = np.bincount(pi, weights=ln, minlength=n).round(1)
    pi, li, ln = line_overlay(P, data["limite_foret"][1])
    df["static_forest_limit_len_m"] = np.bincount(pi, weights=ln, minlength=n).round(1)
    pi, li, ln = line_overlay(P, data["nsbl_line"][1])
    df["nat_road_bl_len_m"] = np.bincount(pi, weights=ln, minlength=n).round(1)
    refs = collections.defaultdict(set)
    for p, l in zip(pi, li):
        refs[p].add(s(data["nsbl_line"][0].planning_approval_name.iloc[l]))
    df["nat_road_bl_ref"] = [",".join(sorted(refs[i])) if i in refs else "" for i in range(n)]
    df["nat_road_bl"] = df.nat_road_bl_len_m > 0
    ov("szp", lambda r: f"{s(r['name'])} [{s(r.LegalStatus)}]", "airport_safety_zone_plan", fmt="{l} ({p:.0f}%)")

    # --- noise + hazards
    ov("dsopb", lambda r: f"DS {s(r.DSOPB)}{' (declasse ' + s(r.DECLASSEMENT) + ')' if s(r.DECLASSEMENT) not in ('', '0') else ''}",
       "noise_ds_opb", fmt="{l} ({p:.0f}%)")
    ov("crues", lambda r: f"{s(r.DEGRE)}", "hazard_flood", fmt="{l} ({p:.0f}%)")
    ov("glp", lambda r: f"{s(r.DEGDANGER)}", "hazard_landslide", fmt="{l} ({p:.0f}%)")
    ov("cpb", lambda r: f"{s(r.DEGDANGER)}", "hazard_rockfall", fmt="{l} ({p:.0f}%)")

    # --- buildings
    bl_attrs, BG = data["bldg"]
    w_pi, w_li, w_g, w_a = overlay(P, BG, min_area=1.0)
    barea = shapely.area(BG)
    surel = set(int(e) for e in data["surel"][0].EGID.dropna())
    egrid_arr = df.egrid.values
    cnt = np.zeros(n, int); egids = [[] for _ in range(n)]; hmax = np.full(n, np.nan); fmax = np.full(n, np.nan)
    gfa = np.zeros(n); nofloor = np.zeros(n, int); sur = [[] for _ in range(n)]
    for p, l, a in zip(w_pi, w_li, w_a):
        r = bl_attrs.iloc[l]
        owned = (a >= 0.5 * barea[l]) or s(r.EGRID_CENTROIDE) == egrid_arr[p]
        if pd.notna(r.HAUTEUR):
            hmax[p] = np.nanmax([hmax[p], r.HAUTEUR])
        if pd.notna(r.NIVEAUX_HORSOL):
            fmax[p] = np.nanmax([fmax[p], r.NIVEAUX_HORSOL]); gfa[p] += a * r.NIVEAUX_HORSOL
        else:
            nofloor[p] += 1
        if owned:
            cnt[p] += 1
            e = s(r.EGID)
            if e:
                egids[p].append(str(int(float(e))))
                if int(float(e)) in surel:
                    sur[p].append(str(int(float(e))))
    df["bldg_n"] = cnt
    df["bldg_egids"] = [",".join(e) for e in egids]
    df["bldg_footprint_m2"] = np.bincount(w_pi, weights=w_a, minlength=n).round(1)
    df["bldg_height_max_m"] = hmax.round(1)
    df["bldg_floors_max"] = fmax
    df["bldg_gfa_approx_m2"] = gfa.round(0)  # sum(footprint part on parcel x NIVEAUX_HORSOL)
    df["bldg_parts_no_floors"] = nofloor
    df["bldg_surelevable_egids"] = [",".join(e) for e in sur]
    print(f"[{time.time()-t0:6.0f}s] buildings done", flush=True)

    # --- regime by precedence partition: road(DP) > PLQ > dev zone > protected overlay (ZP, PS) > primary zone class
    plq_u = union_by(n, q_pi, q_g)
    dev_u = union_by(n, d_pi, d_g)
    prot_u = union_by(n, np.concatenate([ps_pi, zpp_pi]), np.concatenate([ps_g, zpp_g]))
    A = collections.defaultdict(lambda: np.zeros(n))
    A["plq"] = area_of(plq_u)
    over = nz(plq_u)
    # approved PDZI over DIA/DAM development zones acts like a PLQ (LZIAM art. 4 al.1 let.a)
    ind = np.array([s(zd_attrs.ABRV_ZONE.iloc[l]) in ("DIA", "DAM") for l in d_li], dtype=bool)
    devind_u = union_by(n, d_pi[ind], d_g[ind])
    pdzi_ok = np.array([s(pz_attrs.STATUT_JUR.iloc[l]).lower() == "en vigueur" for l in x_li], dtype=bool)
    pdzi_u = union_by(n, x_pi[pdzi_ok], x_g[pdzi_ok])
    pdzi_dev = safe(shapely.intersection, nz(devind_u), nz(pdzi_u))
    A["pdzi"] = shapely.area(safe(shapely.difference, pdzi_dev, over))
    over = safe(shapely.union, over, pdzi_dev)
    dev_rest = safe(shapely.difference, nz(dev_u), over)
    A["dev"] = shapely.area(dev_rest)
    over = safe(shapely.union, over, nz(dev_u))
    A["prot"] += shapely.area(safe(shapely.difference, nz(prot_u), over))
    over = safe(shapely.union, over, nz(prot_u))
    rest = shapely.area(safe(shapely.difference, z_g, over[z_pi]))
    cls = np.array([ZCLASS.get(s(zp_attrs.ABRV_ZONE.iloc[l]), "nb") for l in z_li])
    for c in set(cls):
        m = cls == c
        A[c] += np.bincount(z_pi[m], weights=rest[m], minlength=n)
    classes = list(A.keys())
    M = np.vstack([A[c] for c in classes])
    covered = M.sum(axis=0)
    best = M.argmax(axis=0)
    share = np.where(covered > 0, M.max(axis=0) / np.maximum(covered, 1e-9), 0)
    regime, detail = [], []
    for i in range(n):
        d = sorted(((classes[k], M[k, i]) for k in range(len(classes)) if M[k, i] >= MIN_PIECE), key=lambda x: -x[1])
        detail.append("; ".join(f"{c} {100*a/max(covered[i],1e-9):.0f}%" for c, a in d))
        if df.type_propri.iat[i] in ROADTYPES:
            regime.append("road_or_domain_public")
        elif not np.isnan(dab_sum[i]):
            regime.append("plq_dab")  # parcel listed in an adopted PLQ rights table: exact figure
        elif covered[i] <= 0:
            regime.append("no_zone")
        elif share[i] < DOMINANT:
            regime.append("mixed")
        else:
            c = classes[best[i]]
            if c == "plq":
                regime.append("plq_dab" if not np.isnan(dab_sum[i]) else "plq_no_dab")
            else:
                regime.append(CLASS2REGIME[c])
    df["regime"] = regime
    df["regime_detail"] = detail
    df["regime_share_pct"] = (100 * share).round(1)

    # --- buildability + plain-language notice (uses ge_rules: parcel_sectors.csv, plans_de_site.json, pdzi.json)
    geo_stats = buildability(df, n, parea, rules, data, A, dict(
        P=P, pieces=pieces, plq_u=plq_u, dev_u=dev_u, pdzi_dev=pdzi_dev, q=(q_pi, q_li, q_g), aires=(a_pi, a_li, a_g),
        z=(z_pi, z_li, z_g), d=(d_pi, d_li, d_g), ps=(ps_pi, ps_li, ps_a, ps_g), rs=(rs_pi, rs_li, rs_a, rs_g),
        pdzi=(x_pi, x_li, x_a, x_g), classe=(cl_pi, cl_g), bldg=(w_pi, w_g),
        gw=(gw_pi[np.array([not s(data["gwz"][0].TYPE_ZONE.iloc[l]).endswith("S3") for l in gw_li], dtype=bool)],
            gw_g[np.array([not s(data["gwz"][0].TYPE_ZONE.iloc[l]).endswith("S3") for l in gw_li], dtype=bool)]), qmain=qmain, zone_names=zone_names, dev_names=dev_names))
    rg = run_regression(df)
    rg.to_csv(os.path.join(OUT, "qa_regression.csv"), index=False)
    print(f"[{time.time()-t0:6.0f}s] regression: {int(rg.ok.sum())}/{len(rg)} pass", flush=True)
    nf, ncount = notice_flag_test(df, dev_names)
    nf.to_csv(os.path.join(OUT, "qa_notice_flags.csv"), index=False)
    print(f"[{time.time()-t0:6.0f}s] notice flag test: {len(nf)} missing mentions", flush=True)
    print(f"[{time.time()-t0:6.0f}s] buildability done", flush=True)

    # --- official per-parcel synthesis (RDPPF_SYNTH_DYN_EXTRACT) for a canton-wide cross-check
    sy = data["synth"][0].drop_duplicates("EGRID").set_index("EGRID")
    df["oereb_synth_zone_prim"] = df.egrid.map(sy.ID73_ZONES_AFFECT_PRIM).fillna("")
    df["oereb_synth_zone_superp"] = df.egrid.map(sy.ID73_ZONES_AFFECT_SUPERP).fillna("")
    df["oereb_synth_plq"] = df.egrid.map(sy.ID73_PLQ).fillna("")
    df["oereb_synth_ds_opb"] = df.egrid.map(sy.ID145_DSOPB).fillna("")

    def synth_main(t):
        m = re.findall(r"([0-9A-Za-z]+) \((\d+(?:[.,]\d+)?)\s*%\)", t or "")
        return max(m, key=lambda x: float(x[1].replace(",", ".")))[0] if m else ""
    df["oereb_synth_zone_main"] = df.oereb_synth_zone_prim.map(synth_main)
    df["synth_agrees"] = (df.oereb_synth_zone_main == df.zone_main) | ((df.oereb_synth_zone_main == "") & (df.zone_main == ""))

    # --- write
    df.to_csv(os.path.join(OUT, "parcels.csv"), index=False)
    df.to_parquet(os.path.join(OUT, "parcels.parquet"), index=False)
    os.makedirs(os.path.join(GENEVA, "data"), exist_ok=True)
    df.to_parquet(os.path.join(GENEVA, "data", "parcels.parquet"), index=False)
    gdf = gpd.GeoDataFrame(df.copy(), geometry=gpd.GeoSeries(P, crs=2056))
    for c in gdf.columns:
        if gdf[c].dtype == bool:
            gdf[c] = gdf[c].astype(int)
    gdf.to_file(os.path.join(OUT, "parcels.gpkg"), layer="parcels", driver="GPKG", engine="pyogrio")
    print(f"[{time.time()-t0:6.0f}s] written parcels.*", flush=True)

    # --- QA
    nz_ = df[df.zone_count == 0]
    nz_.assign(reason=np.where(nz_.type_propri.isin(ROADTYPES), "public road / domain (no zone drawn)",
                               "zone plan gap (check)"))[
        ["egrid", "commune", "no_parcelle", "type_propri", "area_geom_m2", "oereb_synth_zone_prim", "reason"]
    ].to_csv(os.path.join(OUT, "qa_no_zone.csv"), index=False)
    mm = df[df.zone_sum_mismatch_gt2pct & (df.zone_count > 0)]
    mm[["egrid", "commune", "no_parcelle", "type_propri", "area_geom_m2", "zone_sum_m2", "zone_sum_pct", "zones_prim"]] \
        .to_csv(os.path.join(OUT, "qa_zone_mismatch.csv"), index=False)
    dis = df[~df.synth_agrees]
    dis[["egrid", "commune", "no_parcelle", "type_propri", "zones_prim", "oereb_synth_zone_prim"]] \
        .to_csv(os.path.join(OUT, "qa_synth_disagree.csv"), index=False)
    pd.crosstab(df.commune, df.regime, margins=True).to_csv(os.path.join(OUT, "by_commune.csv"))
    changes = {}
    if prev is not None:
        old = df.egrid.map(prev.regime).fillna("(new)")
        ch = df[old.values != df.regime.values].assign(regime_prev=old[old.values != df.regime.values])
        ch[["egrid", "commune", "no_parcelle", "regime_prev", "regime", "regime_detail"]].to_csv(
            os.path.join(OUT, "qa_regime_changes.csv"), index=False)
        changes = dict(n=int(len(ch)), transitions={f"{a} -> {b}": int(v) for (a, b), v in
                                                     ch.groupby(["regime_prev", "regime"]).size().items()})
        if "buildability" in prev.columns:
            ob = df.egrid.map(prev.buildability).fillna("(new)")
            m = ob.values != df.buildability.values
            bc = df[m].assign(buildability_prev=ob[m])
            bc[["egrid", "commune", "no_parcelle", "buildability_prev", "buildability", "notice_en"]].to_csv(
                os.path.join(OUT, "qa_buildability_changes.csv"), index=False)
            changes["buildability_prev_counts"] = prev.buildability.value_counts().to_dict()
            changes["buildability_changed"] = int(m.sum())
            if "buildable_m2" in prev.columns:
                ob2 = df.egrid.map(prev.buildable_m2).astype(float)
                d2 = (df.buildable_m2 - ob2).abs()
                big = d2 > 0.1 * np.maximum(ob2, df.buildable_m2).clip(lower=1)
                big &= d2 >= 5
                changes["buildable_m2_changed_gt10pct"] = int(big.sum())
                changes["buildable_m2_total_prev_vs_now"] = [round(float(ob2.sum())), round(float(df.buildable_m2.sum()))]
            changes["buildability_transitions"] = {f"{a} -> {b}": int(v) for (a, b), v in
                                                   bc.groupby(["buildability_prev", "buildability"]).size().items()}
    qa = dict(
        parcels_in_canton=n_cad, rows=int(len(df)), coverage_pct=round(100 * len(df) / n_cad, 3),
        unique_egrid=int(df.egrid.nunique()), communes=int(df.commune.nunique()),
        regime_counts=df.regime.value_counts().to_dict(),
        no_zone=int(len(nz_)), no_zone_by_type=nz_.type_propri.value_counts().to_dict(),
        zone_sum_mismatch_gt2pct=int(len(mm)), zone_sum_mismatch_by_type=mm.type_propri.value_counts().to_dict(),
        zone_sum_mismatch_nonroad=int((~mm.type_propri.isin(ROADTYPES)).sum()),
        zone_sum_pct_median=float(df.loc[df.zone_count > 0, "zone_sum_pct"].median()),
        synth_main_zone_agreement_pct=round(100 * df.synth_agrees.mean(), 3), synth_disagree=int(len(dis)),
        dab_parcels=int(df.dab_m2.notna().sum()), runtime_s=round(time.time() - t0),
        regime_changes_vs_previous_build=changes,
        buildability=df.buildability.value_counts().to_dict(), rules_files=rules.get("mtimes"),
        densif_accrue=df.densif_accrue.value_counts().to_dict(),
        pdzi_parcels=int((df.pdzi_pct > 0).sum()), nat_road_bl_parcels=int(df.nat_road_bl.sum()),
        airport_szp_parcels=int((df.airport_safety_zone_plan != "").sum()),
        static_forest_limit_parcels=int((df.static_forest_limit_len_m > 0).sum()),
        zone_remark_parcels=int(((df.zones_prim_remarks != "") | (df.zones_dev_remarks != "")).sum()),
        zone_remark_limit=df.zone_remark_limit[df.zone_remark_limit != ""].value_counts().to_dict(),
        notice_flag_test=dict(missing_mentions=int(len(nf)), parcels_with_flag=dict(ncount)),
        regression=dict(passed=int(rg.ok.sum()), total=int(len(rg)), failed=rg[~rg.ok].to_dict("records")),
        plan_rows_geometry=geo_stats,
        new_overlays=dict(polluted=int((df.polluted_site != "").sum()), gravel=int((df.gravel_extraction_plan != "").sum()),
                          forest_reserve=int((df.forest_reserve != "").sum()),
                          lake_shore_cap=int((df.lake_shore_cap_m2 > 0).sum())),
    )
    # national-road building lines: verify positives against the OEREB extract
    if not args.no_oereb:
        rnd2 = random.Random(7)
        pos = list(df.index[df.nat_road_bl])
        chk = []
        for i in rnd2.sample(pos, min(20, len(pos))):
            try:
                oz, _ = oereb_zones(df.egrid.iat[i])
                chk.append(dict(egrid=df.egrid.iat[i], commune=df.commune.iat[i], no_parcelle=df.no_parcelle.iat[i],
                                len_m=df.nat_road_bl_len_m.iat[i], oereb=("ch.BaulinienNationalstrassen" in oz)))
            except Exception as e:
                chk.append(dict(egrid=df.egrid.iat[i], error=str(e)[:100]))
        ck = pd.DataFrame(chk)
        ck.to_csv(os.path.join(OUT, "oereb_nsbl_check.csv"), index=False)
        qa["nat_road_bl_oereb_check"] = dict(n=int(len(ck)), confirmed=int(ck.get("oereb", pd.Series(dtype=bool)).fillna(False).sum()))

    # --- OEREB extract comparison on a regime-stratified sample
    if not args.no_oereb:
        rnd = random.Random(42)
        by = {r: list(g.index) for r, g in df.groupby("regime")}
        sample = []
        for r, k in (("dev_zone_pdzi", 5), ("industrial_IA", 4)):   # >= 8 PDZI / industrial parcels
            for _ in range(min(k, len(by.get(r, [])))):
                sample.append(by[r].pop(rnd.randrange(len(by[r]))))
        # plus positives of the federal / forest-limit flags so those themes are actually exercised
        for mask in (df.nat_road_bl, df.airport_safety_zone_plan != "", df.static_forest_limit_len_m > 0):
            cand = [i for i in df.index[mask] if i not in sample]
            for i in rnd.sample(cand, min(3, len(cand))):
                sample.append(i)
                for v in by.values():
                    if i in v:
                        v.remove(i)
        regs = sorted(by)
        while len(sample) < args.oereb_n and any(by.values()):
            for r in regs:
                if by[r] and len(sample) < args.oereb_n:
                    sample.append(by[r].pop(rnd.randrange(len(by[r]))))
        rows = []
        for i in sample:
            r = df.loc[i]
            try:
                oz, larea = oereb_zones(r.egrid)
                oshare = collections.defaultdict(float)  # one zone can appear as several entries (zone plans)
                for t_, p_ in oz.get("ch.GE.Zonedaffectationprimaire", []):
                    oshare[norm(t_)] += p_
                myshare = {norm(zone_names.get(z.split(" ")[0], z.split(" ")[0])): float(re.search(r"\(([\d.]+)%\)", z).group(1))
                           for z in r.zones_prim.split("; ") if z}
                ofz = {k for k, v in oshare.items() if v >= 2}
                share_diff = max([abs(oshare.get(k, 0) - myshare.get(k, 0)) for k in set(oshare) | set(myshare)] or [0])
                ofd = {norm(t) for t, p in oz.get("ch.GE.Zonedaffectationsuperpose", []) if p >= 2}
                oplq = any(p >= 2 for _, p in oz.get("ch.GE.Planlocalisdequartier", []))
                opdzi = any(p >= 2 for k, v in oz.items() if "Plandirecteurdeszones" in (k or "") for _, p in v)
                onsbl = "ch.BaulinienNationalstrassen" in oz
                oszp = "ch.Sicherheitszonenplan" in oz
                osfl = "ch.StatischeWaldgrenzen" in oz
                mine = {norm(zone_names.get(z.split(" ")[0], z.split(" ")[0]))
                        for z in r.zones_prim.split("; ") if z and float(re.search(r"\(([\d.]+)%\)", z).group(1)) >= 2}
                mined = {norm(dev_names.get(z.split('/')[0], z)) for z in r.zones_dev.split("; ")
                         if z and float(re.search(r"\(([\d.]+)%\)", z).group(1)) >= 2}
                rows.append(dict(egrid=r.egrid, commune=r.commune, no_parcelle=r.no_parcelle, regime=r.regime,
                                 mine_prim="|".join(sorted(mine)), oereb_prim="|".join(sorted(ofz)),
                                 prim_match=mine == ofz, prim_share_maxdiff_pct=round(share_diff, 2), mine_dev="|".join(sorted(mined)),
                                 oereb_dev="|".join(sorted(ofd)), dev_match=mined == ofd,
                                 plq_mine=r.plq_pct >= 2, plq_oereb=oplq, plq_match=(r.plq_pct >= 2) == oplq,
                                 pdzi_mine=r.pdzi_pct >= 2, pdzi_oereb=opdzi, pdzi_match=(r.pdzi_pct >= 2) == opdzi,
                                 nsbl_mine=bool(r.nat_road_bl), nsbl_oereb=onsbl, nsbl_match=bool(r.nat_road_bl) == onsbl,
                                 szp_mine=r.airport_safety_zone_plan != "", szp_oereb=oszp,
                                 szp_match=(r.airport_safety_zone_plan != "") == oszp,
                                 sfl_mine=r.static_forest_limit_len_m > 0, sfl_oereb=osfl,
                                 sfl_match=(r.static_forest_limit_len_m > 0) == osfl,
                                 area_cad=r.area_cadastre_m2, area_oereb=larea))
            except Exception as e:
                rows.append(dict(egrid=r.egrid, commune=r.commune, regime=r.regime, error=str(e)[:200]))
            print("oereb", rows[-1], flush=True)
        oc = pd.DataFrame(rows)
        oc.to_csv(os.path.join(OUT, "oereb_check.csv"), index=False)
        ok = oc[oc.get("error").isna()] if "error" in oc else oc
        qa["oereb_sample"] = dict(n=int(len(oc)), fetched=int(len(ok)),
                                  primary_zone_match=int(ok.prim_match.sum()), dev_zone_match=int(ok.dev_match.sum()),
                                  plq_match=int(ok.plq_match.sum()), pdzi_match=int(ok.pdzi_match.sum()),
                                  nat_road_bl_match=int(ok.nsbl_match.sum()), airport_szp_match=int(ok.szp_match.sum()),
                                  static_forest_limit_match=int(ok.sfl_match.sum()),
                                  regimes=ok.regime.value_counts().to_dict(),
                                  prim_share_maxdiff_pct_max=float(ok.prim_share_maxdiff_pct.max()))
    json.dump(qa, open(os.path.join(OUT, "qa.json"), "w"), indent=1, ensure_ascii=False, default=str)
    print(json.dumps(qa, indent=1, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
