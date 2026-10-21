"""fill_white.py view.json outname seeds(x,y;..) [open_px] [dil] : flood-fill uncoloured land bounded by COLOURED AREAS
(saturated fills: roads, green spaces, water strips) and the drawn perimeter, ignoring thin lines (morphological opening).
Paints filled pixels pure green on a copy -> georef/<outname>.png/.view.json"""
import sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
Image.MAX_IMAGE_PIXELS = None
vf, outname, seeds = sys.argv[1:4]
SAT = int(sys.argv[6]) if len(sys.argv) > 6 else 35
op = int(sys.argv[4]) if len(sys.argv) > 4 else 7; dil = int(sys.argv[5]) if len(sys.argv) > 5 else 5
v = json.load(open(vf)); im = Image.open(vf[:-10] + '.png').convert('RGB'); a = np.asarray(im).astype(int)
sat = a.max(axis=2) - a.min(axis=2); lum = a.mean(axis=2)
m = Image.fromarray((((sat > SAT) | (lum < 120) | (lum < 236)) * 255).astype('uint8'))
m = m.filter(ImageFilter.MinFilter(op | 1)).filter(ImageFilter.MaxFilter(op | 1))          # keep only area fills
blue = (np.abs(a - np.array([0, 0, 255])).sum(axis=2) < 90)                                  # drawn perimeter line
bar = (np.asarray(m) > 0) | blue
work = Image.fromarray((bar * 255).astype('uint8')).filter(ImageFilter.MaxFilter(dil | 1)).convert('L')
for s in seeds.split(';'):
    x, y = map(int, s.split(','))
    if work.getpixel((x, y)) != 0: print('seed on barrier', x, y); continue
    ImageDraw.floodfill(work, (x, y), 128, thresh=0)
f = np.asarray(Image.fromarray(((np.asarray(work) == 128) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(dil | 1))) > 0
out = np.asarray(im).copy(); out[f] = [0, 255, 0]
Image.fromarray(out).save(f'georef/{outname}.png'); json.dump(v, open(f'georef/{outname}.view.json', 'w')); print('filled', int(f.sum()))
