import json,sys,urllib.request,urllib.parse,ssl
ctx=ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')
res={}
for L in ['RDPPF_ZONES_PRIM','RDPPF_ZONES_DEV']:
    rows=[];off=0
    while True:
        q=dict(where='1=1',outFields='*',returnGeometry='false',orderByFields='OBJECTID',resultOffset=off,resultRecordCount=1000,f='json')
        u=f'https://vector.sitg.ge.ch/arcgis/rest/services/{L}/FeatureServer/0/query?'+urllib.parse.urlencode(q)
        d=json.load(urllib.request.urlopen(u,context=ctx))
        if 'error' in d: print(L,d['error']);break
        fs=[f['attributes'] for f in d['features']]; rows+=fs
        if not fs: break
        off+=len(fs)
        if not d.get('exceededTransferLimit') and len(fs)<1000: break
    res[L]=rows; print(L,len(rows),len({r['OBJECTID'] for r in rows}))
json.dump(res,open(sys.argv[1],'w'),ensure_ascii=False)
