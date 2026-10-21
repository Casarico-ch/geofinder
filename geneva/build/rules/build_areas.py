"""Drawn new-building areas (or drawn free / garden areas) of a plan -> georef/build_areas_<key>.geojson
usage: build_areas.py spec.json
spec: {"view": "georef/wXXXX.view.json",            # georeferenced render (view_plan.py)
       "areas": [{"kind": "build_area"|"free_area", "label": "...", "polys": [[[x,y],...], ...]}],   # hand-traced, view px
       "masks": [{"kind": ..., "label": ..., "rgb": [r,g,b] | [[r,g,b],...], "tol": 40, "close": 5, "open": 3,
                  "fill_holes": true, "min_m2": 15, "within": [[[x,y],...]] (optional clip polys, view px)}],
       "confidence": "medium", "note": "..."}
Features are clipped to the SITG perimeter. A preview is written to georef/<key>_areas.png."""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape, mapping, Polygon, box
from shapely.ops import unary_union
from PIL import ImageFilter
spec = json.load(open(sys.argv[1])); v = json.load(open(spec['view'])); g = json.load(open(v['gfile']))
M = g['M']; s = v['dpi'] / 72
def lv(px, py): return to_lv95(M, v['x0'] + px / s, v['y0'] + py / s)
def topx(X, Y):
    u, w = to_page(M, X, Y); return ((u - v['x0']) * s, (w - v['y0']) * s)
gj = json.load(open(f"{GE}/raw/{g['layer']}.geojson"))
k0, ind = (g['key'].split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties'].get('INDICE') == ind)]).buffer(0)
im = Image.open(spec['view'][:-10] + '.png').convert('RGB'); a = np.asarray(im).astype(int); H, W = a.shape[:2]

def px_poly_to_lv(poly):
    return Polygon([lv(*p) for p in poly]).buffer(0)

def mask_to_geom(mask, f=2):
    """union of run-length boxes of a boolean mask (downsampled by f) -> LV95 geometry"""
    h, w = mask.shape; hh, ww = h // f, w // f
    m = mask[:hh * f, :ww * f].reshape(hh, f, ww, f).any(axis=(1, 3))
    boxes = []
    for y in range(hh):
        row = m[y]
        if not row.any(): continue
        d = np.diff(np.concatenate([[0], row.astype(int), [0]]))
        st = np.where(d == 1)[0]; en = np.where(d == -1)[0]
        for x0, x1 in zip(st, en): boxes.append(box(x0 * f, y * f, x1 * f, (y + 1) * f))
    if not boxes: return None
    u = unary_union(boxes).simplify(f * 0.75)
    polys = u.geoms if u.geom_type == 'MultiPolygon' else [u]
    out = []
    for p in polys:
        ext = [lv(*c) for c in p.exterior.coords]; holes = [[lv(*c) for c in r.coords] for r in p.interiors]
        out.append(Polygon(ext, holes).buffer(0))
    return unary_union(out)

feats = []
for ar in spec.get('areas', []):
    geo = unary_union([px_poly_to_lv(p) for p in ar['polys']]).intersection(per.buffer(2))
    feats.append((ar['kind'], ar['label'], geo, 'traced'))
for pa in spec.get('parcels', []):   # area defined in the règlement by parcel numbers
    pp = [q['geom'] for q in parcels_in_bbox(*per.buffer(50).bounds) if q['no'] in [str(n) for n in pa['nos']] and q['geom'].intersects(per)]
    geo = unary_union(pp).intersection(per.buffer(2))
    feats.append((pa['kind'], pa['label'], geo, 'parcels ' + ','.join(map(str, pa['nos']))))
for mk in spec.get('masks', []):
    cols = mk['rgb'] if isinstance(mk['rgb'][0], list) else [mk['rgb']]
    m = np.zeros((H, W), bool)
    for c in cols: m |= np.abs(a - np.array(c)).max(axis=2) <= mk.get('tol', 40)
    img = Image.fromarray((m * 255).astype('uint8'))
    if mk.get('close', 0) > 1: img = img.filter(ImageFilter.MaxFilter(mk['close'] | 1)).filter(ImageFilter.MinFilter(mk['close'] | 1))
    if mk.get('open', 0) > 1: img = img.filter(ImageFilter.MinFilter(mk['open'] | 1)).filter(ImageFilter.MaxFilter(mk['open'] | 1))
    if mk.get('fill_holes', True):
        inv = Image.fromarray(((np.asarray(img) == 0) * 255).astype('uint8')).convert('L')
        big = Image.new('L', (W + 2, H + 2), 255); big.paste(inv, (1, 1))
        ImageDraw.floodfill(big, (0, 0), 128)
        bg = np.asarray(big)[1:-1, 1:-1] == 128
        m2 = ~bg
    else:
        m2 = np.asarray(img) > 0
    if mk.get('within'):
        wimg = Image.new('L', (W, H), 0); dw = ImageDraw.Draw(wimg)
        for p in mk['within']: dw.polygon([tuple(q) for q in p], fill=255)
        m2 &= np.asarray(wimg) > 0
    geo = mask_to_geom(m2)
    if geo is None: print('empty mask', mk['label']); continue
    parts = [p for p in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo]) if p.area >= mk.get('min_m2', 15)]
    if mk.get('max_hole_m2'):   # fill only small holes (e.g. trees drawn over a garden), keep large enclosed land
        parts = [Polygon(p.exterior.coords, [r.coords for r in p.interiors if Polygon(r.coords).area > mk['max_hole_m2']]) for p in parts]
    geo = unary_union(parts).intersection(per.buffer(2)) if parts else None
    if geo is None or geo.is_empty: print('mask empty after filter', mk['label']); continue
    feats.append((mk['kind'], mk['label'], geo, 'colour mask'))
out = f"{GE}/georef/build_areas_{g['key']}.geojson"
json.dump(dict(type='FeatureCollection', properties=dict(plan=g['key'], georef=v['gfile'], method='georef', confidence=spec.get('confidence', 'medium'), note=spec.get('note', '')),
               features=[dict(type='Feature', properties=dict(kind=k, label=l, how=h, area_m2=round(geo.area, 1)), geometry=mapping(geo)) for k, l, geo, h in feats]), open(out, 'w'))
# preview
d = ImageDraw.Draw(im, 'RGBA')
for poly in (per.geoms if per.geom_type == 'MultiPolygon' else [per]):
    d.line([topx(*c) for c in poly.exterior.coords], fill=(0, 0, 255, 255), width=2)
for k, l, geo, h in feats:
    col = (0, 200, 0) if k == 'build_area' else (230, 0, 200)
    for p in (geo.geoms if geo.geom_type == 'MultiPolygon' else [geo] if geo.geom_type == 'Polygon' else []):
        d.polygon([topx(*c) for c in p.exterior.coords], fill=col + (90,), outline=col + (255,))
im.save(f"{GE}/georef/{g['key']}_areas.png")
print(out, [(k, l, round(geo.area), h) for k, l, geo, h in feats], 'perimeter', round(per.area))
