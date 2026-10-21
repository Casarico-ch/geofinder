import json,ssl,sys,urllib.request,os
CTX=ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
out=sys.argv[1]
for n in sys.argv[2:]:
    u=f"https://vector.sitg.ge.ch/arcgis/rest/services/{n}/FeatureServer/0?f=json"
    try:
        d=json.loads(urllib.request.urlopen(u,timeout=60,context=CTX).read().decode('utf-8-sig'))
        json.dump(d,open(os.path.join(out,n+'.json'),'w'))
        c=json.loads(urllib.request.urlopen(f"https://vector.sitg.ge.ch/arcgis/rest/services/{n}/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json",timeout=60,context=CTX).read().decode('utf-8-sig'))
        print('==',n,d.get('geometryType'),'count',c.get('count'),'maxRec',d.get('maxRecordCount'))
        print('  ',(d.get('description') or '')[:400].replace('\n',' '))
        print('  ',[f['name'] for f in d.get('fields',[])])
    except Exception as e: print('ERR',n,e)
