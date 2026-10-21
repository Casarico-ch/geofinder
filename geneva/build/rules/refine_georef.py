"""Refine a plan georeference by aligning the drawn parcel lines of the plan with the cadastral parcel boundaries.
usage: refine_georef.py KEY [--page N] [--max 15] [--dark 150] [--write]
Model: homography defined by 4 anchor points (corners of the perimeter bbox) in LV95; each anchor may move up to --max m.
Score: mean of a blurred dark-line mask sampled along the projected cadastral boundaries (coarse-to-fine blur 10/5/2.5 m).
With --write the refined M replaces georef/KEY_p<page>.json (original kept as KEY_p<page>_pre.json)."""
import sys, os, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
from PIL import ImageFilter
args = sys.argv[1:]; key = args[0]
def opt(name, d):
    return type(d)(args[args.index(name) + 1]) if name in args else d
page = opt('--page', 1); MAXD = opt('--max', 15.0); DARK = opt('--dark', 150)
gf = f'{GE}/georef/{key}_p{page}.json'; g = json.load(open(gf)); M0 = np.array(g['M']); pdf = g['pdf']
gj = json.load(open(f"{GE}/raw/{g['layer']}.geojson")); k0, ind = (key.split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties'].get('INDICE') == ind)]).buffer(0)
minx, miny, maxx, maxy = per.buffer(40).bounds
anchors = np.array([(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)])
def H_from(src_page, dst_lv):
    A = []
    for (u, v), (X, Y) in zip(src_page, dst_lv):
        A.append([u, v, 1, 0, 0, 0, -X * u, -X * v, -X]); A.append([0, 0, 0, u, v, 1, -Y * u, -Y * v, -Y])
    _, _, Vt = np.linalg.svd(np.array(A)); H = Vt[-1].reshape(3, 3); return H / H[2, 2]
anc_page = np.array([to_page(M0, x, y) for x, y in anchors])
# render
W, Hh = page_size(pdf, page)
x0, x1 = max(0, anc_page[:, 0].min() - 50), min(W, anc_page[:, 0].max() + 50); y0, y1 = max(0, anc_page[:, 1].min() - 50), min(Hh, anc_page[:, 1].max() + 50)
scale = g.get('scale_m_per_pt') or 0.35
if scale > 1.5 or scale < 0.05: scale = 0.35
dpi = int(max(30, min(150, 3 * 72 * scale))); s = dpi / 72
fn = f'{GE}/tmp/rg_{key}'
subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-x', str(int(x0 * s)), '-y', str(int(y0 * s)), '-W', str(int((x1 - x0) * s)), '-H', str(int((y1 - y0) * s)), '-gray', '-png', '-singlefile', pdf, fn], check=True)
img = np.asarray(Image.open(fn + '.png')).astype(float); os.remove(fn + '.png')
px_per_m = s / scale
m0 = Image.fromarray(((img < DARK) * 255).astype('uint8'))
k = int(max(3, 1.5 * px_per_m)) | 1
opened = m0.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))
mask = Image.fromarray(((np.asarray(m0) > 0) & ~(np.asarray(opened) > 0)).astype('uint8') * 255)   # thin lines only
if '--perimeter' in args:   # thick dark perimeter line: keep pixels surviving a small opening
    k2 = max(3, int(0.6 * px_per_m)) | 1
    mask = m0.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
blurs = {r: np.asarray(mask.filter(ImageFilter.GaussianBlur(max(1, r * px_per_m)))).astype(float) / 255 for r in (10, 5, 2.5)}
# cadastral boundary sample points (every 1 m)
pars = parcels_in_bbox(minx, miny, maxx, maxy)
pts = []
if '--perimeter' in args:
    pars = [dict(geom=per)]
for p in pars:
    geo = p['geom']
    for poly in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo]):
        ring = poly.exterior; n = max(2, int(ring.length))
        for i in range(n):
            q = ring.interpolate(i / n, normalized=True); pts.append((q.x, q.y))
P = np.array(pts); P1 = np.c_[P, np.ones(len(P))]
def score(Hinv, B):
    r = P1 @ Hinv.T; u = r[:, 0] / r[:, 2]; v = r[:, 1] / r[:, 2]
    cx = (u - x0) * s; cy = (v - y0) * s
    ok = (cx >= 0) & (cy >= 0) & (cx < B.shape[1] - 1) & (cy < B.shape[0] - 1)
    if ok.mean() < 0.5: return 0
    return B[cy[ok].astype(int), cx[ok].astype(int)].mean()
def Hinv_of(disp):
    dst = anchors + disp.reshape(4, 2)
    H = H_from(anc_page, dst)          # page -> LV95
    return np.linalg.inv(H), H
disp = np.zeros(8)
s0 = score(Hinv_of(disp)[0], blurs[2.5])
for r, step0 in ((10, 4.0), (5, 2.0), (2.5, 1.0)):
    B = blurs[r]; best = score(Hinv_of(disp)[0], B); step = step0
    while step >= step0 / 4:
        improved = False
        for i in range(8):
            for sg in (1, -1):
                d2 = disp.copy(); d2[i] += sg * step
                if np.abs(d2).max() > MAXD: continue
                v = score(Hinv_of(d2)[0], B)
                if v > best + 1e-5: best, disp, improved = v, d2, True
        if not improved: step /= 2
s1 = score(Hinv_of(disp)[0], blurs[2.5])
Hn = Hinv_of(disp)[1]
print(key, 'line score %.3f -> %.3f' % (s0, s1), 'anchor shifts m', np.round(np.linalg.norm(disp.reshape(4, 2), axis=1), 1).tolist())
if '--write' in args and s1 > s0 * 1.03:
    pre = gf[:-5] + '_pre.json'
    if not os.path.exists(pre): json.dump(g, open(pre, 'w'), indent=1)
    g2 = dict(g, M=Hn.tolist(), refined=dict(method='line alignment to cadastre (refine_georef.py)', score_before=round(s0, 3), score_after=round(s1, 3),
                                             anchor_shift_m=np.round(np.linalg.norm(disp.reshape(4, 2), axis=1), 1).tolist()))
    json.dump(g2, open(gf, 'w'), indent=1); print('written', gf)
