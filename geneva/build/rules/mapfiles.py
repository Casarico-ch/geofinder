import json,os,sys
S=sys.argv[1]
d=json.load(open(f'{S}/raw/overlays.json'))
m={}
for L,dirn in [('RDPPF_PS','ps_dl'),('RDPPF_RS','ps_dl'),('RDPPF_PDZI','pdzi_dl')]:
    for r in d[L]:
        key=str(r['NO_PLAN']); ind=r['INDICE']
        e=m.setdefault(L,{}).setdefault(key,{'indices':set(),'files':[],'meta':[]})
        e['indices'].add(ind)
        meta={k:r.get(k) for k in ('NO_PLAN','INDICE','COMMUNE','LIEU','TITRE_DU_PLAN','TYPE_DE_PLAN','DATE_ADOPTION','DATE_ADOP_CE','LIEN_REGLEMENT','LIEN_PLAN','PLAN_VALANT','SITE')}
        if meta not in e['meta']: e['meta'].append(meta)
        for k,role in (('LIEN_REGLEMENT','reglement'),('LIEN_PLAN','plan')):
            u=r.get(k)
            if not u: continue
            f=f'{dirn}/'+os.path.basename(u).replace(' ','_')
            cands=[]
            for ext in ('.raw.txt','.ocr.txt','.txt'):
                p=f[:-4]+ext
                if os.path.exists(f'{S}/{p}') and os.path.getsize(f'{S}/{p}')>200: cands.append(p)
            ent={'role':role,'url':u,'pdf':f if os.path.exists(f'{S}/{f}') else None,'text':cands[0] if cands else None}
            if ent not in e['files']: e['files'].append(ent)
for L in m:
    for k,e in m[L].items(): e['indices']=sorted(x or '' for x in e['indices'])
json.dump(m,open(f'{S}/raw/planfiles.json','w'),ensure_ascii=False,indent=1)
for L in m: print(L,len(m[L]),'no text:',[k for k,e in m[L].items() if not any(f['text'] for f in e['files'])])
