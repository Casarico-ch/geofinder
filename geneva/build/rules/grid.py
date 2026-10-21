import sys
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS=None
im=Image.open(sys.argv[1]).convert('RGB'); d=ImageDraw.Draw(im); st=int(sys.argv[3]) if len(sys.argv)>3 else 100
W,H=im.size
for x in range(0,W,st):
    d.line([(x,0),(x,H)],fill=(0,170,0),width=1); 
    for y in range(0,H,st*2): d.text((x+2,y+2),str(x),fill=(0,140,0))
for y in range(0,H,st):
    d.line([(0,y),(W,y)],fill=(0,170,0),width=1)
    for x in range(0,W,st*2): d.text((x+2,y+12),str(y),fill=(200,0,0))
im.save(sys.argv[2])
