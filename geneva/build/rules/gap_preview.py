"""gap_preview.py KEY view.json out.png -- draw build areas (green) and buildings outside them (red) on the view"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
import bldg_lib
from shapely.geometry import shape
from shapely.ops import unary_union
key, vf, out = sys.argv[1:4]
v = json.load(open(vf)); g = json.load(open(v['gfile'])); s = v['dpi'] / 72; M = g['M']
b = unary_union([shape(x['geometry']) for x in json.load(open(f'{GE}/georef/build_areas_{key}.geojson'))['features'] if x['properties']['kind'] == 'build_area'])
im = Image.open(vf[:-10] + '.png').convert('RGB'); d = ImageDraw.Draw(im, 'RGBA')
def px(X, Y):
    u, w = to_page(M, X, Y); return ((u - v['x0']) * s, (w - v['y0']) * s)
for p in (b.geoms if b.geom_type == 'MultiPolygon' else [b]):
    d.polygon([px(*c) for c in p.exterior.coords], fill=(0, 200, 0, 50), outline=(0, 150, 0, 255))
for r in bldg_lib.in_geom(b.buffer(80), 0.5):
    if r[4].area < 20: continue
    col = (255, 0, 0) if r[4].intersection(b).area < 0.5 * r[4].area else (0, 0, 255)
    for p in (r[4].geoms if r[4].geom_type == 'MultiPolygon' else [r[4]]):
        d.polygon([px(*c) for c in p.exterior.coords], fill=col + (120,), outline=col + (255,))
im.save(out); print(out, im.size)
