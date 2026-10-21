"""areas_from_sectors.py KEY 'sector1,sector2' label confidence note -> georef/build_areas_KEY.geojson from sectors_KEY.geojson"""
import sys, json
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
GE = __import__('os').environ.get('GENEVA_RULES_WORK', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', 'work', 'rules'))
key, secs, label, conf, note = sys.argv[1:6]
g = json.load(open(f'{GE}/georef/sectors_{key}.geojson'))
want = secs.split('|')
geo = unary_union([shape(f['geometry']) for f in g['features'] if f['properties']['sector'] in want])
json.dump(dict(type='FeatureCollection', properties=dict(plan=key, method=g['properties']['method'], confidence=conf, note=note, from_sectors=want),
               features=[dict(type='Feature', properties=dict(kind='build_area', label=label, how='sector polygons', area_m2=round(geo.area, 1)), geometry=mapping(geo))]),
          open(f'{GE}/georef/build_areas_{key}.geojson', 'w'))
print(key, round(geo.area))
