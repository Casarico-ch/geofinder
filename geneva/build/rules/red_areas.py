"""red_areas.py view.json out_view_name seeds(x,y;...) [dil] [rgb r,g,b] [tol]
Flood-fill areas enclosed by red dashed outlines (aires de localisation) on a georeferenced view from seed points,
paint them pure green on a copy of the view (georef/<out_view_name>.png + .view.json) for build_areas.py masks."""
import sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
Image.MAX_IMAGE_PIXELS = None
vf, outname, seeds = sys.argv[1:4]
dil = int(sys.argv[4]) if len(sys.argv) > 4 else 13
rgb = list(map(int, sys.argv[5].split(','))) if len(sys.argv) > 5 else [230, 30, 30]
tol = int(sys.argv[6]) if len(sys.argv) > 6 else 90
v = json.load(open(vf)); im = Image.open(vf[:-10] + '.png').convert('RGB'); a = np.asarray(im).astype(int)
bar = (np.abs(a - np.array(rgb)).sum(axis=2) < tol) | (np.abs(a - np.array([0, 0, 255])).sum(axis=2) < 60)   # red outlines + drawn SITG perimeter
bimg = Image.fromarray((bar * 255).astype('uint8')).filter(ImageFilter.MaxFilter(dil | 1))
work = bimg.convert('L')
if len(sys.argv) > 7:   # walls 'x,y,x,y,...|...'
    dw = ImageDraw.Draw(work)
    for wl in sys.argv[7].split('|'):
        c = list(map(int, wl.split(','))); dw.line(list(zip(c[::2], c[1::2])), fill=255, width=dil)
for s in seeds.split(';'):
    x, y = map(int, s.split(','))
    if work.getpixel((x, y)) != 0: print('seed on barrier', x, y); continue
    ImageDraw.floodfill(work, (x, y), 128, thresh=0)
fill = Image.fromarray(((np.asarray(work) == 128) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(dil | 1))
f = np.asarray(fill) > 0
out = np.asarray(im).copy(); out[f] = [0, 255, 0]
Image.fromarray(out).save(f'georef/{outname}.png'); json.dump(v, open(f'georef/{outname}.view.json', 'w'))
print('filled px', int(f.sum()), 'of', f.size)
