"""Flood-fill sector regions on a georeferenced plan render.
usage: sector_flood.py view.json spec.json   (spec: {"thr":70,"dil":5,"seeds":[["1",x,y],...], "rgb":null})
writes <view>_labels.npy and <view>_sectors.png"""
import sys, json, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
Image.MAX_IMAGE_PIXELS = None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
v = json.load(open(sys.argv[1])); spec = json.load(open(sys.argv[2]))
g = json.load(open(v['gfile'])); s = v['dpi'] / 72
base = sys.argv[1][:-10]
clean = base + '_clean.png'
if not os.path.exists(clean):
    im0 = Image.open(base + '.png'); W, H = im0.size
    subprocess.run(['pdftoppm', '-f', str(g['page']), '-l', str(g['page']), '-r', str(v['dpi']), '-x', str(int(v['x0'] * s)), '-y', str(int(v['y0'] * s)),
                    '-W', str(W), '-H', str(H), '-png', '-singlefile', g['pdf'], clean[:-4]], check=True)
im = Image.open(clean).convert('RGB'); a = np.asarray(im).astype(int)
if spec.get('rgb'):
    r, gg, b = spec['rgb']; tol = spec.get('tol', 60)
    bar = (abs(a[:, :, 0] - r) + abs(a[:, :, 1] - gg) + abs(a[:, :, 2] - b)) < tol
else:
    bar = a.max(axis=2) < spec.get('thr', 70)
for extra in spec.get('walls', []):   # manual barrier polylines in view px
    pass
bimg = Image.fromarray((bar * 255).astype('uint8'))
if spec.get('dil', 0) > 1: bimg = bimg.filter(ImageFilter.MaxFilter(spec['dil'] | 1))
dw = ImageDraw.Draw(bimg)
for wall in spec.get('walls', []): dw.line([tuple(p) for p in wall], fill=255, width=spec.get('wall_w', 5))
lab = Image.new('I', bimg.size, 0)
work = bimg.convert('L')
names = []
for i, (name, x, y) in enumerate(spec['seeds']):
    if name not in names: names.append(name)
    val = 10 + names.index(name) * 10
    if work.getpixel((x, y)) != 0: print('seed on barrier', name, x, y); continue
    ImageDraw.floodfill(work, (x, y), val, thresh=0)
L = np.asarray(work).astype(int)
labels = np.zeros(L.shape, int)
for i, n in enumerate(names): labels[L == 10 + i * 10] = i + 1
np.save(base + '_labels.npy', labels); json.dump(names, open(base + '_labels.json', 'w'))
pal = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180), (70, 240, 240), (240, 50, 230), (210, 245, 60), (250, 190, 212), (0, 128, 128), (170, 110, 40)]
col = np.asarray(im).copy()
for i in range(len(names)):
    m = labels == i + 1; col[m] = (0.5 * col[m] + 0.5 * np.array(pal[i % len(pal)])).astype('uint8')
out = Image.fromarray(col); d = ImageDraw.Draw(out)
for name, x, y in spec['seeds']: d.text((x, y), name, fill=(0, 0, 0))
out.save(base + '_sectors.png')
print('sectors', names, 'filled px', [(n, int((labels == i + 1).sum())) for i, n in enumerate(names)])
