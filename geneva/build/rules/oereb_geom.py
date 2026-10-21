"""oereb_geom.py extract.json subcode -> list of shapely polygons of the restriction (ÖREB GE JSON layout)"""
import json, sys
from shapely.geometry import Polygon
from shapely.ops import unary_union
def rings(o):
    pts = [(c['c1'], c['c2']) for c in o['polyline']['Items']] if 'polyline' in o else []
    return pts
def geoms(d, subcode):
    out = []
    for r in d['Item']['RealEstate']['RestrictionOnLandownership']:
        if r['Theme'].get('SubCode') != subcode: continue
        for g in r.get('Geometry') or []:
            it = g.get('Item') or {}
            ext = it.get('exterior') or []
            for e in ext:
                p = rings(e)
                if len(p) >= 3:
                    holes = [rings(i) for i in (it.get('interior') or []) if len(rings(i)) >= 3]
                    out.append(Polygon(p, holes).buffer(0))
    return out
if __name__ == '__main__':
    d = json.load(open(sys.argv[1])); gs = geoms(d, sys.argv[2]); print(len(gs), [round(g.area) for g in gs])
