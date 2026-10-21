"""validate_sheet.py sectors_or_areas.geojson view.json out.png seed egrid[,egrid..]|random5
Contact sheet: for 5 parcels of the plan, crop of the georeferenced plan with the parcel (red) and the traced sector
outlines (blue, labelled) and the parcel's assigned shares, for eye-checking."""
import sys, os, json, random, csv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
gjf, vf, out, seed, which = sys.argv[1:6]
v = json.load(open(vf)); g = json.load(open(v['gfile'])); s = v['dpi'] / 72; M = g['M']
im0 = Image.open(vf[:-10] + '.png').convert('RGB')
F = [(f['properties'].get('sector') or f['properties'].get('label'), shape(f['geometry'])) for f in json.load(open(gjf))['features']]
U = unary_union([x for _, x in F])
def px(X, Y):
    u, w = to_page(M, X, Y); return ((u - v['x0']) * s, (w - v['y0']) * s)
pars = [p for p in parcels_in_bbox(*U.bounds) if p['geom'].intersection(U).area > 0.5 * p['geom'].area and p['geom'].area > 150]
random.seed(int(seed))
if which == 'random5': pick = random.sample(pars, min(5, len(pars)))
else: pick = [p for p in pars if p['egrid'] in which.split(',')]
tiles = []
for p in pick:
    G = p['geom']; minx, miny, maxx, maxy = G.buffer(45).bounds
    a, b = px(minx, maxy), px(maxx, miny); xs = sorted([a[0], b[0]]); ys = sorted([a[1], b[1]])
    crop = im0.crop((int(xs[0]), int(ys[0]), int(xs[1]), int(ys[1]))).copy(); d = ImageDraw.Draw(crop, 'RGBA')
    off = (int(xs[0]), int(ys[0]))
    def q(X, Y):
        x, y = px(X, Y); return (x - off[0], y - off[1])
    for n, x in F:
        for pp in (x.geoms if x.geom_type == 'MultiPolygon' else [x] if x.geom_type == 'Polygon' else []):
            d.line([q(*c) for c in pp.exterior.coords], fill=(0, 60, 255, 255), width=2)
            c = pp.representative_point()
            if c.within(G.buffer(45).envelope): d.text(q(c.x, c.y), str(n)[:14], fill=(0, 60, 255, 255))
    for pp in (G.geoms if G.geom_type == 'MultiPolygon' else [G]):
        d.line([q(*c) for c in pp.exterior.coords], fill=(255, 0, 0, 255), width=3)
    shares = [(n, round(x.intersection(G).area / G.area, 2)) for n, x in F if x.intersects(G) and x.intersection(G).area > 1]
    crop = crop.resize((400, int(400 * crop.size[1] / max(1, crop.size[0])))) if crop.size[0] > 0 else crop
    lab = Image.new('RGB', (400, 40), 'white'); ImageDraw.Draw(lab).text((3, 3), f"{p['no']} {p['egrid']}\n{shares}"[:120], fill=(0, 0, 0))
    t = Image.new('RGB', (400, crop.size[1] + 40), 'white'); t.paste(lab, (0, 0)); t.paste(crop, (0, 40)); tiles.append(t)
H = max(t.size[1] for t in tiles); sheet = Image.new('RGB', (410 * len(tiles), H), 'white')
for i, t in enumerate(tiles): sheet.paste(t, (i * 410, 0))
sheet.save(out); print(out, [(p['no'], p['egrid']) for p in pick])
