"""draw_sectors.py sectors.geojson view.json out.png  -- outline sector polygons (with names) on a georeferenced view"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
gj, vf, out = sys.argv[1:4]
v = json.load(open(vf)); g = json.load(open(v['gfile'])); s = v['dpi'] / 72; M = g['M']
im = Image.open(vf[:-10] + '.png').convert('RGB'); d = ImageDraw.Draw(im, 'RGBA')
pal = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240), (240, 50, 230), (210, 245, 60), (0, 128, 128)]
def px(X, Y):
    u, w = to_page(M, X, Y); return ((u - v['x0']) * s, (w - v['y0']) * s)
names = []
for f in json.load(open(gj))['features']:
    geo = shape(f['geometry']); n = f['properties'].get('sector') or f['properties'].get('label')
    if n not in names: names.append(n)
    c = pal[names.index(n) % len(pal)]
    for p in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo] if geo.geom_type == 'Polygon' else []):
        d.polygon([px(*xy) for xy in p.exterior.coords], fill=c + (60,), outline=c + (255,))
        x, y = px(*p.representative_point().coords[0]); d.text((x, y), str(n)[:12], fill=(0, 0, 0, 255))
im.save(out); print(out, names)
