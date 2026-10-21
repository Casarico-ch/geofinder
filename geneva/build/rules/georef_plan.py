import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
layer, key, pdf = sys.argv[1], sys.argv[2], sys.argv[3]
page = int(sys.argv[4]) if len(sys.argv) > 4 else 1
mode = sys.argv[5] if len(sys.argv) > 5 else 'auto'
dpi = int(sys.argv[6]) if len(sys.argv) > 6 else 200
gj = json.load(open(f'{GE}/raw/{layer}.geojson'))
k0, ind = (key.split('-') + [None])[:2]
geoms = [shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)]
per = unary_union(geoms); minx, miny, maxx, maxy = per.bounds
pars = parcels_in_bbox(minx - 300, miny - 300, maxx + 300, maxy + 300)
res = None; used = None
if mode in ('auto', 'text'):
    lab = labels_textlayer(pdf, page); res = fit(lab, pars); used = 'text'
if mode == 'ocr' or (mode == 'auto' and (res is None or res['n_inliers'] < 8)):
    png = render(pdf, page, dpi, f'{GE}/georef/{key}_p{page}_{dpi}.png')
    lab = labels_ocr(png, dpi); r2 = fit(lab, pars)
    if r2 and (res is None or r2['n_inliers'] > res['n_inliers']): res, used = r2, 'ocr'
if res is None: print(key, 'FAILED'); sys.exit(1)
res.update(layer=layer, key=key, pdf=pdf, page=page, labels_from=used, dpi_ocr=dpi)
json.dump(res, open(f'{GE}/georef/{key}_p{page}.json', 'w'), indent=1)
print(key, used, 'labels', res['n_labels'], 'inliers', res['n_inliers'], 'median_res_m %.2f' % res['median_res_m'], 'scale m/pt %.3f' % res['scale_m_per_pt'])
