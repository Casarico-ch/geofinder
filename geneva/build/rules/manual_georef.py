"""usage: manual_georef.py LAYER KEY pdf page 'u,v,X,Y;u,v,X,Y;...'  (u,v in PDF points)"""
import sys, json, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import GE
layer, key, pdf, page, cps = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
P = np.array([[float(t) for t in c.split(',')] for c in cps.split(';')])
X = np.c_[P[:, :2], np.ones(len(P))]; E = P[:, 2:]
M = np.linalg.lstsq(X, E, rcond=None)[0]; res = np.linalg.norm(X @ M - E, axis=1)
if len(sys.argv) > 6 and sys.argv[6] == 'H':
    # normalised DLT homography
    mu = E.mean(0); E0 = E - mu
    A = []
    for (u, v, _), (x, y) in zip(X, E0):
        A.append([u, v, 1, 0, 0, 0, -x * u, -x * v, -x]); A.append([0, 0, 0, u, v, 1, -y * u, -y * v, -y])
    Hm = np.linalg.svd(np.array(A))[2][-1].reshape(3, 3)
    T = np.array([[1, 0, mu[0]], [0, 1, mu[1]], [0, 0, 1]]); Hm = T @ Hm
    pr = (Hm @ X.T).T; pr = pr[:, :2] / pr[:, 2:]; res = np.linalg.norm(pr - E, axis=1); M = Hm
print('residuals m', res.round(1))
json.dump(dict(M=M.tolist(), n_labels=len(P), n_inliers=len(P), median_res_m=float(np.median(res)), max_res_m=float(res.max()),
               layer=layer, key=key, pdf=pdf, page=page, labels_from='manual control points', control_points=P.tolist()),
          open(f'{GE}/georef/{key}_p{page}.json', 'w'), indent=1)
