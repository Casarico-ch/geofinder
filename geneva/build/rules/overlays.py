import json,sys,urllib.request,urllib.parse,ssl,collections
ctx=ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')
def get(u): return json.load(urllib.request.urlopen(u,context=ctx))
res={}
for L in sys.argv[2:]:
    base=f'https://vector.sitg.ge.ch/arcgis/rest/services/{L}/FeatureServer/0'
    meta=get(base+'?f=json'); fields=[f['name'] for f in meta.get('fields',[])]
    rows=[];off=0
    while True:
        q=dict(where='1=1',outFields='*',returnGeometry='false',orderByFields='OBJECTID',resultOffset=off,resultRecordCount=1000,f='json')
        d=get(base+'/query?'+urllib.parse.urlencode(q))
        if 'error' in d: print(L,d['error']);break
        fs=[f['attributes'] for f in d['features']]; rows+=fs
        if not fs or (not d.get('exceededTransferLimit') and len(fs)<1000): break
        off+=len(fs)
    res[L]=rows
    print('=====',L,meta.get('name'),len(rows),fields)
    for f in fields:
        if f in ('OBJECTID','Shape__Area','Shape__Length','EREBID','DATE_MAJ') or f.startswith('LIEN') or f.startswith('DATE'): continue
        c=collections.Counter(r.get(f) for r in rows)
        if len(c)<=40: print(' ',f,len(c),c.most_common(40))
        else: print(' ',f,len(c),'e.g.',list(c)[:8])
json.dump(res,open(sys.argv[1],'w'),ensure_ascii=False)
