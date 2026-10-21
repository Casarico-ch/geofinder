import sys, os, json, collections, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cites import C
BASE = sys.argv[1]
OUT = os.path.join(BASE, 'ge_rules', 'rules_catalogue.json')
attrs = json.load(open(os.path.join(BASE, 'ge_rules/raw/all_attrs.json')))

def cit(*ids):
    return list(ids)

# ---------------------------------------------------------------- shared blocks
COMMON_14 = ['LCI35.1', 'LCI36', 'LCI38', 'LCI45.1', 'LCI18.2']
ROOF_14 = {'rule': 'One habitable roof level within the roof gabarit: horizontal base line from the top of the facade gabarit (+ max 1.50 m projection), 35° oblique line, ridge max 4.80 m above base line.',
           'max_ridge_above_facade_m': 4.8, 'angle_deg': 35, 'base_projection_m': 1.5, 'cite': ['LCI36']}
NO_UG = {'rule': 'No statutory cap on underground floor area in zones 1-4; geotechnical report required for deep works (>4 m or several basement levels). Underground works count nowhere in gabarit.', 'cite': ['LCI44']}

def dense(code, label, layer, use, h, roof, dist, contig, dens, ug, plq, special, exc, extra=None):
    e = dict(code=code, layer=layer, label=label, use=use, height=h, roof=roof, distance=dist,
             contiguous=contig, density=dens, underground=ug, plq_effect=plq,
             special_regulation=special, exceptions=exc)
    if extra: e.update(extra)
    return e

PLQ_ORD = {'rule': 'Ordinary zone: no PLQ needed; if a PLQ (LExt) or règlement de quartier covers the parcel, its gabarits, implantation and distances prevail (heights reserved in LCI 19/23/27/32; distances reserved in LCI 45 al.3).',
           'cite': ['LCI23.7', 'LCI32.3', 'LCI45.3']}

EXC_DENSE = ['LCI10', 'LCI11.1', 'LCI11.3', 'LCI11.4', 'LCI11.5', 'LCI11.6', 'LCI12', 'LaLAT26.1', 'LaLAT26.2', 'LCI21.5']
EXC_ZONE4 = ['LCI10', 'LCI11.1', 'LCI11.3', 'LCI11.4', 'LCI11.6', 'LCI12', 'LCI33.4', 'LaLAT26.1', 'LaLAT26.2', 'LCI21.5']
EXC_Z5 = ['LCI59.4', 'LCI59.4bis', 'LCI59.3', 'LCI64', 'LCI70.3', 'LCI75.3', 'LCI10', 'LCI11.3', 'LCI12', 'LaLAT26.1']
EXC_OUT = ['LaLAT27', 'LaLAT27C', 'LaLAT24.3']

Z = {}

# ---------------------------------------------------------------- PRIM zones
Z['1'] = dense('1', 'Zone 1', 'RDPPF_ZONES_PRIM',
    {'text': "Large buildings for housing, commerce and tertiary activities; other non-nuisance activities admissible. Zone 1 = quarters of the Ville de Genève inside the former fortifications (in SITG: Saint-Gervais, Rues Basses, Tour-de-l'Île).", 'housing': True, 'cite': ['LaLAT19.1', 'LaLAT19.1a']},
    {'street_formula': 'H <= 5/4*D + 3 (D = distance between alignments); if D < 12 m: H <= 5/3*D + 3 and <= 18 m',
     'boundary_formula': 'H <= 5*D + 3 (from LCI 21 al.1)', 'absolute_max_m': 24, 'absolute_max_if_D_lt_12_m': 18,
     'measured_from': 'mean adjacent ground (LCI 35)', 'widest_street_governs': True,
     'cite': ['LCI19.1', 'LCI19.3', 'LCI19.4', 'LCI35.1', 'LCI38']},
    ROOF_14,
    {'formula': 'D >= (H - 3)/5', 'minimum_m': 4, 'between_buildings': 'sum of each building\'s boundary distance (LCI 45 al.1)', 'cite': ['LCI21.1', 'LCI21.3', 'LCI45.1']},
    {'allowed': True, 'rule': 'Building on the boundary of two private properties is allowed (mur en attente may require a plan d\'ensemble).', 'cite': ['LCI20.1']},
    {'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No floor-area ratio in zones 1-4: buildable volume = gabarit envelope.', 'cite': []},
    NO_UG, PLQ_ORD,
    {'text': 'Zone 1 itself is not a protected zone; protected sectors overlay it (Vieille-Ville LCI 83-88 via RDPPF_ZP; Rôtisserie-Pélisserie LCI 93A-93B applies arts 18-21 and 35-57; ensembles XIXe LCI 89-93).', 'overlays': ['ZP_VIEILLE_VILLE', 'ROTISSERIE_PELISSERIE', 'ENSEMBLES_XIX', 'PUS_VDG'], 'cite': ['LCI93B', 'LaLAT28']},
    EXC_DENSE, {'regime': 'zone à bâtir ordinaire (LaLAT 19 al.1)'})

Z['2'] = dense('2', 'Zone 2', 'RDPPF_ZONES_PRIM',
    {'text': 'Large buildings for housing, commerce and tertiary activities; quarters on the former fortifications and contiguous clearly urban quarters.', 'housing': True, 'cite': ['LaLAT19.1']},
    {'street_formula': 'H <= D + 3', 'boundary_formula': 'H <= 2*D + 3', 'absolute_max_m': 24,
     'surelevation': {'street_formula': 'H <= D + 6', 'boundary_formula': 'H <= 2*D + 6', 'absolute_max_m': 30,
                      'condition': 'only for additional housing and only for buildings on a surélévation map adopted by the Conseil d\'Etat (SITG SIT_SURELEVATION_BATIMENT)'},
     'cite': ['LCI23.1', 'LCI23.3', 'LCI23.4', 'LCI23.5', 'LCI23.6']},
    ROOF_14,
    {'formula': 'D >= (H - 3)/2; surélévation: D >= (H - 6)/2', 'minimum_m': 4, 'cite': ['LCI25.1', 'LCI25.2', 'LCI25.4', 'LCI45.1']},
    {'allowed': True, 'rule': 'Building on the private boundary allowed anywhere.', 'cite': ['LCI24.1']},
    {'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No floor-area ratio: envelope = gabarit.', 'cite': []},
    NO_UG, PLQ_ORD,
    {'text': 'Vieille-Ville and southern sector of former fortifications are zone 2 polygons with AFFCOMP "PERIMETRE PROTEGE DE LA VIEILLE VILLE" -> LCI 83-88 (height <= existing buildings). Ensembles XIXe/XXe (LCI 89-93) maintain cornice height and storeys. Praille-Acacias-Vernets: LCI 22-25 and 36-48 not applicable. Ville de Genève PUS applies.', 'overlays': ['ZP_VIEILLE_VILLE', 'ENSEMBLES_XIX', 'PAV', 'PUS_VDG', 'RS_VDG'], 'cite': ['LCI23.7', 'LCI87.1', 'LCI92.1', 'LCI17.2']},
    EXC_DENSE + ['LCI23.3'], {'regime': 'zone à bâtir ordinaire (LaLAT 19 al.1)'})

Z['3'] = dense('3', 'Zone 3', 'RDPPF_ZONES_PRIM',
    {'text': 'Large buildings for housing, commerce and tertiary activities; regions whose urbanisation is well advanced.', 'housing': True, 'cite': ['LaLAT19.1']},
    {'street_formula': 'H <= 3/4*D + 3', 'boundary_formula': 'H <= 5/3*D + 3', 'absolute_max_m': 21,
     'surelevation': {'street_formula': 'H <= 3/4*D + 6', 'boundary_formula': 'H <= 5/3*D + 6', 'absolute_max_m': 27,
                      'condition': 'additional housing; only in the quarters listed in LCI 27 al.4 and for buildings on an adopted surélévation map'},
     'cite': ['LCI27.1', 'LCI27.4', 'LCI27.5', 'LCI27.6']},
    ROOF_14,
    {'formula': 'D >= 3/5*(H - 3); surélévation: D >= 3/5*(H - 6)', 'minimum_m': 6, 'cite': ['LCI29.1', 'LCI29.2', 'LCI29.3', 'LCI45.1']},
    {'allowed': 'partial', 'rule': 'On the private boundary only within 20 m depth from the street alignment; beyond only if both owners build simultaneously at same height or against a mur en attente. Minor buildings only (LCI 43 al.2).', 'max_depth_m': 20, 'cite': ['LCI28.1', 'LCI28.2', 'LCI43.2']},
    {'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No floor-area ratio: envelope = gabarit.', 'cite': []},
    NO_UG, PLQ_ORD,
    {'text': 'Ensembles XIXe (LCI 89-93) and PUS Ville de Genève / PUS Carouge may apply depending on location.', 'overlays': ['ENSEMBLES_XIX', 'PUS_VDG', 'PUS_CAROUGE', 'PAV'], 'cite': ['LCI92.1']},
    EXC_DENSE + ['LCI23.3'], {'regime': 'zone à bâtir ordinaire (LaLAT 19 al.1)'})

def z4(code, label, cap, rural, special, extra_cite=()):
    return dense(code, label, 'RDPPF_ZONES_PRIM',
        {'text': 'Mainly residential buildings, in principle with several dwellings; non-nuisance activities admissible.' + (' Rural 4B applies to villages and hamlets; agricultural buildings (stables etc.) admissible.' if rural else ''), 'housing': True, 'cite': ['LaLAT19.2', 'LaLAT19.2b'] + (['LCI110.1'] if rural else [])},
        {'street_formula': 'H <= D/2 + 1', 'boundary_formula': 'H <= D + 1', 'absolute_max_m': cap, 'cite': ['LCI32.1', 'LCI32.3', 'LCI35.1'] + list(extra_cite)},
        ROOF_14,
        {'formula': 'D >= H - 1', 'minimum_m': 5, 'cite': ['LCI34.1', 'LCI34.2', 'LCI45.1']},
        {'allowed': 'partial', 'rule': 'Contiguous order is the rule; on the private boundary only within 20 m depth from the alignment (beyond: simultaneous agreement or mur en attente). Department may allow/impose isolated villas under zone 5 rules. Rebuilding in formed villages may derogate (33 al.4).', 'max_depth_m': 20, 'cite': ['LCI30.1', 'LCI30.2', 'LCI33.1', 'LCI33.4', 'LCI43.2']},
        {'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No statutory floor-area ratio in zone 4 (envelope = gabarit); village regulations (LCI 10) often fix IUS 0.2-0.6 — see overlays RS_*.', 'cite': []},
        NO_UG, PLQ_ORD, special, EXC_ZONE4, {'regime': 'zone à bâtir ordinaire (LaLAT 19 al.2)'})

Z['4A'] = z4('4A', 'Zone 4A (urbaine)', 15, False,
    {'text': 'Vieux-Carouge is a 4A polygon (RESTRIC "PERIMETRE PROTEGE DU VIEUX CAROUGE") -> LCI 94-104: 4A norms subject to plans de site; gabarit and number of storeys set by plans de site; roof 30-40°; boundary distance D >= 2/3 H, min 4 m. PUS Carouge applies there.', 'overlays': ['VIEUX_CAROUGE', 'PUS_CAROUGE', 'PUS_29188', 'PLANS_DE_SITE'], 'cite': ['LCI95.2', 'LCI98.1', 'LCI99.1', 'LCI101.1']})
Z['4B'] = z4('4B', 'Zone 4B (rurale)', 10, True,
    {'text': 'Village construction regulations (LCI art.10 règlements spéciaux, RDPPF_RS) may cap IUS and height (e.g. Puplinge 0.5/0.3, 7 m at the sablière).', 'overlays': ['RS_VILLAGES', 'PLANS_DE_SITE'], 'cite': ['RS27275.4', 'RS27275.5']})
Z['4BP'] = z4('4BP', 'Zone 4B protégée (villages protégés)', 10, True,
    {'text': 'Villages protégés (LCI 105-107): the department fixes case by case implantation, gabarit, volume and style on preavis of commune and CMNS, and may derogate from building/boundary distances and vues droites; otherwise zone 4B rural rules apply. Village regulations (RDPPF_RS) fix IUS and heights: Soral 0.35 / 7 m sablière; Collex-Bossy 0.4; Gy 0.2 / 7 m; Lully 0.4 / 7 m; Bernex 0.4-0.6 / max 3 levels + attic; plans de site (RDPPF_PS) prevail where adopted.', 'overlays': ['VILLAGES_PROTEGES', 'RS_VILLAGES', 'PLANS_DE_SITE'],
     'cite': ['LCI106.1', 'LCI107', 'RS26959.4', 'RS26959.3', 'RS27283.4', 'RSGy4', 'RSGy10', 'RS27425.4', 'RS27425.11', 'RS27304.4', 'RS27304.12']})
Z['4BP']['regime'] = 'zone à bâtir ordinaire + zone protégée (LaLAT 12 al.5, 28, 29 al.1 let.f; LCI 105-107)'
Z['4BP']['height']['note'] = 'Case-by-case gabarit fixed by the department (LCI 106 al.1); 10 m cap of rural zone 4 applies by default (LCI 107).'
Z['4BP']['height']['cite'] += ['LCI106.1', 'LCI107']
Z['4BP']['distance']['note'] = 'Department may derogate from boundary distances in protected villages (LCI 106 al.1).'
Z['4BP']['exceptions'] = Z['4BP']['exceptions'] + ['LCI106']

Z['5'] = dense('5', 'Zone 5 (villas)', 'RDPPF_ZONES_PRIM',
    {'text': 'Residential zone for villas; farms admissible; professional activity of the resident owner/tenant in part of the villa if no serious nuisance. In principle max 4 dwellings per building.', 'housing': True, 'max_dwellings_per_building': 4, 'cite': ['LaLAT19.3', 'LCI75.1']},
    {'street_formula': 'H <= D/2 + 1', 'boundary_formula': 'H <= D + 1', 'absolute_max_m': 10, 'measured_at': 'top of the roof slab (dalle de couverture)', 'cite': ['LCI61.2', 'LCI61.4']},
    {'rule': 'Flat roof or pitched roof max 35° (derogations for aesthetics or solar). Attic habitable when floor height respected on at least half its surface.', 'max_pitch_deg': 35, 'cite': ['LCI64.1', 'RCI24.2']},
    {'formula': 'D >= H - 1', 'minimum_m': 5, 'cite': ['LCI69.1', 'LCI69.2']},
    {'allowed': 'conditional', 'rule': 'No building above ground on the boundary, except (a) servitude + boundary wall treated as a facade, or (b) ordre contigu (>= 2 houses joined, each with own ground-level access), which the department may require a plan d\'ensemble for or refuse.', 'cite': ['LCI67', 'LCI67.2b', 'LCI58.1']},
    {'metric': 'SBP hors sol / parcel area (rapport des surfaces)',
     'by_right': {'standard': 0.25, 'HPE': 0.275, 'THPE': 0.30, 'cite': ['LCI59.1']},
     'by_derogation': [
        {'tier': '59 al.4 let.a', 'max': 0.44, 'max_THPE': 0.48, 'form': 'ordre contigu or habitat groupé', 'conditions': 'in a densification perimeter of an approved plan directeur communal (al.4) or, in communes without such perimeters, by derogation (al.4bis); consult commune + commission d\'architecture; compatible with character of quarter; LGZD 3A-3C taxes apply (al.5)', 'cite': ['LCI59.4', 'LCI59.4a', 'LCI59.4bis']},
        {'tier': '59 al.4 let.b', 'max': 0.55, 'max_THPE': 0.60, 'form': 'ordre contigu or habitat groupé', 'conditions': 'parcel or contiguous parcels > 5000 m2, municipal council deliberation agreeing, commission d\'architecture consulted', 'cite': ['LCI59.4b', 'LCI59.4bis']}],
     'minimum': None,
     'exclusions': 'Not applicable to agricultural buildings and public-interest buildings imposed by their purpose (al.11). Inside LPRLac perimeter: max 20% and al.4 not applicable. SITG SIT_PROG_DENS marks perimeters where the State grants no al.4 derogations.',
     'open_ground': 'a pleine-terre surface must be preserved (al.3bis, quantity not fixed in the law)',
     'cite': ['LCI59.1', 'LCI59.3bis', 'LCI59.4a', 'LCI59.4b', 'LCI59.11', 'LPRLac3.1']},
    {'rule': 'Basement floor area <= authorised above-ground floor area (al.1 ratio) and in all cases <= 20% of parcel (22% HPE, 24% THPE); basements not habitable.', 'max_ratio_of_parcel': {'standard': 0.20, 'HPE': 0.22, 'THPE': 0.24}, 'cite': ['LCI59.8', 'LCI59.9', 'LCI76.1']},
    {'rule': 'No PLQ required in ordinary zone 5; if a PLQ or règlement de quartier exists its provisions prevail (LCI 61 al.4 reserves PLQ for height; LCI 66/70 al.4 reserve PLQ/règlement de quartier for distances).', 'cite': ['LCI61.4']},
    {'text': 'LPRLac perimeter: max 20% floor area ratio and 2 levels flat roof / 1 level + habitable roof. Quarter regulations (e.g. Domaine de Ruth, Cologny: 6 m from boundaries; Hermance Tuilières: one dwelling per parcel).', 'overlays': ['LPRLAC', 'SIT_PROG_DENS', 'RS_QUARTIER', 'FORET_20M', 'EAUX_SI'], 'cite': ['LPRLac3.1', 'LPRLac7.1', 'RS4737.4', 'RS27526.1']},
    EXC_Z5, {'regime': 'zone à bâtir ordinaire (LaLAT 19 al.3)', 'minor_buildings': {'rule': 'constructions de peu d\'importance: <= 50 m2 each, 2.50 m wall / 4.50 m ridge, total <= 100 m2 and <= 8% of parcel; excluded from the ratio', 'cite': ['RCI3.1', 'RCI3.4']}})

def nonbuild(code, label, use, height_note, dist_note, special, exc, regime, extra_cites=(), ug=None, height=None, dist=None, contig=None, density=None, plq=None):
    return dict(code=code, layer='RDPPF_ZONES_PRIM', label=label, regime=regime, use=use,
        height=height or {'absolute_max_m': None, 'note': height_note, 'cite': list(extra_cites)},
        roof={'rule': 'No specific statutory roof rule.', 'cite': []},
        distance=dist or {'formula': None, 'minimum_m': None, 'note': dist_note, 'cite': []},
        contiguous=contig or {'allowed': None, 'rule': 'Not applicable (non-building zone).', 'cite': []},
        density=density or {'by_right': 0, 'by_derogation': None, 'minimum': None, 'note': 'No building rights for ordinary constructions.', 'cite': []},
        underground=ug or {'rule': 'Same restrictions as above ground.', 'cite': []},
        plq_effect=plq or {'rule': 'No PLQ regime; changes require a zone modification law (LaLAT 15).', 'cite': []},
        special_regulation=special, exceptions=exc)

Z['AG'] = dict(code='AG', layer='RDPPF_ZONES_PRIM', label='Zone agricole', regime='hors zone à bâtir (LaLAT 20-21; LAT 16a)',
    use={'text': 'Agricultural/horticultural/viticultural use; only buildings durably serving that activity and its full-time operators, respecting nature and landscape (OAT 34ff). Beyond internal development: plan localisé agricole (RDPPF_PLA).', 'housing': 'farm operator only', 'cite': ['LaLAT20.1', 'LaLAT20.7']},
    height={'street_formula': 'H <= D/2 + 1', 'boundary_formula': 'H <= D + 1', 'absolute_max_m': 10, 'note': 'Zone 5 norms apply to buildings in the agricultural zone; a plan localisé agricole (>= 5000 m2 projects) may derogate.', 'cite': ['LCI82.1', 'LCI61.4', 'LaLAT20.7']},
    roof={'rule': 'Zone 5 rule: flat or pitched max 35°.', 'max_pitch_deg': 35, 'cite': ['LCI82.1', 'LCI64.1']},
    distance={'formula': 'D >= H - 1', 'minimum_m': 5, 'cite': ['LCI82.1', 'LCI69.1', 'LCI69.2']},
    contiguous={'allowed': 'conditional', 'rule': 'Zone 5 rule (LCI 67); dwelling and farm buildings in principle grouped (LaLAT 21 al.1).', 'cite': ['LCI82.1', 'LCI67']},
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'LCI 59 ratio does not apply to agricultural buildings (al.11); need-based (LAT 16a / OAT 34). Existing non-conforming buildings: OAT 43 buildings follow zone 4 norms, others zone 5 norms (LaLAT 27C al.2).', 'cite': ['LCI59.11', 'LaLAT27C.2']},
    underground={'rule': 'No specific cap (LCI 59 not applicable to agricultural buildings).', 'cite': ['LCI59.11']},
    plq_effect={'rule': 'Plan localisé agricole (CE) needed beyond internal development; for >= 5000 m2 it fixes gabarit, destination and implantation.', 'cite': ['LaLAT20.7']},
    special_regulation={'text': 'Zone viticole protégée inside AG; LPRRhône/LPRVers perimeters; forest 20 m; watercourses 10/30/50 m.', 'overlays': ['LPRRHONE', 'LPRVERS', 'FORET_20M', 'EAUX_SI', 'PLA'], 'cite': ['LaLAT20.1']},
    exceptions=EXC_OUT)

Z['BF'] = nonbuild('BF', 'Zone des bois et forêts',
    {'text': 'Forest area as determined by the Forest Act; non-forest constructions prohibited (forest buildings only if needed and impossible outside forest).', 'housing': False, 'cite': ['LaLAT23.2', 'LFor14.1']},
    'No buildable envelope: non-forest constructions forbidden.', 'Neighbouring parcels: no construction within 20 m of the forest edge (derogation down to 10 m in building zone along an alignment).',
    {'text': 'Forest distance applies to adjacent parcels (RDPPF_DISTANCES_FORET, RDPPF_LIMITE_FORET). Chimneys >= 30 m from woods (10 m if spark-proof heating).', 'overlays': ['FORET_20M'], 'cite': ['LFor11.1', 'LFor11.2c', 'RCI41.1']},
    ['LFor11.2', 'LaLAT27'], 'zone à protéger / forêt (LaLAT 23; LForêts)', extra_cites=('LFor14.1',),
    dist={'formula': 'distance to forest edge >= 20 m', 'minimum_m': 20, 'derogation_minimum_m': 10, 'cite': ['LFor11.1', 'LFor11.2c']})

Z['V'] = nonbuild('V', 'Zone de verdure',
    {'text': 'Land open to public use for recreation, and cemeteries; constructions forbidden unless serving outdoor recreation / cemeteries. Exceptionally public-utility buildings imposed by purpose and farms.', 'housing': False, 'cite': ['LaLAT24.2', 'LaLAT24.3']},
    'No gabarit set by law; exceptional public-utility buildings judged case by case.', 'No statutory distance specific to the zone.',
    {'text': 'Several V polygons lie inside the Vieille-Ville protected perimeter (Bastions, Saint-Antoine...). RESTRIC on some polygons gives site-specific caps (e.g. "GABARIT 9M. MAXIMUM", "INTERDICTION DE BATIR").', 'overlays': ['ZP_VIEILLE_VILLE'], 'cite': ['LaLAT24.2']},
    ['LaLAT24.3', 'LaLAT27'], 'zone ordinaire de verdure, zone à protéger (LaLAT 24, 29 al.1 let.g)', extra_cites=('LaLAT24.2',))

Z['S'] = nonbuild('S', 'Zone sportive',
    {'text': 'Sports grounds and sport-related installations; important buildings (stands, halls, gyms, parkings) may require a prior PLQ.', 'housing': False, 'cite': ['LaLAT24.4']},
    'No gabarit set by law; important buildings via PLQ.', 'No statutory distance specific to the zone; LCI general provisions.',
    {'text': 'RESTRIC on some polygons fixes caps (e.g. "HAUTEUR MAXIMUM 12 METRES").', 'overlays': [], 'cite': []},
    ['LaLAT26.1'], 'zone ordinaire de verdure et délassement (LaLAT 24 al.4)', extra_cites=('LaLAT24.4',),
    plq={'rule': 'A PLQ (LExt art.3) may be required before buildings of a certain importance; it then fixes their envelope.', 'cite': ['LaLAT24.4']},
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No statutory ratio; sport installations only.', 'cite': []})

Z['JF'] = nonbuild('JF', 'Zone de jardins familiaux',
    {'text': 'Allotment-garden estates created by public bodies or non-profit groups.', 'housing': False, 'cite': ['LaLAT24.5']},
    'NOT DETERMINED BY STATUTE: no gabarit, cabin size or distance rule for this zone exists in LaLAT/LCI/RCI; set by each estate project/authorisation.', 'Not determined by statute.',
    {'text': 'No cantonal construction norm found for allotment cabins.', 'overlays': [], 'cite': []},
    ['LaLAT26.1'], 'zone ordinaire de verdure et délassement (LaLAT 24 al.5)', extra_cites=('LaLAT24.5',),
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'Not determined by statute.', 'cite': []})
Z['JF']['determined'] = 'partial'

Z['ER'] = nonbuild('ER', 'Zone des eaux et des rives',
    {'text': 'Zone to protect public and private waters (surface and groundwater, watercourses, banks and vegetation).', 'housing': False, 'cite': ['LaLAT29.1a']},
    'No buildable envelope; construction norms for lake/watercourse protection are defined by LEaux-GE.', 'Inconstructible strip: 10/30/50 m from a watercourse, 15/30/50 m from the lake (mapped in RDPPF_SI); espace réservé aux eaux kept free of buildings.',
    {'text': 'LEaux-GE arts 15-16; RDPPF_SI gives per-reach distance (10, 30 or 50 m).', 'overlays': ['EAUX_SI'], 'cite': ['LaLAT29.2', 'LEaux15.5', 'LEaux16.2']},
    ['LEaux16.5'], 'zone à protéger (LaLAT 29 al.1 let.a)', extra_cites=('LaLAT29.2', 'LEaux15.5'),
    dist={'formula': 'distance to watercourse >= 10|30|50 m; to lake >= 15|30|50 m (per RDPPF_SI.DISTANCE_INCONSTR)', 'minimum_m': 10, 'cite': ['LEaux16.2']},
    ug={'rule': 'Inconstructible strip applies underground too ("ni en sous-sol ni en élévation").', 'cite': ['LEaux16.2']})

Z['PNP'] = nonbuild('PNP', 'Zone de protection de la nature et du paysage (rives du Lac / Rhône / Versoix)',
    {'text': 'Protected-landscape zones of the shore laws: Rhône (no new construction except public-utility imposed by destination; small extension/transformation/rebuild of existing reserved); Lac and Versoix "secteur inconstructible" (no construction except public-interest/minor). Arve law applies via RDPPF_PNP overlay.', 'housing': False, 'cite': ['LaLAT29.1hk', 'LPRRh3.1', 'LPRLac2.1', 'LPRVers2.2d', 'LPRVers3.1']},
    'No buildable envelope for new buildings.', 'Inconstructible sectors; LEaux 16 distances also apply.',
    {'text': 'DESC_ZONE distinguishes: "rives du Rhône" (LPRRhône L 4 13), "rives du Lac (secteur inconstructible)" (LPRLac L 4 10), "rives de la Versoix (secteur inconstructible)" (LPRVers L 4 19). Arve: LPRArve L 4 16 art.6.', 'overlays': ['LPRLAC', 'LPRRHONE', 'LPRARVE', 'LPRVERS'], 'cite': ['LPRRh3.1', 'LPRLac2.1', 'LPRArve6.2', 'LPRVers3.1']},
    ['LaLAT27'], 'zone à protéger (LaLAT 29 al.1 let.h-k)', extra_cites=('LPRRh3.1', 'LPRLac2.1'))

Z['FE'] = dict(code='FE', layer='RDPPF_ZONES_PRIM', label='Zone ferroviaire', regime='zone à bâtir ordinaire (LaLAT 19 al.5)',
    use={'text': 'Railway installations, tracks, stations and railway-related activities; other buildings (e.g. over tracks) need a prior PLQ.', 'housing': False, 'cite': ['LaLAT19.5']},
    height={'street_formula': 'H <= D + 3', 'boundary_formula': 'H <= 2*D + 3', 'absolute_max_m': 24, 'note': 'Zone 2 norms (LCI 80 al.1); a PLQ for non-railway buildings may apply other norms than zone 3.', 'cite': ['LCI80.1', 'LCI23.1', 'LCI23.6']},
    roof=ROOF_14, distance={'formula': 'D >= (H - 3)/2', 'minimum_m': 4, 'cite': ['LCI80.1', 'LCI25.1', 'LCI25.4']},
    contiguous={'allowed': True, 'rule': 'Zone 2 rule (boundary building allowed).', 'cite': ['LCI80.1', 'LCI24.1']},
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No ratio (gabarit); PLQ fixes rights for non-railway buildings.', 'cite': []},
    underground=NO_UG,
    plq_effect={'rule': 'Non-railway buildings require a PLQ, which may set norms other than zone 3.', 'cite': ['LaLAT19.5']},
    special_regulation={'text': 'Federal railway law (plan approval) governs railway installations.', 'overlays': [], 'cite': []},
    exceptions=['LaLAT26.1', 'LCI11.4'])

def ind(code, label, use_cite, use_text, special, regime):
    return dict(code=code, layer='RDPPF_ZONES_PRIM', label=label, regime=regime,
        use={'text': use_text, 'housing': 'guardian housing only', 'cite': use_cite + ['LCI80.2']},
        height={'street_formula': 'H <= D + 3', 'boundary_formula': 'H <= 2*D + 3', 'absolute_max_m': 24, 'note': 'Industrial zone buildings follow zone 2 norms.', 'cite': ['LCI80.1', 'LCI23.1', 'LCI23.6']},
        roof=ROOF_14,
        distance={'formula': 'D >= (H - 3)/2', 'minimum_m': 4, 'note': 'Department may allow smaller distances between industrial buildings if work-room daylight not darkened (RCI 253).', 'cite': ['LCI80.1', 'LCI25.1', 'LCI25.4', 'LCI81', 'RCI253']},
        contiguous={'allowed': 'restricted', 'rule': 'On the boundary only murs en attente, minor buildings, underground and low buildings (<= 7 m wall + 30°).', 'cite': ['RCI252']},
        density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No statutory ratio (gabarit); plans directeurs de zone industrielle (RDPPF_PDZI) may fix min/max IUS.', 'cite': ['LZIAM2.1']},
        underground={'rule': 'Underground buildings allowed on the boundary (RCI 252 al.1 let.c).', 'cite': ['RCI252']},
        plq_effect={'rule': 'Ordinary industrial zone: no PLQ needed; PLQ/plan directeur prevails where adopted.', 'cite': ['LCI45.3']},
        special_regulation=special, exceptions=['LCI81', 'RCI253', 'LaLAT26.1', 'LCI11.4'])

Z['IA'] = ind('IA', 'Zone industrielle et artisanale', ['LaLAT19.4'], 'Industrial, artisanal and railway buildings (production activities); housing only for guarding.',
    {'text': 'RDPPF_PDZI plans directeurs where adopted; AFFCOMP/RESTRIC on polygons (e.g. "RESERVEE A L\'ARTISANAT ET A L\'INDUSTRIE LEGERE NON POLLUANTE").', 'overlays': ['PDZI'], 'cite': ['LZIAM2.1']}, 'zone à bâtir ordinaire (LaLAT 19 al.4)')
Z['AE'] = ind('AE', 'Zone aéroportuaire', ['LaLAT19.6'], 'Reserved for airport buildings and installations; built under industrial-zone rules; State pre-emption right.',
    {'text': 'Airport safety heights (plan 20158, RCI 43) cap cranes and constructions; federal aviation law (PSIA) governs airport installations.', 'overlays': [], 'cite': ['RCI43']}, 'zone à bâtir ordinaire (LaLAT 19 al.6)')

Z['EP'] = dict(code='EP', layer='RDPPF_ZONES_PRIM', label="Zone affectée à de l'équipement public", regime='zone à bâtir ordinaire (LaLAT 19 al.8)',
    use={'text': 'Buildings other than housing needed for public equipment of the State, communes or public-law bodies; pre-emption right.', 'housing': False, 'cite': ['LaLAT19.8use']},
    height={'street_formula': 'H <= 3/4*D + 3', 'boundary_formula': 'H <= 5/3*D + 3', 'absolute_max_m': 21, 'note': 'Zone 3 norms unless the zoning law says otherwise.', 'cite': ['LaLAT19.8', 'LCI27.1', 'LCI27.6']},
    roof=ROOF_14,
    distance={'formula': 'D >= 3/5*(H - 3)', 'minimum_m': 6, 'cite': ['LaLAT19.8', 'LCI29.1', 'LCI29.3']},
    contiguous={'allowed': 'partial', 'rule': 'Zone 3 rule: boundary building within 20 m depth from alignment.', 'cite': ['LaLAT19.8', 'LCI28.1']},
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'No ratio (gabarit).', 'cite': []},
    underground=NO_UG, plq_effect=PLQ_ORD,
    special_regulation={'text': 'Zone modification law may set other norms (check LIEN_LOI of the polygon).', 'overlays': [], 'cite': ['LaLAT19.8']},
    exceptions=EXC_DENSE)

Z['H'] = dict(code='H', layer='RDPPF_ZONES_PRIM', label='Zone de hameaux', regime='zone spéciale (LaLAT 22; LAT 18)',
    use={'text': 'Special zone protecting hamlets; a building permit requires a prior plan de site.', 'housing': True, 'cite': ['LaLAT22.2']},
    height={'street_formula': 'H <= D/2 + 1', 'boundary_formula': 'H <= D + 1', 'absolute_max_m': 10, 'note': 'Rural zone 4 norms unless the plan de site sets otherwise.', 'cite': ['LaLAT22.3', 'LCI32.1', 'LCI32.3']},
    roof=ROOF_14,
    distance={'formula': 'D >= H - 1', 'minimum_m': 5, 'cite': ['LaLAT22.3', 'LCI34.1', 'LCI34.2']},
    contiguous={'allowed': 'partial', 'rule': 'Zone 4 rule: contiguous order is the rule, boundary building within 20 m depth.', 'cite': ['LaLAT22.3', 'LCI30.1', 'LCI33.1']},
    density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'Fixed by the plan de site (LPMNS 38).', 'cite': ['LPMNS38.2']},
    underground=NO_UG,
    plq_effect={'rule': 'Plan de site (LPMNS 38) is mandatory before any permit and overrides zone-4 norms.', 'cite': ['LaLAT22.2', 'LPMNS38.2']},
    special_regulation={'text': 'Plan de site of the hamlet (RDPPF_PS).', 'overlays': ['PLANS_DE_SITE'], 'cite': ['LPMNS38.2']},
    exceptions=['LCI13', 'LCI33.4', 'LaLAT26.1'])

# ---------------------------------------------------------------- DEV zones
def dev(code, label, ordinary, mind, use, h, d, contig, extra_special, cites_h, cites_d, plq_extra=None, regime=None):
    e = dict(code=code, layer='RDPPF_ZONES_DEV', label=label, regime=regime or 'zone de développement (LaLAT 12 al.4, 30; LGZD)',
        use=use, height=h, roof=ROOF_14 if ordinary != '5' else {'rule': 'Zone 5 rule: flat or pitched max 35°.', 'max_pitch_deg': 35, 'cite': ['LCI64.1']},
        distance=d, contiguous=contig,
        density={'metric': 'indice de densité ID = SBP (logements+activités) / surface nette; IUS = SBP / surface totale',
                 'by_right': {'note': 'No statutory maximum: the PLQ fixes IUS, ID and the rights table (LGZD 3 al.1 let.g).', 'cite': ['LGZD3.1g', 'LGZD2A.4']},
                 'by_derogation': {'note': 'PLQ/permit may go below the minimum ID for urban/architectural quality, heritage or other public interest.', 'cite': ['LGZD2A.3']},
                 'minimum': mind,
                 'without_plq': 'pre-existing zone (ZONE_PREEX) rules apply unless the CE authorises dev-zone norms',
                 'cite': ['LGZD2A.1', 'LGZD2A.2', 'LGZD2A.3']},
        underground=NO_UG if ordinary != '5' else {'rule': 'Zone 5 rule: basement <= authorised above-ground area and <= 20/22/24% of parcel.', 'cite': ['LCI59.8', 'LCI59.9']},
        plq_effect={'with_plq': 'Building to dev-zone norms requires a PLQ (with règlement) approved by the CE; projects must conform to it (IUS/ID respected, small deviations allowed).',
                    'without_plq': 'Department applies the norms of the pre-existing zone that the dev zone overlays (SITG field ZONE_PREEX), unless CE waives the PLQ (LGZD 2 al.2: 5th-zone dev perimeters, public-equipment dev zones, heavily urbanised quarters, plan directeur de quartier, 1st-prize competition) - then dev-zone norms with permit conditions.',
                    'housing_mix': 'LGZD 4A: >= 1/3 LUP + >= 1/3 ZDLOC rental (not in D4B / D4BP).',
                    'cite': ['LGZD2.1', 'LGZD2.2', 'LaLAT12.4', 'LGZD3.5', 'LGZD4A.1', 'LGZD4A.4'] + (plq_extra or [])},
        special_regulation=extra_special,
        exceptions=['LGZD2.2', 'LGZD2A.3', 'LGZD3.5', 'LCI10', 'LCI11.4', 'LaLAT26.1'])
    e['height']['cite'] = cites_h; e['distance']['cite'] = cites_d
    e['ordinary_zone_equivalent'] = ordinary
    return e

def h_of(code):
    h = json.loads(json.dumps(Z[code]['height'])); return h
def d_of(code):
    return json.loads(json.dumps(Z[code]['distance']))

USE_DENSE = {'text': 'Dev zone for housing, commerce and tertiary activities (artisanal activities may be authorised by the CE).', 'housing': True, 'cite': ['LaLAT30', 'LGZD2.1']}
Z['D2'] = dev('D2', 'Zone de développement 2', '2', {'ID_min': 2.5, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('2'), d_of('2'), Z['2']['contiguous'],
    {'text': 'Gabarit of zone 2 (24 m; surélévation up to 30 m; LGZD 12 al.3 surélévations may depart from pre-24.11.2009 PLQs).', 'overlays': ['PUS_VDG'], 'cite': ['LGZD12.3']}, Z['2']['height']['cite'], Z['2']['distance']['cite'])
Z['D3'] = dev('D3', 'Zone de développement 3', '3', {'ID_min': 1.8, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('3'), d_of('3'), Z['3']['contiguous'],
    {'text': 'Zone 3 norms apply in the historical D3 agglomeration perimeter (LGZD 11 al.2); PUS VdG sector 3: >= 80% housing in dev zones; PUS 29188 (Carouge) islands.', 'overlays': ['PUS_VDG', 'PUS_29188'], 'cite': ['LGZD11.2', 'LGZD12.3', 'PUS7.2']}, Z['3']['height']['cite'] + ['LGZD11.2'], Z['3']['distance']['cite'])
Z['D4A'] = dev('D4A', 'Zone de développement 4A', '4A', {'ID_min': 1.0, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('4A'), d_of('4A'), Z['4A']['contiguous'],
    {'text': 'Gabarit of zone 4A (15 m).', 'overlays': [], 'cite': []}, Z['4A']['height']['cite'], Z['4A']['distance']['cite'])
Z['D4AP'] = dev('D4AP', 'Zone de développement 4A protégée', '4A', {'ID_min': 1.0, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('4A'), d_of('4A'), Z['4A']['contiguous'],
    {'text': 'Single polygon (Versoix, route de Suisse / ch. des Graviers, zoning law 11289 of 20.12.2013, plan 29818). The law sets only noise degrees; "protégée" = protected zone (LaLAT 12 al.5) with no quantified extra limits in the law -> gabarit case by case by the department; zone 4A dev norms otherwise.', 'overlays': [], 'cite': ['LaLAT12.5']}, Z['4A']['height']['cite'], Z['4A']['distance']['cite'])
Z['D4AP']['determined'] = 'partial'
Z['D4B'] = dev('D4B', 'Zone de développement 4B', '4B', {'ID_min': 0.8, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('4B'), d_of('4B'), Z['4B']['contiguous'],
    {'text': 'Gabarit of rural zone 4B (10 m); LGZD 4A housing categories do not apply.', 'overlays': ['RS_VILLAGES'], 'cite': ['LGZD4A.4']}, Z['4B']['height']['cite'], Z['4B']['distance']['cite'])
Z['D4BP'] = dev('D4BP', 'Zone de développement 4B protégée', '4BP', {'ID_min': 0.8, 'cite': ['LGZD2A.2']}, USE_DENSE, h_of('4BP'), d_of('4BP'), Z['4BP']['contiguous'],
    {'text': 'Protected villages regime (LCI 105-107) on top of dev-zone rules; PLQ may be worth plan de site; village regulations (e.g. Soral 0.35 / 0.2) apply.', 'overlays': ['VILLAGES_PROTEGES', 'RS_VILLAGES', 'PLANS_DE_SITE'], 'cite': ['LCI106.1', 'LCI107', 'LGZD4A.4', 'RS26959.4']}, Z['4BP']['height']['cite'], Z['4BP']['distance']['cite'])
Z['D5'] = dev('D5', 'Zone de développement 5', '5', {'ID_min': None, 'note': 'No minimum ID for dev 5 in LGZD 2A al.2.', 'cite': ['LGZD2A.2']},
    {'text': 'Residential villa dev zone; PLQ may be waived (LGZD 2 al.2 let.a) and art.4/5 conditions do not apply; LCI 59 al.4-5 reserved.', 'housing': True, 'cite': ['LGZD2.1', 'LGZD2.2a']},
    h_of('5'), d_of('5'), Z['5']['contiguous'],
    {'text': 'Zone 5 envelope; density per LCI 59 (25/27.5/30%, 44/48 and 55/60% by derogation).', 'overlays': ['SIT_PROG_DENS'], 'cite': ['LCI59.1', 'LCI59.4a', 'LCI59.4b']}, Z['5']['height']['cite'], Z['5']['distance']['cite'])
Z['D5']['density']['by_right'] = Z['5']['density']['by_right']; Z['D5']['density']['by_derogation'] = Z['5']['density']['by_derogation']
Z['D5']['density']['cite'] += ['LCI59.1']

def act(code, label, use, special, mixed):
    return dict(code=code, layer='RDPPF_ZONES_DEV', label=label, regime='zone de développement industriel / activités mixtes (LaLAT 30; LZIAM)',
        use=use,
        height=dict(Z['IA']['height'], note=('Mixed-activity zone meets the norms of one of the first 4 zones as fixed by the zoning plan / plan directeur / PLQ; no statutory default height.' if mixed else 'With CE authorisation, industrial-zone norms = zone 2 gabarit (24 m); plan directeur may fix gabarits.')),
        roof=ROOF_14, distance=Z['IA']['distance'], contiguous=Z['IA']['contiguous'],
        density={'by_right': None, 'by_derogation': None, 'minimum': None, 'note': 'Plan directeur may fix min and max IUS per sector (LZIAM 2 al.1 let.l); building rights registered (LZIAM 3B).' + (' DAM: >= 60% of SBP for secondary-sector activities.' if mixed else ''), 'cite': ['LZIAM2.1'] + (['LZIAM1.2'] if mixed else [])},
        underground=Z['IA']['underground'],
        plq_effect={'with_plan': 'CE may authorise industrial / mixed-zone norms after approval of plan + règlement directeur (or PLQ).', 'without_plan': 'Pre-existing zone (ZONE_PREEX) norms; CE may waive the plan in heavily built sectors, per plan directeur de quartier, or 1st-prize competition.', 'cite': ['LZIAM4.1', 'LZIAM4.3', 'LaLAT12.4']},
        special_regulation=special, exceptions=['LZIAM4.3', 'RCI253', 'LCI81', 'LaLAT26.1'])

Z['DIA'] = act('DIA', 'Zone de développement industriel et artisanal',
    {'text': 'Industrial, artisanal and railway buildings (secondary sector); housing only for guarding.', 'housing': 'guardian housing only', 'cite': ['LaLAT19.4', 'LZIAM4.1', 'LCI80.2']},
    {'text': 'Plans directeurs de zones industrielles (RDPPF_PDZI: ZIMEYSA, ZIPLO, ZIBAT, Pallanterie, ...). RESTRIC on polygons often fixes max SBP or airport safety height.', 'overlays': ['PDZI'], 'cite': ['LZIAM2.1', 'RCI43']}, False)
Z['DIA']['height']['cite'] = ['LZIAM4.1', 'LCI80.1', 'LCI23.1', 'LCI23.6']
Z['DAM'] = act('DAM', "Zone de développement d'activités mixtes",
    {'text': 'Mixed secondary + tertiary activities (incl. cultural/festive); min 60% SBP secondary sector; PLQ or plan directeur required.', 'housing': False, 'cite': ['LZIAM1.2', 'LaLAT19.7']},
    {'text': 'Lancy, Pont-Butin/Morgines (zoning law 11808, plan 29959): law sets noise degree IV only; norms come from PLQ / plan directeur.', 'overlays': [], 'cite': ['LaLAT19.7', 'LZIAM1.2']}, True)
Z['DAM']['height'] = {'street_formula': None, 'absolute_max_m': None, 'note': 'Norms of one of the first 4 zones as fixed by the zoning plan / PLQ / plan directeur (LaLAT 19 al.7); not fixed by statute.', 'cite': ['LaLAT19.7']}
Z['DAM']['determined'] = 'plan-dependent'

# ---------------------------------------------------------------- derogations catalogue
EXCEPTIONS = {
 'LCI10': {'name': 'Règlements spéciaux (special regulations)', 'effect': 'CE may set lower or higher heights, occupation limits, character and destination in a defined perimeter.', 'zones': 'all building zones', 'cite': ['LCI10.1', 'LCI10.2']},
 'LCI11.1': {'name': 'Harmonisation with contiguous pre-1940 buildings', 'effect': 'Department may prescribe lower or higher heights to match immediately contiguous buildings authorised before 1.5.1940 or justified by quarter character.', 'zones': '1-4, dev', 'cite': ['LCI11.1']},
 'LCI11.3': {'name': 'Reduced floor height', 'effect': 'Gabarit may be exceeded when storey height reduced to 2.40 m.', 'zones': 'all', 'cite': ['LCI11.3']},
 'LCI11.4': {'name': 'Height exceedance on large free plots', 'effect': 'Gabarit may be exceeded if free surface protects neighbours, IUS from strict law not exceeded, skyline preserved, aesthetic justification.', 'zones': 'all', 'cite': ['LCI11.4']},
 'LCI11.5': {'name': 'Habitable ground floor bonus', 'effect': '+1 m above max height in zones 1-3 when ground floor is habitable and legal distances are respected (granted as of right: "autorise").', 'zones': '1, 2, 3 (and EP/IA/FE via zone 2/3 norms)', 'delta_m': 1, 'cite': ['LCI11.5']},
 'LCI11.6': {'name': 'Different gabarits per face', 'effect': 'Department may apply different gabarits on the faces of a building.', 'zones': '1-4', 'cite': ['LCI11.6']},
 'LCI12': {'name': 'Old buildings (pre-7.5.1961)', 'effect': 'Derogations for hygiene/safety; attic conversions with 2.40 m height and derogation from distances/vues droites.', 'zones': 'all', 'cite': ['LCI12.1', 'LCI12.2']},
 'LCI21.5': {'name': 'Corner distances', 'effect': 'Derogation from corner-distance rule for pre-1940 groups or continuous contiguous groups.', 'zones': '1-4', 'cite': ['LCI21.5']},
 'LCI23.3': {'name': 'Surélévation (additional housing)', 'effect': 'Zone 2: H <= D+6 / 30 m; zone 3: H <= 3/4 D + 6 / 27 m, only for buildings on adopted surélévation maps.', 'zones': '2, 3, D2, D3', 'cite': ['LCI23.3', 'LCI23.4', 'LCI23.5', 'LCI23.6', 'LCI27.4', 'LCI27.5', 'LCI27.6']},
 'LCI33.4': {'name': 'Rebuilding in formed villages', 'effect': 'Derogation from boundary-building rule when old buildings are rebuilt in villages.', 'zones': '4, H', 'cite': ['LCI33.4']},
 'LCI59.4': {'name': 'Zone 5 densification (perimeters of plan directeur communal)', 'effect': '44%/48% THPE; 55%/60% THPE on > 5000 m2 with municipal deliberation.', 'zones': '5, D5', 'cite': ['LCI59.4', 'LCI59.4a', 'LCI59.4b']},
 'LCI59.4bis': {'name': 'Zone 5 densification (communes without perimeters)', 'effect': 'Same tiers as al.4 by derogation.', 'zones': '5, D5', 'cite': ['LCI59.4bis']},
 'LCI59.3': {'name': 'Zone 5 floor-area exclusions', 'effect': 'Low attics (<1.8 m), minor attics, modest integrated garages, light winter gardens may be excluded from the ratio.', 'zones': '5', 'cite': ['LCI59.3bis']},
 'LCI64': {'name': 'Zone 5 roof pitch', 'effect': 'Derogation from 35° max for aesthetics or solar.', 'zones': '5', 'cite': ['LCI64.1']},
 'LCI70.3': {'name': 'Zone 5 distances between buildings', 'effect': 'Derogation for satisfactory architecture with rational and healthy layouts.', 'zones': '5', 'cite': ['LCI70.3']},
 'LCI75.3': {'name': 'Zone 5 number of dwellings', 'effect': 'More than 4 dwellings for contiguous / grouped housing.', 'zones': '5', 'cite': ['LCI75.1']},
 'LCI81': {'name': 'Industrial distances', 'effect': 'RCI sets derogations to distances between buildings (no darkening of work rooms).', 'zones': 'IA, AE, DIA, DAM', 'cite': ['LCI81', 'RCI253']},
 'RCI253': {'name': 'Industrial building distances', 'effect': 'Smaller distances between industrial buildings if work-room daylight preserved; not at boundary except low buildings or agreement.', 'zones': 'IA, AE, DIA', 'cite': ['RCI253']},
 'LCI106': {'name': 'Protected villages', 'effect': 'Department fixes implantation/gabarit/volume case by case; may derogate from distances and vues droites.', 'zones': '4BP, D4BP', 'cite': ['LCI106.1']},
 'LCI13': {'name': 'Destination / zone-edge / hamlet derogations', 'effect': 'Refers to LaLAT 22, 26, 27.', 'zones': 'all', 'cite': ['LCI13']},
 'LaLAT26.1': {'name': 'Nature of construction', 'effect': 'Department may derogate from the zone\'s allowed use if no serious inconvenience.', 'zones': 'building zones', 'cite': ['LaLAT26.1']},
 'LaLAT26.2': {'name': 'Zone-edge bonus', 'effect': 'Building at/over a zone limit adjoining zone 3 or 4 may benefit from that zone\'s norms.', 'zones': 'building zones next to 3/4', 'cite': ['LaLAT26.2']},
 'LaLAT24.3': {'name': 'Green zone public-utility buildings', 'effect': 'Exceptional public-utility buildings imposed by destination and farms.', 'zones': 'V', 'cite': ['LaLAT24.3']},
 'LaLAT27': {'name': 'Outside building zones (LAT 24)', 'effect': 'Only if location imposed by destination and no overriding interest.', 'zones': 'AG, BF, V, PNP, ER', 'cite': ['LaLAT27']},
 'LaLAT27C': {'name': 'Existing non-conforming buildings outside building zones', 'effect': 'Renovation/partial transformation/measured extension (LAT 24c); zone 4 or zone 5 norms.', 'zones': 'AG etc.', 'cite': ['LaLAT27C.2']},
 'LGZD2.2': {'name': 'PLQ waiver', 'effect': 'CE may waive PLQ in dev 5, public-equipment dev zones, urbanised quarters, plan directeur de quartier, competition 1st prize.', 'zones': 'D*', 'cite': ['LGZD2.2']},
 'LGZD2A.3': {'name': 'Below-minimum density', 'effect': 'PLQ/permit may go below min ID for quality, heritage or public interest.', 'zones': 'D2, D3, D4A, D4B', 'cite': ['LGZD2A.3']},
 'LGZD3.5': {'name': 'Deviation from PLQ', 'effect': 'Department may admit deviations from the PLQ if IUS and ID respected (technical or public-interest reasons, e.g. extra housing).', 'zones': 'D*', 'cite': ['LGZD3.5']},
 'LZIAM4.3': {'name': 'Plan directeur waiver (industrial)', 'effect': 'CE may waive the plan/règlement directeur or PLQ.', 'zones': 'DIA, DAM', 'cite': ['LZIAM4.3']},
 'LFor11.2': {'name': 'Forest distance derogation', 'effect': 'Down to 10 m in building zone along alignment; public-interest or minor works.', 'zones': 'all near forest', 'cite': ['LFor11.2c']},
 'LEaux16.5': {'name': 'Watercourse distance derogation', 'effect': 'For public-interest, water-related, minor objects outside espace minimal, lake-side pools.', 'zones': 'all near water', 'cite': ['LEaux16.5']},
 'PUS14': {'name': 'PUS derogation (Ville de Genève)', 'effect': 'Exceptional derogation when a more judicious use imperatively requires it.', 'zones': 'Ville de Genève', 'cite': ['PUS14']},
}

# ---------------------------------------------------------------- overlays
OVERLAYS = {
 'ZP_VIEILLE_VILLE': {'source': 'RDPPF_ZP + AFFCOMP "PERIMETRE PROTEGE DE LA VIEILLE VILLE" (zone 2 / V polygons)', 'rule': 'Existing buildings maintained; street alignments maintained; height <= existing buildings; general LCI otherwise.', 'cite': ['LCI83.2', 'LCI84', 'LCI86', 'LCI87.1']},
 'ROTISSERIE_PELISSERIE': {'source': 'RDPPF_ZP (Vieille Ville - Secteur Rôtisserie-Pélisserie)', 'rule': 'Single ensemble (housing, offices, underground garage); zone 1 rules arts 18-21 and 35-57 apply.', 'cite': ['LCI93B']},
 'ENSEMBLES_XIX': {'source': 'Department\'s indicative list (not an RDPPF layer)', 'rule': 'Complete ensembles maintained; on rebuild, cornice height and number of levels maintained.', 'cite': ['LCI90.1', 'LCI92.1']},
 'VIEUX_CAROUGE': {'source': 'zone 4A polygon RESTRIC "PERIMETRE PROTEGE DU VIEUX CAROUGE" (plan 20427)', 'rule': '4A urban norms subject to plans de site; gabarit and storeys from plans de site; roof 30-40°; boundary distance >= 2/3 H, min 4 m.', 'cite': ['LCI95.2', 'LCI98.1', 'LCI99.1', 'LCI101.1']},
 'VILLAGES_PROTEGES': {'source': 'zone codes 4BP / D4BP', 'rule': 'Case-by-case gabarit; derogation from distances; zone 4B rural default.', 'cite': ['LCI106.1', 'LCI107']},
 'PLANS_DE_SITE': {'source': 'RDPPF_PS (73 polygons, 60 plans) + RDPPF_RS (20 polygons, 14 special regulations)', 'details_file': 'plans_de_site.json',
          'rule': 'Each plan de site + règlement fixes implantation, gabarit, volume, aspect, destination (LPMNS 38); maintained buildings cannot be demolished or substantially transformed without CE authorisation. Per-plan overriding limits (height, density, building areas, maintain/demolition rules, distances, use) are in plans_de_site.json keyed by NO_PLAN (plan-wide values under limits, sector / sub-perimeter / building-area values under sectors; parcel_sectors.csv gives each parcel's sector); fields not set there fall back to the zone entry.',
          'cite': ['LPMNS38.1', 'LPMNS38.2', 'LPMNS38.4', 'LCI10.1']},
 'RS_VILLAGES': {'source': 'RDPPF_RS (village construction regulations, LCI art.10)', 'items': [
     {'plan': '26959A', 'commune': 'Soral', 'IUS_max': {'village': 0.35, 'development_sectors': 0.2}, 'height': '7 m at sablière (2 levels) in village; 4 m in dev sector', 'cite': ['RS26959.4', 'RS26959.3']},
     {'plan': '27283', 'commune': 'Collex-Bossy', 'IUS_max': {'sectors_1_3_4BP': 0.4}, 'roof': '30-40° (25-35° zone 5 sector)', 'cite': ['RS27283.4']},
     {'plan': '27275', 'commune': 'Puplinge', 'IUS_max': {'A_rue_de_Graman': 0.5, 'C_route_de_Corniere': 0.3}, 'height': '7 m at sablière, 2 levels', 'cite': ['RS27275.4', 'RS27275.5']},
     {'plan': '27425', 'commune': 'Bernex (Lully)', 'IUS_max': {'A': 0.4, 'B': 0.2}, 'height': '7 m at sablière, R+1', 'cite': ['RS27425.4', 'RS27425.11']},
     {'plan': '27304', 'commune': 'Bernex (village)', 'IUS_max': {'1_4_5_6': 0.4, '7': 0.6}, 'height': 'max 3 levels + attic incl. ground floor', 'cite': ['RS27304.4', 'RS27304.12']},
     {'plan': 'Gy schéma directeur', 'commune': 'Gy', 'IUS_max': {'4BP': 0.2}, 'height': '7 m at sablière, R+1', 'cite': ['RSGy4', 'RSGy10']},
     {'plan': '27723', 'commune': 'Genthod', 'rule': '1/3 isolated, 2/3 contiguous or grouped; roofs 30-35°', 'cite': ['RS27723.4']}]},
 'RS_QUARTIER': {'source': 'RDPPF_RS (règlements de quartier)', 'items': [
     {'plan': '4737', 'commune': 'Cologny (Domaine de Ruth)', 'rule': 'villas only, R + attic or R+1, >= 6 m from neighbouring parcels', 'cite': ['RS4737.4']},
     {'plan': '27526', 'commune': 'Hermance (ch. des Tuilières)', 'rule': 'one dwelling (+ service flat) per parcel; implantation zones', 'cite': ['RS27526.1']}]},
 'RS_VDG': {'source': 'RDPPF_RS (Ville de Genève règlements spéciaux)', 'items': [
     {'plan': '4198', 'place': 'Quai Gustave-Ador / rue Pierre-Fatio', 'rule': 'cornice at 19.60 m above sidewalk; roof <= 30°, ridge <= 4 m above cornice', 'cite': ['RS4198.2']},
     {'plan': '28316', 'place': 'Mont-Blanc / Cornavin', 'rule': 'maintained buildings: transformed height <= existing; others set by department', 'cite': ['RS28316.7']},
     {'plan': '27749', 'place': 'Rond-Point de Rive', 'rule': 'maintained ensembles: transformed height <= existing (OCR partly illegible)', 'cite': ['RS27749.4']},
     {'plan': '27353', 'place': 'Servette / Lyon', 'rule': 'slab top levels fixed per building on the plan (R+5 / R+7); values only graphical', 'cite': []},
     {'plan': '27650', 'place': 'Plantamour / Grand Casino', 'rule': 'levels, gabarits and destinations fixed graphically by the plan', 'cite': []}]},
 'PUS_VDG': {'source': 'RDPPF_PUS (Ville de Genève; sector map PDF only)', 'rule': 'Additional SBP: >= 50% housing (sector 1), >= 80% (sector 2), dev zones >= 80%; surélévation of residential building 100% housing; green/leisure space >= 35% (2.2) / 40% (2.3) on parcels > 1000 m2, half in open ground if > 2000 m2. Does not cap floor area.', 'cite': ['LExt15A.1', 'PUS7.1', 'PUS7.2', 'PUS8.1', 'PUS12.1', 'PUS13', 'PUS13.2', 'PUS14']},
 'PUS_PETITS_DELICES': {'source': 'RDPPF_PUS (PA-109)', 'rule': 'open/green space 48% overall; sub-perimeter A 25%; B 78% (50% open ground), 80% housing / 20% commerce.', 'cite': ['PUSPD1']},
 'PUS_CAROUGE': {'source': 'RDPPF_PUS (Vieux-Carouge, Octroi, Armes, Promenades; 2019)', 'rule': 'Additional surfaces: >= 80% of upper floors to housing; ground floors to public-facing activities.', 'cite': ['PUSCar6.1']},
 'PUS_29188': {'source': 'RDPPF_PUS (Carouge, plan 29188, 2002, OCR)', 'rule': 'Max IUS per island: I 1.8, II 1.8, III 0.9, IV 0.7 (indicative, public use), V 1.8 (400 dpi re-OCR); min green space I/II 40%, III/IV 60%, V 30%; >= 70% additional SBP to housing.', 'cite': ['PUS29188.8', 'PUS29188.9']},
 'LPRLAC': {'source': 'RDPPF_PNP (rives du lac)', 'rule': 'Zone 5 inside perimeter: max 20% floor area, LCI 59 al.4 not applicable; 2 levels flat roof or 1 + habitable roof (lake-side facade).', 'cite': ['LPRLac3.1', 'LPRLac7.1']},
 'LPRRHONE': {'source': 'RDPPF_PNP (rives du Rhône)', 'rule': 'No new construction except public-utility.', 'cite': ['LPRRh3.1']},
 'LPRARVE': {'source': 'RDPPF_PNP (rives de l\'Arve)', 'rule': 'Inconstructible sectors: no new building, road, parking, relief change or fence.', 'cite': ['LPRArve6.2']},
 'LPRVERS': {'source': 'RDPPF_PNP (rives de la Versoix)', 'rule': 'Outside building zones no new construction; inside, plan-specific rules.', 'cite': ['LPRVers3.1']},
 'FORET_20M': {'source': 'RDPPF_DISTANCES_FORET / RDPPF_LIMITE_FORET', 'rule': 'No construction < 20 m from forest edge (derogation to 10 m in building zone).', 'cite': ['LFor11.1', 'LFor11.2c']},
 'EAUX_SI': {'source': 'RDPPF_SI (DISTANCE_INCONSTR 10/30/50)', 'rule': 'No construction above or below ground within 10/30/50 m of watercourses, 15/30/50 m of lake.', 'cite': ['LEaux16.2']},
 'SIT_PROG_DENS': {'source': 'SITG SIT_PROG_DENS (52 perimeters)', 'rule': 'Administrative practice: perimeters where no LCI 59 al.4 derogation is granted (or zone change pending).', 'cite': ['LCI59.4bis']},
 'PAV': {'source': 'Plan 29712A (Praille-Acacias-Vernets)', 'rule': 'LCI 22-25 and 36-48 not applicable; specific PAV law.', 'cite': ['LCI17.2']},
 'ALIGNMENTS': {'source': 'RPU_ALIGNEMENT / OTC_ALIGN_CONST_LROUTES', 'rule': 'No building between road and alignment; without plan: 25 m (cantonal) / 15 m (communal) from road axis.', 'cite': ['LRoutes11.1', 'LRoutes11.2']},
 'PDZI': {'source': 'RDPPF_PDZI (25 polygons, 16 plan numbers / 17 plans); per-plan values in ge_rules/pdzi.json, keyed like parcels.pdzi_id (NO_PLAN-INDICE, e.g. 26615-N, 29975-A); per-sector values under sectors, parcel placement in parcel_sectors.csv',
          'rule': 'Plans directeurs de zones de développement industriel (LZIAM art. 2-3): fix notably gabarits (let. h), min and/or max IUS per sector (let. l), possibly an obligation to build the gabarits (let. m); building rights in m2 of usable floor area from max IUS, only registered rights count. Approval of plan + règlement directeur (or PLQ) is the precondition for the CE to authorise industrial-zone (zone 2 gabarit, LCI 80) or mixed-zone norms in DIA/DAM; without it the pre-existing zone (ZONE_PREEX) applies unless waived under LZIAM 4 al.3.',
          'enables_industrial_norms': True, 'details_file': 'pdzi.json',
          'cite': ['LZIAM2.1h', 'LZIAM2.1', 'LZIAM2.1m', 'LZIAM3A.2', 'LZIAM3B.2', 'LZIAM4.1', 'LZIAM4.3']},
 'PLA': {'source': 'RDPPF_PLA', 'rule': 'Plans localisés agricoles: gabarit/destination/implantation for large agricultural installations.', 'cite': ['LaLAT20.7']},
}

COMMON = {'rule': 'Zones 1-4 common provisions: H measured from mean adjacent ground; same gabarit on all faces except murs en attente; widest street governs; building-to-building distance = sum of boundary distances; roof gabarit 35°/4.80 m.', 'cite': COMMON_14}

# ---------------------------------------------------------------- assemble
def expand(ids):
    out = []
    for i in ids:
        law, art, al, f, q = C[i]
        out.append({'id': i, 'law': law, 'article': art, 'paragraph': al, 'quote': q, 'source_file': f})
    return out

def collect(o, acc):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == 'cite': acc.extend(v)
            else: collect(v, acc)
    elif isinstance(o, list):
        for v in o: collect(v, acc)

counts = {L: collections.Counter(r['ABRV_ZONE'] for r in rows) for L, rows in attrs.items()}
desc = {}
for L, rows in attrs.items():
    for r in rows:
        if r['DESC_ZONE']: desc.setdefault(r['ABRV_ZONE'], r['DESC_ZONE'])
preex = collections.Counter((r['ABRV_ZONE'], r['ZONE_PREEX']) for r in attrs['RDPPF_ZONES_DEV'])

zones = []
for code, e in Z.items():
    L = e['layer']
    e['n_polygons'] = counts[L][code]
    e['sitg_desc_zone'] = desc.get(code)
    e.setdefault('determined', 'yes')
    if L == 'RDPPF_ZONES_DEV':
        e['zone_preex_counts'] = {p: n for (c, p), n in preex.items() if c == code}
    acc = []; collect({k: v for k, v in e.items() if k != 'exceptions'}, acc)
    for x in e['exceptions']: acc.extend(EXCEPTIONS[x]['cite'])
    seen = []; [seen.append(i) for i in acc if i not in seen]
    e['citations'] = expand(seen)
    order = ['code', 'label', 'layer', 'regime', 'determined', 'n_polygons', 'sitg_desc_zone', 'ordinary_zone_equivalent', 'zone_preex_counts', 'use', 'height', 'roof', 'distance', 'contiguous', 'density', 'underground', 'plq_effect', 'special_regulation', 'minor_buildings', 'exceptions', 'citations']
    zones.append({k: e[k] for k in order if k in e})

allc = []
collect(EXCEPTIONS, allc); collect(OVERLAYS, allc); collect(COMMON, allc)
cat = {
  'meta': {'canton': 'GE', 'generated': '2026-10-14',
           'sources': 'silgeneve.ch consolidated texts (LCI 22.10.2025; RCI 14.10.2026; LaLAT/LExt/LEaux/LPRVers 4.7.2026; LGZD 1.9.2026); SITG RDPPF layers; communal regulations from ge.ch/sitg/RDPPF (OCR where scanned).',
           'notation': 'H = height of vertical facade line of the gabarit; D (height formulas) = distance between alignments (street) or to the boundary; D (distance formulas) = distance to private boundary.',
           'zone_layers': {L: {'features': len(rows), 'distinct_ABRV_ZONE': sorted(counts[L])} for L, rows in attrs.items()}},
  'common_rules_zones_1_4': COMMON,
  'zones': zones,
  'exceptions': EXCEPTIONS,
  'overlays': OVERLAYS,
  'citation_library': {k: {'law': v[0], 'article': v[1], 'paragraph': v[2], 'quote': v[4], 'source_file': v[3]} for k, v in C.items()},
}
# sanity: every referenced id exists
miss = set()
for z in zones:
    for c in z['citations']: pass
for i in allc:
    if i not in C: miss.add(i)
json.dump(cat, open(OUT, 'w'), ensure_ascii=False, indent=1)
codes = {z['code'] for z in zones}
sitg = set(counts['RDPPF_ZONES_PRIM']) | set(counts['RDPPF_ZONES_DEV'])
print('zones', len(zones), 'sitg distinct', len(sitg), 'missing', sitg - codes, 'extra', codes - sitg, 'bad cite ids', miss)
