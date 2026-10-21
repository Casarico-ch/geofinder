"""Classify sector areas on a georeferenced plan render by fill grey level / colour.
usage: shade_labels.py view.json spec.json
spec: {"classes": [["D",[134,134,134],12], ...], "grey": true}  -> <view>_labels.npy/json + _sectors.png"""
import sys, json, os
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
v = json.load(open(sys.argv[1])); spec = json.load(open(sys.argv[2])); base = sys.argv[1][:-10]
a = np.asarray(Image.open(base + '.png').convert('RGB')).astype(int)
lab = np.zeros(a.shape[:2], int); names = []
for i, (n, rgb, tol) in enumerate(spec['classes']):
    m = np.abs(a - np.array(rgb)).max(axis=2) <= tol
    if n not in names: names.append(n)
    lab[m & (lab == 0)] = names.index(n) + 1
np.save(base + '_labels.npy', lab); json.dump(names, open(base + '_labels.json', 'w'))
pal = [(230, 25, 75), (60, 180, 75), (255, 225, 25), (0, 130, 200), (245, 130, 48), (145, 30, 180)]
col = a.copy().astype('uint8')
for i in range(len(names)):
    m = lab == i + 1; col[m] = (0.3 * col[m] + 0.7 * np.array(pal[i])).astype('uint8')
Image.fromarray(col).save(base + '_sectors.png')
print(names, [(n, int((lab == i + 1).sum())) for i, n in enumerate(names)])
