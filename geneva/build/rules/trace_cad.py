"""Sectors traced directly on a cadmap image (pixel coords) -> LV95. spec: {"layer","key","minx","maxy","sc","sectors":{...},"rest","note","confidence"}"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape, mapping, Polygon
from shapely.ops import unary_union
sp = json.load(open(sys.argv[1]))
gj = json.load(open(f"{GE}/raw/{sp['layer']}.geojson")); k0, ind = (sp['key'].split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)])
lv = lambda px, py: (sp['minx'] + px / sp['sc'], sp['maxy'] - py / sp['sc'])
feats, used = [], []
for name, polys in sp['sectors'].items():
    geo = unary_union([Polygon([lv(*p) for p in poly]).buffer(0) for poly in polys]).intersection(per)
    for u in used: geo = geo.difference(u)
    used.append(geo); feats.append(dict(type='Feature', properties=dict(sector=name), geometry=mapping(geo)))
if sp.get('rest'):
    feats.append(dict(type='Feature', properties=dict(sector=sp['rest']), geometry=mapping(per.difference(unary_union(used)))))
json.dump(dict(type='FeatureCollection', properties=dict(plan=sp['key'], method='manual', confidence=sp.get('confidence', 'low'), note=sp.get('note', '')), features=feats),
          open(f"{GE}/georef/sectors_{sp['key']}.geojson", 'w'))
print([(f['properties']['sector'], round(shape(f['geometry']).area)) for f in feats], round(per.area))
