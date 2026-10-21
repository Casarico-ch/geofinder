"""Least-squares affine from text-layer labels restricted to a given parcel-number list (the plan's own parcels),
with iterative outlier removal. usage: labelfit.py LAYER KEY pdf page no1,no2,... [tol]"""
import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
from shapely.ops import unary_union
layer, key, pdf, page, nos = sys.argv[1:6]; page = int(page); tol = float(sys.argv[6]) if len(sys.argv) > 6 else 8
nos = nos.split(',')
gj = json.load(open(f"{GE}/raw/{layer}.geojson")); k0, ind = (key.split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties']['INDICE'] == ind)])
P = {}
for p in parcels_in_bbox(*per.buffer(150).bounds): P.setdefault(p['no'], []).append(p)
lab = labels_textlayer(pdf, page)
pairs = []
for w, x, y in lab:
    if w in nos and w in P and len(P[w]) == 1:
        pairs.append((x, y, P[w][0]['geom'].representative_point(), w))
print('pairs', [(w, round(x), round(y)) for x, y, _, w in pairs])
X = np.array([[x, y, 1] for x, y, _, _ in pairs]); E = np.array([[p.x, p.y] for _, _, p, _ in pairs])
keep = np.ones(len(pairs), bool)
for it in range(10):
    M = np.linalg.lstsq(X[keep], E[keep], rcond=None)[0]; r = np.linalg.norm(X @ M - E, axis=1)
    print(it, keep.sum(), [(pairs[i][3], round(r[i], 1)) for i in range(len(pairs))])
    nk = r < max(tol, np.median(r[keep]) * 2.5)
    if (nk == keep).all(): break
    keep = nk
M = np.linalg.lstsq(X[keep], E[keep], rcond=None)[0]; r = np.linalg.norm(X[keep] @ M - E[keep], axis=1)
out = dict(M=M.tolist(), n_labels=len(pairs), n_inliers=int(keep.sum()), median_res_m=float(np.median(r)),
           scale_m_per_pt=float(np.sqrt(abs(np.linalg.det(M[:2, :2])))), layer=layer, key=key, pdf=pdf, page=page, labels_from='text-restricted')
json.dump(out, open(f"{GE}/georef/{key}_p{page}.json", 'w')); print({k: out[k] for k in out if k != 'M'})
