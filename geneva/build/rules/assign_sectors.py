"""Produce ge_rules/parcel_sectors.csv: one row per (parcel, plan, sector).
share = fraction of the parcel's area inside the plan perimeter that lies in the sector (sums to 1 per parcel+plan;
for raster plans it is the fraction of sample points). Unplaced parcels get sector 'UNPLACED: <reason>', share empty."""
import sys, os, json, re, csv, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from sector_config import C
from newbuild_data import NB
import pandas as pd
from shapely.geometry import shape, Point
from shapely.ops import unary_union
from shapely import prepared

d = pd.read_parquet(SP + '/ge_all/parcels.parquet', columns=['egrid', 'no_parcelle', 'commune', 'plan_de_site_ids', 'pdzi_id', 'reglement_special', 'zones_prim', 'zones_dev'])
todo = []
for r in d.itertuples():
    for k in (r.plan_de_site_ids or '').split(';'):
        if k.strip(): todo.append((r.egrid, 'PS ' + k.strip()))
    if r.pdzi_id: todo.append((r.egrid, 'PDZI ' + r.pdzi_id))
    for m in re.finditer(r'RS (\S+)', r.reglement_special or ''): todo.append((r.egrid, 'RS ' + m.group(1)))
todo = list(dict.fromkeys(todo))
P = d.set_index('egrid')

# geometries
eg = sorted({e for e, _ in todo}); G = {}
for i in range(0, len(eg), 500):
    ch = eg[i:i + 500]
    for e, g in con().execute('select egrid, geom from parcels where egrid in (%s)' % ','.join('?' * len(ch)), ch): G[e] = gpkg_geom(g)

LAYER = {'PS': 'RDPPF_PS', 'RS': 'RDPPF_RS', 'PDZI': 'RDPPF_PDZI'}
_per = {}
def perimeter(plan):
    if plan in _per: return _per[plan]
    t, k = plan.split(' ', 1); no, ind = (k.split('-') + [None])[:2]
    gj = json.load(open(f'{GE}/raw/{LAYER[t]}.geojson'))
    fs = [shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == no and (ind is None or f['properties'].get('INDICE') == ind)]
    _per[plan] = unary_union(fs).buffer(0) if fs else None
    return _per[plan]

def zcodes(r):
    out = []
    for fld in ('zones_dev', 'zones_prim'):
        for m in re.finditer(r'(?:^|; )([^ ;]+) (\d+)m2', getattr(r, fld) or ''): out.append((fld, m.group(1), float(m.group(2))))
    return out

_gj = {}
def sectors_file(f):
    if f not in _gj:
        g = json.load(open(f'{GE}/georef/sectors_{f}.geojson'))
        _gj[f] = (g['properties'], [(x['properties']['sector'], prepared.prep(shape(x['geometry'])), shape(x['geometry'])) for x in g['features']])
    return _gj[f]

_ras = {}
def raster(view):
    if view not in _ras:
        v = json.load(open(f'{GE}/{view}')); g = json.load(open(f"{GE}/{v['gfile']}"))
        base = f'{GE}/{view}'[:-10]
        _ras[view] = (v, g, np.load(base + '_labels.npy'), json.load(open(base + '_labels.json')))
    return _ras[view]

def samples(geo, n=400):
    minx, miny, maxx, maxy = geo.bounds
    step = max(0.75, np.sqrt(geo.area / n)); pg = prepared.prep(geo); pts = []
    for x in np.arange(minx + step / 2, maxx, step):
        for y in np.arange(miny + step / 2, maxy, step):
            if pg.contains(Point(x, y)): pts.append((x, y))
    if not pts: pts = [geo.representative_point().coords[0]]
    return pts

_ba = {}
def build_areas(plan):
    """(union of build_area, union of free_area, file) for the plan, or None"""
    nb = NB.get(plan.replace(' ', ':', 1), {})
    f = nb.get('areas')
    if not f: return None
    if f not in _ba:
        g = json.load(open(f'{GE}/georef/build_areas_{f}.geojson'))
        b = unary_union([shape(x['geometry']) for x in g['features'] if x['properties']['kind'] == 'build_area'])
        fr = unary_union([shape(x['geometry']) for x in g['features'] if x['properties']['kind'] == 'free_area'])
        _ba[f] = (b, fr, {x['properties']['label']: shape(x['geometry']) for x in g['features']}, g['properties'].get('confidence', 'medium'))
    return _ba[f]
_mt = {}
def maintained(plan):
    """union of footprints classified maintained / interesting / integrated / demolish for a PS plan"""
    if not plan.startswith('PS '): return None
    k = plan[3:]
    if k not in _mt:
        f = f'{GE}/georef/maintained_{k}.geojson'
        if not os.path.exists(f): _mt[k] = None
        else:
            fs = json.load(open(f))['features']
            _mt[k] = {c: [(x['properties']['EGID'], shape(x['geometry'])) for x in fs if x['properties']['category'] == c] for c in ('maintained', 'interesting', 'integrated', 'demolish')}
    return _mt[k]
def nb_value(plan, sector):
    nb = NB.get(plan.replace(' ', ':', 1))
    if not nb: return ''
    return (nb.get('sectors', {}).get(sector) or nb['plan'])[0]
_Z = None
def zone_pieces(geo):
    """[(zone code, polygon)] of RDPPF_ZONES_PRIM intersecting geo"""
    global _Z
    if _Z is None:
        import glob
        from shapely.strtree import STRtree
        from shapely.geometry import Polygon as _P
        zs = []
        for fn in glob.glob(SP + '/ge_all/raw/zprim/p*.json'):
            for x in json.load(open(fn))['features']:
                r_ = (x.get('geometry') or {}).get('rings')
                if r_: zs.append((x['attributes']['ABRV_ZONE'], _P(r_[0], r_[1:]).buffer(0)))
        _Z = (zs, STRtree([g_ for _, g_ in zs]))
    zs, tr = _Z
    out = []
    for k_ in tr.query(geo):
        c_, g_ = zs[k_]
        x_ = g_.intersection(geo)
        if x_.area > 0: out.append((c_, x_))
    return out
rows = []; stats = collections.Counter(); per_plan = collections.defaultdict(collections.Counter)
for e, plan in todo:
    cfg = C.get(plan)
    r = P.loc[e]; geo = G.get(e)
    def add(sector, share, method, conf):
        rows.append(dict(egrid=e, plan=plan, sector=sector, share='' if share is None else round(share, 3), method=method, confidence=conf))
    if cfg is None:
        add('UNPLACED: plan not in sector configuration', None, '', ''); stats['unplaced'] += 1; per_plan[plan]['unplaced'] += 1; continue
    kind = cfg['kind']; placed = True
    if str(r.no_parcelle) in cfg.get('overrides', {}):
        for sec, sh in cfg['overrides'][str(r.no_parcelle)]: add(sec, sh, 'manual', 'medium')
    elif kind == 'whole':
        add(cfg.get('sector', 'whole perimeter (no sector-specific limits)'), 1.0, 'layer', 'high')
    elif kind == 'unplaced':
        add('UNPLACED: ' + cfg['reason'], None, '', ''); placed = False
    elif kind == 'detail':
        ids = [x.strip() for x in (r.plan_de_site_ids or '').split(';')]
        add(cfg['in'] if cfg['detail_plan'] in ids else cfg['out'], 1.0, 'layer', 'high')
    elif kind == 'parcels':
        v = cfg['parcels'].get(str(r.no_parcelle))
        conf = cfg.get('confidence', 'high')
        if isinstance(v, tuple):
            add(v[0], v[1], 'manual', 'low'); add(cfg['default'], 1 - v[1], 'manual', 'low')
        elif v: add(v, 1.0, 'manual', conf)
        else: add(cfg['default'], 1.0, 'manual', conf)
    elif kind == 'zone':
        acc = collections.Counter(); seen_prim = set()
        zs = zcodes(r)
        dev_area = sum(a for f, c, a in zs if f == 'zones_dev')
        for f, c, a in zs:
            if f == 'zones_prim' and dev_area > 0: continue      # dev zone overlays the primary zone: use dev codes
            acc[cfg['map'].get(c, cfg.get('other', 'other zones'))] += a
        tot = sum(acc.values()) or 1
        for s, a in acc.most_common(): add(s, a / tot, 'layer', 'high')
    elif kind == 'geojson':
        props, secs = sectors_file(cfg['file'])
        per = perimeter(plan); g2 = geo.intersection(per) if (geo is not None and per is not None) else None
        if g2 is None or g2.area < 1:
            # parcel touches the perimeter only marginally in the SITG layer: use the nearest sector to its centroid
            pt = geo.representative_point() if geo is not None else None
            if pt is None: add('UNPLACED: no geometry', None, '', ''); placed = False
            else:
                best = min(secs, key=lambda s: s[2].distance(pt)); add(best[0], 1.0, props['method'], 'low')
        else:
            acc = []
            for name, pg, sg in secs:
                if pg.intersects(g2):
                    a = sg.intersection(g2).area
                    if a > 0: acc.append((name, a))
            tot = sum(a for _, a in acc)
            zc = cfg.get('zone_consistency'); corrected = False
            if zc and tot > 0:
                # per zone piece: only pieces whose SITG zone contradicts their traced sector are re-assigned
                acc2 = collections.Counter(); changed = False
                zp = zone_pieces(g2)
                for name, pg, sg in secs:
                    if not pg.intersects(g2): continue
                    piece = sg.intersection(g2)
                    if piece.area <= 0: continue
                    covered = 0.0
                    for zcode, zg in zp:
                        a_ = piece.intersection(zg).area
                        if a_ <= 0: continue
                        covered += a_
                        allowed = zc.get(zcode)
                        real = any(name in v_ for v_ in zc.values())   # 'unidentified' etc. are never re-assigned
                        if not allowed or not real or name in allowed:
                            acc2[name] += a_; continue
                        # contradiction: nearest allowed traced sector to this piece
                        pc = piece.intersection(zg).representative_point()
                        cand_ = sorted((sg2.distance(pc), n2) for n2, pg2, sg2 in secs if n2 in allowed and not (n2 == 'D' and zcode != 'AG'))
                        if cand_: acc2[cand_[0][1]] += a_; changed = True
                        else: acc2[name] += a_
                    if piece.area - covered > 0.5: acc2[name] += piece.area - covered
                if changed:
                    acc, tot, corrected = list(acc2.items()), sum(acc2.values()), True
            agg_ = collections.Counter()
            for n_, a_ in acc: agg_[n_] += a_
            acc = list(agg_.items())
            if tot <= 0: add('UNPLACED: outside traced sectors', None, '', ''); placed = False
            else:
                for name, a in sorted(acc, key=lambda x: -x[1]):
                    if a / tot >= 0.005: add(name, a / tot, 'layer' if corrected else props['method'], 'low' if corrected else props['confidence'])
    elif kind == 'raster':
        v, g, lab, names = raster(cfg['view']); s = v['dpi'] / 72; H, Wd = lab.shape
        zo = cfg.get('zone_override', {})
        zs = zcodes(r)
        per = perimeter(plan); g2 = geo.intersection(per) if geo is not None else None
        if g2 is None or g2.area < 1: g2 = geo
        cnt = collections.Counter(); n = 0
        for X, Y in samples(g2):
            u, w = to_page(g['M'], X, Y); px, py = int((u - v['x0']) * s), int((w - v['y0']) * s)
            if 0 <= px < Wd and 0 <= py < H:
                n += 1; L = lab[py, px]
                if L > 0: cnt[names[L - 1]] += 1
        # zone overrides (parcel wholly in a zone that is outside the sectors)
        zmain = max(zs, key=lambda z: z[2])[1] if zs else None
        if cfg.get('unlabeled', '').startswith('secteurs') and zmain in zo and not cnt:
            add(zo[zmain], 1.0, 'layer', 'high')
        elif plan.startswith('PDZI'):
            tot = sum(cnt.values())
            if tot == 0 or tot < 0.1 * max(n, 1): add(cfg['unlabeled'], 1.0, 'georef', cfg['confidence'])
            else:
                for k2, c2 in cnt.most_common():
                    if c2 / tot >= 0.02: add(k2, c2 / tot, 'georef', cfg['confidence'])
        else:   # Laconnex: labelled = village ancien, everything else = secteurs d'aménagement
            nn = max(n, 1); lab_share = sum(cnt.values()) / nn
            if lab_share > 0.02: add(names[0], lab_share, 'georef', cfg['confidence'])
            if lab_share < 0.98: add(cfg['unlabeled'], 1 - lab_share, 'georef', cfg['confidence'])
    # ---- drawn new-building / free areas
    mine = [x for x in rows if x['egrid'] == e and x['plan'] == plan and 'nb' not in x]
    ba = build_areas(plan) if geo is not None else None
    per = perimeter(plan) if geo is not None else None
    gin = geo.intersection(per) if (geo is not None and per is not None) else geo
    if gin is not None and gin.area < 1: gin = geo
    share_b = ''
    if ba and gin is not None and gin.area > 0:
        b, fr, parts, conf = ba
        if not b.is_empty: share_b = round(b.intersection(gin).area / gin.area, 3)
        if plan == 'PS 29827' and not fr.is_empty and placed:
            gs = parts.get('aire de jardin non-bâtie (art. 7, art. 16)'); cs = parts.get('cour ouverte sur rue (art. 8)')
            g_sh = gs.intersection(gin).area / gin.area if gs is not None else 0
            c_sh = cs.difference(gs).intersection(gin).area / gin.area if cs is not None else 0
            if g_sh + c_sh > 0.005:
                k = max(0.0, 1 - g_sh - c_sh)
                for x in mine:
                    if x['share'] != '': x['share'] = round(float(x['share']) * k, 3)
                new = []
                if g_sh > 0.005: new.append(dict(egrid=e, plan=plan, sector='aire de jardin non-bâtie', share=round(g_sh, 3), method='georef', confidence=conf))
                if c_sh > 0.005: new.append(dict(egrid=e, plan=plan, sector='cour ouverte sur la rue', share=round(c_sh, 3), method='georef', confidence=conf))
                for x in [x for x in mine if x['share'] != '' and float(x['share']) < 0.005]: rows.remove(x); mine.remove(x)
                rows.extend(new); mine += new
    mt = maintained(plan) if gin is not None else None
    mshare, megids = '', ''
    if mt is not None and gin is not None and gin.area > 0:
        hit = [(eg, gg) for eg, gg in mt['maintained'] if gg.intersects(gin) and gg.intersection(gin).area > 0.3 * gg.area]
        mshare = round(unary_union([gg for _, gg in hit]).intersection(gin).area / gin.area, 3) if hit else 0.0
        megids = ' '.join(str(eg) for eg, _ in hit)
    for x in mine:
        x['maintained_bldg_share'] = mshare; x['maintained_egids'] = megids
    for x in mine:
        x['nb'] = 1
        v = nb_value(plan, x['sector']) if not x['sector'].startswith('UNPLACED') else (NB.get(plan.replace(' ', ':', 1), {}).get('plan', ('',))[0])
        x['new_buildings'] = v
        x['build_area_share'] = share_b
        x['build_area_confidence'] = (ba[3] if (ba and share_b != '') else '')
    stats['placed' if placed else 'unplaced'] += 1; per_plan[plan]['placed' if placed else 'unplaced'] += 1

with open(f'{GE}/parcel_sectors.csv', 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=['egrid', 'plan', 'sector', 'share', 'method', 'confidence', 'new_buildings', 'build_area_share', 'build_area_confidence', 'maintained_bldg_share', 'maintained_egids'], extrasaction='ignore'); w.writeheader(); w.writerows(rows)
up = {k: dict(v) for k, v in per_plan.items() if v['unplaced']}
json.dump({'parcel_plan_pairs': len(todo), 'parcels': len({e for e, _ in todo}), 'placed_pairs': stats['placed'], 'unplaced_pairs': stats['unplaced'],
           'unplaced_by_plan': up, 'rows': len(rows),
           'by_method': dict(collections.Counter(r['method'] for r in rows if r['method']))}, open(f'{GE}/georef/assign_stats.json', 'w'), indent=1)
print('pairs', len(todo), 'parcels', len({e for e, _ in todo}), dict(stats), 'rows', len(rows)); print('unplaced by plan', up)
