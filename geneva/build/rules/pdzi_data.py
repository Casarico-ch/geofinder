# key: NO_PLAN-INDICE exactly as parcels.pdzi_id ('26615-N', '29975-A'); plain NO_PLAN when SITG INDICE is '-'. Fields as in plans_data.
D = {}
Z2 = "La hauteur des constructions doit se conformer aux dispositions de la 2ème zone de construction"
D['29362'] = dict(name='Route des Fayards (Versoix)',
  use=("Industrial and artisanal constructions", ["terrains situés dans le périmètre de la zone de développement industriel et artisanal sont affectés aux constructions industrielles et artisanales."]),
  height=({'max_altitude_m': 398}, ["gabarits du ou des bâtiments ne peuvent dépasser la cote d'altitude de 398 mètres."]),
  density=({'IUS_max': 0.45, 'IOS_max': 0.45, 'reference_area_m2': 11650}, ["ne peut excéder le taux de 0,45.", "ne peut excéder 0,45.", "soit environ 11 650 m2"]),
)
D['29702'] = dict(name='Rue Kazem-Radjavi (Sécheron, Ville de Genève) - zone 2 activités mixtes',
  use=("Min 25% industrial/artisanal, max 75% administrative", ["zone 2 affectée à des activités mixtes est destinée à raison d’au minimum 25 % à des activités industrielles et artisanales, et d’au maximum 75 % à des activités administratives."]),
  height=({'max_roof_slab_altitude_m': 418.0}, ["ALTITUDE MAXIMALE DE LA DALLE DE COUVERTURE 418.00 m"]),
  density=({'IUS_min': 2, 'IUS_max': 4.0, 'SBP_max_m2': 48000}, ["ne peut être inférieur à 2.", "ace brute de plancher (SBP) est limitée à 48000 m2, soit un indice d'utilisation du sol (IUS) de 4,0 maximum"]),
)
D['29292'] = dict(name='Bois-de-Bay (Satigny)',
  use=("Priority to construction sector and recycling", ["sont réservés à des constructions et installations affectées en priorité au secteur de la construction et aux entreprises assimilées, ainsi qu’au recyclage de divers matériaux."]),
  density=({'IUS_min': 'may be imposed by CE at permit stage (no figure)'}, ["imposer un indice d'utilisation du sol minimum."]),
  height=({'rule': 'industrial-zone default: règlement directeur sets no gabarit, so the industrial-zone norms enabled by LZIAM art. 4 apply = zone 2 gabarit (LCI art. 80 al. 1, art. 23); building limit lines on the plan sheet', 'street_formula': 'H <= D + 3', 'max_m': 24, 'source': 'default (rules_catalogue.json zone DIA/IA)'},
          ["imposer un indice d'utilisation du sol minimum."], ['LZIAM4.1', 'LCI80.1', 'LCI23.1', 'LCI23.6']),
)
D['29745-A'] = dict(name='Valavran II (Bellevue)',
  height=({'max_height_m': 16.0, 'note': 'per parcel group on plan d\'aménagement; airport ceiling applies'}, ["Pour chaque parcelle ou groupe de parcelles, le gabarit maximum admis est fixé par le plan d’aménagement n° 29'745A.", "Haut. max (m) : 16.0"]),
  density=({'IUS_min': 0.61, 'ID_min': 0.8, 'footprint_max': '40% of parcel'}, ["L’indice d’utilisation du sol (ci-après IUS) doit être au minimum de 0.61 (correspondant à un indice de densité (ci-après ID) de 0.8).", "L’emprise des bâtiments au sol ne peut pas excéder 40% de la surface de la parcelle."]),
)
D['29968'] = dict(name='Les Cherpines (Confignon / Plan-les-Ouates)',
  height=({'max_m': 24, 'max_route_de_Base_m': 27}, ["Le gabarit maximum est de 24 m pour les bâtiments sis le long des chemins des Grands-Champs et des Longues-Rasses, de la nouvelle voie de desserte, de la nouvelle rue nord-sud, et de 27 m pour les bâtiments sis en front de la route de Base."]),
  density=({'IUS_min_global': 0.82, 'ID_min_global': 1.2}, ["IUS 0.82 (correspondant à un ID de 1.2)"]),
)
D['29975-A'] = dict(name='ZIBAT Sud (Vernier / Meyrin)',
  height=({'rule': 'zone 2 gabarit (LCI 80 al.1, 23): street H <= D+3, max 24 m; airport ceiling'}, [Z2]),
  density=({'IUS_min': {'A': 0.4, 'B': 0.8}, 'IOS_max_B_C': 0.5}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification B 0.8 IOS maximum 0.5"]),
  distances=("Min 6 m setback from industrial roads / public domain", ["Un recul des constructions d'au minimum 6 mètres est exigé le long des dessertes industrielles et/ou du domaine public."]),
)
D['29975-B'] = dict(name='ZIBAT Nord (Vernier)',
  height=({'rule': 'zone 2 gabarit (LCI 80 al.1, 23); airport ceiling'}, [Z2]),
  density=({'IUS_min': {'A': 0.4, 'C': 1.0}, 'IOS_max_A_C': 0.7}, ["IUS minimum Secteur de densification A 0.4 Secteur de densification C 1 IOS maximum 0.7"]),
  distances=("Min 6 m setback", ["Un recul des constructions d'au minimum 6 mètres est exigé le long des dessertes industrielles et/ou du domaine public."]),
)
D['29976'] = dict(name='ZIMOGA - zone industrielle de Mouille-Galand (Vernier / Meyrin / Satigny)',
  height=({'rule': 'zone 2 gabarit (LCI 80 al.1, 23); airport ceiling'}, [Z2]),
  density=({'IUS_min': {'A': 0.8, 'B': 0.8, 'C': 0.8, 'D': 1.5}, 'IOS_max': {'C': 0.5, 'D': 0.5}}, ["IUS minimum IOS maximum Secteur de densification A 0.8 néant Secteur de densification B 0.8 néant Secteur de densification C 0.8 0.5 Secteur de densification D 1.5 0.5"]),
  distances=("Min 6 m setback", ["Un recul des constructions d'au minimum 6 mètres est exigé le long des dessertes industrielles et/ou du domaine public."]),
)
D['29994'] = dict(name='La Pallanterie Sud (Meinier / Collonge-Bellerive)',
  height=({'max_m': 23, 'max_altitude_m': 453, 'community_building_altitude_m': 458, 'max_levels': 'R+3'}, ["e gabarit des bâtiments ne peut pas excéder 23 mètres et la cote d’altitude de 453 m.", "ne peuvent abriter plus de 4 niveaux en surface (R+3).", "peut atteindre la cote d’altitude de 458 m."]),
  density=({'IUS_min': {'A': 1.5, 'B': 1.5, 'C': 1.7, 'D': 1.5, 'E': 1.9}, 'note': 'per aire de localisation, see sectors'}, ["Dans l’aire de localisation « C », l’IUS minimal à atteindre est de 1,7.", "Dans l’aire de localisation « E », l’IUS minimal à atteindre est de 1,9."]),
)
D['29995'] = dict(name='Bois-Brûlé (Grand-Saconnex / Bellevue)',
  height=({'rule': 'zone 2 gabarit (LCI 80 al.1, 23); airport ceiling'}, [Z2]),
  density=({'IUS_min': {'A': 0.8, 'B': 0.8, 'C': 0.8, 'D': 0.5}, 'IOS_max': {'A': 0.5, 'B': 0.5, 'C': 0.5, 'D': 0.3}}, ["Pour les secteurs de densification A, B et C, l’IUS minimum doit être de 0.8 et l’IOS maximum de 0.5. Pour le secteur de densification D, l’IUS minimum doit être de 0.5 et l’IOS maximum de 0.3."]),
)
D['30097'] = dict(name='Les Rouettes (Bernex)',
  height=({'max_m': 24, 'reduced_m': 18, 'reduced_where': 'fronts on ch. des Rouettes / retention basin over 20 m depth (areas C, D)', 'min_m_boulevard_des_Abarois': 15}, ["La hauteur maximale des constructions est de 24 m, conformément aux articles 23 et 80 de la loi sur les constructions et les installations diverses", "une hauteur maximale réduite à 18 m est applicable sur une profondeur d’au minimum 20 m", "Boulevard des Abarois : une hauteur minimale de 15 m est ap"]),
  density=({'SBP_min_total_m2': 88568, 'IUS_min_global': 1.0, 'IUS_min': {'A': 0.84, 'B': 1.12, 'C': 0.95, 'D': 0.85}, 'ID_min': 1.31}, ["un minimum de 88'568 m2 de SBP est prévu, représentant un IUS minimum (IUS min) d’environ 1.0.", "Pièce urbaine A : IUS min de 0.84 et SBP min de 8'533 m2", "Pour chaque pièce urbaine, l’indice de densité minimum (ID min) est de 1.31."]),
)

D['28495-B'] = dict(name='La Palanterie (Collonge-Bellerive) [OCR]',
  use=("Priority industrial and artisanal; industrial-zone rules (LCI 80-81)", ["sont affectés prioritairement à des activités-industrielles et artisanalès"]),
  height_rule=("Plan fixes max gabarit per sector", ["LE CHIFFRE INDIQUE LE GABARIT MAXIMUM"]),
)
D['28460-B'] = dict(name='ZODIM (Meyrin) [OCR]',
  use=("Industrial, artisanal and distribution activities", ["les terrains sont affectés à des activités industrielles, artisanales et de distri"]),
  density=({'IUS_max': 2.0, 'footprint_max': '2/3 of initial parcel area', 'green_min': '15% of parcel'}, ["ne peut excéder le taux de 2,0.", "L'occupation des bâtiments hors-sol ne peut excéder les deux tiers de la surface initiale des parcelles", "surface résultante sera équivalente au minimum à 15 % de la surface de"]),
  height_rule=("Max height indicated per perimeter on plan", ["LA HAUTEUR MAXIMUM DES CONSTRUCTIONS EST INDIQUEE DANS CHAQUE PERIMETRE"]),
)
D['27953'] = dict(name='La Susette (Grand-Saconnex) [OCR, heavily garbled]',
  density=({'IUS': 1.2, 'IUS_if_height_over_12m': 1.5, 'footprint_max': '2/3 of initial surface', 'note': 'OCR garbled; values confirmed visually on the sheet (georef/evidence/27953_art5_values.png)'}, ["u = 1,2", "peut Être porté à 1,5", "excéder les 2/3 de la surfase"]),
  height_rule=("Plan fixes max height per implantation sector (roof gabarit not included); figures read visually on the plan, see sectors", ["u = 1,2"]),
)
D['26615-N'] = dict(name='ZIMEYSA (Satigny / Meyrin) - règlement 27111A [OCR]',
  use=("Exclusively industrial or assimilated activities; housing only for guarding", ["sont réservés exclusivement à des constructions affectées à des activités industrielles ou assimilées."]),
  height=({'rule': 'industrial-zone default: règlement directeur 27111A sets no gabarit, so the industrial-zone norms enabled by LZIAM art. 4 apply = zone 2 gabarit (LCI art. 80 al. 1, art. 23)', 'street_formula': 'H <= D + 3', 'max_m': 24, 'source': 'default (rules_catalogue.json zone DIA/IA)'},
          ["sont réservés exclusivement à des constructions affectées à des activités industrielles ou assimilées."], ['LZIAM4.1', 'LCI80.1', 'LCI23.1', 'LCI23.6']),
)

D['28667'] = dict(name='ZIPLO extension / route de Base (Plan-les-Ouates) [OCR]',
  use=("Essentially industrial or artisanal activities", ["sont destinés essentiellement à des constructions affectées à des activités industrielles ou arti"]),
  height_rule=("Max altitude incl. superstructures per sub-perimeter A-I (legend): A 429.00, B 426.00, C 427.50, D+I 426.00, E+H 425.50, F+G 424.00 m; values per sector",
               ["L'attiude des constructions, y compris les superstructures"]),
)

D['28689-A'] = dict(name='La Pallanterie-Est (Meinier / Collonge-Bellerive) [OCR]',
  use=("Industrial and artisanal activities", ["Les terrains sont affectés à des activités industrielles et artisanales"]),
  height=({'max_m': 10, 'measured': 'mean natural ground to top of roof slab, excl. superstructures'}, ["La hauteur du gabarit, mesurée à partir du niveau moyen du terrain naturel adjacent jusqu'au sommet de la dalle brute de couverture est de 10 mètres au maximum, superstructures non comprises."]),
)
