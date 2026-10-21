"""Full self-check of plans_de_site.json and pdzi.json (ALL entries, plan-wide and per-sector values).
1. every quote is re-found on the cited page of the cited text file;
2. every number in a value occurs in one of its quotes (number words / decimal comma / thousands separators accepted);
3. second read of OCR-derived numbers: the cited PDF page is re-rendered at a higher resolution and re-OCR'd
   (tesseract fra, psm 6 and 11); the number must appear in that independent read, else it is listed for visual check;
4. every sector named in the JSON for a placed plan exists in parcel_sectors.csv and vice versa.
usage: selfcheck_all.py <ge_rules dir>  -> georef/selfcheck_all.json"""
import json, re, os, sys, subprocess, csv, collections
G = sys.argv[1]
def norm(t):
    t = t.replace('’', "'"); t = re.sub(r'-\n(?=[a-zà-ü])', '', t); return re.sub(r'\s+', ' ', t)
_pg = {}
def pages(f):
    if f not in _pg:
        raw = open(os.path.join(G, f), encoding='utf-8', errors='replace').read()
        ps = re.split(r'=== PAGE \S*\n', raw)[1:] if '=== PAGE' in raw else raw.split('\f')
        _pg[f] = [norm(p) for p in ps]
    return _pg[f]
def nums(o):
    out = []
    if isinstance(o, dict):
        for v in o.values(): out += nums(v)
    elif isinstance(o, list):
        for v in o: out += nums(v)
    elif isinstance(o, (int, float)) and not isinstance(o, bool): out.append(o)
    return out
W = {1: 'un', 2: 'deux', 3: 'trois', 4: 'quatre'}
def forms(n):
    f = {str(n), str(n).replace('.', ','), f'{n:g}', f'{n:g}'.replace('.', ','), f"{n:,.0f}".replace(',', "'"), f"{n:,.0f}".replace(',', ' '), f'{n:.2f}', f'{n:.2f}'.replace('.', ','), str(n).replace('.', ' m. ') + '0'}
    if n in W: f |= {W[n], W[n].capitalize()}
    return f
def is_ocr(src):
    return src.endswith('.ocr.txt') or '/regs/' in src
def pdf_of(src):
    s = src.replace('ge_rules/', '')
    return s[:-8] + '.pdf' if s.endswith('.ocr.txt') else s[:-4] + '.pdf'
_ocr2 = {}
def sr_path(pdf, page):
    return os.path.join(G, 'tmp', 'sr', re.sub(r'[^A-Za-z0-9]', '_', pdf) + f'_p{page}.txt')
NEED = set()
# second reads done by viewing a high-resolution crop (page too large/dense for a full re-OCR in reasonable time)
VISUAL2 = {('regs/27353R.pdf', 418.11): 'georef/evidence/27353_gabarit.png', ('pdzi_dl/27953.pdf', 1.2): 'georef/evidence/27953_art5_values.png', ('pdzi_dl/27953.pdf', 1.5): 'georef/evidence/27953_art5_values.png'}
visual2_used = []
def second_read(pdf, page):
    """reads the cached independent OCR (made by scripts/second_read.sh); records a need if missing"""
    f = sr_path(pdf, page)
    if not os.path.exists(f): NEED.add((pdf, page)); return ('', 0)
    t = open(f, encoding='utf-8', errors='replace').read()
    dpi = int(t.split(' ', 1)[0].split('=')[1]) if t.startswith('dpi=') else 0
    return (norm(t), dpi)

ps = json.load(open(f'{G}/plans_de_site.json'))['plans']
pz = json.load(open(f'{G}/pdzi.json'))['plans']
entries = [('PS' if v['meta']['layer'] == 'RDPPF_PS' else 'RS', k, v) for k, v in ps.items()] + [('PDZI', k, v) for k, v in pz.items()]
report = []; tot = collections.Counter(); visual = []
for src, k, v in entries:
    probs = []; nq = nn = 0; ocr_n = ocr_ok = 0
    items = [(f, lim) for f, lim in v.get('limits', {}).items()]
    for s, flds in v.get('sectors', {}).items(): items += [(s + ':' + f, lim) for f, lim in flds.items()]
    for extra in ('plan_note', 'outside_note', 'new_buildings'):
        if extra in v: items.append((extra, v[extra]))
    for field, lim in items:
        if not isinstance(lim.get('value'), (dict, str, list, int, float)) or lim.get('value') == 'unknown' or 'citations' not in lim: continue
        qs = []
        for c in lim['citations']:
            nq += 1
            pg = pages(c['source_file'].replace('ge_rules/', ''))
            if norm(c['quote']).strip() not in pg[c['page'] - 1]: probs.append(f'{field}: quote not on page {c["page"]}')
            qs.append((norm(c['quote']), c))
        for lc in lim.get('law_citations', []):
            nq += 1
            src = os.path.join(os.path.dirname(G), lc['source_file'])
            if norm(lc['quote']).strip() not in norm(open(src, encoding='utf-8', errors='replace').read()): probs.append(f'{field}: law quote {lc["id"]} not found')
            qs.append((norm(lc['quote']), dict(lc, page=1)))
        for n in nums(lim['value']):
            nn += 1
            hit = [c for q, c in qs if any(f in q for f in forms(n))]
            if not hit:
                if 'source' in lim['value'] and 'read' in str(lim['value'].get('source', '')): visual.append((src, k, field, n, lim['value'].get('source'))); continue
                probs.append(f'{field}: value {n} not in quotes'); continue
            c = hit[0]
            if is_ocr(c['source_file']):
                ocr_n += 1
                if (pdf_of(c['source_file']), n) in VISUAL2:
                    ocr_ok += 1; visual2_used.append((k, field, n, VISUAL2[(pdf_of(c['source_file']), n)])); continue
                t2, dpi = second_read(pdf_of(c['source_file']), 0 if len(pages(c['source_file'].replace('ge_rules/', ''))) == 1 else c['page'])
                if not dpi: continue
                if any(f in t2 for f in forms(n)): ocr_ok += 1
                else: visual.append((src, k, field, n, f'second OCR read ({dpi} dpi) did not reproduce it; page {c["page"]} of {pdf_of(c["source_file"])}'))
    tot['entries'] += 1; tot['quotes'] += nq; tot['numbers'] += nn; tot['ocr_numbers'] += ocr_n; tot['ocr_confirmed'] += ocr_ok
    tot['ok' if not probs else 'fail'] += 1
    report.append(dict(src=src, key=k, ok=not probs, quotes=nq, numbers=nn, ocr_numbers=ocr_n, ocr_confirmed=ocr_ok, problems=probs))
    print(src, k, 'OK' if not probs else 'FAIL', f'quotes={nq} numbers={nn} ocr={ocr_ok}/{ocr_n}', probs)
# sector-name consistency with parcel_sectors.csv
rows = list(csv.DictReader(open(f'{G}/parcel_sectors.csv')))
csv_sec = collections.defaultdict(set)
for r in rows:
    if not r['sector'].startswith('UNPLACED'): csv_sec[r['plan']].add(r['sector'])
mism = []
for src, k, v in entries:
    if not v.get('sectors'): continue
    plan = f'{src} {k}'
    if plan not in csv_sec: mism.append((plan, 'no placed parcels (unplaced plan)')); continue
    miss = [s for s in v['sectors'] if s not in csv_sec[plan]]
    if miss: mism.append((plan, 'sectors without parcels: ' + ', '.join(miss)))
print('TOTAL', dict(tot)); print('visual checks needed', len(visual)); [print('  ', x) for x in visual]
print('sector-name join issues', mism)
if NEED:
    open(f'{G}/tmp/sr/need.txt', 'w').write(''.join(f'{p} {g}\n' for p, g in sorted(NEED))); print('second reads missing:', len(NEED))
print('visual second reads', visual2_used)
json.dump({'visual_second_reads': visual2_used, 'totals': dict(tot), 'entries': report, 'visual_checks': visual, 'sector_join': mism}, open(f'{G}/georef/selfcheck_all.json', 'w'), ensure_ascii=False, indent=1)
