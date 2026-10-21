"""How each plan's sectors are placed onto parcels (used by assign_sectors.py).
kinds:
  whole    - no sector-specific values; every parcel -> one sector (method 'layer': SITG perimeter)
  geojson  - georef/sectors_<file>.geojson polygons (method/confidence from the file)
  raster   - label raster on a georeferenced plan render (view json); 'unlabeled' sector for pixels without a label
  zone     - sector from the parcel's SITG zone codes (method 'layer'); map: code -> sector (dev codes 'D4BP/pre:AG' tried first)
  parcels  - parcel-number list (method 'manual'); 'default' for the others (None -> unplaced)
  unplaced - sectors exist but could not be placed; reason
Keys: 'PS <no>', 'RS <no>', 'PDZI <no>[-<indice>]'."""
W = {'kind': 'whole'}
C = {}
# ---- plans de site (RDPPF_PS)
for k in ['216', '27383', '27626', '27646', '28271', '28590', '29108', '29165', '29183', '29394', '29431', '29479', '29485', '29530',
          '29541', '29543', '29559', '29575', '29577', '29720', '29802', '29848', '29866', '29872', '29901', '29934', '29953', '29961',
          '29962', '29969', '30036', '30075', '30077', '30111', '30151', '30205', '79114', '810217']:
    C['PS ' + k] = W
C['PS 29790'] = {'kind': 'whole', 'sector': 'sub-perimeter valant plan de site (maintained buildings)',
                 'note': 'RDPPF_PS polygon of 29790 = the sub-perimeter valant plan de site; the PLQ part (density) is outside it'}
C['PS 29589'] = {'kind': 'whole', 'sector': '5'}            # parcel 1817, sub-perimeter 5 of 29184A
C['PS 30054'] = {'kind': 'whole', 'sector': '3'}            # chemin Thury, sub-perimeter 3 of 29184A
for k in ['29184', '29376', '29400', '29999', '30074']:
    C['PS ' + k] = {'kind': 'geojson', 'file': k}
C['PS 29827'] = {'kind': 'raster', 'view': 'georef/w29827.view.json', 'unlabeled': "secteurs d'aménagement",
                 'zone_override': {'V': 'zone de verdure (outside sectors)', 'AG': 'agricultural zone (outside sectors)'},
                 'confidence': 'medium', 'note': 'village ancien = red-outlined sector on plan 29827 (flood fill on georeferenced render)'}
C['PS 30216'] = {'kind': 'zone', 'map': {'5': 'zone 5 part', 'AG': 'agricultural part'}}
C['PS 29993'] = {'kind': 'zone', 'map': {'AG': 'agricultural zone'}, 'other': 'outside agricultural zone'}
C['PS 29718'] = {'kind': 'zone', 'map': {'4BP': 'zone 4B protégée (village, implantation areas 1-2)', 'AG': 'agricultural sub-perimeters A-D'}, 'other': 'other zones (forest, garden)'}
C['PS 28392'] = {'kind': 'detail', 'detail_plan': '28590', 'in': 'detail plan 28590 (Palais Wilson)', 'out': 'general perimeter'}
C['PS 30158'] = {'kind': 'detail', 'detail_plan': '28590', 'in': 'detail plan 28590 (Palais Wilson)', 'out': 'general perimeter'}
C['PS 29484'] = {'kind': 'parcels', 'parcels': {'13417': 'parcel 13417 (new school-extension area)'}, 'default': 'rest of perimeter'}
C['PS 29430'] = {'kind': 'parcels', 'parcels': {'2592': 'shopping centre (parcels 2592, 4320)', '4320': 'shopping centre (parcels 2592, 4320)'}, 'default': 'rest of perimeter'}
C['PS 29792'] = {'kind': 'parcels', 'parcels': {'1053': 'parcel 1053 (demolition condition)'}, 'default': 'rest of perimeter'}
C['PS 30079'] = {'kind': 'parcels', 'parcels': {n: 'parcels 866/1885/1410/1999/2000 (demolition condition)' for n in ('866', '1885', '1410', '1999', '2000')}, 'default': 'rest of perimeter'}
C['PS 29525'] = {'kind': 'unplaced', 'reason': 'sectors A/B/C are only drawn on the combined plan-règlement sheet 29525B, which could not be georeferenced (no usable parcel labels, perimeter not identifiable)'}
for k in ['27878', '28679', '30174']:
    C['PS ' + k] = {'kind': 'unplaced', 'reason': 'réserve naturelle / camping sub-perimeters A-C are only graphical on scanned sheets that could not be georeferenced'}
# ---- règlements spéciaux (RDPPF_RS)
for k in ['0', '27526', '27650', '27723', '27749', '28316', '4198']:
    C['RS ' + k] = W
for k in ['27304', '27425', '27275']:
    C['RS ' + k] = {'kind': 'geojson', 'file': k}
C['RS 26959'] = {'kind': 'zone', 'map': {'D4BP/pre:AG': 'secteur de développement', 'D4BP/pre:4BP': 'secteur de développement', '4BP': 'village actuel', 'AG': 'outside building sectors (agricultural)'}, 'other': 'other zones'}
C['RS 27283'] = {'kind': 'zone', 'map': {'4BP': 'sectors 1-3 (4B protégée)', 'D4BP/pre:5': 'sector 4 (zone 5)', '5': 'sector 4 (zone 5)', 'AG': 'outside building sectors (agricultural)'}, 'other': 'other zones'}
C['RS 4737'] = {'kind': 'unplaced', 'reason': 'blue (pitched-roof) and red (flat-roof) zones exist only on a 1935 photographed plan; cadastral subdivision has changed, georeferencing not reliable'}
# ---- PDZI (key NO_PLAN-INDICE as in parcels.pdzi_id)
for k in ['29362', '29702', '29292', '29745-A', '28689-A', '26615-N']:
    C['PDZI ' + k] = W
C['PDZI 29968'] = {'kind': 'geojson', 'file': '29968'}
for k in ['29975-A', '29975-B', '29994', '30097', '28667']:
    C['PDZI ' + k] = {'kind': 'geojson', 'file': k}
C['PDZI 28495-B'] = {'kind': 'geojson', 'file': '28495-B'}
C['PDZI 29976'] = {'kind': 'raster', 'view': 'georef/w29976.view.json', 'unlabeled': 'outside densification sectors (roads, green strips)',
                   'confidence': 'medium', 'note': 'densification sectors A-D = grey shades on the georeferenced plan 29976 (homography, residuals 1-6 m)'}
C['PDZI 29995'] = {'kind': 'parcels', 'confidence': 'medium',
                   'parcels': {'2110': 'A', '693': 'B', '3476': 'C', '3477': 'C', '1430': 'C', '3095': 'D', '3094': 'D', '3313': ('D', 0.2)},
                   'default': 'outside densification sectors (roads, forest, public spaces)',
                   'note': 'parcel labels on plan 29995 + sector areas (A 7305 m2 ~ parcel 2110; B 5552 ~ 693; C 6025 ~ 3476+3477+1430; D 2473 ~ 3094+3095+part of 3313)'}
C['PDZI 28460-B'] = {'kind': 'geojson', 'file': '28460-B'}
C['PDZI 27953'] = {'kind': 'unplaced', 'reason': 'gabarit figures per implantation sector read on the 1985 scanned plan, but sector outlines were not traced/georeferenced'}
C['RS 27353'] = {'kind': 'parcels', 'parcels': {'2135': 'parcels 2135/2265/2266 (rue de Lyon, R+5)', '2265': 'parcels 2135/2265/2266 (rue de Lyon, R+5)', '2266': 'parcels 2135/2265/2266 (rue de Lyon, R+5)', '2176': 'parcel 2176 (rue de la Servette, R+6 / R+7 corner)'}, 'default': None}
# manual per-parcel corrections from overlay checks (audit 3: #104, #118, #127): no_parcelle -> [(sector, share)]
C['RS 27304'] = dict(C['RS 27304'], overrides={'8500': [('4', 1.0)], '2509': [('1', 1.0)]}, override_note='audit-3 overlay of the parcel on plan 27304 (#104: west of the sector-1 boundary = sector 4; #127: wholly sector 1)')
C['RS 27425'] = dict(C['RS 27425'], overrides={'7871': [('C', 1.0)]}, override_note='audit-3 overlay on plan 27425 (#118: wholly in sector C, south of the road)')
# zone-consistency rules for low-res RS sector traces (audit 4): a parcel whose main SITG zone is incompatible with the traced
# sector is moved to the nearest compatible sector (règlements: individual-housing sectors use the zone-5 ratio, art. 129 LCI)
C['RS 27304']['zone_consistency'] = {'5': ['2', '2A', '3'], '4BP': ['1', '4'], '4B': ['5', '6', '7']}
C['RS 27425']['zone_consistency'] = {'5': ['C']}   # audit 7: only zone-5 villa land is moved (to C); building-zone pieces are never moved to D
