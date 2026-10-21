"""gap_check.py -> georef/gap_check.json : per build_areas file, share of existing building footprints (CAD_BATIMENT_HORSOL,
>=20 m2, footprint >=50% inside the plan perimeter) whose footprint lies mostly (>50%) outside the drawn build areas.
Flag >20%. For plans de site the drawn areas are areas for NEW buildings, so existing buildings are expected outside them
(flag only meaningful where the drawn areas are the general building zones: PDZI aires de localisation, 29292 limits)."""
import sys, os, json, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
import bldg_lib
from shapely.geometry import shape
from shapely.ops import unary_union
LAY = {'PS': 'RDPPF_PS', 'PDZI': 'RDPPF_PDZI'}
pz = set(json.load(open(f'{GE}/pdzi.json'))['plans'])
out = {}
for f in sorted(glob.glob(f'{GE}/georef/build_areas_*.geojson')):
    key = f.split('build_areas_')[1][:-8]
    g = json.load(open(f))
    b = unary_union([shape(x['geometry']) for x in g['features'] if x['properties']['kind'] == 'build_area'])
    if b.is_empty: continue
    layer = 'RDPPF_PDZI' if key in pz else 'RDPPF_PS'
    gj = json.load(open(f'{GE}/raw/{layer}.geojson')); k0, ind = (key.split('-') + [None])[:2]
    per = unary_union([shape(x['geometry']) for x in gj['features'] if str(x['properties']['NO_PLAN']) == k0 and (ind is None or x['properties'].get('INDICE') == ind)]).buffer(0)
    B = [r for r in bldg_lib.in_geom(per, 0.5) if r[4].area >= 20]
    outside = [r for r in B if r[4].intersection(b).area < 0.5 * r[4].area]
    area_out = sum(r[4].area for r in outside); area_all = sum(r[4].area for r in B) or 1
    kind = 'PDZI building zones' if layer == 'RDPPF_PDZI' else 'plan de site new-building areas'
    out[key] = dict(kind=kind, confidence=g['properties'].get('confidence'), buildings=len(B), outside=len(outside),
                    share_outside=round(len(outside) / max(1, len(B)), 3), footprint_share_outside=round(area_out / area_all, 3),
                    flag=(layer == 'RDPPF_PDZI' and len(B) >= 3 and len(outside) / len(B) > 0.2))
    print(key, out[key])
json.dump(out, open(f'{GE}/georef/gap_check.json', 'w'), indent=1)
