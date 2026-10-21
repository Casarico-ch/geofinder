import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
gfile = sys.argv[1]; out = sys.argv[2]; target_px = int(sys.argv[3]) if len(sys.argv) > 3 else 1800
draw_parcels = len(sys.argv) > 4 and sys.argv[4] == 'parcels'
g = json.load(open(gfile)); M = g['M']
gj = json.load(open(f"{GE}/raw/{g['layer']}.geojson"))
k0, ind = (g['key'].split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)])
minx, miny, maxx, maxy = per.buffer(40).bounds
pts = [to_page(M, x, y) for x, y in ((minx, miny), (minx, maxy), (maxx, miny), (maxx, maxy))]
x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts); y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
W, H = page_size(g['pdf'], g['page'])
x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
dpi = max(30, min(300, int(target_px / max(x1 - x0, y1 - y0) * 72)))
s = dpi / 72
fn = out[:-4]
subprocess.run(['pdftoppm', '-f', str(g['page']), '-l', str(g['page']), '-r', str(dpi), '-x', str(int(x0 * s)), '-y', str(int(y0 * s)),
                '-W', str(int((x1 - x0) * s)), '-H', str(int((y1 - y0) * s)), '-png', '-singlefile', g['pdf'], fn], check=True)
im = Image.open(out).convert('RGB'); d = ImageDraw.Draw(im)
def px(X, Y):
    u, v = to_page(M, X, Y); return ((u - x0) * s, (v - y0) * s)
for poly in (per.geoms if per.geom_type == 'MultiPolygon' else [per]):
    d.line([px(*c) for c in poly.exterior.coords], fill=(0, 0, 255), width=3)
if draw_parcels:
    for p in parcels_in_bbox(*per.bounds):
        gg = p['geom']
        if not gg.intersects(per): continue
        for poly in (gg.geoms if gg.geom_type == 'MultiPolygon' else [gg]):
            d.line([px(*c) for c in poly.exterior.coords], fill=(255, 0, 255), width=1)
im.save(out)
json.dump(dict(gfile=gfile, x0=x0, y0=y0, dpi=dpi), open(out[:-4] + '.view.json', 'w'))
print(out, im.size, 'dpi', dpi)
