import json,sys,urllib.request,urllib.parse,ssl
ctx=ssl.create_default_context(cafile='/root/.ccr/ca-bundle.crt')
out=sys.argv[1]
res={}
for L,fields in [('RDPPF_ZONES_PRIM',['ABRV_ZONE','NOM_ZONE','DESC_ZONE']),('RDPPF_ZONES_DEV',['ABRV_ZONE','NOM_ZONE','DESC_ZONE','ZONE_PREEX'])]:
    rows=[];off=0
    while True:
        q=dict(where='1=1',outFields=','.join(fields),groupByFieldsForStatistics=','.join(fields),
          outStatistics=json.dumps([{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"n"}]),
          resultOffset=off,resultRecordCount=1000,orderByFields=','.join(fields),f='json')
        u=f'https://vector.sitg.ge.ch/arcgis/rest/services/{L}/FeatureServer/0/query?'+urllib.parse.urlencode(q)
        d=json.load(urllib.request.urlopen(u,context=ctx))
        if 'error' in d: print(L,d['error']);break
        fs=[f['attributes'] for f in d['features']]; rows+=fs
        if not d.get('exceededTransferLimit') or not fs: break
        off+=len(fs)
    # total count
    u=f'https://vector.sitg.ge.ch/arcgis/rest/services/{L}/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json'
    tot=json.load(urllib.request.urlopen(u,context=ctx))
    res[L]={'total':tot.get('count'),'groups':rows}
    print(L,'total',tot,'groups',len(rows),'sum',sum(r['n'] for r in rows))
json.dump(res,open(out,'w'),ensure_ascii=False,indent=1)
