# Geneva building-rules catalogue (`rules_catalogue.json`)

The catalogue covers every zone code in the SITG zone plan, built on 2026-10-14. Each code carries its legal building limits, cited by law, article and paragraph, with a verbatim quote. It uses no paid API.

## Coverage
- `RDPPF_ZONES_PRIM` has 2,479 features and 19 distinct `ABRV_ZONE` codes: 1, 2, 3, 4A, 4B, 4BP, 5, AE, AG, BF, EP, ER, FE, H, IA, JF, PNP, S, V.
- `RDPPF_ZONES_DEV` has 756 features and 9 codes: D2, D3, D4A, D4AP, D4B, D4BP, D5, DAM, DIA.
- 28 of the 28 codes are covered. `returnDistinctValues` on the FeatureServer returns duplicates, so the distinct sets come from a full attribute download (`raw/all_attrs.json`).
- Some protected zones have no code of their own in SITG, so they are modelled as **overlays**:
  - Vieille-Ville: zone 2 / V polygons with AFFCOMP "PERIMETRE PROTEGE DE LA VIEILLE VILLE", plus `RDPPF_ZP`.
  - Vieux-Carouge: a 4A polygon with RESTRIC "PERIMETRE PROTEGE DU VIEUX CAROUGE".
  - Ensembles XIXe.
  - Plans de site (`RDPPF_PS`).
  - Règlements spéciaux and village rules (`RDPPF_RS`).
  - PUS (`RDPPF_PUS`).
  - Shore laws (`RDPPF_PNP`).
  - Forest and water setbacks (`RDPPF_DISTANCES_FORET`, `RDPPF_SI`).
  - Zone-5 no-derogation perimeters (`SIT_PROG_DENS`).

## Structure
- `zones[]` has one entry per code. Fields: `code, label, layer, regime, determined, n_polygons, sitg_desc_zone, use, height, roof, distance, contiguous, density{by_right, by_derogation, minimum}, underground, plq_effect, special_regulation, exceptions[], citations[]`.
  - Every value block has a `cite` list of ids.
  - `citations[]` expands those ids to `{law, article, paragraph, quote, source_file}`.
- `exceptions` is the derogation catalogue: LCI 10, 11 al.1/3/4/5/6, 12, 21 al.5, 23/27 surélévation, 33 al.4, 59 al.4/4bis, 64, 70 al.3, 75, 81, 106; RCI 253; LaLAT 24 al.3, 26, 27, 27C; LGZD 2 al.2, 2A al.3, 3 al.5; LZIAM 4 al.3; LForêts 11 al.2; LEaux 16 al.5; PUS 14.
  - Zone entries reference these by key.
  - Use them to explain buildings above the standard envelope, for example LCI 11 al.5 (+1 m with a habitable ground floor in zones 1–3), LCI 11 al.4 and LCI 10.
- `overlays` lists the perimeter rules (protected zones, communal regulations, PUS, setbacks).
- `citation_library` holds all 194 cited passages.

## How to apply it to a parcel
1. Find the parcel's zone in `RDPPF_ZONES_PRIM`. If a `RDPPF_ZONES_DEV` polygon overlaps it:
   - With a PLQ (`RDPPF_PLQ`): the PLQ envelope and rights apply.
   - Without a PLQ: the rules of `ZONE_PREEX` apply, unless the PLQ was waived under LGZD 2 al.2, in which case the dev-zone norms apply (`ordinary_zone_equivalent`).
2. Apply `height`, `distance` and `density` from that entry. Formulas use H = facade-line height and D = distance between alignments or to the boundary.
3. Intersect the parcel with the overlays and apply each one's rule. Also check the `AFFCOMP` / `RESTRIC` attributes on the zone polygon: they carry site-specific caps (e.g. "HAUTEUR MAXIMUM 12 METRES", maximum SBP).

## Limits
- **JF (jardins familiaux):** `determined: partial`. No cantonal statute sets a gabarit, cabin size or setback; only the use is defined (LaLAT 24 al.5).
- **D4AP:** `determined: partial`. It is a single polygon in Versoix (zoning law 11289), and that law sets only noise degrees. The protection is not quantified, so the zone-4A dev norms apply, with the gabarit set case by case.
- **DAM:** `determined: plan-dependent`. LaLAT 19 al.7 leaves the norms to the zoning plan, PLQ or plan directeur. The only statutory number is LZIAM 1 al.2 (at least 60% of SBP for secondary-sector activities).
- **V, S, BF, ER, PNP:** no building envelope by law; buildings need an exception.
- **Plans de site:** the 60 plans de site have their own regulations. Only the mechanism (LPMNS 38) is catalogued, with links in `raw/overlays.json` (`LIEN_REGLEMENT`).
- **Graphic-only plans:** RS 27353 and 27650 give their values only as drawings.
- **OCR:** communal regulations from scanned PDFs (Soral, Collex-Bossy, Puplinge, Lully, Bernex, Gy, Ruth, Tuilières, 4198, 28316, 27749, PUS 29188) were OCR'd with tesseract; their quotes are verbatim OCR output. 27749 and 28316 are partly illegible.

## Files
In this repository the `scripts/` named below are in `geneva/build/rules/`. The research inputs they read (`raw/`, `regs/`,
`dl/`, `ps_dl/`, `pdzi_dl/`) stayed in the workspace the catalogue was built in and are not committed.
- `rules_catalogue.json` is the output.
- `scripts/cites.py` holds the citation library; `scripts/build.py` builds the catalogue.
- `scripts/verify.py` checks that all 194 quotes occur in their sources.
- `scripts/selfcheck.py` re-opens the sources for 15 random zones and checks each numeric value against its cited quote. Result: 15/15.
- `scripts/distinct.py`, `scripts/fetchall.py` and `scripts/overlays.py` pull the SITG data.
- `laws/` holds the extra silgeneve texts: LZIAM, LForêts, LPRLac, LPRRhône, LPRArve, LPRVers, LEaux-GE, LPMNS, and the current LCI (`lci_current.txt`).
- `regs/` holds the communal regulations (PDF + text).
- `raw/` holds the SITG extracts.

## Plans de site, special regulations and PDZI (added 2026-10-14, revised after audit 2)
- **`plans_de_site.json`** is keyed by `NO_PLAN` exactly as in SITG. It covers 74 plans: all 60 in `RDPPF_PS` and all 14 in `RDPPF_RS` (Gy is `0`).
  - `limits{...}` hold **plan-wide** values only. A value that applies to one sector, sub-perimeter, building area or named parcel is under
    `sectors{<sector>: {field: {value, citations}}}`, never plan-wide. `moved_to_sectors` lists fields that were moved.
  - `sector_placement` says how parcels were placed (geojson polygons, raster, zone codes, parcel list, whole, or unplaced + reason).
  - Every value has citations `{source_file, page, article (auto-located), quote}`. `value: "unknown"` has a `reason`;
    `"not regulated by this plan"` means the plan sets no such rule and the zone rule applies.
- **`pdzi.json`** is keyed exactly like `parcels.pdzi_id`: `NO_PLAN-INDICE` (`26615-N`, `29975-A`, `28460-B`, ...) or plain `NO_PLAN`
  when the SITG indice is `-`. Each entry stores `no_plan`, `indice`, `name`, and the SITG communes.
- **`parcel_sectors.csv`** (`egrid, plan, sector, share, method, confidence`): one row per parcel × plan × sector for every parcel listed
  in `plan_de_site_ids`, `reglement_special` (RS) or `pdzi_id`. `plan` is `PS <no>`, `RS <no>` or `PDZI <key>`; `sector` matches the
  `sectors` keys of the JSON files. `share` = fraction of the parcel's in-perimeter area in that sector.
  `method`: `layer` (SITG perimeter / zone codes), `georef` (sectors traced on a georeferenced plan sheet), `manual` (cadastral-map
  transcription or parcel list from the règlement). Unplaced parcels have `sector = "UNPLACED: <reason>"`.
  - No SITG layer holds plan-de-site / PDZI sectors (RPU_* = PLQ only), so sectors were georeferenced from the plan sheets:
    `georef/sectors_<plan>.geojson` (polygons, with method/confidence/note), raster labels for 29827 and 29976, views `georef/w*.png`.
  - Scripts: `scripts/georef_lib.py`, `georef_plan.py` (label RANSAC), `manual_georef.py` (control points, affine/homography),
    `trace_sectors.py`, `trace_cad.py`, `shade_labels.py`, `sector_flood.py`; `sector_config.py` + `assign_sectors.py` write the CSV.
- **Visual reads**: values read on plan images (not in any text layer) carry a `source` naming the crop in `georef/evidence/`
  (ZIPLO 28667 legend, 28495-B and 28460-B gabarits, 29999 building labels).
- **Sources:** regulation and plan PDFs in `ps_dl/`, `pdzi_dl/`, `regs/` (`*.raw.txt` = pdftotext, `*.ocr.txt` / `regs/*.txt` = tesseract fra).
  Quotes from OCR text are the OCR output verbatim. 29184's plan sheet is `ps_dl/29184A-plan.pdf` (SITG path PS/29184A-plan.pdf).
- **Checks:** `scripts/build_plans.py` fails on any quote it cannot find. `scripts/selfcheck_all.py <ge_rules>` checks ALL entries (plan-wide and
  per sector): quote on the cited page, every number in its quote, a second independent OCR read (`scripts/second_read.sh`, higher dpi,
  other page-segmentation mode) for every OCR-derived number, and sector-name consistency with the CSV. Result: `georef/selfcheck_all.json`.

### New-building rule (`new_buildings`, added after audit 3)
- Every plan in `plans_de_site.json` / `pdzi.json` carries `new_buildings {value, note, citations}` (plan-wide), and every sector a
  sector-level `new_buildings`. value ∈ `allowed_per_zone`, `only_in_drawn_areas`, `forbidden`, `extensions_only` (e.g. verandas ≤ 2.8 m),
  `case_by_case`, `unknown`.
- Where the value is `only_in_drawn_areas`, `new_buildings.drawn_areas` points to `georef/build_areas_<plan>.geojson`
  (features `kind` = `build_area`, or `free_area` for drawn gardens / courtyards, e.g. Laconnex 29827); `null` +
  `drawn_areas_missing_reason` when the sheet could not be traced. Areas come from tracing on georeferenced sheets
  (`scripts/build_areas.py`), colour masks, the sector polygons, or the parcels the règlement names (`areas_from_parcels.py`).
- `parcel_sectors.csv` has two extra columns: `new_buildings` (the sector's value) and `build_area_share` + `build_area_confidence` (share of the parcel's
  in-perimeter area lying in drawn build areas; 0 = outside every drawn area → no new building). Laconnex parcels in garden /
  open-courtyard areas get the sectors `aire de jardin non-bâtie` / `cour ouverte sur la rue` (forbidden).
- Counts: `scripts/newbuild_stats.py` → `georef/newbuild_stats.json`.
- PDZI 26615-N and 29292 heights now state the industrial-zone default (LZIAM 4 al.1 → LCI 80 al.1 → LCI 23: H ≤ D+3, max 24 m)
  with `law_citations` copied from the catalogue.

### Audit 4 additions
- **Maintained buildings:** `georef/maintained_<plan>.geojson` per georeferenced plan de site — every cadastral above-ground building
  (CAD_BATIMENT_HORSOL, `EGID`, `EGRID_CENTROIDE`) inside the perimeter with `category` (maintained / interesting / integrated /
  demolish / other / not marked), the matched legend label, distance and confidence. Built by `scripts/maintained.py`: legend swatches
  are read next to the legend labels, the plan is rendered, footprints are registered on the drawn building outlines (±10 m shift
  search), and the fill inside each eroded footprint is matched to the nearest swatch. Previews `georef/<plan>_maint.png`.
- `parcel_sectors.csv` gains `maintained_bldg_share` (share of the parcel's in-perimeter area covered by buildings classed
  *maintained*) and `maintained_egids`. A parcel almost covered by a maintained building (e.g. Thônex 5126, 0.90) has no room for
  a new building whatever the sector value says.
- RS 27425 re-traced on the cadastre overlay; RS 27304 / 27425 sectors are checked against the parcel's SITG zone
  (`zone_consistency` in `sector_config.py`: zone-5 parcels can only be in the villa sectors) — corrected placements are
  `method=layer, confidence=low`. Manual parcel overrides from audit overlays are `method=manual`.
- Every placement from a low-confidence trace carries `confidence=low`; validation sheets (5 parcels each, checked by eye) in
  `georef/evidence/val_*.png`, results in `georef/validation_low.json`.
- PDZI 28460-B height sectors and PDZI 29292 building-limit sectors are now placed (manual georef + `scripts/refine_georef.py`
  line alignment); PS 29961 projected-building areas and the 29975-A/B aires de localisation re-extracted by flood fill
  between the red outlines (`scripts/red_areas.py`).
- Audit 5: PDZI 29292 building zones re-extracted by flood fill between the art. 9 limit lines (the hand trace had a gap
  on Satigny 7739). `scripts/gap_check.py` → `georef/gap_check.json`: per drawn-area file, share of existing CAD buildings
  outside the drawn areas; PDZI plans above 20% (28495-B, 29975-A, 29975-B) were inspected (`georef/evidence/gap_*.png`) —
  the outside buildings sit in road reserves, pipeline corridors and recul bands, so no trace gaps.
- Audit 6: RS 27425 sector D `new_buildings=forbidden` (arts 17-18: agricultural only; other uses need a plan-directeur
  complement). PDZI 29968 aires A1a/A1b/A2 traced (`georef/sectors_29968.geojson`, `build_areas_29968.geojson`; `scripts/fill_white.py`).
  PS 28271 detail plan found at PS/28271.pdf (SITG link 404) — OCR'd, heights / new-building perimeter recorded; PS 27383
  plan sheet and annex height plans are still not online (all URL variants 404), so its per-building heights stay unknown and
  `new_buildings=case_by_case`. Rade 28392/30158: ÖREB geometry = RDPPF_PS (100%); the 87/91% is a −50 m² offset in the ÖREB
  `AreaShare` attribute (`georef/rade_oereb_check.json`). LPRArve plan 28616A georeferenced (`georef/28616_p1.json`,
  manual homography + alignment to the RDPPF_PNP perimeter); its 'secteurs inconstructibles' could not be separated from
  the perimeter line style on the 1993 scan and are not traced.
- Audit 7: the zone-consistency correction for RS 27304/27425 now works per zone piece (parcel ∩ traced sector ∩ SITG zone
  polygon): only a piece whose zone contradicts its traced sector is moved, never into sector D unless the piece is agricultural
  land, and 'unidentified' pieces are left as traced. For 27425 only zone-5 land is corrected (to the villa sector C).
  Changed parcels: `georef/audit7_changed_parcels.json`.
