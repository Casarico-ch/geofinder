import sys,re,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from cites import C
BASE=sys.argv[1]
def norm(s): return re.sub(r'\s+',' ',s.replace('’',"'").replace('’',"'")).strip()
cache={}
bad=[]
for k,(law,art,al,f,q) in C.items():
    if f not in cache: cache[f]=norm(open(os.path.join(BASE,f),encoding='utf-8',errors='replace').read())
    if norm(q) not in cache[f]: bad.append(k)
print(len(C),'citations;',len(bad),'missing:',bad)
