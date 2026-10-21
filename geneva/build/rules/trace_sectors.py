"""Convert hand-traced sector polygons (pixel coords on a georeferenced view image) to LV95 sector polygons.
spec json: {"view": "georef/vXXXX.view.json", "sectors": {"name": [[[x,y],...],...]}, "rest": "name or null",
            "note": "...", "confidence": "medium"}
output: georef/sectors_<key>.geojson + georef/<key>_traced.png preview"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape, mapping, Polygon
from shapely.ops import unary_union
spec = json.load(open(sys.argv[1])); v = json.load(open(spec['view'])); g = json.load(open(v['gfile']))
M = g['M']; s = v['dpi'] / 72
def lv(px, py): return to_lv95(M, v['x0'] + px / s, v['y0'] + py / s)
gj = json.load(open(f"{GE}/raw/{g['layer']}.geojson"))
k0, ind = (g['key'].split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)])
feats = []; used = []
for name, polys in spec['sectors'].items():
    geo = unary_union([Polygon([lv(*p) for p in poly]).buffer(0) for poly in polys]).intersection(per)
    for u in used: geo = geo.difference(u)
    used.append(geo)
    feats.append(dict(type='Feature', properties=dict(sector=name), geometry=mapping(geo)))
if spec.get('rest'):
    geo = per.difference(unary_union(used)) if used else per
    feats.append(dict(type='Feature', properties=dict(sector=spec['rest']), geometry=mapping(geo)))
out = f"{GE}/georef/sectors_{g['key']}.geojson"
json.dump(dict(type='FeatureCollection', properties=dict(plan=g['key'], method='georef', georef=v['gfile'], confidence=spec.get('confidence', 'medium'), note=spec.get('note', '')), features=feats), open(out, 'w'))
# preview
im = Image.open(spec['view'][:-10] + '.png').convert('RGB'); d = ImageDraw.Draw(im, 'RGBA')
pal = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240), (240, 50, 230), (210, 245, 60), (0, 128, 128)]
def px(X, Y):
    u, w = to_page(M, X, Y); return ((u - v['x0']) * s, (w - v['y0']) * s)
for i, f in enumerate(feats):
    geo = shape(f['geometry'])
    for poly in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo] if geo.geom_type == 'Polygon' else []):
        c = pal[i % len(pal)]
        d.polygon([px(*xy) for xy in poly.exterior.coords], fill=c + (70,), outline=c + (255,))
        cx, cy = px(*poly.representative_point().coords[0]); d.text((cx, cy), f['properties']['sector'], fill=(0, 0, 0, 255))
im.save(f"{GE}/georef/{g['key']}_traced.png")
print(out, [(f['properties']['sector'], round(shape(f['geometry']).area)) for f in feats], 'perimeter', round(per.area))
