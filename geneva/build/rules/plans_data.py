# Per-plan extraction. Each field: (value_dict_or_text, [verbatim quotes]) ; quotes must occur in the plan's text files.
# Special values: ('unknown', reason) when only graphical / illegible.
P = {}
STD_MAINT = "Maintained buildings: no demolition; only maintenance / transformation (adaptation of premises, comfort, energy); protected elements (facades, roof profile, structures) preserved"

P['216'] = dict(
  zones='forest / nature reserve (Bois d\'Avault)',
  use=("Nature reserve protection; the règlement on protected sites and nature reserves (L 4 8) applies in the general perimeter", ["Périmètres Le plan de site comprend un périmètre, général à l’intérieur duquel figure le périmètre particulier de la réserve naturelle."]),
  height=('none', 'not regulated: nature-reserve plan, no building provisions'),
)
P['30151'] = dict(
  zones='zone 2',
  maintained=(STD_MAINT + " (cat. A and B)", ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux, à une amélioration du confort ou à un assainissement énergétique."]),
  other_buildings=("May be demolished, transformed or rebuilt at most in the same implantation and gabarit", ["autres bâtiments peuvent être démolis, transformés ou être reconstruits aux maxima dans la même implantation et le même gabarit"]),
  height=({'rule': 'existing gabarit (max = existing for rebuilds)'}, ["reconstruits aux maxima dans la même implantation et le même gabarit"]),
)
P['29993'] = dict(
  zones='mainly agricultural zone, plus 4B protégée, verdure, sportive, équipement public',
  maintained=(STD_MAINT, ["travaux d’entretien ou les transformations nécessaires à un changement d’affectation des bâtiments maintenus peuvent être entrepris"]),
  other_buildings=("Outside agricultural zone: demolish, transform, minor extension or rebuild in same implantation and gabarit", ["Les autres bâtiments situés hors zone agricole peuvent être démolis, transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit."]),
  demolition=("Demolition of buildings marked on the plan required as counterpart of rehabilitation / change of use", ["démolition de bâtiments ou parties de bâtiments, indiqués comme tels sur le plan, est exigée en contrepartie d'une réhabilitation du site"]),
  unbuilt_land=("Unbuilt land stays free of construction (except minor constructions / minor extensions), outside the public-equipment area", ["les surfaces de terrains non bâtis doivent rester libres de constructions et d'installations diverses, sous réserve de constructions de peu d'importance"]),
  height=({'rule': 'existing gabarit'}, ["reconstruits dans la même implantation et le même gabarit."]),
)
P['29792'] = dict(
  zones='zone 3 and zone 5 de développement',
  maintained=(STD_MAINT, ["plan désigne les bâtiments qui sont maintenus, en raison de leurs qualités architecturales et historiques"]),
  other_buildings=("May be transformed or rebuilt on same location in initial gabarit", ["autres bâtiments peuvent être transformés ou être reconstruits au même emplacement, dans leur gabarit initial."]),
  new_construction=({'areas': 'graphical (aires d\'implantation on plan)', 'levels': 'R+2 (3 habitable levels)', 'use': 'housing'}, ["une nouvelle construction comportant trois niveaux habitables correspondant à R+2 et destinée à l'habitation, peut être autorisée"]),
  demolition=("Parcel 1053: permit subject to demolition of marked building", ["parcelle no 1053, la délivrance de l'autorisation de construire est subordonnée à la démolition du bâtiment indiqué comme tel sur le plan."]),
  height=({'new_buildings_levels': 'R+2', 'existing': 'initial gabarit'}, ["trois niveaux habitables correspondant à R+2"]),
)
P['29934'] = dict(
  zones='(Sauverny - Le Martinet, Versoix)',
  maintained=(STD_MAINT, ["travaux d'entretien ou les transformations nécessaires à un changement d'affectation des bâtiments maintenus peuvent être entrepris"]),
  new_construction=("Only minor constructions and minor extensions per LAT/LaLAT", ["dispositions de la LAT et de LaLAT sont applicables aux constructions de peu d'importance et aux agrandissements mineurs des bâtiments existants."]),
  parking=("Max 2 parking places per dwelling near maintained buildings", ["deux places au maximum par logement (visiteurs compris)"]),
  height=({'rule': 'existing (no new buildings provided)'}, ["dispositions de la LAT et de LaLAT sont applicables aux constructions de peu d'importance"]),
)
P['30216'] = dict(
  zones='zone 5 and agricultural zone; LPRLac',
  density=({'IUS_max': 0.2, 'SBP_max_m2': 8042, 'SBP_existing_m2': 750, 'IUS_HPE_THPE': 0.22, 'use': 'housing'}, ["L'indice d'utilisation du sol (IUS) maximum de la partie du périmètre du plan de site sise en zone 5 est de 0.2, représentant un maximum de 8'042 m2/ de surfaces brutes de plancher (SBP) hors sol destinées à du logement, dont 750 m2 / de SBP existantes.", "peuvent être augmentés de 10 % (IUS 0,22) lorsque la réalisation est conforme à un standard de haute ou très haute performance énergétique"]),
  new_construction=({'areas': 'graphical', 'levels_max': 2, 'heights': 'max altitudes in sections (graphical)'}, ["constructions nouvelles doivent être implantées dans les aires prévues à cet effet", "Deux niveaux habitables peuvent être prévus au maximum."]),
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux"]),
  demolition=("Building 2 rights conditional on demolishing building A379 and pool", ["La réalisation des droits à bâtir nécessaires à la construction du bâtiment 2 est subordonnée à la démolition du bâtiment A379"]),
  height=({'levels_max': 2, 'altitudes': 'unknown - graphical (sections AA/BB)'}, ["Deux niveaux habitables peuvent être prévus au maximum."]),
)
P['29848'] = dict(
  zones='hamlet of Arare-Dessus (zone rules per LCI/LaLAT)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l'objet de transformations nécessaires à une adaptation des locaux"]),
  other_buildings=("Integrated buildings: demolish and rebuild in same implantation and gabarit; other buildings: transform, minor extension or rebuild", ["bâtiments intégrés peuvent être démolis et reconstruits dans la même implantation et le même gabarit."]),
  new_construction=({'areas': 'graphical (areas partly abrogated 2024)', 'height_max_m': 7}, ["constructions nouvelles ne peuvent être édifiées que dans les aires prévues à cet effet.", "gabarit max h=7m"]),
  unbuilt_land=("Unbuilt land free of construction except rebuilds, minor buildings, minor extensions, parking, play areas", ["surfaces de terrain non bâties doivent rester libres de construction et d'installations diverses"]),
  height=({'new_buildings_max_m': 7, 'existing': 'same gabarit'}, ["gabarit max h=7m"]),
)
P['28392'] = dict(
  zones='zones 1/2 (Rade)',
  maintained=("Maintained buildings incl. 1945-70 contemporary; transformed height <= existing", ["Gabarit Pour les bâtiments visés à l'article 4, le gabarit de hauteur d'un bâtiment transformé ne peut excéder la hauteur du bâtiment existant."]),
  other_buildings=("May be demolished and rebuilt or enlarged; department fixes gabarit for harmonious junction, may impose lower; never above roof gabarit of neighbours", ["Autres bâtiments Les autres bâtiments peuvent être démolis et reconstruits ou agrandis aux conditions du présent règlement.", "gabarit ne devra en aucun cas être supérieur au gabarit de toiture des bâtiments contigus."]),
  use=("Ground floors: commercial activities open to public; hotels keep hotel use (if not, other activities max 30% SBP)", ["Destination Les rez-de-chaussée des bâtiments sont, en règle générale, destinés aux activités commerciales ouvertes au public", "n'occupent pas plus de 30 % des surfaces brutes de plancher de l'immeuble."]),
  height=({'maintained': '<= existing', 'others': 'set by department, <= roof gabarit of contiguous buildings'}, ["le gabarit de hauteur d'un bâtiment transformé ne peut excéder la hauteur du bâtiment existant."]),
  reserved=("Gabarit regulations 4198, 1150, 20170 reserved", ["Demeure réservée l'application des règlements fixant les gabarits nº 4198-259"]),
)
P['30158'] = dict(P['28392'], zones='partial modification of plan de site de la Rade 28392G (same règlement)')
P['28590'] = dict(P['28392'], zones='Palais Wilson: PLQ valant règlement spécial et plan de site de détail (same règlement file as 28392G)',
  new_construction=("Hotel Président extension, congress centre, light low buildings and underground construction located graphically", ["Hôtel Président Extension de l’Hôtel Président Centre de congrès Constructions basses légères attenantes au Palais Wilson Construction en sous-sol"]))
P['29394'] = dict(
  zones='zone 5 (Le Mervelet)',
  maintained=("Maintained buildings: only maintenance or comfort transformations; interesting buildings in principle maintained", ["bâtiments maintenus ne peuvent faire l’objet que de travaux d’entretien ou de transformations nécessaires à une amélioration du confort."]),
  other_buildings=("Transform, minor extension or rebuild", ["Autres bâtiments Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits aux conditions du présent règlement."]),
  new_construction=("Indicative implantation of new building conforming to zone 5", ["Implantation indicative d’une construction nouvelle conforme à la zone 5"]),
  height=({'rule': 'zone 5 rules (10 m) for new; existing for maintained'}, ["Implantation indicative d’une construction nouvelle conforme à la zone 5"]),
)
P['29430'] = dict(
  zones='Le Lignon (Vernier)',
  maintained=("Cat. A and B buildings maintained", ["batiments de la catégorie A sont maintenus.", "bâtiments de la catégorie B sont maintenus."]),
  other_buildings=("Transform or rebuild in initial gabarit; shopping centre (parcels 2592, 4320) may add one storey", ["Les autres bâtiments peuvent être transformés ou être reconstruits au même emplacement, dans leur gabarit initial"]),
  new_construction=({'levels_max': 'R+2', 'use': 'public activities', 'height': '<= neighbouring building'}, ["une nouvelle construction comportant au maximum trois niveaux habitables correspondant à R+2 et destinée à des activités publiques peut être autorisée.", "gabarit de hauteur de la construction nouvelle ne devra pas excéder celui du bâtiment voisin."]),
  height=({'new': 'R+2, <= neighbouring building', 'existing': 'initial gabarit'}, ["correspondant à R+2"]),
)
P['29575'] = dict(
  zones='PLQ valant plan de site, hameau de Malagny (Genthod)',
  density=({'SBP_total_m2': 2680, 'SBP_existing_m2': 1980, 'SBP_new_m2': 700, 'bonus': '+10% max (energy standard)'}, ["surface brute de plancher (SBP) est fixée à 2'680 m2", "SBP existante: 1980 m2, SBP constructible nouveau bâtiment et annexe: 700 m2", "la surface de plancher constructible peut excéder de 10% au maximum celle qui résulterait de la stricte application du plan."]),
  new_construction=({'gabarits_levels': 'unknown - graphical (fixed on the plan)'}, ["Le plan fixe les gabarits, les implantations et le nombre de niveaux des bâtiments projetés."]),
  height=('unknown', 'gabarits and number of levels fixed graphically on the plan'),
)
P['29484'] = dict(
  zones='Meyrin-Parc (Cité de Meyrin)',
  maintained=("Cat. A and B maintained", ["bâtiments de la catégorie A sont maintenus.", "bâtiments de la catégorie B sont maintenus."]),
  other_buildings=("Transform or rebuild in initial gabarit", ["Autres bâtiments Les autres bâtiments peuvent être transformés ou être reconstruits au même emplacement, dans leur gabarit initial."]),
  new_construction=({'parcel': 13417, 'levels_max': 'R+1', 'use': 'school extension (parascolaire)', 'height': '<= rue des Boudines level'}, ["Dans l'aire prévue à cet effet sur la parcelle 13417, une nouvelle construction comportant au maximum deux niveaux habitables depuis le niveau des terrains de football correspondant à R+1"]),
  height=({'new': 'R+1', 'existing': 'initial gabarit'}, ["correspondant à R+1"]),
)

P['27626'] = dict(
  zones='zone 1 (Saint-Gervais, Coutance)',
  maintained=("Cat. A maintained (only maintenance / comfort renovation); cat. B in principle maintained, transformation/rebuild may be allowed", ["Les bâtiments de la catégorie A sont maintenus ; ils ne peuvent faire l’objet que de travaux d’entretien ou de rénovations nécessaires à une amélioration du confort des locaux.", "bâtiments de la catégorie B sont, en principe maintenus"]),
  height=({'cat_A_B_C': '<= existing height and storeys (plan may fix a higher cornice)', 'others': 'department fixes gabarit to harmonise with contiguous'}, ["Gabarits Pour les catégories A, B, C le gabarit de hauteur d’un bâtiment transformé ou reconstruit ne peut excéder la hauteur du bâtiment existant ; il en va de même pour le nombre des nivaux.", "Toutefois, si une augmentation du gabarit et du nombre de niveaux est admise, le plan fixe la position de la corniche."]),
  use=("Ground floors: public-facing commercial (no administrative); upper floors housing", ["Destination Les rez-de-chaussée des bâtiments sont, en règle générale, destinés aux activités commerciales ouvertes au public et compatibles avec le site, à l’exclusion des activités administratives.", "En règle générale, les étages sont destinés à l’habitation."]),
  underground=("Basements must not harm preservation goals", ["La création de locaux en sous-sol ne doit en aucun cas nuire aux objectifs de préservation."]),
)
P['29962'] = dict(
  zones='zone 4B protégée and agricultural zone (Landecy-sud)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux ou à une amélioration du confort."]),
  other_buildings=("Demolish, transform or rebuild in same implantation and gabarit", ["Les autres bâtiments peuvent être démolis, transformés ou être reconstruits dans la même implantation et le même gabarit"]),
  new_construction=({'areas': 'graphical', 'gabarit': 'fixed by the plan (R+1+attic indicated)', 'SBP': 'unknown - per-parcel SBP table drawn on the plan'}, ["Des constructions nouvelles peuvent être implantées dans les aires prévues à cet effet et dans les gabarits fixés par le plan"]),
  height=({'new': 'R+1+combles (graphical label on plan)'}, ["R+ 1+ Aires d'implantation de constructions nouvelles"]),
  density=('unknown', 'SBP distribution table only graphical on the plan sheet'),
)
P['29431'] = dict(
  zones='zone de hameaux, 4B protégée and agricultural zone (Anières)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux, à un changement d'affectation ou à une amélioration du confort."]),
  other_buildings=("Transform, minor extension or rebuild in same implantation and gabarit", ["peuvent être transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit."]),
  new_construction=({'areas': 'graphical', 'levels_max': 2, 'agricultural': 'in agricultural implantation area'}, ["Des constructions nouvelles peuvent être implantées dans les aires prévues à cet effet, pour autant qu'elles comprennent au maximum 2 niveaux habitables."]),
  unbuilt_land=("Outside implantation areas, unbuilt land stays free of construction", ["Hors des aires d'implantation destinées à des constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de constructions et d'installations diverses"]),
  demolition=("Permit subject to demolition of marked buildings", ["délivrance de l'autorisation de construire est subordonnée à la démolition des bâtiments indiqués comme tels dans le plan."]),
  height=({'new_levels_max': 2}, ["au maximum 2 niveaux habitables."]),
)
P['29376'] = dict(
  zones='zone 4B protégée, zone 5 and agricultural zone (Villette, Thônex)',
  maintained=("Maintained: maintenance, transformation, renovation for comfort", ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien, de transformations et de rénovation nécessaires à une amélioration du confort des locaux."]),
  other_buildings=("Integrated and other buildings may be transformed, extended or demolished; rebuild only in implantation areas (sub-perimeters 1-3)", ["Ces bâtiments peuvent être transformés, agrandis ou démolis.", "cas de démolition d’un bâtiment situé dans les sous-périmètres 1, 2 et 3, celui-ci ne peut être reconstruit que dans les aires d’implantation prévues à cet effet."]),
  height=({'new_buildings': 'R+1 max and 6.00 m at cornice; parcel 4842 / lower 3052: 3.50 m upslope, flat roofs'}, ["gabarit des constructions nouvelles doit comporter un étage sur rez-de-chaussée au maximum et respecter la hauteur de 6,00 m à la corniche.", "Pour la parcelle 4842 et la partie inférieure de la parcelle 3052, le gabarit des constructions nouvelles ne doit pas excéder une hauteur de 3,50 m, mesurée en amont de la pente."]),
  density=({'sub_perimeter_2_IUS_max': 0.2, 'sub_perimeter_4_IUS_max': 0.2, 'sub_perimeter_4': 'two new individual villas'}, ["L’indice d’utilisation du sol est limité à 0,2 conformément au plan directeur communal", "À l’intérieur du sous-périmètre 4, l’indice d’utilisation du sol est limité à 0,2."]),
  distances=("Parcel 5222 rebuild: 15 m from north enclosure wall", ["l’implantation de la nouvelle construction doit respecter la distance de 15 mètres au mur d’enceinte nord."]),
  new_construction=({'areas': 'graphical'}, ["de nouvelles constructions ne peuvent être édifiées que dans les aires prévues à cet effet."]),
)
CAMP = dict(
  zones='Pointe-à-la-Bise (Collonge-Bellerive), leisure/camping sector',
  new_construction=("No new construction inside the (reserve) sector; existing may be maintained; projected 1-level reception building located graphically; sub-perimeters A-C extend the camping", ["Toute construction nouvelle est interdite à l’intérieur du secteur ; les constructions existantes peuvent être maintenues.", "Bâtiment projeté, 1 niveau"]),
  use=("Camping extension", ["Les trois sous-périmètres A, B, C sont destinés à prolonger le secteur du camping actuel."]),
  height=({'projected_building_levels': 1}, ["Bâtiment projeté, 1 niveau"]),
)
P['27878'] = dict(CAMP); P['28679'] = dict(CAMP); P['30174'] = dict(CAMP, zones='Partial abrogation of 28679B (chemin des Marèches); same règlement file')
ROSE = dict(
  zones='Roseraie / Beau-Séjour (Ville de Genève): ordinary zones per sub-perimeter',
  maintained=("Maintained buildings: only maintenance / adaptation / change of use / comfort; interesting buildings and XXth ensembles maintained", ["bâtiments maintenus ne peuvent faire l’objet que de travaux d’entretien ou de transformations nécessaires à une adaptation des locaux, à un changement d’affectation ou à une amélioration du confort."]),
  other_buildings=("Transform, minor extension or rebuild", ["Autres bâtiments Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits aux conditions du présent règlement."]),
  height=({'rule': 'transformed or rebuilt building <= existing height (except PLQ 28670B in sub-perimeter 6)'}, ["le gabarit de hauteur d’un bâtiment transformé ou démoli et reconstruit ne peut excéder la hauteur du bâtiment existant."]),
  unbuilt_land=("Sub-perimeters 1 and 3: unbuilt land free of construction (minor works excepted); sub-perimeter 5: no new buildings except implantation areas on parcels 1817 and 1822", ["Surfaces libres de constructions Sous-périmètres 1 et 3, les surfaces de terrain non bâties doivent rester libres de constructions et d’installations diverses", "à l'exception des aires d'implantation de constructions nouvelles sises sur les parcelles 1817 et 1822, n'est pas autorisée."]),
  use=("Sub-perimeters 5: mainly hospital uses", ["les terrains compris à l’intérieur des sous-périmètres 5 sont destinés principalement à des affectations hospitalières."]),
)
P['29184'] = dict(ROSE); P['29589'] = dict(ROSE, zones='Plan de site La Colline (shares règlement 29184A-29589-30054)'); P['30054'] = dict(ROSE, zones='Plan de site chemin Thury, parcel 1817 (shares règlement 29184A-29589-30054)')

P['30074'] = dict(
  zones='agricultural zone hamlet (La Branvaude, Versoix)',
  maintained=(STD_MAINT, ["travaux d'entretien ou les transformations nécessaires à un changement d'affectation des bâtiments maintenus peuvent être entrepris"]),
  other_buildings=("Demolish, transform or rebuild in same implantation and gabarit; buildings 882, 1571, 2934, 4069 measured agricultural extension", ["peuvent être démolis, transformés ou être reconstruits dans la même implantation et le même gabarit", "les bâtiments nos 882, 1571, 2934 et 4069 peuvent faire l'objet d'un agrandissement mesuré"]),
  unbuilt_land=("View cones free of any new construction, even minor", ["cônes de vues doivent être maintenus libres de toute nouvelle construction, même de peu d’importance."]),
  parking=("Max 2 places per dwelling", ["à raison de deux places au maximum par logement (visiteurs compris)."]),
  height=({'rule': 'existing gabarit'}, ["reconstruits dans la même implantation et le même gabarit"]),
)
P['29999'] = dict(
  zones='La Malvande (Pregny-Chambésy)',
  density=({'IUS_max': 0.6, 'SBP_new_m2': 25901, 'SBP_existing_m2': 3198, 'SBP_total_m2': 29099, 'per_building': 'see sectors (A 11221, B 8132, C 3327, D 1786, E 1435 m2)'}, ["L'indice d'utilisation du sol sera inférieur ou égal à 0.60 selon le tableau ci-dessus.", "25'901 m2 ====== 29'099 m2", "673 m2 1'433 m2 1'092 m2 ______ 3'198 m2"]),
  new_construction=({'areas': 'building areas A-E (see sectors for levels, SBP and max altitude)', 'use': 'A-C housing/tertiary; D-E hotel/tertiary', 'roofs': 'green, non-accessible'}, ["constructions nouvelles peuvent être implantées dans les aires prévues à cet effet et dans les gabarits et altitudes maximales fixés par le plan.", "L'aire d'implantation du bâtiment A, prévue pour du logement et / ou du tertiaire"]),
  height=({'rule': 'per building area: levels and max altitude fixed by the plan (see sectors); maintained buildings keep existing gabarit'}, ["dans les gabarits et altitudes maximales fixés par le plan."]),
  maintained=(STD_MAINT, ["travaux d’entretien ou les transformations nécessaires à un changement d’affectation des bâtiments maintenus peuvent être entrepris"]),
  other_buildings=("May be demolished", ["Les autres bâtiments peuvent être démolis."]),
  underground=("All parking underground (except short-term)", ["Toutes les places de stationnement, hormis celles de courte durée réservées à la dépose et aux livraisons, devront être aménagées en sous-sol."]),
)
P['29479'] = dict(
  zones='Cartigny hamlet; plan de site valant partly PLQ (LGZD)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux, à un changement d'affectation ou à une amélioration du confort."]),
  other_buildings=("Transform, minor extension or rebuild in same implantation and gabarit", ["Les autres bâtiments peuvent être transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit."]),
  new_construction=({'areas': 'graphical', 'levels_max': 2, 'use': 'housing (buildings A and B)'}, ["Des constructions nouvelles peuvent être implantées dans les aires prévues à cet effet, pour autant qu'elles comprennent au maximum 2 niveaux habitables."]),
  unbuilt_land=("Outside implantation areas, unbuilt land free of construction", ["Hors des aires d'implantation destinées à des constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de constructions et d'installations diverses"]),
  demolition=("Permit subject to demolition of marked buildings", ["délivrance de l'autorisation de construire est subordonnée à la démolition des bâtiments indiqués comme tels dans le plan."]),
  height=({'new_levels_max': 2}, ["au maximum 2 niveaux habitables."]),
)
P['29525'] = dict(
  zones='zone 5 (Cologny, LPRLac)',
  density=({'IUS_max': 0.2, 'basis': 'LPRLac'}, ["L'indice d'utilisation du sol est limité à 0,2, conformément à la loi sur la protection des rives du lac."]),
  use=("Sector B several villas; sector C one villa; sector A maintained buildings", ["secteur B est destiné à la construction de plusieurs villas localisées au Nord Est de la parcelle.", "secteur C est destiné à la construction d'une villa individuelle."]),
  new_construction=({'areas': 'graphical'}, ["constructions nouvelles doivent être implantées à l’intérieur des aires prévues à cet effet et doivent ménager les points de vue."]),
  unbuilt_land=("Outside implantation areas no construction at all", ["En dehors des aires d’implantation de constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de toutes constructions et d’installations."]),
  maintained=("Maintained: maintenance and comfort transformations", ["ils peuvent faire l’objet de travaux d’entretien et de transformations nécessaires à une amélioration du confort des locaux."]),
  height=({'rule': 'zone 5 (10 m) - no specific height in règlement'}, ["situées en 5ème zone destinée aux villas."]),
)
P['29541'] = dict(
  zones='zone de hameaux (Meinier)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux"]),
  other_buildings=("Transform, minor extension or rebuild in same implantation and gabarit", ["Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit."]),
  new_construction=({'areas': 'graphical (one area)', 'levels_max': 2}, ["Une construction nouvelle peut être implantée dans l’aire prévue à cet effet, pour autant qu’elle comprenne au maximum 2 niveaux habitables."]),
  unbuilt_land=("Outside the area, unbuilt land free of construction", ["Hors de l’aire d’implantation destinée à une construction nouvelle, les surfaces de terrain non bâties doivent rester libres de construction et d’installations diverses"]),
  height=({'new_levels_max': 2}, ["au maximum 2 niveaux habitables."]),
)
P['29400'] = dict(
  zones='Cités-jardins d\'Aïre (Genève / Vernier)',
  maintained=("Maintained: only maintenance / adaptation / comfort", ["bâtiments maintenus ne peuvent faire l'objet que de travaux d'entretien ou de transformations nécessaires à une adaptation des locaux et à une amélioration du confort."]),
  other_buildings=("Transform, demolish or rebuild same place, initial gabarit and use", ["Autres bâtiments Les autres bâtiments peuvent être transformés, démolis ou être reconstruits au même emplacement, dans leur gabarit et affectation initiaux."]),
  new_construction=({'levels_max': 2, 'IUS_max_parcel': 0.6, 'where': 'aires d\'implantation de constructions nouvelles (graphical)', 'extensions': 'per sector (verandas), see sectors'}, ["gabarit maximum des nouvelles constructions est fixé à 2 niveaux.", "revenant à la parcelle est limité à 0.6."]),
  density=({'IUS_max': 0.6}, ["revenant à la parcelle est limité à 0.6."]),
  unbuilt_land=("Outside new-construction areas, gardens free of construction except garden sheds", ["En dehors des aires destinées aux constructions nouvelles, les surfaces de terrain non bâties et les jardins privatifs doivent rester libres de constructions et d’installations diverses, à l’exception des cabanes de jardin ou remises."]),
  height=({'new_levels_max': 2}, ["gabarit maximum des nouvelles constructions est fixé à 2 niveaux."]),
)
P['30111'] = dict(
  zones='Les Arpillières (Chêne-Bougeries), zone 5',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux ou à une amélioration du confort."]),
  other_buildings=("Demolish, transform or rebuild in same implantation and gabarit", ["autres bâtiments peuvent être démolis, transformés ou être reconstruits dans la même implantation et le même gabarit"]),
  new_construction=({'areas': 'graphical', 'gabarit': 'fixed by plan (graphical)', 'SBP': 'indicated on plan (graphical); LCI 59 reserved'}, ["construction nouvelle peut être implantée dans l’aire prévue à cet effet et dans les gabarits fixés par le plan, selon la surface brute de plancher indiquée sur le plan, sous réserve du respect de l'article 59 de la loi sur les constructions et installations diverses"]),
  height=({'new_building': 'R+1+C, SBP total 225 m2 (parcel 1637)', 'source': 'plan label read visually (georef/evidence/30111_new_area_R+1+C_SBP225.png)'}, ["Une construction nouvelle peut être implantée dans l'aire prévue à cet effet et dans les gabarits fixés par le plan"]),
  density=({'rule': 'LCI art. 59 (zone 5) applies; SBP figure only graphical'}, ["sous réserve du respect de l'article 59 de la loi sur les constructions et installations diverses"]),
)

HAMLET2 = lambda zones, q_maint, q_other, q_new, q_free, extra=None: dict(dict(
  zones=zones,
  maintained=(STD_MAINT, [q_maint]),
  other_buildings=("Transform, minor extension or rebuild (same implantation/gabarit or new-construction rules)", [q_other]),
  new_construction=({'areas': 'graphical', 'levels_max': 2}, [q_new]),
  unbuilt_land=("Outside implantation areas unbuilt land free of construction (minor works, parking excepted)", [q_free]),
  height=({'new_levels_max': 2}, [q_new])), **(extra or {}))
P['29108'] = HAMLET2('zone 4B protégée and agricultural zone (Peissy, Satigny)',
  "bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux",
  "Autres bâtiments Les autres bâtiments, sis en 4e zone B protégée, peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits en respectant les règles relatives aux constructions nouvelles",
  "Des constructions nouvelles peuvent être implantés dans les aires prévus à cet effet, pour autant qu’elles comprennent au maximum 2 niveaux habitables.",
  "Hors des aires d’implantation destinés à des constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de constructions et d’installations diverses")
P['29543'] = HAMLET2('zone de hameaux (Meinier)',
  "bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformation nécessaires à une adaptation des locaux",
  "Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit.",
  "Une construction nouvelle peut être implantée dans l’aire prévue à cet effet, pour autant qu’elle comprenne au maximum 2 niveaux habitables.",
  "Aires libres de constructions Les surfaces de terrain non bâties doivent rester libres de construction et d’installations diverses",
  {'demolition': ("Permit subject to demolition of marked buildings", ["délivrance de l'autorisation de construire est subordonnée à la démolition des bâtiments indiqués comme tels dans le plan."])})
P['29165'] = dict(
  zones='zone 5 and agricultural zone (Fossard, Thônex)',
  maintained=("Maintained: maintenance, transformation, renovation for comfort", ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien, de transformation et de rénovation nécessaires à une amélioration du confort des locaux."]),
  other_buildings=("Transform, minor extension or rebuild per new-construction rules and forest/watercourse distances", ["Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits en respectant les règles relatives aux constructions nouvelles"]),
  new_construction=({'areas': 'graphical (one area)', 'gabarit_levels': 'per LCI (zone rules)'}, ["Les constructions nouvelles sont implantées à l'intérieur de l'aire prévue à cet effet.", "nombre de niveaux habitables sont définis par la LCI."]),
  unbuilt_land=("Outside the area, unbuilt land free of construction", ["Hors de l’aire d’implantation de constructions nouvelles, les surfaces de terrains non bâties doivent rester libres de construction et d’installations diverses"]),
  height=({'rule': 'LCI zone rules (zone 5: 10 m)'}, ["nombre de niveaux habitables sont définis par la LCI."]),
)
P['29530'] = dict(
  zones='Cité-jardin Le Bouchet (Vernier / Genève)',
  maintained=("Maintained: only maintenance / adaptation / comfort; roof openings 2 x 50x70 cm per slope, no dormers", ["bâtiments maintenus ne peuvent faire l'objet que de travaux d'entretien ou de transformations nécessaires à une adaptation des locaux et à une amélioration du confort.", "percements de jours en toiture peuvent être autorisés à raison de deux jours de 50x70 cm par pan de toit, à l'exception de lucarnes."]),
  other_buildings=("Building A1450 may be rebuilt in same implantation and gabarit", ["bâtiment n°A1450 peut, le cas échéant, être reconstruit dans la même implantation et le même gabarit"]),
  height=({'rule': 'existing gabarit'}, ["reconstruit dans la même implantation et le même gabarit"]),
)
P['30036'] = dict(
  zones='zone 4B protégée, équipement public, agricultural and forest (Dardagny village)',
  maintained=(STD_MAINT, ["Les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des"]),
  new_construction=({'areas': 'graphical', 'levels': 'per area on plan: R+1+C, R inf.+R+C, R+X+C (graphical labels)'}, ["nombre de niveaux habitables figure sur le plan.", "Aire d'implantation de constructions nouvelles et gabarit maximum"]),
  height=({'new_buildings_levels_per_area': ['R+1+C (most areas)', 'R+2+C', 'R inf.+R+C', 'R+X+C (legend)'], 'note': 'level label printed in each drawn area (text layer); see build_areas_30036.geojson', 'source': 'plan text layer'}, ["R+1+C", "R+2+C", "R inf.+R+C", "Aire d'implantation de constructions nouvelles et gabarit maximum"]),
  demolition=("New construction permit may be conditional on demolition of marked buildings", ["délivrance de l’autorisation de construire d’une construction nouvelle doit être subordonnée à la démolition des bâtiments"]),
)
P['30075'] = dict(
  zones='agricultural zone and zone de hameaux (Petit et Grand Sionnet, Jussy/Meinier)',
  maintained=("Maintained buildings and roofs: maintenance / transformation per LAT 24d", ["les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux"]),
  other_buildings=("Demolish, transform or rebuild in same implantation and gabarits; garages/annexes >= 20 m2 cannot change use", ["autres bâtiments peuvent être démolis, transformés ou être reconstruits dans les mêmes implantations et gabarits", "bâtiments cadastrés comme garage ou autre bâtiment de 20 m2 et plus ne pourront en aucun cas être changés d’affectation."]),
  unbuilt_land=("View cones free of any new construction, even minor", ["cônes de vues indiquant les ouvertures sur la campagne environnante doivent impérativement être maintenus libres de toute nouvelle construction, même de peu d’importance."]),
  height=({'rule': 'existing gabarits (no new buildings)'}, ["reconstruits dans les mêmes implantations et gabarits"]),
)

P['27646'] = dict(
  zones='Rond-point de Plainpalais (zone 2/3, Ville de Genève)',
  maintained=("Maintained: only maintenance / comfort renovation", ["Bâtiments maintenus Les bâtiments maintenus ne peuvent faire l’objet que de travaux d’entretien ou de rénovations nécessaires à une amélioration du confort des locaux."]),
  other_buildings=("Department fixes gabarit and number of levels to harmonise with neighbours", ["fixe le gabarit et le nombre des niveaux de manière à ce que le bâtiment s’harmonise aux constructions voisines."]),
  height=({'maintained': 'existing', 'others': 'set case by case by department (harmonise with neighbours)'}, ["fixe le gabarit et le nombre des niveaux de manière à ce que le bâtiment s’harmonise aux constructions voisines."]),
  use=("Ground floors public-facing commercial, no administrative", ["Destination Les rez-de-chaussée des bâtiments sont, en règle générale, destinés aux activités commerciales ouvertes au public et compatible avec le site, à l’exclusion des activités administratives."]),
)
P['29183'] = dict(
  zones='zone 4B protégée, agricultural and forest (Ecogia, Versoix)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l’objet de travaux d’entretien ou de transformations nécessaires à une adaptation des locaux"]),
  other_buildings=("Transform, minor extension or rebuild", ["Autres bâtiments Les autres bâtiments peuvent être transformés, faire l’objet d’un agrandissement mineur ou être reconstruits."]),
  new_construction=({'areas': 'graphical', 'levels_max': 'R+1'}, ["constructions nouvelles comprennent au maximum 1 niveau sur rez-de-chaussée."]),
  unbuilt_land=("Outside implantation areas free of construction", ["Hors des aires d’implantation de constructions nouvelles, les surfaces de terrains non bâtis doivent rester libres de constructions et d’installations"]),
  height=({'new': 'R+1'}, ["constructions nouvelles comprennent au maximum 1 niveau sur rez-de-chaussée."]),
)
P['30077'] = dict(P['30075'], zones='hamlet of Monniaz (Jussy), agricultural / hamlet',
  maintained=("Maintained buildings and roofs: maintenance / transformation per LAT 24d", ["les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux"]),
  new_construction=({'agricultural_areas': 'graphical, gabarit drawn', 'roofs': 'pitched'}, ["nouveaux volumes auront des toits en pente et les gabarits devront s’inscrire, le cas échéant, dans une continuité avec les constructions agricoles maintenues."]),
  unbuilt_land=("Gardens, orchards and open agricultural land free of construction outside areas", ["en dehors des aires d'implantation des constructions nouvelles, doivent rester libres de constructions."]))
P['29969'] = dict(
  zones='domaine du Grand Morillon (Ville de Genève)',
  maintained=(STD_MAINT, ["plan désigne les bâtiments maintenus, en raison de leurs qualités architecturale, historique et de leur appartenance à un ensemble digne d'intérêt."]),
  other_buildings=("Demolish, transform, minor extension or rebuild in same implantation and gabarit", ["Les autres bâtiments peuvent être démolis, transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans la même implantation et le même gabarit"]),
  new_construction=({'areas': 'graphical', 'heights': 'max gabarits and altitudes fixed graphically on plan', 'use': 'lower area along allée David-Morse: international organisations / diplomatic missions; north-west areas: housing'}, ["constructions nouvelles peuvent être implantées dans les aires prévues à cet effet et dans les gabarits et altitudes maximales fixés par le plan", "aires d'implantation de constructions nouvelles situées au nord-ouest des parcelles nos 5427, 5428 et 5431 sont prévues pour de l'habitation."]),
  height=('unknown', 'max gabarits and altitudes only on the plan sheet'),
)
P['29953'] = dict(
  zones='zone 4B protégée, zone 4B and zone de développement 3 (Chêne-Bougeries village north)',
  maintained=(STD_MAINT, ["bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformations qui s'avèreraient nécessaires à une adaptation des locaux"]),
  other_buildings=("Other buildings may be demolished; buildings with interesting elements may be raised within plan gabarits", ["autres bâtiments peuvent être démolis.", "bâtiments avec éléments intéressants peuvent faire l'objet d'une surélévation dans les gabarits fixés par le plan"]),
  new_construction=({'levels': 'fixed by the plan (labels e.g. R+2, R+3+C)'}, ["plan fixe le nombre de niveaux autorisés pour les constructions nouvelles.", "Aire d’implantation de construction nouvelle / Nombre de niveaux R+2"]),
  use=("Buildings for housing; ground floors on rue de Chêne-Bougeries / ch. de la Fontaine commercial", ["principe, les bâtiments sont dévolus au logement"]),
  height=({'new_buildings_levels_per_area': ['R+2', 'R+3', 'R+2+C'], 'note': 'level label printed in each drawn area (text layer)'}, ["R+3", "R+2+C", "Aire d’implantation de construction nouvelle / Nombre de niveaux R+2"]),
)
P['29872'] = dict(
  zones='Ville de Genève (Garages / Dentand / Dejean ensemble)',
  maintained=("Maintained in gabarit, implantation and substance", ["doivent être maintenus dans leur gabarit, dans leur implantation et dans leur substance."]),
  use=("Garages/boxes keep their use (may become commercial/artisanal); ground floors on rue de Lausanne / Valais commercial per PUS", ["box fermés situés le long de la rue des Garages, de la rue Dentand et de la rue Dejean"]),
  underground=("Minor underground constructions possible", ["constructions en sous-sol de moindre importance sont envisageables sous réserves du respect des dispositions légales en vigueur."]),
  height=({'rule': 'existing gabarit maintained'}, ["doivent être maintenus dans leur gabarit, dans leur implantation et dans leur substance."]),
)
P['29559'] = dict(
  zones='Squares de Montchoisy (Ville de Genève)',
  maintained=("Cat. A and B maintained; interesting buildings in principle maintained, rebuild possible in initial gabarit", ["bâtiments de la catégorie A sont maintenus.", "bâtiments de la catégorie B sont maintenus.", "peut autoriser leur reconstruction au même emplacement et dans leur gabarit initial."]),
  use=("Ground floors on rue de Montchoisy: public commercial (PUS)", ["rez-de-chaussée des bâtiments situés le long de la rue de Montchoisy sont destinés aux activités commerciales ouvertes au public"]),
  height=({'rule': 'existing / initial gabarit'}, ["dans leur gabarit initial."]),
)

P['29790'] = dict(
  zones='PLQ valant pour partie plan de site (Coin-de-Terre / Nant-Cayla, Ville de Genève)',
  density=({'SBP_max_m2': 32254, 'activities_max_m2': 4000, 'IUS_max_dense_part': 1.23, 'IUS_whole_perimeter': 0.76}, ["La surface brute de plancher (SBP) est limitée à 32'254 m2 dont 4'000 m2 maximum d'activité et/ou de locaux communs soit un indice d'utilisation du sol (IUS) de 1.23 maximum correspondant à un IUS de 0.76 pour l'ensemble du périmètre"]),
  height=({'new_buildings': 'R+7, max altitudes 442.00-443.00 m (plan labels)'}, ["alt. max. 442.00", "alt. max. 443.00", "s Vélo R+7"]),
  maintained=("Maintained buildings (site sub-perimeter): energy transformations; minor buildings and limited extensions on courtyard side", ["Les bâtiments maintenus peuvent faire l'objet de transformations nécessaires aux économies d'énergie"]),
  use=("Housing and/or activities", ["Affectation : logements et/ou activités (commerce, administrations...)."]),
  bonus=("+10% floor area for energy standard", ["la surface de plancher constructible peut excéder de 10% au maximum celle qui résulterait de la stricte application du plan."]),
)
P['29485'] = dict(
  zones='Ensemble de Budé (Ville de Genève)',
  maintained=("Cat. A, B and C buildings maintained", ["bâtiments de la catégorie A sont maintenus.", "bâtiments de la catégorie B sont maintenus.", "bâtiments de la catégorie C sont maintenus."]),
  height=({'rule': 'existing (all buildings maintained)'}, ["bâtiments de la catégorie A sont maintenus."]),
)
P['29802'] = dict(
  zones='Miremont (Ville de Genève)',
  maintained=("Maintained: maintenance / comfort", ["bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une amélioration du confort."]),
  other_buildings=("Other buildings may be transformed, demolished or rebuilt respecting garden trees and maintained buildings", ["Les autres bâtiments peuvent être transformés, démolis ou reconstruits dans le respect de l'arborisation des jardins et des constructions existantes maintenues."]),
  unbuilt_land=("Buildings and gardens maintained", ["bâtiments et les jardins doivent être maintenus"]),
  height=({'rule': 'existing for maintained; zone rules otherwise'}, ["bâtiments et les jardins doivent être maintenus"]),
)
P['29961'] = dict(
  zones='PLQ valant plan de site, centre of Cartigny village',
  density=({'SBP_max_m2': 3865, 'use': 'housing', 'IUS_max': 0.6, 'ID_min': 0.6}, ["La surface brute de plancher (SBP) est limitée à 3865 m2 de logement, soit un indice d'utilisation du sol (IUS) de 0.6 maximum.", "L'indice de densité (ID) est de 0.6 minimum."]),
  new_construction=({'gabarits': 'fixed by plan; labels R+1+combles'}, ["plan fixe les implantations, les gabarits, la destination et le nombre de niveaux des constructions projetées.", "R+1+combles"]),
  other_buildings=("Transform or rebuild on same location in initial gabarit", ["autres bâtiments peuvent être transformés ou être reconstruits au même emplacement, dans leur gabarit initial."]),
  height=({'new': 'R+1+combles (plan labels)'}, ["R+1+combles"]),
)
P['29577'] = dict(
  zones='Chêne-Bougeries (route de Chêne / Grange-Canal / Puthon)',
  maintained=("Maintained: only maintenance / comfort", ["bâtiments maintenus ne peuvent faire l'objet que de travaux d'entretien ou de transformations nécessaires à une amélioration du confort."]),
  other_buildings=("Transform, minor extension or rebuild in gabarit and implantation", ["Les autres bâtiments peuvent être transformés, faire l'objet d'un agrandissement mineur ou être reconstruits dans leur gabarit et leur implantation."]),
  height=({'rule': 'existing gabarit'}, ["reconstruits dans leur gabarit et leur implantation."]),
)
CAR = dict(
  zones='Vieux-Carouge (4A protected, LCI 94-104)',
  maintained=("Cat. A: maintenance / improvement only; cat. B: transformation if interesting substance kept", ["Un bâtiment maintenu, de la catégorie A, ne peut faire l’objet que de travaux d’entretien ou de transformations utiles à une amélioration des locaux", "bâtiment maintenu, de la catégorie B, peut être transformé si les éléments intéressants de sa substance architecturale sont sauvegardés."]),
  height=('unknown', 'gabarit (number of lit storeys under cornice, cornice position, silhouette) fixed by annex drawings to plan 27383, not available online (plan PDF 404)'),
  height_rule=("Height limit = annex plans (storeys under cornice)", ["Gabarit La limite de gabarit de hauteur des constructions est déterminée par les plans annexés au plan nº 27383 susvisé, qui fixent le nombre de niveaux éclairés sous corniche"]),
  roof=("Max one level in attic; flat tiles", ["l’aménagement de plus d’un niveau dans les combles est interdit."]),
  use=("Ground floor artisanal/commercial; upper floors mainly housing", ["Destinations Le rez-de-chaussée des immeubles est, en principe, destiné à des activités artisanales et commerciales."]),
)
P['27383'] = dict(CAR, height=('unknown', 'règlement art. 5 is legible: gabarit = number of lit storeys under cornice, cornice position and silhouette fixed by the annex plans to plan 27383; the plan sheet and its annex plans are not published online (SITG link 27383_Suivant.pdf and all variants return 404), so the per-building values cannot be read'))
P['28271'] = dict(CAR, zones="Carouge plan de site de détail, parcels 386, 2395 and 397 along passage de l'Intendant (shares règlement 27383)",
  height=({'new_building_parcel_386': 'sablière at altitude 394.30 m (elevation drawing)', 'parcels_2395_397': 'gabarits 1/R and 2/R (storeys / ground floor) drawn on the passage de l\'Intendant elevation', 'source': 'plan sheet PS/28271.pdf read visually (georef/evidence/28271_gabarit_elevation.png)'}, ["h.à la sablière", "394.30", "gabarit"]),
  new_construction=({'areas': "construction nouvelle - périmètre d'implantation on parcel 386 (drawn)", 'maintained': 'building on parcel 386 west maintained in cat. B; wall and gate maintained'}, ["CONSTRUCTION NOUVELLE _ PERIMETRE  D'IMPLANTATION", "- en cat. B"]))

# ---------------- RDPPF_RS (règlements spéciaux / de quartier / village) - texts OCR'd in regs/
RS = {}
RS['26959'] = dict(src='regs/26959AR.txt', zones='4B protégée and 4B protégée de développement (Soral village)',
  density=({'IUS_max': {'village_actuel': 0.35, 'secteurs_de_developpement': 0.2}}, ["a) 0,35 dans le village actuel ;", "b) 0,2 dans le secteur de développement"]),
  height=({'village_actuel': '7 m at sablière (2 levels), attic habitable', 'development_sectors': '4 m at sablière (1 level)'}, ["la hauteur maximum est de 7 m. à la sablière soit 2", "la hauteur maximum est de 4 m. à la sablière, soit 1"]),
  contiguous=("Village: new housing in principle in contiguous order, block length max 50 m", ["la longueur d'un bloc de bâtiment ne peut excéder 50m."]),
  roof=("Two slopes 30-40°", ["Les toitures doivent être à 2 pans inclinés de 300 à 400 avec"]),
  maintained=("Existing village buildings in principle maintained, rebuild on current implantation/gabarit", ["les bâtiments sont en principe maintenus ; sous réserve"]),
)
RS['27425'] = dict(src='regs/27425R.txt', zones='Lully village (Bernex)',
  density=({'IUS_max': {'A': 0.4, 'B': 0.2, 'C': 'LCI art.129 (old numbering = zone 5 ratio)'}}, ["0,4 pour le secteur À", "0,2 pour le secteur B"]),
  height=({'facade_max_m': 7, 'measured': 'at sablière, downhill facade', 'levels': 'R+1 + attic'}, ["La hauteur de la façade ne peut dépasser 7 m au niveau de la sablière."]),
  roof=("Two slopes 30-40°, tiles", ["Les toitures doivent être à deux pans inclinés"]),
)
RS['27723'] = dict(src='regs/27723R.txt', zones='Genthod (secteurs du plan 27723)',
  contiguous=("1/3 isolated, 2/3 contiguous or grouped", ["2/3 des constructions séront édifiés en ordre contiqgu où groupé."]),
  roof=("Two slopes 30-35°", ["Les toitures doivent être à deux pans inclinés de 300 à 350."]),
  height=('none', 'no height in this regulation; LCI zone rules apply'),
)
RS['27304'] = dict(src='regs/27304R.txt', zones='Bernex village',
  density=({'IUS_max': {'1_4_5_6': 0.4, '7_artisanal': 0.6, '2_3': 'LCI art.129 (zone 5 ratio)'}}, ["0,4 pour les secteurs nos 1-4-5-6", "0,6 pour le secteur no 7"]),
  height=({'collective_sectors_levels_max': '3 levels + attic incl. ground floor', 'sector_2A': 'ground floor + habitable attic'}, ["il ne peut excéder 3 niveaux + comble, rez compris.", "est limité à un rez-de-chaussée, plus comble habitable."]),
  use=("Sector 7: artisanal / light non-polluting industry", ["Le secteur est destiné à l'artisanat et à l'industrie"]),
)
RS['4737'] = dict(src='regs/04737AR.txt', zones='Domaine de Ruth (Cologny), règlement de quartier 1938',
  use=("Residential villas only", ["Le quartier est destiné à la résidence exclusivement."]),
  height=({'blue_zone': 'R + habitable attic, ~25° gables', 'pink_zone': 'flat roof, R+1 max', 'rest': 'R + attic or R+1'}, ["un rez-de-chaussée et un premier étage au maximum."]),
  distances=({'min_to_neighbour_parcels_m': 6}, ["à 6 mètres au minimum de la limite des parcelles voisines."]),
)
RS['0'] = dict(src='regs/GyR.txt', zones='Gy village, zone 4B protégée (schéma directeur, cahier des charges)',
  density=({'IUS_max': 0.2}, ["ne peut dépasser 0,2."]),
  height=({'facade_max_m': 7, 'levels': 'R+1 + attic'}, ["La hauteur de la façade ne peut dépasser 7 m au niveau de"]),
  roof=("Two slopes", ["Les toitures doivent être à deux pans"]),
)
RS['27650'] = dict(src='regs/27650R.txt', zones='Plantamour / Cloche / Monthoux / Grand Casino (Ville de Genève)',
  height=('unknown', 'levels, gabarits and destinations fixed only graphically on the plan (OCR of drawing)'),
  rule=("Existing street facades reconstituted; levels/gabarits/uses fixed by plan", ["Les niveaux, gabarits et affectations des constructions sont fixés par le"]),
)
RS['27526'] = dict(src='regs/27526R.txt', zones='Chemin des Tuilières (Hermance), règlement de quartier',
  use=("One dwelling (+ service flat) per parcel", ["Chaque parcelle ne peut comporter qu'un seul logement"]),
  new_construction=("Buildings inside implantation zones on plan (graphical)", ["Les constructions doivent ètre situées à l'intérieur des zones d'implantation figurant au plan."]),
  height=('none', 'not regulated; zone 5 / LPRLac rules'),
)
RS['27283'] = dict(src='regs/27283R.txt', zones='Collex-Bossy (4B protégée sectors 1-3, 5A sector 4)',
  density=({'IUS_max': {'sectors_1_2_3': 0.4, 'sector_4': 'LCI art.129 (zone 5 ratio)'}, 'derogation': 'not derogable (art.8 excludes art.4)'}, ["0,4 pour les secteurs No 1, 2 et 3"]),
  roof=("30-40° (sectors 1-3), 25-35° (sector 4)", ["Les toitures doivent être à 4 pans inclinès de 300 à 400 dans les secteurs 1,"]),
  height=('none', 'no height in regulation; LCI 4B rural (10 m) / zone 5 apply'),
)
RS['4198'] = dict(src='regs/04198_ACE_R.txt', zones='Quai Gustave-Ador / rue Pierre-Fatio (Ville de Genève)',
  height=({'cornice_m_above_sidewalk': 19.60, 'roof_max_deg': 30, 'ridge_max_above_cornice_m': 4}, ["corniche à 19 m. 60 au-dessus du trottoir.", "pas un angle de plus de 30° par rapport à l'horizontale à partir de la corniche.", "Le fsîtage fini ne sera pas à plus de 4 m. au-dessus du niveau de la corniche"]),
  alignment=("Current alignments maintained, no projecting balconies", ["Les alignements de construction actuels sont maintenus."]),
)
RS['27275'] = dict(src='regs/27275R.txt', zones='Puplinge village (4B / 4B protégée)',
  density=({'IUS_max': {'A_rue_de_Graman': 0.5, 'C_route_de_Corniere': 0.3, 'A_with_ground_floor_commerce': 0.6, 'B': 'LCI art.129 (zone 5 ratio)'}}, ["0,5 pour le secteur rue de Graman (A)", "0,3 pour le secteur route de Cornière €", "total de 0,6 des surfaces occupées en rez-de-chaussée"]),
  height=({'facade_max_m': 7, 'at': 'sablière', 'levels_max': 2}, ["dépasser nulle part 7 m au niveau de la sablière ;", "le nombre de niveaux est limité à deux, rez-de-chaussée"]),
)
RS['27353'] = dict(src='regs/27353R.txt', zones='Servette / Lyon (Ville de Genève), parcels 2135-2176-2265-2266',
  height=({'top_slab_altitudes_m': {'R+7': 418.11, 'R+6': 413.74, 'R+5': 410.30}, 'note': 'OCR of plan labels (S. 421.05 also shown); verify on the drawing'}, ["R+7 418.11", "R+6 413.74", "R+5_410.30"]),
  rule=("Regulation fixes top-slab altitudes", ["Réglement fixant les cotes de niveaux des lignes horizontales supérieures"]),
)
RS['27749'] = dict(src='regs/27749R.txt', zones='Rond-Point de Rive (Ville de Genève), règlement spécial valant plan de site',
  height=({'maintained_ensembles': 'transformed height <= existing; others set by department'}, ["le gabarit de hauteur d'un"]),
  note=("Low-resolution scan: partly illegible", ["Gabarit"]),
)
RS['28316'] = dict(src='regs/28316R.txt', zones='Mont-Blanc / Cornavin (Ville de Genève), règlement spécial valant plan de site',
  height=({'maintained': 'transformed height <= existing; others set by department, may impose lower'}, ["le gabarit de hauteur d'un bâtiment transformé ne peut"]),
  use=("Ground floors mainly commercial", ["Les rez-de-chaussée des bâtiments sont, en règle générale. destinés aux activités commer."]),
)

P['29901'] = dict(
  zones='hamlet of Bourdigny-Dessous (Satigny), agricultural zone',
  maintained=(STD_MAINT, ["transformations nécessaires à un changement d'affectation des bâtiments prévus maintenus peuvent être envisagées"]),
  other_buildings=("Demolish, transform or rebuild in same implantation and gabarit, without change of use", ["Les autres bâtiments peuvent être démolis, transformés ou être reconstruits dans la même implantation et le même gabarit, sans changement d'affectation."]),
  demolition=("Demolition of marked buildings required as counterpart of transformations / change of use", ["Bâtiment ou parties de bâtiment dont la démolition est exigée en contrepartie de transformations nécessaires à une adaptation des locaux"]),
  height=({'rule': 'existing gabarit'}, ["reconstruits dans la même implantation et le même gabarit, sans changement d'affectation."]),
)

P['29718'] = dict(
  zones="zone 4B protégée + agricultural sub-perimeters A-D (Saconnex d'Arve-Dessous, Plan-les-Ouates) [OCR]",
  maintained=("Maintained buildings: structures, stairs, facades, roof profile preserved", ["Les éléments dignes de protection doivent être sauvegardés; il en va ainsi des structures porteuses, des escaliers, des façades, et du profil des toitures."]),
  other_buildings=("Integrated: demolish/transform/rebuild in same gabarit; others: demolish, transform, extend within zone limits; site-altering constructions to be demolished with any new request", ["Les bâtiments intégrés peuvent être démolis, transformés ou reconstruits dans le même gabarit et la même implantation.", "peuvent être démolis, transformés et agrandis dans les limites prescriptives de la zone concernée."]),
  new_construction=({'areas': 'implantation areas 1 and 2 (graphical)', 'roof': 'single/double pitch 15-35°, eaves >= 50 cm', 'norms': 'zone 4B protégée'}, ["De nouvelles constructions ne peuvent être édifiées que dans les aires d'implantation de constructions nouvelles n° 1 et 2 prévues à cet effet.", "respecter une pente comprise entre 15° et 35°", "Elles sont soumises aux dispositions applicables en zone 4B protégée."]),
  unbuilt_land=("Building zone outside implantation areas free of construction", ["en dehors des aires d'implantation des constructions nouvelles, les surfaces de terrain non bâties doivent rester libres de constructions"]),
  height=({'rule': 'zone 4B protégée rules (LCI 106-107, 10 m) for new; existing gabarit for integrated'}, ["Elles sont soumises aux dispositions applicables en zone 4B protégée."]),
)
P['29720'] = dict(
  zones='Veyrier site (agricultural, rives de l\'Arve) [OCR]',
  maintained=(STD_MAINT, ["Les travaux d'entretien ou les transformations nécessaires à un changement d'affectation des bâtiments maintenus peuvent être entrepris"]),
  other_buildings=("Other buildings may be demolished; rebuild only for agricultural use", ["Art.5 Autres bâtiments Les autres bâtiments peuvent être démolis.", "Ils peuvent être reconstruits pour autant qu'ils soient affectés à l'exploitation agricole à l'exclusion d'autres affectations."]),
  unbuilt_land=("Unbuilt land free of construction except minor works", ["Les surfaces de terrains non bâtis doivent rester libres de constructions et d'installations, sous réserve de constructions de peu d'importance"]),
  height=({'rule': 'existing; agricultural rebuild only'}, ["Ils peuvent être reconstruits pour autant qu'ils soient affectés à l'exploitation agricole"]),
)
P['29827'] = dict(
  zones='Laconnex village, zone 4B protégée and zone de verdure [OCR]',
  use=("Housing, commerce and agricultural buildings", ["Le village de Laconnex est destiné à l'habitation, au commerce et aux bâtiments agricoles."]),
  density=({'IUS_max': 0.4, 'IUS_exceptional_multi_parcel': 0.6, 'energy_derogation': 'HPE may derogate'}, ["L'indice d'utilisation du sol de chaque parcelle ou groupe de parcelles est fixé à 0.4.", "Un indice d'utilisation du sol de 0.6 au maximum peut être admis à titre exceptionnel"]),
  height=({'rule': 'fixed case by case (LCI 106); 4B rural 10 m cap by default'}, ["Le gabarit des constructions nouvelles est fixé dans chaque cas particulier de manière à sauvegarder le caractère architectural et l'échelle du village"]),
  roof=("Two slopes 30-40°", ["Les toitures doivent être à 2 pans inclinés de 30 à 40°."]),
  maintained=(STD_MAINT, ["Les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux"]),
  unbuilt_land=("Garden areas free of construction (minor works, access, parking, pools excepted)", ["A l'intérieur de cette aire, les terrains doivent rester libres de construction"]),
)

P['29866'] = dict(
  zones='Maisons ouvrières du Petit-Lancy, zone 4B (+ dev 3 for ch. de l\'Epargne) [OCR]',
  maintained=("Maintained buildings = original footprint; maintenance/transformation; facade geometry changes forbidden upstairs", ["Les bâtiments maintenus correspondent à l'emprise des bâtiments d'origine.", "Les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux"]),
  new_construction=({'only': 'verandas', 'depth_type_a_m': 2.5, 'depth_type_b_max_m': 4, 'height_m': 2.8}, ["l'aire d'implantation des vérandas comprend une bande de 2,5 mètres de profondeur", "une bande de 4 mètres maximum de profondeur", "La hauteur des vérandas par rapport au sol fini du rez-de-chaussée est fixée à 2,8 mètres."]),
  height=({'rule': 'existing (maintained footprint); verandas 2.8 m'}, ["La hauteur des vérandas par rapport au sol fini du rez-de-chaussée est fixée à 2,8 mètres."]),
)

P['30079'] = dict(
  zones='Hermance village: 4B protégée, verdure, agricultural, forest [OCR]',
  maintained=("Maintained: maintenance/transformation/energy; no roof openings except tabatière skylights", ["Les bâtiments maintenus peuvent faire l'objet de travaux d'entretien ou de transformation nécessaires à une adaptation des locaux", "La réalisation d'ouvertures en toiture n'est pas autorisée à l'exception des chassis de toiture type tabatière."]),
  other_buildings=("Transform, demolish or rebuild in same implantation and gabarit", ["Les autres bâtiments peuvent être transformés, démolis, ou reconstruits dans la même implantation et le même gabarit"]),
  new_construction=({'areas': 'graphical', 'order': 'contiguous', 'roof': '2 slopes, ridge parallel to street'}, ["Des constructions nouvelles ne peuvent être réalisées que dans les aires prévues à cet effet", "Au sein des aires d'implantation, les constructions nouvelles sont édifiées en ordre contigu."]),
  contiguous=("Contiguous order inside implantation areas", ["Au sein des aires d'implantation, les constructions nouvelles sont édifiées en ordre contigu."]),
  demolition=("New construction on parcels 866, 1885, 1410, 1999, 2000 requires demolition of other buildings", ["est subordonnée à la démolition des autres bâtiments situés sur la parcelle concernée."]),
  unbuilt_land=("Unbuilt land free of construction except art. 6 new buildings", ["Les surfaces de terrain non bâties doivent rester libres de constructions et d'installations diverses, sous réserve des constructions nouvelles visées à l'article 6."]),
  underground=("Ramps to basements forbidden", ["Les rampes d'accès au sous-sol sont interdites."]),
  height=({'new_buildings': 'gabarit maximum R+1 (some areas R) written in each drawn area', 'existing': 'same implantation and gabarit', 'source': 'plan labels read visually (georef/evidence/30079_R+1_area.png)'}, ["R+1// | Aire d'implantation de constructions nouvelles et gabarit maximum", "Les autres bâtiments peuvent être transformés, démolis, ou reconstruits dans la même implantation et le même gabarit"]),
)

P['30205'] = dict(
  zones='Chêne-Bougeries, chemin de la Fontaine parcel 1150 (partial modification of 29953) [OCR, poor quality]',
  maintained=("Maintained buildings, same regime as 29953", ["Le plan désigne les bâtiments maintenus, en raison de leurs qualités historiques et architecturales"]),
  new_construction=({'levels': 'fixed by plan (graphical labels)'}, ["Le plan fe le nombre de niveaux autorisés pour les constructions nouvelles."]),
  height=('unknown', 'number of levels for the new-construction area only graphical; OCR of labels illegible'),
)

P['810217'] = dict(
  zones='Vallon de la Laire (Soral etc.), natural site; règlement = LPMNS generic [OCR]',
  rule=("Plan only bans motor-vehicle traffic inside perimeter (except cantonal roads, private access, farm/forest traffic) and marks a military activity zone", ["LA CIRCULATION DES VEHICULES AUTOMOBILES", "Zone d'activités militaires"]),
  height=('none', 'no building provisions on the plan sheet; natural-site protection under LPMNS 35ff; zone rules (mostly AG/BF) apply'),
)

P['79114'] = dict(
  zones="Vallon de l'Hermance, natural site; règlement = LPMNS generic [OCR]",
  rule=("Plan legend only: pedestrian path, forest area, meadows/crops/hedges to conserve", ["SENTIER RESERVE AUX PIETONS", "haies à conserver"]),
  height=('none', 'no building provisions on the plan sheet; land-use conservation map only; zone rules apply'),
)
