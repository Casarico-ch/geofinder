"""Render cadastral parcels of a plan perimeter with numbers and an LV95 grid. usage: cadmap.py LAYER KEY out.png [px] [grid_m] [buffer_m]"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
layer, key, out = sys.argv[1:4]; PX = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
gs = float(sys.argv[5]) if len(sys.argv) > 5 else 50; buf = float(sys.argv[6]) if len(sys.argv) > 6 else 60
gj = json.load(open(f'{GE}/raw/{layer}.geojson')); k0, ind = (key.split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)])
minx, miny, maxx, maxy = per.buffer(buf).bounds
sc = PX / max(maxx - minx, maxy - miny); W, H = int((maxx - minx) * sc), int((maxy - miny) * sc)
im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
def p(x, y): return ((x - minx) * sc, (maxy - y) * sc)
for q in parcels_in_bbox(minx, miny, maxx, maxy):
    g = q['geom']
    for poly in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
        d.line([p(*c) for c in poly.exterior.coords], fill=(90, 90, 90), width=1)
    c = g.representative_point(); d.text(p(c.x, c.y), q['no'], fill=(0, 0, 200))
for poly in (per.geoms if per.geom_type == 'MultiPolygon' else [per]):
    d.line([p(*c) for c in poly.exterior.coords], fill=(255, 0, 0), width=3)
import math
x = math.ceil(minx / gs) * gs
while x < maxx:
    d.line([p(x, miny), p(x, maxy)], fill=(0, 170, 0)); d.text((p(x, maxy)[0] + 2, 2), str(int(x))[-4:], fill=(0, 120, 0)); x += gs
y = math.ceil(miny / gs) * gs
while y < maxy:
    d.line([p(minx, y), p(maxx, y)], fill=(0, 170, 0)); d.text((2, p(minx, y)[1] + 2), str(int(y))[-4:], fill=(200, 0, 0)); y += gs
im.save(out); print(out, im.size, 'x', int(minx), int(maxx), 'y', int(miny), int(maxy))
