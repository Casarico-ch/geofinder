"""Cadastral above-ground buildings (SITG CAD_BATIMENT_HORSOL, LV95) from ge_all/raw/bldg pages; cached as a pickle."""
import json, glob, os, pickle
from shapely.geometry import Polygon, MultiPolygon
from shapely.strtree import STRtree
SP = __import__('os').environ.get('GENEVA_WORK', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', 'work'))
CACHE = SP + '/ge_rules/tmp/bldg.pkl'
_B = None
def load():
    global _B
    if _B is not None: return _B
    if os.path.exists(CACHE):
        _B = pickle.load(open(CACHE, 'rb'))
    else:
        recs = []
        for fn in sorted(glob.glob(SP + '/ge_all/raw/bldg/p*.json')):
            for f in json.load(open(fn))['features']:
                rings = (f.get('geometry') or {}).get('rings')
                if not rings: continue
                try:
                    g = Polygon(rings[0], rings[1:]).buffer(0)
                except Exception: continue
                a = f['attributes']; recs.append((a.get('EGID'), a.get('EGRID_CENTROIDE'), a.get('DESTINATION'), a.get('HAUTEUR'), g))
        _B = recs
        pickle.dump(recs, open(CACHE, 'wb'))
    return _B
_T = None
def tree():
    global _T
    if _T is None: _T = STRtree([r[4] for r in load()])
    return _T
def in_geom(geo, min_frac=0.5):
    """buildings with >= min_frac of their footprint inside geo"""
    B = load(); out = []
    for i in tree().query(geo):
        r = B[i]
        if r[4].area > 0 and r[4].intersection(geo).area / r[4].area >= min_frac: out.append(r)
    return out
