# Per-sector limits. SEC[plan_key] = {'drop': [plan-level fields that were really sector-specific],
#                                     'sectors': {sector_name: {field: (value, [quotes])}}}
# Sector names match the 'sector' column of parcel_sectors.csv. Quotes must occur in the plan's text files.
SEC = {}

# ---------------- PS 29184 Roseraie / Beau-Séjour (règlement 29184A, mod. 29589 / 30054)
R29184 = {
  '1': {'unbuilt_land': ("Unbuilt land free of construction (minor constructions and minor extensions excepted)", ["Sous-périmètres 1 et 3, les surfaces de terrain non bâties doivent rester libres de constructions et d’installations diverses, sous réserve de constructions de peu d’importance et d’agrandissements mineurs des bâtiments existants."])},
  '2': {'unbuilt_land': ("Outside the new-building area on parcels 1797 and 1802, unbuilt land free of construction (minor works excepted)", ["Sous-périmètre 2, hors de l’aire d’implantation d’une construction nouvelle, sise sur les parcelles 1797 et 1802, les surfaces de terrain non bâtis doivent rester libres de constructions et d’installations diverses"]),
        'new_construction': ({'areas': 'one new building inside the area on parcels 1797/1802', 'gabarit': 'must respect the character of the neighbouring ensemble; CMNS and Ville de Genève favourable opinion required'}, ["dans le sous périmètre 2, à l’intérieur de l’aire prévue à cet effet, une construction nouvelle pourra être édifiée.", "Par son implantation, ses gabarits et son architecture, cette construction devra respecter le caractère de l’ensemble bâti voisin compris dans ce sous-périmètre."])},
  '3': {'unbuilt_land': ("Unbuilt land free of construction (minor constructions and minor extensions excepted)", ["Sous-périmètres 1 et 3, les surfaces de terrain non bâties doivent rester libres de constructions et d’installations diverses, sous réserve de constructions de peu d’importance et d’agrandissements mineurs des bâtiments existants."])},
  '4': {'unbuilt_land': ("Street-side gardens and terraces and courtyard gardens / green spaces free of construction (pedestrian permeability)", ["Sous-périmètre 4, les jardins et terrasses côté rue de même que les jardins et espaces verts côté cour doivent rester libres de constructions et d’installations diverses"])},
  '5': {'use': ("Mainly hospital uses", ["les terrains compris à l’intérieur des sous-périmètres 5 sont destinés principalement à des affectations hospitalières."]),
        'unbuilt_land': ("No new construction in currently free spaces except the areas on parcels 1817 and 1822; rebuilt building <= existing height", ["la réalisation de constructions nouvelles dans les espaces actuellement libres de construction, à l'exception des aires d'implantation de constructions nouvelles sises sur les parcelles 1817 et 1822, n'est pas autorisée.", "Le gabarit d'un bâtiment démoli puis reconstruit ne dépassera pas la hauteur du bâtiment existant."]),
        'new_construction': ({'areas': 'parcels 1817 and 1822 (graphical areas)'}, ["Des constructions nouvelles pourront être édifiées sur les parcelles 1817 et 1822 à l'intérieur des aires prévues à cet effet."])},
  '6': {'height': ({'rule': 'PLQ 28670B-264 applies (exception to the existing-height rule)'}, ["À l’exception des constructions prévues par le PLQ nº 28670B-264 (ACE 03.04.1996) à l’intérieur du sous-périmètre 6"])},
}
SEC['29184'] = {'drop': ['unbuilt_land', 'use'], 'sectors': R29184}
SEC['29589'] = {'drop': ['unbuilt_land', 'use'], 'sectors': {'5': R29184['5']}}
SEC['30054'] = {'drop': ['unbuilt_land', 'use'], 'sectors': {'3': R29184['3']}}

# ---------------- PS 29827 Laconnex
SEC['29827'] = {'drop': ['density', 'height'], 'sectors': {
  'village ancien': {
    'new_construction': ("New buildings only outside the garden areas (aires de jardin non-bâties) drawn on the plan; may encroach slightly", ["Dans le secteur du village ancien, les constructions nouvelles ne peuvent s'implanter qu'en dehors des aires de jardin non-bâties figurant en plan."]),
    'height': ({'rule': 'fixed case by case (LCI 106); 4B protégée rural cap 10 m by default'}, ["Le gabarit des constructions nouvelles est fixé dans chaque cas particulier de manière à sauvegarder le caractère architectural"]),
    'density': ({'IUS_max': 'none in règlement (zone 4B protégée rules)'}, ["DISPOSITIONS APPLICABLES AUX TERRAINS SIS DANS LE SECTEUR DU VILLAGE ANCIEN"])},
  "secteurs d'aménagement": {
    'density': ({'IUS_max': 0.4, 'IUS_exceptional_multi_parcel': 0.6, 'energy_derogation': 'HPE may derogate (art. 20 al.2)'}, ["L'indice d'utilisation du sol de chaque parcelle ou groupe de parcelles est fixé à 0.4.", "Un indice d'utilisation du sol de 0.6 au maximum peut être admis à titre exceptionnel", "Une dérogation à l'article 17 du présent règlement peut être admise lorsque la construction répond à un standard de haute"]),
    'height': ({'rule': 'fixed case by case (LCI 106); 4B protégée rural cap 10 m by default'}, ["Le gabarit des constructions est fixé dans chaque cas particulier de manière à sauvegarder le caractère architectural et l'échelle"]),
    'other': ("Parcels 2437 and 2438: plan d'ensemble required, resident parking underground", ["Sur les parcelles n°2'437 et 2'438, la réalisation des bâtiments est subordonnée à l'établissement d'un plan d'ensemble."])},
}}

# ---------------- PS 29999 La Malvande (values from the plan sheet text layer; per-building altitudes read on the plan labels)
def B29999(levels, sbp, alt, q_lv, q_alt):
    return {'new_construction': ({'levels': levels, 'SBP_max_m2': sbp, 'max_altitude_m': alt}, [q_lv, "11'221 m2 8'132 m2 3'327 m2 1'786 m2 1'435 m2", q_alt]),
            'height': ({'levels': levels, 'max_altitude_m': alt}, [q_lv, q_alt])}
SEC['29999'] = {'drop': [], 'sectors': {
  'building area A': B29999('R+3+A (4+A)', 11221, 399.9, "bâtiment A R+3+A (4+A)", "R+2+A +401.8 m +399.9 m R+3+A"),
  'building area B': B29999('R+2+A (3+A)', 8132, 401.8, "bâtiment B R+2+A (3+A)", "R+2+A +401.8 m +399.9 m R+3+A"),
  'building area C': B29999('R+3', 3327, 396.2, "bâtiment C R+3", "LP +396.2 m +396.2 m +396.2 m LP +395.5 m"),
  'building area D': B29999('R+2', 1786, 396.2, "bâtiment D R+2", "LP +396.2 m +396.2 m +396.2 m LP +395.5 m"),
  'building area E': B29999('R+1', 1435, 395.5, "bâtiment E R+1", "LP +396.2 m +396.2 m +396.2 m LP +395.5 m"),
  'outside new-building areas (maintained buildings, free land)': {
    'maintained': ("Existing SBP: maison de maître 673 m2, dépendance 1 1'433 m2, dépendance 2 1'092 m2 (total 3'198 m2)", ["673 m2 1'433 m2 1'092 m2 ______ 3'198 m2"])}}}
SEC['29999']['plan_note'] = ("Per-building altitude assignment checked visually on the plan labels (georef/evidence/29999_label*.png, 29999_labels_*.png): A 399.9, B 401.8, C 396.2, D 396.2, E 395.5 m; table totals 25'901 m2 new + 3'198 m2 existing = 29'099 m2",
                             ["25'901 m2 ====== 29'099 m2"])

# ---------------- PS 29376 Villette
SEC['29376'] = {'drop': ['density', 'height', 'distances'], 'sectors': {
  '1': {'new_construction': ({'areas': 'graphical', 'levels_max': 'R+1', 'cornice_m': 6.0}, ["À l’intérieur des sous-périmètres 1 et 3, de nouvelles constructions ne peuvent être édifiées que dans les aires prévues à cet effet.", "Le gabarit des constructions nouvelles doit comporter un étage sur rez-de-chaussée au maximum et respecter la hauteur de 6,00 m à la corniche."]),
        'height': ({'new_levels_max': 'R+1', 'cornice_m': 6.0}, ["respecter la hauteur de 6,00 m à la corniche."])},
  '3': {'new_construction': ({'areas': 'graphical', 'levels_max': 'R+1', 'cornice_m': 6.0}, ["À l’intérieur des sous-périmètres 1 et 3, de nouvelles constructions ne peuvent être édifiées que dans les aires prévues à cet effet.", "respecter la hauteur de 6,00 m à la corniche."]),
        'height': ({'new_levels_max': 'R+1', 'cornice_m': 6.0}, ["respecter la hauteur de 6,00 m à la corniche."])},
  '2': {'density': ({'IUS_max': 0.2}, ["L’indice d’utilisation du sol est limité à 0,2 conformément au plan directeur communal"]),
        'height': ({'new_levels_max': 'R+1', 'cornice_m': 6.0, 'parcel_4842_and_lower_3052_m': 3.5}, ["respecter la hauteur de 6,00 m à la corniche.", "Pour la parcelle 4842 et la partie inférieure de la parcelle 3052, le gabarit des constructions nouvelles ne doit pas excéder une hauteur de 3,50 m, mesurée en amont de la pente."]),
        'other_buildings': ("Parcels 3932, 3935, 4340: demolished building may be rebuilt on the same footprint", ["Dans le sous-périmètre 2, en cas de démolition d’un bâtiment situé sur les parcelles 3932, 3935 et 4340, celui-ci pourra être reconstruit dans la même implantation."])},
  '4': {'density': ({'IUS_max': 0.2, 'new_villas': 2}, ["À l’intérieur du sous-périmètre 4, l’indice d’utilisation du sol est limité à 0,2.", "Deux nouvelles villas individuelles peuvent être réalisés"]),
        'height': ({'new_levels_max': 'R+1', 'cornice_m': 6.0}, ["respecter la hauteur de 6,00 m à la corniche."]),
        'distances': ("Parcel 5222 rebuild: 15 m from the north enclosure wall", ["l’implantation de la nouvelle construction doit respecter la distance de 15 mètres au mur d’enceinte nord."])},
  '5': {'other': ("Sub-perimeter 5 requires a specific study (historic / archaeological value)", ["Les sous-périmètre 5 devra faire l’objet d’une étude particulière compte tenu de sa valeur"])},
}}

# ---------------- PS 29400 Cités-jardins d'Aïre
SEC['29400'] = {'drop': [], 'sectors': {
  '1': {'new_construction': ("Garden-side verandas are the only extensions allowed; no habitable attics", ["Les vérandas côté jardin sont les seules extensions autorisées.", "L'aménagement de surfaces habitables dans les greniers n'est pas autorisé."]),
        'parking': ("No parking on private land", ["Le stationnement des véhicules sur les fonds privés n'est pas autorisé."])},
  '2': {'new_construction': ({'verandas': 'garden side, group project per row of houses', 'levels_max': 1, 'depth_max_m': 3}, ["Des vérandas côté jardin peuvent être autorisées pour autant qu'il s'agisse d'un projet d'ensemble par groupe de maisons", "Le gabarit maximum est de 1 niveau sans sous-sol et ne dépassera pas une profondeur de 3 m."]),
        'parking': ("Exceptionally max 1 place per dwelling on private land", ["le stationnement d'un véhicule par logement au maximum peut être autorisé sur les fonds privés"])},
  '3': {'use': ("Rural ensemble (avenues Henri-Golay / Concorde / Ain) and surroundings", ["l'ensemble rural situé à la rencontre des avenues Henri-Golay, de la Concorde et de l'Ain, avec ses abords."])},
}}

# ---------------- PS 30074 La Branvaude
SEC['30074'] = {'drop': [], 'sectors': {
  'A': {'new_construction': ("New agricultural buildings may be authorised (derogation, existing farms only)", ["la construction de nouveaux bâtiments agricoles peut être autorisée dans les sous-secteurs A et B"])},
  'B': {'new_construction': ("New agricultural buildings may be authorised (derogation, existing farms only)", ["la construction de nouveaux bâtiments agricoles peut être autorisée dans les sous-secteurs A et B"])},
}}

# ---------------- PS 30216 (zone 5 part only)
SEC['30216'] = {'drop': ['density'], 'sectors': {
  'zone 5 part': {'density': ({'IUS_max': 0.2, 'SBP_max_m2': 8042, 'SBP_existing_m2': 750, 'IUS_HPE_THPE': 0.22, 'use': 'housing'}, ["L'indice d'utilisation du sol (IUS) maximum de la partie du périmètre du plan de site sise en zone 5 est de 0.2, représentant un maximum de 8'042 m2/ de surfaces brutes de plancher (SBP) hors sol destinées à du logement, dont 750 m2 / de SBP existantes.", "peuvent être augmentés de 10 % (IUS 0,22) lorsque la réalisation est conforme à un standard de haute ou très haute performance énergétique"])},
}}

# ---------------- PS 29993 (rules outside agricultural zone)
SEC['29993'] = {'drop': ['other_buildings'], 'sectors': {
  'outside agricultural zone': {'other_buildings': ("Demolish, transform, minor extension or rebuild in same implantation and gabarit", ["Les autres bâtiments situés hors zone agricole peuvent être démolis, transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit."])},
}}

# ---------------- PS 29718 (implantation areas 1-2 are in the 4B protégée part)
SEC['29718'] = {'drop': ['new_construction', 'unbuilt_land'], 'sectors': {
  'zone 4B protégée (village, implantation areas 1-2)': {
    'new_construction': ({'areas': 'implantation areas 1 and 2 (graphical)', 'roof': 'single/double pitch 15-35°', 'norms': 'zone 4B protégée'}, ["De nouvelles constructions ne peuvent être édifiées que dans les aires d'implantation de constructions nouvelles n° 1 et 2 prévues à cet effet.", "respecter une pente comprise entre 15° et 35°", "Elles sont soumises aux dispositions applicables en zone 4B protégée."]),
    'unbuilt_land': ("Building zone outside implantation areas free of construction", ["en dehors des aires d'implantation des constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de constructions"])},
  'agricultural sub-perimeters A-D': {'other': ("Agricultural zone: LAT/LaLAT rules; no implantation area", ["peuvent être démolis, transformés et agrandis dans les limites prescriptives de la zone concernée."])},
}}

# ---------------- PS 28392 / 30158 Rade: detail plan 28590 sub-perimeter
for k in ('28392', '30158'):
    SEC[k] = {'drop': [], 'sectors': {'detail plan 28590 (Palais Wilson)': {'new_construction': ("Hotel Président extension, congress centre, light low buildings and underground construction located graphically (plan 28590)", ["Hôtel Président Extension de l’Hôtel Président Centre de congrès Constructions basses légères attenantes au Palais Wilson Construction en sous-sol"])}}}

# ---------------- PS 29790: the RDPPF_PS polygon is the sub-perimeter valant plan de site; density belongs to the PLQ part
SEC['29790'] = {'drop': ['density', 'height', 'bonus'], 'sectors': {
  'sub-perimeter valant plan de site (maintained buildings)': {
    'maintained': ("Maintained buildings: energy transformations; minor buildings and limited extensions on courtyard side", ["Les bâtiments maintenus peuvent faire l'objet de transformations nécessaires aux économies d'énergie"]),
    'height': ({'rule': 'existing (maintained buildings)'}, ["Les bâtiments maintenus peuvent faire l'objet de transformations nécessaires aux économies d'énergie"])}},
  'outside_note': ("PLQ part outside the plan-de-site polygon (not in RDPPF_PS): SBP max 32'254 m2, IUS 1.23 (0.76 whole perimeter), new buildings R+7 alt. max 442-443 m", ["La surface brute de plancher (SBP) est limitée à 32'254 m2 dont 4'000 m2 maximum d'activité et/ou de locaux communs soit un indice d'utilisation du sol (IUS) de 1.23 maximum correspondant à un IUS de 0.76 pour l'ensemble du périmètre", "alt. max. 442.00", "alt. max. 443.00"])}

# ---------------- parcel-specific clauses
SEC['29484'] = {'drop': ['new_construction'], 'sectors': {'parcel 13417 (new school-extension area)': {'new_construction': ({'parcel': 13417, 'levels_max': 'R+1', 'use': 'school extension (parascolaire)'}, ["Dans l'aire prévue à cet effet sur la parcelle 13417, une nouvelle construction comportant au maximum deux niveaux habitables depuis le niveau des terrains de football correspondant à R+1"])}}}
SEC['29792'] = {'drop': ['demolition'], 'sectors': {'parcel 1053 (demolition condition)': {'demolition': ("Permit subject to demolition of marked building", ["parcelle no 1053, la délivrance de l'autorisation de construire est subordonnée à la démolition du bâtiment indiqué comme tel sur le plan."])}}}
SEC['30079'] = {'drop': ['demolition'], 'sectors': {'parcels 866/1885/1410/1999/2000 (demolition condition)': {'demolition': ("New construction requires demolition of the other buildings on the parcel", ["est subordonnée à la démolition des autres bâtiments situés sur la parcelle concernée."])}}}

# ---------------- PS 29525 / camping (unplaced, but values per sector)
SEC['29525'] = {'drop': ['use'], 'sectors': {
  'A': {'maintained': ("School buildings maintained; built footprint <= 20% of the sector; no additional floor area", ["La surface des constructions localisées dans le secteur A ne doit pas excéder 20% de la surface de ce secteur."])},
  'B': {'use': ("Several villas in the north-east of the parcel", ["Le secteur B est destiné à la construction de plusieurs villas localisées au Nord Est de la parcelle."])},
  'C': {'use': ("One individual villa", ["Le secteur C est destiné à la construction d'une villa individuelle."])}}}
for k in ('27878', '28679', '30174'):
    SEC[k] = {'drop': ['new_construction', 'use'], 'sectors': {
      'réserve / protection sector': {'new_construction': ("No new construction inside the sector; existing may be maintained", ["Toute construction nouvelle est interdite à l’intérieur du secteur ; les constructions existantes peuvent être maintenues."])},
      'camping sub-perimeters A-C': {'use': ("Camping extension; projected 1-level reception building", ["Les trois sous-périmètres A, B, C sont destinés à prolonger le secteur du camping actuel.", "Bâtiment projeté, 1 niveau"])}}}

# ---------------- RS
SEC['RS:27304'] = {'drop': ['density', 'height', 'use'], 'sectors': {
  **{s: {'density': ({'IUS_max': 0.4}, ["0,4 pour les secteurs nos 1-4-5-6"]),
         'height': ({'levels_max': '3 levels + attic, ground floor included'}, ["il ne peut excéder 3 niveaux + comble, rez compris."]),
         'use': ("Collective housing / contiguous order, complementary activities", ["Secteurs des habitations collectives (1-4-5-6)"])} for s in ('1', '4', '5', '6')},
  **{s: {'density': ({'rule': 'LCI art. 129 (zone 5 villa ratio)'}, ["les dispositions de l'article 129 L.C.I. sont applicables."]),
         'use': ("Individual housing", ["Secteurs des habitations individuelles (no 2 et 3)"])} for s in ('2', '3')},
  '2A': {'density': ({'rule': 'LCI art. 129 (zone 5 villa ratio)'}, ["les dispositions de l'article 129 L.C.I. sont applicables."]),
         'height': ({'levels': 'ground floor + habitable attic'}, ["est limité à un rez-de-chaussée, plus comble habitable."])},
  '7': {'density': ({'IUS_max': 0.6}, ["0,6 pour le secteur no 7"]),
        'use': ("Artisanal / light non-polluting industry", ["Le secteur est destiné à l'artisanat et à l'industrie"])}}}
SEC['RS:27304']['sectors']['1']['maintained'] = ("Sector 1: existing buildings in principle maintained, may be rebuilt on current implantation and gabarit", ["les bâtiments existants sont en"])
SEC['RS:27425'] = {'drop': ['density', 'height'], 'sectors': {
  'A': {'density': ({'IUS_max': 0.4}, ["0,4 pour le secteur À"]),
        'height': ({'facade_max_m': 7, 'measured': 'at sablière, downhill facade', 'levels': 'R+1 + attic'}, ["La hauteur de la façade ne peut dépasser 7 m au niveau de la sablière."]),
        'use': ("Housing, commerce, agricultural buildings; contiguous order", ["Le secteur À est destiné à l'habitation, au commerce et aux bâtiments agricoles."])},
  'B': {'density': ({'IUS_max': 0.2}, ["0,2 pour le secteur B"]),
        'height': ({'facade_max_m': 7, 'levels': 'R+1 + attic'}, ["La hauteur de la façade ne peut dépasser 7 m au niveau de la sablière."]),
        'use': ("Individual housing in contiguous order", ["Le secteur B est destiné à l'habitation individuelle en ordre contigu."])},
  'C': {'density': ({'rule': 'LCI art. 129 (zone 5 villa ratio)'}, ["Dans le secteur C les dispositions de l'art. 129 LCI sont applicables."]),
        'height': ({'facade_max_m': 7, 'levels': 'R+1 + attic'}, ["La hauteur de la façade ne peut dépasser 7 m au niveau de la sablière."]),
        'use': ("Individual housing", ["Le secteur C est destiné à l'habitation individuelle."])},
  'D': {'use': ("Agricultural activity; other uses need a complement to the plan directeur", ["Le secteur D est en l'état destiné à l'activité agricole."])}}}
SEC['RS:27275'] = {'drop': ['density'], 'sectors': {
  'A': {'density': ({'IUS_max': 0.5, 'IUS_max_with_ground_floor_commerce': 0.6}, ["0,5 pour le secteur rue de Graman (A)", "total de 0,6 des surfaces occupées en rez-de-chaussée"])},
  'B': {'density': ({'rule': 'LCI art. 129 (zone 5 villa ratio)'}, ["les dispositions de l'article 129 L.C.I. sont. applicables."]),
        'use': ("Individual housing (villas)", ["est destiné à l'habitation individuelle (villas)."])},
  'C': {'density': ({'IUS_max': 0.3}, ["0,3 pour le secteur route de Cornière €"])}}}
SEC['RS:26959'] = {'drop': ['density', 'height', 'contiguous'], 'sectors': {
  'village actuel': {'density': ({'IUS_max': 0.35}, ["a) 0,35 dans le village actuel ;"]),
                     'height': ({'max_m': 7, 'at': 'sablière', 'levels': 2, 'attic': 'habitable'}, ["la hauteur maximum est de 7 m. à la sablière soit 2"]),
                     'contiguous': ("New housing in principle contiguous, block length max 50 m", ["la longueur d'un bloc de bâtiment ne peut excéder 50m."])},
  'secteur de développement': {'density': ({'IUS_max': 0.2}, ["b) 0,2 dans le secteur de développement"]),
                               'height': ({'max_m': 4, 'at': 'sablière', 'levels': 1, 'attic': 'habitable', 'sector_A': 'department fixes implantation and gabarit'}, ["la hauteur maximum est de 4 m. à la sablière, soit 1"])},
  'outside building sectors (agricultural)': {'use': ("Secteur non développé maintained as is (5e zone B) / agricultural land", ["Le secteur non développé est maintenu en l'état (5e zone B)."])}}}
SEC['RS:27283'] = {'drop': ['density', 'roof'], 'sectors': {
  'sectors 1-3 (4B protégée)': {'density': ({'IUS_max': 0.4, 'derogation': 'not derogable'}, ["0,4 pour les secteurs No 1, 2 et 3"]),
                                'roof': ("4 slopes 30-40°", ["Les toitures doivent être à 4 pans inclinès de 300 à 400 dans les secteurs 1,"])},
  'sector 4 (zone 5)': {'density': ({'rule': 'LCI art. 129 (zone 5 villa ratio)'}, ["Le secteur 4 est destiné à l'habitation individuelle."]),
                        'roof': ("25-35°", ["respectivement de: 250 à 350 dans le secteur 4."])}}}
SEC['RS:4737'] = {'drop': ['height'], 'sectors': {
  'blue zone (pitched-roof houses)': {'height': ({'levels': 'R + habitable attic, ~25° gables'}, ["un rez-de-chaussée et un premier étage au maximum."])},
  'red zone (flat-roof houses)': {'height': ({'roof': 'flat', 'levels_max': 'R+1'}, ["un rez-de-chaussée et un premier étage au maximum."])}}}

# ---------------- PDZI (keys as in pdzi.json: NO_PLAN-INDICE or NO_PLAN)
SEC['PDZI:29976'] = {'drop': ['density'], 'sectors': {
  s: {'density': ({'IUS_min': v[0], 'IOS_max': v[1]}, ["IUS minimum IOS maximum Secteur de densification A 0.8 néant Secteur de densification B 0.8 néant Secteur de densification C 0.8 0.5 Secteur de densification D 1.5 0.5"])}
  for s, v in {'A': (0.8, 'none'), 'B': (0.8, 'none'), 'C': (0.8, 0.5), 'D': (1.5, 0.5)}.items()}}
SEC['PDZI:29975-A'] = {'drop': ['density'], 'sectors': {
  'A': {'density': ({'IUS_min': 0.4}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification B 0.8 IOS maximum 0.5"])},
  'B': {'density': ({'IUS_min': 0.8, 'IOS_max': 0.5}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification B 0.8 IOS maximum 0.5"])}}}
SEC['PDZI:29975-B'] = {'drop': ['density'], 'sectors': {
  'A': {'density': ({'IUS_min': 0.4, 'IOS_max': 0.7}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification C 1 IOS maximum 0.7"])},
  'C': {'density': ({'IUS_min': 1.0, 'IOS_max': 0.7}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification C 1 IOS maximum 0.7"])}}}
SEC['PDZI:29995'] = {'drop': ['density'], 'sectors': {
  **{s: {'density': ({'IUS_min': 0.8, 'IOS_max': 0.5}, ["Pour les secteurs de densification A, B et C, l’IUS minimum doit être de 0.8 et l’IOS maximum de 0.5."])} for s in 'ABC'},
  'D': {'density': ({'IUS_min': 0.5, 'IOS_max': 0.3}, ["Pour le secteur de densification D, l’IUS minimum doit être de 0.5 et l’IOS maximum de 0.3."])}}}
SEC['PDZI:29994'] = {'drop': ['density'], 'sectors': {
  s: {'density': ({'IUS_min': v}, ["Dans l’aire de localisation « %s », l’IUS minimal à atteindre est de %s." % (s, str(v).replace('.', ','))])}
  for s, v in {'A': 1.5, 'B': 1.5, 'C': 1.7, 'D': 1.5, 'E': 1.9}.items()}}
SEC['PDZI:29994']['sectors']['D']['height'] = ({'community_building_altitude_m': 458, 'note': 'community/services building between aire D and the landscape space'}, ["peut atteindre la cote d’altitude de 458 m."])
SEC['PDZI:30097'] = {'drop': [], 'sectors': {
  s: {'density': ({'IUS_min': v[0], 'SBP_min_m2': v[1], 'ID_min': 1.31}, ["Pièce urbaine %s : IUS min de %s et SBP min de %s m2" % (s, v[0], v[2]), "Pour chaque pièce urbaine, l’indice de densité minimum (ID min) est de 1.31."])}
  for s, v in {'A': (0.84, 8533, "8'533"), 'B': (1.12, 43137, "43'137"), 'C': (0.95, 27498, "27'498"), 'D': (0.85, 9400, "9'400")}.items()}}
for s in 'CD':
    SEC['PDZI:30097']['sectors'][s]['height'] = ({'max_m': 24, 'reduced_m': 18, 'where': 'fronts on ch. des Rouettes / retention basin, over min. 20 m depth'}, ["La hauteur maximale des constructions est de 24 m", "une hauteur maximale réduite à 18 m est applicable sur une profondeur d’au minimum 20 m"])
ZQ = ["L'attiude des constructions, y compris les superstructures"]
SEC['PDZI:28667'] = {'drop': ['height'], 'sectors': {
  s: {'height': ({'max_altitude_m_incl_superstructures': v, 'source': 'plan legend read visually at 400/800 dpi (georef/evidence/28667_legend_400dpi.png, _800dpi.png)'}, ZQ)}
  for s, v in {'A': 429.00, 'B': 426.00, 'C': 427.50, 'D': 426.00, 'I': 426.00, 'E': 425.50, 'H': 425.50, 'F': 424.00, 'G': 424.00}.items()}}
SEC['PDZI:28495-B'] = {'drop': ['height'], 'sectors': {
  'implantation sector W (gabarit 9 m)': {'height': ({'max_gabarit_m': 9, 'source': 'figure read visually on the plan image (georef/evidence/28495B_gabarits.png)'}, ["LE CHIFFRE INDIQUE LE GABARIT MAXIMUM"])},
  'implantation sector S (gabarit 9 m)': {'height': ({'max_gabarit_m': 9, 'source': 'figure read visually on the plan image (georef/evidence/28495B_gabarits.png)'}, ["LE CHIFFRE INDIQUE LE GABARIT MAXIMUM"])},
  'implantation sector centre (gabarit 12 m)': {'height': ({'max_gabarit_m': 12, 'source': 'figure read visually on the plan image (georef/evidence/28495B_gabarits.png)'}, ["LE CHIFFRE INDIQUE LE GABARIT MAXIMUM"])},
  'implantation sector NE (gabarit 12 m + attique)': {'height': ({'max_gabarit_m': 12, 'attique': True, 'except': 'silo des Moulins (A)', 'source': 'figure read visually on the plan image (georef/evidence/28495B_gabarits.png)'}, ["LE CHIFFRE INDIQUE LE GABARIT MAXIMUM"])},
  'outside implantation sectors (roads, free areas)': {'new_construction': ("No building outside the implantation sectors", ["SECTEUR D'IMPLANTATION DES. CONSTRUCTIONS"])}}}
SEC['PDZI:28460-B'] = {'drop': ['height'], 'sectors': {
  'zone de transition (west)': {'height': ({'max_m': 15, 'superstructures': 'not included', 'source': 'annotation read visually on the plan image (georef/evidence/28460B_gabarit_annotations.png)'}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"])},
  'secteur à gabarit limité H=12 m (north)': {'height': ({'max_m': 12, 'superstructures': 'not included', 'source': 'annotation read visually on the plan image (georef/evidence/28460B_gabarit_annotations.png)'}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"])},
  'secteurs à gabarit limité H max 15 m / 10 m (south-east): 15 m part': {'height': ({'max_m': 15, 'superstructures': 'included', 'source': 'annotation read visually on the plan image (georef/evidence/28460B_gabarit_annotations.png)'}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"])},
  'secteurs à gabarit limité H max 15 m / 10 m (south-east): 10 m part': {'height': ({'max_m': 10, 'superstructures': 'included', 'source': 'annotation read visually on the plan image (georef/evidence/28460B_gabarit_annotations.png)'}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"])},
  'rest of perimeter (industrial-zone norms)': {'height': ({'rule': 'no height written for this part: industrial-zone default (LZIAM 4 al. 1 -> LCI 80 al. 1, 23): H <= D + 3, max 24 m', 'max_m': 24}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"], ['LZIAM4.1', 'LCI80.1', 'LCI23.1', 'LCI23.6'])},
  'secteur à gabarit limité H=6 m (east, incl. zone NNI A)': {'height': ({'max_m': 6, 'superstructures': 'included', 'source': 'annotation read visually on the plan image (georef/evidence/28460B_gabarit_annotations.png)'}, ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"])}}}

EV27 = 'figure read visually on the plan image (georef/evidence/27953_gabarits_plan.png, 27953_hotel_b_21m.png, 27953_d_16m.png)'
SEC['PDZI:27953'] = {'drop': [], 'sectors': {
  'a (south-west, 10 m)': {'height': ({'max_m': 10, 'source': EV27}, ["u = 1,2"])},
  'b (hotel, 21 m)': {'height': ({'max_m': 21, 'source': EV27}, ["u = 1,2"])},
  'c (administrative centre, 16 m)': {'height': ({'max_m': 16, 'source': EV27}, ["u = 1,2"])},
  'd (north-east, 16 m)': {'height': ({'max_m': 16, 'source': EV27}, ["u = 1,2"])},
  'other implantation sectors (16 m north / 12 m centre-east / 10 m south)': {'height': ({'max_m': [16, 12, 10], 'source': EV27}, ["u = 1,2"])}}}

SEC['RS:27353'] = {'drop': ['height'], 'sectors': {
  'parcels 2135/2265/2266 (rue de Lyon, R+5)': {'height': ({'levels': 'R+5', 'top_slab_altitude_m': 410.30, 'superstructure_altitude_m': 413.30, 'source': 'gabarit elevation, read visually (georef/evidence/27353_gabarit.png)'}, ["R+5_410.30", "S. 413.30"])},
  'parcel 2176 (rue de la Servette, R+6 / R+7 corner)': {'height': ({'levels': 'R+6, corner R+7', 'top_slab_altitude_m': 413.74, 'corner_top_slab_altitude_m': 418.11, 'superstructure_altitudes_m': [416.74, 421.05], 'source': 'gabarit elevation, read visually (georef/evidence/27353_gabarit.png)'}, ["R46 413.74", "R+7 418.11"])}}}
