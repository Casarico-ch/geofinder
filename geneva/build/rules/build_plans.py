import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
S = sys.argv[1]                      # .../ge_rules
from plans_data import P, RS
from pdzi_data import D
from sectors_data import SEC
from sector_config import C as SCFG
from newbuild_data import NB
CATLIB = {c['id']: c for z in json.load(open(f'{S}/rules_catalogue.json'))['zones'] for c in z.get('citations', [])}

pf = json.load(open(f'{S}/raw/planfiles.json'))

def norm(t):
    t = t.replace('’', "'").replace('’', "'")
    t = re.sub(r'-\n(?=[a-zà-ü])', '', t)
    return re.sub(r'\s+', ' ', t)

_cache = {}
def pages(path):
    """list of normalized page texts"""
    if path in _cache: return _cache[path]
    raw = open(f'{S}/{path}', encoding='utf-8', errors='replace').read()
    if '=== PAGE' in raw:
        parts = re.split(r'=== PAGE \S*\n', raw)[1:]
    else:
        parts = raw.split('\f')
    _cache[path] = [norm(p) for p in parts]
    return _cache[path]

ART = re.compile(r'(?:\bArt(?:icle)?\.?\s*(\d+[a-zA-Z]?)\b)')
def locate(q, files):
    nq = norm(q).strip()
    for f in files:
        for i, pt in enumerate(pages(f)):
            k = pt.find(nq)
            if k >= 0:
                arts = ART.findall(pt[:k])
                art = arts[-1] if arts else None
                if art is None:   # look at previous pages
                    for pp in reversed(pages(f)[:i]):
                        a2 = ART.findall(pp)
                        if a2: art = a2[-1]; break
                return {'source_file': 'ge_rules/' + f, 'page': i + 1, 'article': art and ('art. ' + art + ' (auto-located)'), 'quote': q}
    return None

def text_files(entry, override=None):
    fs = []
    if override: fs.append(override)
    for f in entry['files']:
        if not f['pdf']: continue
        base = f['pdf'][:-4]
        for ext in ('.raw.txt', '.ocr.txt'):
            p = base + ext
            if os.path.exists(f'{S}/{p}') and os.path.getsize(f'{S}/{p}') > 100 and p not in fs and 'rsg_l4_05' not in p: fs.append(p)
    return fs

LIMIT_FIELDS = ('height', 'density', 'new_construction', 'maintained', 'other_buildings', 'demolition', 'unbuilt_land', 'distances', 'use', 'underground', 'contiguous', 'roof')

def cite(quotes, files, missing, tag):
    cites = []
    for q in quotes:
        loc = locate(q, files)
        if loc is None: missing.append(tag + (q[:70],))
        else: cites.append(loc)
    return cites

def field(v, files, missing, tag):
    if isinstance(v, tuple) and len(v) == 2 and v[0] == 'unknown':
        return {'value': 'unknown', 'reason': v[1]}
    if isinstance(v, tuple) and len(v) == 2 and v[0] == 'none':
        return {'value': 'not regulated by this plan (zone rules apply)', 'reason': v[1]}
    val, quotes = v[0], v[1]
    out = {'value': val, 'citations': cite(quotes, files, missing, tag)}
    if len(v) > 2 and v[2]:
        out['law_citations'] = [CATLIB[i] for i in v[2]]
    return out

def build_entry(meta, data, files, missing, sec=None, scfg_key=None):
    out = {'meta': meta, 'text_files': ['ge_rules/' + f for f in files], 'limits': {}}
    drop = set((sec or {}).get('drop', []))
    for k, v in data.items():
        if k in ('src', 'name'): continue
        if k == 'zones': out['zones_in_perimeter'] = v; continue
        if k in drop: continue
        out['limits'][k] = field(v, files, missing, (meta.get('NO_PLAN'), k))
    vals = [k for k, v in out['limits'].items() if k in LIMIT_FIELDS and v.get('value') != 'unknown' and v.get('citations')]  # 'not regulated' entries carry no citations
    if sec:
        out['sectors'] = {}
        for sname, fields in sec['sectors'].items():
            out['sectors'][sname] = {k: field(v, files, missing, (meta.get('NO_PLAN'), sname + ':' + k)) for k, v in fields.items()}
            vals += [sname + ':' + k for k, v in out['sectors'][sname].items() if k in LIMIT_FIELDS and v.get('value') != 'unknown' and v.get('citations')]
        for extra in ('plan_note', 'outside_note'):
            if extra in sec: out[extra] = field(sec[extra], files, missing, (meta.get('NO_PLAN'), extra))
        if drop: out['moved_to_sectors'] = sorted(drop)
    nb = NB.get(scfg_key.replace(' ', ':', 1)) if scfg_key else None
    if nb:
        def nbf(e, tag):
            return {'value': e[0], 'note': e[1], 'citations': cite(e[2], files, missing, (meta.get('NO_PLAN'), tag))}
        out['new_buildings'] = nbf(nb['plan'], 'new_buildings')
        if 'areas' in nb:
            out['new_buildings']['drawn_areas'] = ('ge_rules/georef/build_areas_%s.geojson' % nb['areas']) if nb['areas'] else None
            if nb.get('areas_kind'): out['new_buildings']['drawn_areas_kind'] = nb['areas_kind']
            if nb.get('areas_missing'): out['new_buildings']['drawn_areas_missing_reason'] = nb['areas_missing']
        for sname, e in nb.get('sectors', {}).items():
            out.setdefault('sectors', {}).setdefault(sname, {})['new_buildings'] = nbf(e, sname + ':new_buildings')
        if out.get('sectors'):
            for sname, sv in out['sectors'].items():
                if 'new_buildings' not in sv: sv['new_buildings'] = {**out['new_buildings'], 'note': 'plan-wide value applies: ' + out['new_buildings']['note']}
    sc = SCFG.get(scfg_key) if scfg_key else None
    if sc:
        out['sector_placement'] = {'kind': sc['kind'], **{k: sc[k] for k in ('note', 'reason', 'sector') if k in sc},
                                   'parcel_table': 'ge_rules/parcel_sectors.csv (plan = "%s")' % scfg_key}
        if sc['kind'] == 'geojson': out['sector_placement']['polygons'] = 'ge_rules/georef/sectors_%s.geojson' % sc['file']
    out['has_values'] = bool(vals)
    out['fields_with_values'] = vals
    hv = out['limits'].get('height')
    hs = [v.get('height') for v in out.get('sectors', {}).values() if v.get('height')]
    if hv is None and hs: out['height_status'] = 'determined per sector' if all(h['value'] != 'unknown' for h in hs) else 'partly unknown (per sector)'
    else: out['height_status'] = 'none' if hv is None else ('unknown' if hv['value'] == 'unknown' else 'not regulated (zone rules)' if hv['value'].__class__ is str and hv['value'].startswith('not regulated') else 'determined')
    return out

missing = []
result = {}
for L, src in (('RDPPF_PS', P), ('RDPPF_RS', RS)):
    for key, e in pf[L].items():
        meta = {'layer': L, 'NO_PLAN': e['meta'][0]['NO_PLAN'], 'indices': e['indices'], 'commune': sorted({m['COMMUNE'] for m in e['meta']}),
                'title': e['meta'][0].get('TITRE_DU_PLAN'), 'type': e['meta'][0].get('TYPE_DE_PLAN'), 'lieu': e['meta'][0].get('LIEU'),
                'urls': sorted({f['url'] for f in e['files']})}
        data = src.get(key)
        if data is None:
            result[key] = {'meta': meta, 'has_values': False, 'limits': {}, 'status': 'NOT EXTRACTED'}
            continue
        files = text_files(e, data.get('src'))
        t = 'PS' if L == 'RDPPF_PS' else 'RS'
        result[key] = build_entry(meta, data, files, missing, SEC.get(key if t == 'PS' else 'RS:' + key), t + ' ' + key)
json.dump({'meta': {'generated': '2026-10-14', 'source_layers': ['RDPPF_PS', 'RDPPF_RS'],
                    'note': 'Keyed by NO_PLAN exactly as in SITG. "limits" hold plan-wide values only; values that apply to one sector / sub-perimeter / building area are under "sectors" (never plan-wide), and parcel_sectors.csv says which sector each parcel lies in. Fields absent => zone rules (rules_catalogue.json) apply. value "unknown" = only graphical or illegible. Article numbers auto-located (last "Art. N" before the quote on the page).'},
           'plans': result}, open(f'{S}/plans_de_site.json', 'w'), ensure_ascii=False, indent=1)

pz = {}
for key, e in pf['RDPPF_PDZI'].items():
    groups = {}
    for m in e['meta']: groups.setdefault(m['INDICE'] or '-', []).append(m)
    for ind, metas in groups.items():
        jk = key if ind in ('-', '', None) else key + '-' + ind
        data = D.get(jk)
        files_e = {'files': [f for f in e['files'] if ind in ('-', '') or len(groups) == 1 or (key + ind) in os.path.basename(f['pdf'] or '')]}
        files = text_files(files_e)
        meta = {'layer': 'RDPPF_PDZI', 'NO_PLAN': key, 'INDICE': ind, 'communes_SITG': sorted({m['COMMUNE'] for m in metas}), 'lieu': metas[0].get('LIEU'),
                'urls': sorted({f['url'] for f in files_e['files']})}
        sub = build_entry(meta, data, files, missing, SEC.get('PDZI:' + jk), 'PDZI ' + jk) if data else {'meta': meta, 'has_values': False, 'status': 'NOT EXTRACTED'}
        sub = {'key': jk, 'no_plan': key, 'indice': None if ind in ('-', '') else ind, 'name': (data or {}).get('name'), **sub}
        if 'limits' in sub: sub['limits'].pop('name', None)
        pz[jk] = sub
json.dump({'meta': {'generated': '2026-10-14', 'source_layer': 'RDPPF_PDZI',
                    'legal_basis': 'LZIAM art. 2 al.1 let. h (gabarits) and l (min/max IUS); art. 4 al.1: approval of plan + règlement directeur enables industrial-zone (or mixed) norms',
                    'note': 'Keyed exactly like parcels.pdzi_id: NO_PLAN-INDICE (e.g. 26615-N, 29975-A) or plain NO_PLAN when SITG INDICE is "-". Each entry also stores no_plan and indice. Sector-specific values under "sectors"; parcel placement in parcel_sectors.csv.'},
           'plans': pz}, open(f'{S}/pdzi.json', 'w'), ensure_ascii=False, indent=1)

tot = len(result); hv = sum(1 for v in result.values() if v.get('has_values'))
print('PS+RS plans', tot, 'with values', hv, 'not extracted', [k for k, v in result.items() if v.get('status')])
print('PS', sum(1 for v in result.values() if v['meta']['layer'] == 'RDPPF_PS'), 'RS', sum(1 for v in result.values() if v['meta']['layer'] == 'RDPPF_RS'))
print('height determined', sum(1 for v in result.values() if v.get('height_status') == 'determined'), 'unknown', sum(1 for v in result.values() if v.get('height_status') == 'unknown'))
print('PDZI keys', len(pz), sorted(pz), 'with values', sum(1 for x in pz.values() if x.get('has_values')))
import collections
print('new_buildings plan-wide', collections.Counter(v.get('new_buildings', {}).get('value') for v in list(result.values()) + list(pz.values())))
print('plans with sectors', sum(1 for v in result.values() if v.get('sectors')), 'pdzi with sectors', sum(1 for v in pz.values() if v.get('sectors')))
print('missing quotes', len(missing)); [print('  ', m) for m in missing]
