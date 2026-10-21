import re,sys
pat=sys.argv[2]; w=int(sys.argv[3]) if len(sys.argv)>3 else 250
for f in sys.argv[1].split(','):
    t=open(f,encoding='utf-8',errors='replace').read()
    t=re.sub(r'-\n(?=[a-zà-ü])','',t); t=re.sub(r'\s+',' ',t)
    seen=-10**9
    for m in re.finditer(pat,t,re.I):
        if m.start()-seen<w: continue
        seen=m.start()
        print('>>',t[max(0,m.start()-60):m.start()+w].strip())
