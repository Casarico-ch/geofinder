"""crop.py view_png_with_grid x0 y0 x1 y1 out [scale]  (coords in grid-label units = full-res view px)"""
import sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
im = Image.open(sys.argv[1]); x0, y0, x1, y1 = map(int, sys.argv[2:6]); sc = float(sys.argv[7]) if len(sys.argv) > 7 else 1
c = im.crop((x0, y0, x1, y1))
if sc != 1: c = c.resize((int(c.size[0] * sc), int(c.size[1] * sc)))
c.save(sys.argv[6]); print(c.size)
