# Geneva plot data

Every Geneva plot (73,120 in 48 cadastral communes) answered from free official
sources, so `/v1/property` never needs Popety in Geneva (`server/geneva.ts`).

| Folder | What |
|---|---|
| `data/communes/<no>.json.gz` | One record per plot, keyed by EGRID (what the server ships) |
| `data/index.json.gz` | EGRID → commune file; `"<commune>\|<plot no>"` → EGRID |
| `data/parcels.parquet` | The full plot table the export reads |
| `data/golden.json.gz` | Reference answers the server must reproduce (`scripts/check-geneva.ts`) |
| `rules/` | Rules for every zone type (`rules_catalogue.json`), plans de site / special regulations (`plans_de_site.json`) and industrial plans (`pdzi.json`) with per-sector limits and verbatim citations, the plot → plan-part table (`parcel_sectors.csv`), traced plan areas (`georef/`), and the law texts cited (`laws/`) |
| `build/parcels/build.py` | Builds the plot table from SITG and geo.admin layers (`layers.json`); runs the audit regression tests |
| `build/rules/` | The scripts that read, OCR, trace and self-check the plans (one-off research tools; most plan values were read and checked by hand) |
| `build/compose.py` | The reference answer for one plot (`python3 -I geneva/build/compose.py <EGRID>`) |
| `build/export.py` | Writes `data/` for the server; refuses to export if a regression test fails |

## Scores

`build/scores.py` writes `data/scores.parquet` and `data/scores_qa.json`: our own plot scores,
from official data only (Popety publishes no formula for its scores).

| Score | How |
|---|---|
| Location 0–100 | Road distance from the plot's hectare to shop, stop, primary school, doctor, pharmacy, forest/lake (Federal Statistical Office, accessibility of services, latest survey 2021); weights 25/25/20/10/10/10 |
| Plot shape 0–100 | Usable width (widest circle that fits, full marks at 25 m) 60%, compactness 40% |
| Existing buildings 0–100 | How recent the newest building is (1950 → 0, 2020 → 100) 70%, heating renewed (1990 → 0, 2020 → 100) 30% (building register) |
| Built vs allowed, room left | Built floor area (footprint × floors, register) against the floor area allowed by right (Zone 5: 30% of the buildable land, LCI art. 59; or the PLQ's figure). Built area is a range that holds 95% of the time per building type, measured against the canton's heated-floor-area register (OCEN IDC) on held-out halves; the band (less than half built / half to fully built / built out) is "sure" only when the whole range falls in it, else "likely". Not computed where the zone sets no floor-area ratio. |

| Rebuild potential 0–100 (Zone 5) | How likely a plot is to be demolished and rebuilt, from: the volume of the largest new house allowed by right (allowed floor area × 5.1 m³ per m², the median of 567 new villas whose permit states the density and which the canton's 3D model shows) against today's houses in the 3D model, plot area, house age and plot width. Fitted and checked on what owners did after the 3D survey (demolition or new-build permits since 2023-03): on held-out plots AUC 0.77, top 10% redeveloped 3× the average (7.9% vs 2.6% in under 3 years), bottom 10% 0.1%. Shown with the plot's volume today vs the new house, and permits granted / refused at 40%+ within 300 m since 2015 (facts, not in the score: they did not improve it). |
| Permit density | The latest granted permit on the plot that states its density ("construction de 3 villas contiguës (48% THPE)"): rate, reference, text (building permits, SITG `SIT_AUTOR_DOSSIER`, since 1995). |

Villas are never "sure" on built vs allowed: against the densities their own permits state (the law's
measure, above-ground floor area, LCI art. 59 al. 2), our villa "sure" bands held only about 79% of
the time on 147 plots.

`scripts/check-geneva.ts` fails if a range holds less than 95% on its worst held-out half, or if the
rebuild score's worst held-out AUC drops under 0.7 or its top 10% under 2× the average.

## Refresh

Needs Python 3 with `pandas`, `pyarrow`, `geopandas`, `shapely`, `pyogrio` (about 3 minutes, downloads cached in `geneva/work/`, not committed):

```bash
python3 -I geneva/build/parcels/build.py --refresh --no-wait   # re-download SITG layers, rebuild the table
python3 -I geneva/build/scores.py                              # our plot scores (downloads cached in geneva/work/scores)
python3 -I geneva/build/export.py                              # regression tests, then data/ for the server
pnpm exec tsx scripts/check-geneva.ts                          # the server gives exactly the reference answers
```

This runs by itself on the 3rd of each month (`.github/workflows/geneva-refresh.yml`, or by hand
from the Actions tab): it rebuilds, runs the checks, pushes branch `geneva/refresh` and opens an
issue "Geneva data refresh YYYY-MM ready" with `build/refresh_report.py`'s summary of what changed
and a one-click link to its pull request (the organisation does not let Actions open pull requests
itself). Merging that pull request ships the new data.
A failed run opens an issue; the app keeps last month's data meanwhile.

The plan rules (`rules/`) change only when the canton adopts or amends a plan. A new plan has no
rules entry, so its plots come out `special_plan_unresolved` (never "buildable") and the refresh
issue lists it under "New plans to read": read the new plan, update `plans_de_site.json` / `pdzi.json` and
`parcel_sectors.csv`, then rebuild as above.

## Known limits

- 573 plots are `special_plan_unresolved`: their part of a special plan could not be placed (mostly RS 4737 and village regulations RS 27304 / 27425 / 27275, traced from old or photographed sheets). Their notice links the plan.
- 240 plots in the Arve shore-protection plan (LPRArve 28616A) carry a "check the plan" notice: its no-build sectors are not mapped.
- Vieux-Carouge (PS 27383): building heights are unknown, the annex height plans are offline.
- S2 groundwater zones count as not buildable for new buildings (OEaux annex 4); S3 is mentioned only.
