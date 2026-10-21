"""Render a PDF page (or part) with a pixel grid labelled in PDF points. usage: pagegrid.py pdf page out.png dpi [x0 y0 x1 y1 in pt]"""
import sys, subprocess
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
pdf, page, out, dpi = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
s = dpi / 72
args = ['pdftoppm', '-f', str(page), '-l', str(page), '-r', str(dpi), '-png', '-singlefile']
x0 = y0 = 0
if len(sys.argv) > 8:
    x0, y0, x1, y1 = map(float, sys.argv[5:9]); args += ['-x', str(int(x0 * s)), '-y', str(int(y0 * s)), '-W', str(int((x1 - x0) * s)), '-H', str(int((y1 - y0) * s))]
subprocess.run(args + [pdf, out[:-4]], check=True)
im = Image.open(out).convert('RGB'); d = ImageDraw.Draw(im); W, H = im.size
step = 25 if dpi >= 150 else 50
import math
u = math.ceil(x0 / step) * step
while (u - x0) * s < W:
    X = (u - x0) * s; d.line([(X, 0), (X, H)], fill=(0, 170, 0)); d.text((X + 2, 2), str(int(u)), fill=(0, 120, 0)); u += step
v = math.ceil(y0 / step) * step
while (v - y0) * s < H:
    Y = (v - y0) * s; d.line([(0, Y), (W, Y)], fill=(0, 170, 0)); d.text((2, Y + 2), str(int(v)), fill=(200, 0, 0)); v += step
im.save(out); print(out, im.size)
