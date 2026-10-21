"""parcel_share.py sectors_file egrid... -> sector shares of the given parcels"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape
S = [(f['properties'].get('sector') or f['properties'].get('label'), shape(f['geometry'])) for f in json.load(open(sys.argv[1]))['features']]
for e in sys.argv[2:]:
    r = con().execute('select geom,no_parcelle from parcels where egrid=?', (e,)).fetchone(); g = gpkg_geom(r[0])
    print(e, r[1], [(n, round(x.intersection(g).area / g.area, 2)) for n, x in S if x.intersects(g) and x.intersection(g).area > 1])
