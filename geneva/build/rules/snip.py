import re,sys
KW=r"(gabarit|hauteur|niveaux?\b|R\s*\+\s*\d|indice|IUS|IBUS|densit|surface brute|SBP|surfaces? de plancher|distance|démoli|maintenu|destin|affect|implantation|toitur|attique|sous-sol|inconstructible|aire d'implantation|aire d’implantation|constructions? nouvelles?|agrandissement|m2|m²|mètres|\d+\s?m\b|zone \d|surélév)"
t=open(sys.argv[1],encoding='utf-8',errors='replace').read()
t=re.sub(r'-\n(?=[a-zà-ü])','',t)
t=re.sub(r'\s+',' ',t)
# split into sentences-ish
parts=re.split(r'(?<=[.;:])\s+(?=(?:\d+\s)?[A-ZÀ-Ü])|(?=\bArt\.?\s*\d)',t)
out=[];last=''
for p in parts:
    if re.search(KW,p,re.I) and len(p)<900:
        out.append(p.strip())
mx=int(sys.argv[2]) if len(sys.argv)>2 else 60
for p in out[:mx]: print('-',p)
