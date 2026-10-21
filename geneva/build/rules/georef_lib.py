"""Georeferencing of plan sheets (PDF page -> LV95) by matching parcel-number labels
(text layer or OCR) to cadastral parcel centroids, RANSAC affine. Adapted from ge_audit2/scripts/georef*.py."""
import sqlite3, re, subprocess, csv, json, os
import numpy as np
from shapely import wkb
from shapely.geometry import Polygon, MultiPolygon, Point, box
from PIL import Image, ImageDraw, ImageFont
Image.MAX_IMAGE_PIXELS = None
SP = __import__('os').environ.get('GENEVA_WORK', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', 'work'))
GE = SP + '/ge_rules'
_con = None

def con():
    global _con
    if _con is None: _con = sqlite3.connect(SP + '/ge_all/parcels.gpkg')
    return _con

def gpkg_geom(b):
    flags = b[3]; env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return wkb.loads(bytes(b[8 + env:]))

def parcels_in_bbox(minx, miny, maxx, maxy):
    q = ('select p.egrid,p.commune,p.no_parcelle,p.geom,p.zones_prim,p.zones_dev,p.plan_de_site_ids,p.pdzi_id,p.reglement_special from parcels p '
         'join rtree_parcels_geom r on p.fid=r.id where r.maxx>=? and r.minx<=? and r.maxy>=? and r.miny<=?')
    out = []
    for eg, cm, no, g, zp, zd, ps, pz, rs in con().execute(q, (minx, maxx, miny, maxy)):
        out.append(dict(egrid=eg, commune=cm, no=str(no), geom=gpkg_geom(g), zones_prim=zp, zones_dev=zd, ps=ps, pdzi=pz, rs=rs))
    return out

def page_size(pdf, page=1):
    info = subprocess.run(['pdfinfo', '-f', str(page), '-l', str(page), pdf], capture_output=True, text=True).stdout
    m = re.search(r'Page\s+%d size:\s+([\d.]+) x ([\d.]+)' % page, info) or re.search(r'Page size:\s+([\d.]+) x ([\d.]+)', info)
    r = re.search(r'Page\s+%d rot:\s+(\d+)' % page, info) or re.search(r'Page rot:\s+(\d+)', info)
    w, h = float(m.group(1)), float(m.group(2))
    bx = subprocess.run(['pdfinfo', '-box', '-f', str(page), '-l', str(page), pdf], capture_output=True, text=True).stdout
    mb = re.search(r'MediaBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)', bx)
    if mb: w, h = float(mb.group(3)) - float(mb.group(1)), float(mb.group(4)) - float(mb.group(2))   # pdftoppm renders the MediaBox
    return (h, w) if r and int(r.group(1)) % 180 == 90 else (w, h)

def labels_textlayer(pdf, page=1):
    txt = subprocess.run(['pdftotext', '-f', str(page), '-l', str(page), '-bbox', pdf, '-'], capture_output=True, text=True).stdout
    lab = []
    for m in re.finditer(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)</word>', txt):
        w = m.group(5).strip()
        lab.append((w, (float(m.group(1)) + float(m.group(3))) / 2, (float(m.group(2)) + float(m.group(4))) / 2))
    return lab

def render(pdf, page, dpi, out_png):
    if not os.path.exists(out_png):
        subprocess.run(['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-png', '-singlefile', pdf, out_png[:-4]], check=True)
    return out_png

def labels_ocr(png, dpi):
    """digit words from tesseract, returned in PDF points"""
    lab = []
    for psm in ('11', '12'):
        r = subprocess.run(['tesseract', png, '-', '--psm', psm, '-c', 'tessedit_char_whitelist=0123456789', 'tsv'],
                           capture_output=True, text=True, env=dict(os.environ, OMP_THREAD_LIMIT='1'))
        for x in list(csv.reader(r.stdout.splitlines(), delimiter='\t', quoting=csv.QUOTE_NONE))[1:]:
            if len(x) > 11 and x[11].isdigit() and len(x[11]) >= 2:
                l, t, w, h = map(int, x[6:10]); s = 72 / dpi
                lab.append((x[11], (l + w / 2) * s, (t + h / 2) * s))
    return lab

def fit(labels, parcels, tol=12, iters=6000, seed=0):
    P = {}
    for p in parcels:
        P.setdefault(p['no'], []).append(p)
    cand = {}
    for w, x, y in labels:
        if w in P and len(P[w]) == 1 and P[w][0]['geom'].area > 120:
            cand.setdefault(w, set()).add((round(x, 0), round(y, 0)))
    pairs = [(list(v)[0], P[k][0]['geom'].representative_point(), k) for k, v in cand.items() if len(v) <= 2]
    if len(pairs) < 6: return None
    X = np.array([[x, y, 1] for (x, y), _, _ in pairs], float); E = np.array([[p.x, p.y] for _, p, _ in pairs])
    rng = np.random.default_rng(seed); best = None
    for _ in range(iters):
        idx = rng.choice(len(pairs), 3, replace=False)
        try: M = np.linalg.lstsq(X[idx], E[idx], rcond=None)[0]
        except Exception: continue
        if abs(np.linalg.det(M[:2, :2])) < 1e-6: continue
        inl = np.linalg.norm(X @ M - E, axis=1) < tol
        if best is None or inl.sum() > best.sum(): best = inl
    M = np.linalg.lstsq(X[best], E[best], rcond=None)[0]
    res = np.linalg.norm(X[best] @ M - E[best], axis=1)
    return dict(M=M.tolist(), n_labels=len(pairs), n_inliers=int(best.sum()), median_res_m=float(np.median(res)),
                scale_m_per_pt=float(np.sqrt(abs(np.linalg.det(M[:2, :2])))))

def to_lv95(M, x, y):
    M = np.array(M)
    if M.shape == (3, 3):
        r = M @ np.array([x, y, 1.0]); return (r[0] / r[2], r[1] / r[2])
    return tuple(np.array([x, y, 1.0]) @ M)

def to_page(M, X, Y):
    M = np.array(M)
    if M.shape == (3, 3):
        r = np.linalg.inv(M) @ np.array([X, Y, 1.0]); return (r[0] / r[2], r[1] / r[2])
    A = np.array([[M[0, 0], M[1, 0], M[2, 0]], [M[0, 1], M[1, 1], M[2, 1]], [0, 0, 1]])
    return tuple((np.linalg.inv(A) @ np.array([X, Y, 1.0]))[:2])
