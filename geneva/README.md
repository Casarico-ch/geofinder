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

## Refresh

Needs Python 3 with `pandas`, `pyarrow`, `geopandas`, `shapely`, `pyogrio` (about 3 minutes, downloads cached in `geneva/work/`, not committed):

```bash
python3 -I geneva/build/parcels/build.py --refresh --no-wait   # re-download SITG layers, rebuild the table
python3 -I geneva/build/export.py                              # regression tests, then data/ for the server
pnpm test                                                      # the server gives exactly the reference answers
```

The plan rules (`rules/`) change only when the canton adopts or amends a plan;
re-read the new plan and update `plans_de_site.json` / `pdzi.json` and
`parcel_sectors.csv`, then rebuild as above.

## Known limits

- 573 plots are `special_plan_unresolved`: their part of a special plan could not be placed (mostly RS 4737 and village regulations RS 27304 / 27425 / 27275, traced from old or photographed sheets). Their notice links the plan.
- 240 plots in the Arve shore-protection plan (LPRArve 28616A) carry a "check the plan" notice: its no-build sectors are not mapped.
- Vieux-Carouge (PS 27383): building heights are unknown, the annex height plans are offline.
- S2 groundwater zones count as not buildable for new buildings (OEaux annex 4); S3 is mentioned only.
