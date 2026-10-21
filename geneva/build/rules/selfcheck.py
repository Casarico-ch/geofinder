import json,random,re,os,sys
BASE=sys.argv[1]
d=json.load(open(os.path.join(BASE,'ge_rules/rules_catalogue.json')))
def norm(s): return re.sub(r'\s+',' ',s.replace('’',"'")).strip()
def num(x): return str(x).replace('.',',') if isinstance(x,float) and x%1 else str(int(x)) if isinstance(x,(int,float)) else str(x)
random.seed(20261014)
sample=random.sample(d['zones'],15)
ok=0; report=[]
for z in sample:
    srcs={}
    probs=[]
    # 1) every citation quote re-read from source file
    for c in z['citations']:
        f=os.path.join(BASE,c['source_file'])
        srcs.setdefault(f,norm(open(f,encoding='utf-8',errors='replace').read()))
        if norm(c['quote']) not in srcs[f]: probs.append('quote not found '+c['id'])
    cq={c['id']:norm(c['quote']) for c in z['citations']}
    # 2) numeric values must appear in a cited quote of the same field
    def chk(field,val,ids,fmt=None):
        if val in (None,0): return
        s=fmt(val) if fmt else num(val)
        if not any(s in cq.get(i,'') for i in ids): probs.append(f'{field}={val} ({s}) not in {ids}')
    h=z['height']; chk('height.absolute_max_m',h.get('absolute_max_m'),h.get('cite',[]))
    dd=z['distance']; chk('distance.minimum_m',dd.get('minimum_m'),dd.get('cite',[]))
    den=z['density']
    br=den.get('by_right')
    if isinstance(br,dict) and 'standard' in br:
        for k in ('standard','HPE','THPE'): chk('density.by_right.'+k,br[k],br['cite'],lambda v:f'{v*100:g}%'.replace('.',','))
    mn=den.get('minimum')
    if isinstance(mn,dict) and mn.get('ID_min'): chk('density.minimum',mn['ID_min'],mn['cite'],lambda v:f'{v:g}'.replace('.',','))
    for t in (den.get('by_derogation') or []) if isinstance(den.get('by_derogation'),list) else []:
        chk('derog.max',t['max'],t['cite'],lambda v:f'{v*100:g}%'); chk('derog.THPE',t['max_THPE'],t['cite'],lambda v:f'{v*100:g}%')
    status='OK' if not probs else 'FAIL'
    ok+= not probs
    report.append((z['code'],status,len(z['citations']),probs))
for r in report: print(*r)
print(f'{ok}/15')
