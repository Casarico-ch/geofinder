import json,random,re,os,sys
B=sys.argv[1]   # scratchpad
def norm(t):
    t=t.replace('’',"'"); t=re.sub(r'-\n(?=[a-zà-ü])','',t); return re.sub(r'\s+',' ',t)
def pages(f):
    raw=open(os.path.join(B,f),encoding='utf-8',errors='replace').read()
    ps=re.split(r'=== PAGE \S*\n',raw)[1:] if '=== PAGE' in raw else raw.split('\f')
    return [norm(p) for p in ps]
ps=json.load(open(f'{B}/ge_rules/plans_de_site.json'))['plans']
pz=json.load(open(f'{B}/ge_rules/pdzi.json'))['plans']
pool=[('PS/RS',k,v) for k,v in ps.items()]
for k,v in pz.items():
    if 'by_indice' in v: pool+= [('PDZI',k+i,x) for i,x in v['by_indice'].items()]
    else: pool.append(('PDZI',k,v))
random.seed(int(sys.argv[2]) if len(sys.argv)>2 else 15)
sample=pool if len(sys.argv)>3 else random.sample(pool,15)
def nums(o):
    out=[]
    if isinstance(o,dict):
        for v in o.values(): out+=nums(v)
    elif isinstance(o,(int,float)) and not isinstance(o,bool): out.append(o)
    return out
ok=0
for src,k,v in sample:
    probs=[]; nq=0; nn=0
    for field,lim in v.get('limits',{}).items():
        if lim.get('value')=='unknown': continue
        qs=[]
        for c in lim.get('citations',[]):
            nq+=1
            pg=pages(c['source_file'])
            if norm(c['quote']).strip() not in pg[c['page']-1]: probs.append(f'{field}: quote not on page {c["page"]}')
            qs.append(norm(c['quote']))
        for n in nums(lim['value']):
            nn+=1
            W={1:'un',2:'deux',3:'trois',4:'quatre'}
            forms={W.get(n,'@@'),W.get(n,'@@').capitalize(),str(n),str(n).replace('.',','),f'{n:g}',f'{n:g}'.replace('.',','),f"{n:,.0f}".replace(',',"'"),f"{n:,.0f}".replace(',',' '),str(n).replace('.',' m. ')+'0',f'{n:.2f}'}
            if not any(any(f in q for f in forms) for q in qs): probs.append(f'{field}: value {n} not in quotes')
    st='OK' if not probs else 'FAIL'; ok+=not probs
    print(src,k,st,f'quotes={nq} numbers={nn}',probs)
print(f'{ok}/{len(sample)}')
