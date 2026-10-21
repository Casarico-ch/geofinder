# Writes what the server ships for Geneva (server/geneva.ts reads it):
#   data/communes/<no_comm>.json.gz  one record per parcel, keyed by EGRID
#   data/index.json.gz               EGRID -> commune file, and "<commune>|<parcel no>" -> EGRID
#   data/schema.json                 column groups (from compose.py), build date
# Rules (rules/*.json) are shipped as they are and joined at request time, so a
# record only carries keys into them. Run after build/parcels/build.py:
#   python3 -I geneva/build/export.py
import gzip, io, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compose  # noqa: E402

G = compose.G
EMPTY = set(compose.EMPTY)


def gz_text(path):
    """A gzip text file with no timestamp, so an unchanged export gives identical bytes."""
    return io.TextIOWrapper(gzip.GzipFile(path, "wb", mtime=0), encoding="utf-8")


def plan_ref(label, ps, pz):
    """('pdzi'|'ps', key) for a plan label like 'PS 29827' or 'PDZI 29975-A', or None."""
    kind, _, num = label.partition(" ")
    base = num.split("-")[0]
    table, name = (pz, "pdzi") if kind == "PDZI" else (ps, "ps")
    for key in (num, base):
        if key in table:
            return [name, key]
    return None


def record(egrid, rows, cat, ps, pz, sectors):
    row = rows[egrid]
    a = compose.compose(egrid, rows, cat, ps, pz, sectors)
    values = {c: v for c, v in row.items() if v not in EMPTY}
    rs_items = {k: [str(it.get("plan")) for it in o.get("items", [])] for k, o in a["overlays"].items() if "items" in o}
    plans = []
    for s, p in zip(sectors.get(egrid, []), a["plans_detail"]):
        plans.append({k: v for k, v in {
            "plan": p["plan"], "sector": p["sector"], "share": p["share"], "placement": p["placement"],
            "confidence": p["confidence"], "new_buildings": p["new_buildings"], "build_area_share": p["build_area_share"],
            "build_area_confidence": p.get("build_area_confidence"), "maintained_bldg_share": p["maintained_bldg_share"],
            "maintained_egids": p["maintained_egids"], "ref": plan_ref(p["plan"], ps, pz),
        }.items() if v is not None})
    return {
        "values": values,
        "zones": list(a["zone_rules"]),
        "common_1_4": "zone_rules_common_1_4" in a,
        "overlays": list(a["overlays"]),
        "overlay_items": rs_items,  # RS groups: only the items that concern this parcel
        "plans": plans,
    }


def main():
    rows, cat, ps, pz, sectors = compose.load()
    out = os.path.join(G, "data")
    os.makedirs(os.path.join(out, "communes"), exist_ok=True)
    by_commune = defaultdict(dict)
    index = {"egrid": {}, "plot": {}}
    for egrid, row in rows.items():
        c = row["no_comm"]
        by_commune[c][egrid] = record(egrid, rows, cat, ps, pz, sectors)
        index["egrid"][egrid] = c
        index["plot"][f"{row['commune']}|{row['no_parcelle']}"] = egrid
    for c, recs in by_commune.items():
        with gz_text(os.path.join(out, "communes", f"{c}.json.gz")) as f:
            json.dump(recs, f, ensure_ascii=False, separators=(",", ":"))
    with gz_text(os.path.join(out, "index.json.gz")) as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    # The audited parcels must hold before anything ships (same tests as the build).
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "parcels"))
    import pandas as pd
    import build as parcels_build
    rg = parcels_build.run_regression(pd.read_parquet(os.path.join(G, "data", "parcels.parquet")))
    if not rg.ok.all():
        sys.exit("regression failed:\n" + rg[~rg.ok].to_string())
    # Golden answers: the server's composer must give exactly these (scripts/check-geneva.ts).
    import random
    picks = set(random.Random(20261015).sample(sorted(rows), 400)) | {e for e, _, _ in parcels_build.REGRESSION if e in rows}
    plan_picks = random.Random(7).sample(sorted(e for e in sectors if e in rows), 150)
    golden = {e: compose.compose(e, rows, cat, ps, pz, sectors) for e in sorted(set(picks) | set(plan_picks))}
    with gz_text(os.path.join(out, "golden.json.gz")) as f:
        json.dump(golden, f, ensure_ascii=False, separators=(",", ":"))
    import datetime
    with open(os.path.join(out, "schema.json"), "w", encoding="utf-8") as f:
        json.dump({"groups": compose.GROUPS, "parcels": len(rows), "communes": len(by_commune),
                   "exported": datetime.date.today().isoformat()}, f, ensure_ascii=False, indent=1)
    print(f"{len(rows)} parcels in {len(by_commune)} commune files")


if __name__ == "__main__":
    main()
