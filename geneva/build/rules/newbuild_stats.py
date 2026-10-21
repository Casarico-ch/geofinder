"""Counts of parcel-plan pairs (and distinct parcels) per new_buildings value from parcel_sectors.csv -> georef/newbuild_stats.json"""
import csv, json, collections
GE = __import__('os').environ.get('GENEVA_RULES_WORK', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', '..', 'work', 'rules'))
rows = list(csv.DictReader(open(f'{GE}/parcel_sectors.csv')))
pairs = collections.defaultdict(list)
for r in rows: pairs[(r['egrid'], r['plan'])].append(r)
by_val = collections.Counter(); drawn = collections.Counter(); per_parcel = collections.defaultdict(set)
for (e, p), rs in pairs.items():
    top = max(rs, key=lambda r: float(r['share']) if r['share'] else 0)
    v = top['new_buildings'] or 'unknown'
    by_val[v] += 1; per_parcel[v].add(e)
    if v == 'only_in_drawn_areas':
        b = top['build_area_share']
        if b == '': drawn['areas not traced'] += 1
        elif float(b) == 0: drawn['outside all drawn areas (no new building)'] += 1
        elif float(b) >= 0.98: drawn['inside drawn areas'] += 1
        else: drawn['partly inside drawn areas'] += 1
out = {'pairs_by_value': dict(by_val), 'parcels_by_value': {k: len(v) for k, v in per_parcel.items()}, 'only_in_drawn_areas_detail': dict(drawn), 'pairs': len(pairs)}
json.dump(out, open(f'{GE}/georef/newbuild_stats.json', 'w'), indent=1); print(json.dumps(out, indent=1))
