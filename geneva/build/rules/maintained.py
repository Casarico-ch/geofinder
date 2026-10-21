"""Map plan-de-site building categories (legend: maintenu / éléments intéressants / intégré / autre / à démolir ...) onto
cadastral buildings (CAD_BATIMENT_HORSOL EGIDs).
usage: maintained.py KEY [--legend 'cat:x0,y0,x1,y1;...'] [--ocr]
  - georeference: georef/<KEY>_p1.json (M, pdf, page)
  - legend swatches: found automatically left of legend labels (text layer, or OCR with --ocr), or given in PDF points
  - each building: pixels inside its footprint (eroded) on a render, after a global translation search (+-10 m),
    classified to the nearest legend swatch (RGB mean + texture)
output: georef/maintained_<KEY>.geojson (EGID, EGRID_CENTROIDE, category, legend_label, dist, confidence) + georef/<KEY>_maint.png"""
import sys, os, json, re, subprocess, csv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
import bldg_lib
from shapely.geometry import shape, mapping, Polygon, box
from shapely.ops import unary_union
from shapely import affinity
Image.MAX_IMAGE_PIXELS = None
key = sys.argv[1]; args = sys.argv[2:]
g = json.load(open(f'{GE}/georef/{key}_p1.json')); M = g['M']; pdf = g['pdf']; page = g['page']
gj = json.load(open(f"{GE}/raw/{g['layer']}.geojson")); k0, ind = (key.split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties'].get('INDICE') == ind)]).buffer(0)

CATS = [('demolish', r"d[ée]mol|alt[ée]rant"), ('interesting', r"int[ée]ress"), ('integrated', r"int[ée]gr"),
        ('maintained', r"maintenu|class[ée]|cat[ée]gorie\s*[ABC]\b"), ('other', r"autres?\s+b[âa]t|autre\s+construction"),
        ('new', r"projet[ée]|nouve")]
def canon(t):
    tl = t.lower()
    if not re.search(r"b[âa]t|construction|ensemble|immeuble", tl): return None
    for c, rx in CATS:
        if re.search(rx, tl): return c
    return None

# ---------------- legend labels
def text_lines():
    x = subprocess.run(['pdftotext', '-f', str(page), '-l', str(page), '-bbox-layout', pdf, '-'], capture_output=True, text=True).stdout
    out = []
    for m in re.finditer(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>', x, re.S):
        words = re.findall(r'>([^<]+)</word>', m.group(5))
        out.append((' '.join(words), *map(float, m.group(1, 2, 3, 4))))
    return out
def ocr_lines():
    W, H = page_size(pdf, page); dpi = int(min(150, (60e6 / (W * H)) ** 0.5 * 72))
    png = f'{GE}/tmp/leg_{key}.png'
    subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-gray', '-png', '-singlefile', pdf, png[:-4]], check=True)
    r = subprocess.run(['tesseract', png, '-', '-l', 'fra', '--psm', '11', 'tsv'], capture_output=True, text=True, env=dict(os.environ, OMP_THREAD_LIMIT='1')).stdout
    rows = [x for x in csv.reader(r.splitlines()[1:], delimiter='\t', quoting=csv.QUOTE_NONE) if len(x) > 11 and x[11].strip()]
    s = 72 / dpi; lines = {}
    for x in rows:
        k2 = (x[2], x[3], x[4]); l, t, w, h = map(int, x[6:10])
        lines.setdefault(k2, []).append((x[11], l * s, t * s, (l + w) * s, (t + h) * s))
    out = []
    for ws in lines.values():
        out.append((' '.join(w[0] for w in ws), min(w[1] for w in ws), min(w[2] for w in ws), max(w[3] for w in ws), max(w[4] for w in ws)))
    os.remove(png)
    return out

def render_region(x0, y0, x1, y1, dpi):
    s = dpi / 72; fn = f'{GE}/tmp/rr_{key}'
    subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-x', str(int(x0 * s)), '-y', str(int(y0 * s)), '-W', str(max(1, int((x1 - x0) * s))),
                    '-H', str(max(1, int((y1 - y0) * s))), '-png', '-singlefile', pdf, fn], check=True)
    a = np.asarray(Image.open(fn + '.png').convert('RGB')).astype(float); os.remove(fn + '.png'); return a

GREY_ONLY = False
def feat(a):
    px = a.reshape(-1, 3); lum = px.mean(axis=1)
    sat = px.max(axis=1) - px.min(axis=1)
    if GREY_ONLY: px = px[sat < 45]; lum = lum[sat < 45]
    if len(px) == 0: return np.array([0., 0, 76.5, 76.5, 76.5])
    ink = lum < 235; dark = lum < 90
    col = px[ink].mean(axis=0) if ink.any() else np.array([255., 255, 255])
    return np.array([100 * ink.mean(), 100 * dark.mean(), *(0.3 * col)])

swatches = []   # (category, label, feature, bbox)
manual = [x for x in args if x.startswith('--legend=')]
if manual:
    for item in manual[0][9:].split(';'):
        c, bb = item.split(':'); x0, y0, x1, y1 = map(float, bb.split(','))
        a = render_region(x0, y0, x1, y1, 150); swatches.append((c, 'manual legend ' + c, feat(a), (x0, y0, x1, y1)))
else:
    lines = text_lines()
    if '--ocr' in args or sum(1 for l in lines if canon(l[0])) == 0: lines = ocr_lines()
    cand = [(t, x0, y0, x1, y1) for t, x0, y0, x1, y1 in lines if canon(t) and canon(t) != 'new' and len(t) <= 70]
    def aligned(l):   # legend entries come in a block: another candidate label with the same left edge close by
        return any(o is not l and abs(o[1] - l[1]) < 4 and 0 < abs(o[2] - l[2]) < 60 for o in cand)
    cand = [l for l in cand if aligned(l)] or cand
    for t, x0, y0, x1, y1 in cand:
        c = canon(t)
        white = (c, t, np.array([0., 0, 76.5, 76.5, 76.5]), (x0 - 30, y0, x0 - 2, y1))
        hgt = y1 - y0
        sx0 = max(0, x0 - 260); a = render_region(sx0, y0 - 0.3 * hgt, x0 - 1, y1 + 0.3 * hgt, 150)
        if a.size == 0: continue
        nonwhite = (a.mean(axis=2) < 235).mean(axis=0)
        cols = np.where(nonwhite > 0.12)[0]
        if len(cols) < 4:
            if c == 'other': swatches.append(white)
            continue
        # rightmost contiguous run of non-white columns = swatch
        runs = np.split(cols, np.where(np.diff(cols) > 15)[0] + 1)
        run = [r for r in runs if r[-1] - r[0] >= 10 and r[-1] >= a.shape[1] - 160 * 150 / 72]
        if not run:
            if c == 'other': swatches.append(white)
            continue
        run = run[-1]; c0, c1 = run[0], run[-1]
        sub = a[:, c0:c1 + 1]; rows_nw = np.where((sub.mean(axis=2) < 235).mean(axis=1) > 0.12)[0]
        if len(rows_nw) < 3:
            if c == 'other': swatches.append(white)
            continue
        r0, r1 = rows_nw[0], rows_nw[-1]
        dr, dc = max(2, (r1 - r0) // 4), max(2, (c1 - c0) // 5)
        core = a[r0 + dr:r1 - dr + 1, c0 + dc:c1 - dc + 1]
        if core.size == 0: continue
        s150 = 72 / 150
        swatches.append((c, t, feat(core), (sx0 + c0 * s150, y0 - 0.3 * hgt + r0 * s150, sx0 + c1 * s150, y0 - 0.3 * hgt + r1 * s150)))
if not swatches: print(key, 'NO LEGEND SWATCHES'); sys.exit(2)
# a non-'other' swatch that came out blank was mis-detected: drop it; make sure an unfilled 'other' class exists
swatches = [w for w in swatches if not (w[0] != 'other' and w[2][0] < 3)]
if not any(w[0] == 'other' for w in swatches):
    swatches.append(('other', 'unfilled footprint (other / not categorised)', np.array([0., 0, 76.5, 76.5, 76.5]), (0, 0, 0, 0)))
# de-duplicate identical labels, keep the first
seen = set(); sw2 = []
for w in swatches:
    k_ = (w[0], tuple(np.round(w[2]).astype(int)))
    if k_ not in seen: seen.add(k_); sw2.append(w)
swatches = sw2

# ---------------- render plan around the perimeter
minx, miny, maxx, maxy = per.buffer(30).bounds
pts = [to_page(M, x, y) for x, y in ((minx, miny), (minx, maxy), (maxx, miny), (maxx, maxy))]
W, H = page_size(pdf, page)
px0, px1 = max(0, min(p[0] for p in pts)), min(W, max(p[0] for p in pts)); py0, py1 = max(0, min(p[1] for p in pts)), min(H, max(p[1] for p in pts))
scale = g.get('scale_m_per_pt') or 0.35
dpi = int(max(40, min(220, 4 * 72 * scale)))          # ~4 px per metre
s = dpi / 72
img = render_region(px0, py0, px1, py1, dpi); Hh, Ww = img.shape[:2]
# white-out text-layer words (parcel numbers, labels) so they do not count as fill
for w_, wx, wy in []: pass
_wb = subprocess.run(['pdftotext', '-f', str(page), '-l', str(page), '-bbox', pdf, '-'], capture_output=True, text=True).stdout
for m_ in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">', _wb):
    a0, b0, a1, b1 = [float(v) for v in m_.groups()]
    X0, Y0, X1, Y1 = int((a0 - px0) * s) - 1, int((b0 - py0) * s) - 1, int((a1 - px0) * s) + 2, int((b1 - py0) * s) + 2
    if X1 < 0 or Y1 < 0 or X0 >= Ww or Y0 >= Hh: continue
    img[max(0, Y0):min(Hh, Y1), max(0, X0):min(Ww, X1)] = 255
lum = img.mean(axis=2); nonwhite = lum < 230
def poly_px(geo, dx=0, dy=0):
    out = []
    for p in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo]):
        out.append([((to_page(M, x + dx, y + dy)[0] - px0) * s, (to_page(M, x + dx, y + dy)[1] - py0) * s) for x, y in p.exterior.coords])
    return out
B = bldg_lib.in_geom(per, 0.5)
def mask_of(geos, dx=0, dy=0):
    m = Image.new('L', (Ww, Hh), 0); d = ImageDraw.Draw(m)
    for geo in geos:
        for p in poly_px(geo, dx, dy):
            if len(p) >= 3: d.polygon(p, fill=255)
    return np.asarray(m) > 0
# translation search: maximise ink along the projected footprint outlines (building edges are drawn on the plan)
from PIL import ImageFilter
inkimg = Image.fromarray(((lum < 200) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(3))
inkarr = np.asarray(inkimg) > 0
edge_pts = []
for r in B:
    for p_ in (r[4].geoms if r[4].geom_type == 'MultiPolygon' else [r[4]]):
        ring = p_.exterior; n = max(4, int(ring.length / 0.5))
        for k_ in range(n):
            q = ring.interpolate(k_ / n, normalized=True); edge_pts.append((q.x, q.y))
EP = np.array(edge_pts) if edge_pts else np.zeros((0, 2))
def edge_score(dx_, dy_):
    if len(EP) == 0: return 0
    uv = np.array([to_page(M, x + dx_, y + dy_) for x, y in EP[::3]])
    cx = ((uv[:, 0] - px0) * s).astype(int); cy = ((uv[:, 1] - py0) * s).astype(int)
    ok = (cx >= 0) & (cy >= 0) & (cx < Ww) & (cy < Hh)
    return inkarr[cy[ok], cx[ok]].mean() if ok.any() else 0
best = (0, 0, -1)
for dx_ in range(-10, 11, 2):
    for dy_ in range(-10, 11, 2):
        v_ = edge_score(dx_, dy_)
        if v_ > best[2]: best = (dx_, dy_, v_)
for step in (1, 0.5):
    bx, by = best[0], best[1]
    for dx_ in (bx - step, bx, bx + step):
        for dy_ in (by - step, by, by + step):
            v_ = edge_score(dx_, dy_)
            if v_ > best[2]: best = (dx_, dy_, v_)
dx, dy = best[0], best[1]

GREY_ONLY = all(abs(w[2][2] - w[2][3]) < 8 and abs(w[2][3] - w[2][4]) < 8 for w in swatches)   # legend in greys: ignore coloured ink (cadastre, labels)
F = np.array([w[2] for w in swatches]); wts = np.array([1, 1, 0.15, 0.15, 0.15])
feats = []
for egid, egrid, dest, h, geo in B:
    mrr = geo.minimum_rotated_rectangle; xs_, ys_ = mrr.exterior.coords.xy
    sides = sorted([((xs_[i + 1] - xs_[i]) ** 2 + (ys_[i + 1] - ys_[i]) ** 2) ** 0.5 for i in range(4)])
    e_ = geo.buffer(-max(1.5, 0.22 * sides[0]))
    if e_.is_empty or e_.area < 3: e_ = geo.buffer(-1.0)
    if e_.is_empty or e_.area < 3: e_ = geo
    m = mask_of([e_], dx, dy)
    if m.sum() < 4:
        feats.append((egid, egrid, geo, 'unclassified', None, None, 'footprint too small for the render')); continue
    pix = img[m]; nw = (pix.mean(axis=1) < 235).mean()
    if nw < 0.04 and not any(w[2][0] < 5 for w in swatches):
        feats.append((egid, egrid, geo, 'not marked', 'unfilled footprint (no category on the plan: other building, or built after the plan)', None, 'medium')); continue
    f = feat(pix.reshape(-1, 1, 3))
    d = np.sqrt((((F - f) * wts) ** 2).sum(axis=1)); i = int(d.argmin())
    srt = np.sort(d); margin = (srt[1] - srt[0]) if len(srt) > 1 else 99
    conf = 'high' if d[i] < 15 and margin > 15 else ('medium' if d[i] < 30 and margin > 8 else 'low')
    feats.append((egid, egrid, geo, swatches[i][0], swatches[i][1], round(float(d[i]), 1), conf))
out = f'{GE}/georef/maintained_{key}.geojson'
fc = dict(type='FeatureCollection', properties=dict(plan=key, georef=f'georef/{key}_p1.json', shift_m=[dx, dy], fill_in_footprints=round(best[2], 3),
          legend=[dict(category=c, label=t, swatch_pt=[round(v, 1) for v in bb], rgb_std=[round(float(v), 1) for v in f_]) for c, t, f_, bb in swatches],
          method='colour of the plan inside each cadastral footprint, nearest legend swatch'),
          features=[dict(type='Feature', properties=dict(EGID=e, EGRID_CENTROIDE=gr, category=c, legend_label=l, dist=d_, confidence=cf), geometry=mapping(geo)) for e, gr, geo, c, l, d_, cf in feats])
json.dump(fc, open(out, 'w'), ensure_ascii=False)
# preview
pv = Image.fromarray(img.astype('uint8')); dr = ImageDraw.Draw(pv, 'RGBA')
col = {'maintained': (220, 0, 0), 'interesting': (255, 140, 0), 'integrated': (200, 0, 200), 'other': (0, 160, 0), 'demolish': (0, 0, 255), 'not marked': (120, 120, 120), 'unclassified': (0, 0, 0)}
for e, gr, geo, c, l, d_, cf in feats:
    for p in poly_px(geo, dx, dy): dr.polygon(p, outline=col.get(c, (0, 0, 0)) + (255,), fill=col.get(c, (0, 0, 0)) + (50,))
pv.save(f'{GE}/georef/{key}_maint.png')
import collections
print(key, 'swatches', [(c, t[:40]) for c, t, _, _ in swatches], 'shift', (dx, dy), round(best[2], 2), 'buildings', len(B), dict(collections.Counter(f[3] for f in feats)))
