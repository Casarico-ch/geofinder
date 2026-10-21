import json,ssl,sys,urllib.request,urllib.parse
CTX=ssl.create_default_context(cafile="/root/.ccr/ca-bundle.crt")
layer=sys.argv[1]; prm=dict(f='json',returnGeometry='false',where='1=1',outFields='*')
for a in sys.argv[2:]:
    k,v=a.split('=',1); prm[k]=v
u=f"https://vector.sitg.ge.ch/arcgis/rest/services/{layer}/FeatureServer/0/query"
d=json.loads(urllib.request.urlopen(urllib.request.Request(u,data=urllib.parse.urlencode(prm).encode()),timeout=120,context=CTX).read().decode('utf-8-sig'))
if 'features' in d:
    for f in d['features']: print(json.dumps(f['attributes'],ensure_ascii=False))
else: print(json.dumps(d,ensure_ascii=False)[:3000])
