"""areas_from_parcels.py LAYER KEY nos(comma) label confidence note -> georef/build_areas_KEY.geojson (whole parcels, clipped to perimeter)"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from georef_lib import *
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
layer, key, nos, label, conf, note = sys.argv[1:7]
gj = json.load(open(f'{GE}/raw/{layer}.geojson')); k0, ind = (key.split('-') + [None])[:2]
per = unary_union([shape(f['geometry']) for f in gj['features'] if str(f['properties']['NO_PLAN']) == k0 and (ind is None or f['properties'].get('INDICE') == ind)]).buffer(0)
nos = nos.split(',')
geo = unary_union([p['geom'] for p in parcels_in_bbox(*per.buffer(20).bounds) if p['no'] in nos and p['geom'].intersects(per)]).intersection(per.buffer(2))
json.dump(dict(type='FeatureCollection', properties=dict(plan=key, method='manual', confidence=conf, note=note),
               features=[dict(type='Feature', properties=dict(kind='build_area', label=label, how='parcels ' + ','.join(nos), area_m2=round(geo.area, 1)), geometry=mapping(geo))]),
          open(f'{GE}/georef/build_areas_{key}.geojson', 'w'))
print(key, round(geo.area))
