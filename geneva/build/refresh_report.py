# What changed in a Geneva data refresh, as Markdown for the monthly pull request
# (.github/workflows/geneva-refresh.yml). Run after build.py, scores.py and export.py:
#   python3 -I geneva/build/refresh_report.py <previous parcels.parquet> <previous layers.json>
# Plans the canton adopted since the rules were read have no entry in rules/ yet, so
# their plots come out "special_plan_unresolved" (never "buildable"); this lists them
# so a person can read the new plan.
import json, os, re, sys

import pandas as pd

GENEVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("GENEVA_WORK") or os.path.join(GENEVA, "work")


def known_plans():
    keys = set()
    for k, e in json.load(open(os.path.join(GENEVA, "rules", "plans_de_site.json")))["plans"].items():
        keys.add(("RS " if e.get("meta", {}).get("layer") == "RDPPF_RS" else "PS ") + k)
    for k in json.load(open(os.path.join(GENEVA, "rules", "pdzi.json")))["plans"]:
        keys.add("PDZI " + k)
    return keys


def plan_labels(status):
    # "PS 30074:rest of perimeter=forbid; RS 27749:whole perimeter=case" -> {"PS 30074", "RS 27749"}
    return set(re.findall(r"\b((?:PS|RS|PDZI) [\w-]+):", status or ""))


def main(prev_parquet, prev_layers):
    old = pd.read_parquet(prev_parquet)
    new = pd.read_parquet(os.path.join(GENEVA, "data", "parcels.parquet"))
    out = ["## Geneva data refresh", ""]

    # Plans with plots but no rules entry: the person-needed part of a refresh.
    known = known_plans()
    missing = {}
    for egrid, status in zip(new.egrid, new.plan_sector_status.fillna("")):
        for label in plan_labels(status) - known:
            base = label.split("-")[0]
            if base not in known:
                missing.setdefault(label, []).append(egrid)
    if missing:
        out += ["### ⚠️ New plans to read", "",
                "These plans cover plots but have no rules yet, so their plots say \"special plan, check it\". "
                "Read each plan and add it to `geneva/rules/` (see `geneva/README.md`).", "",
                "| Plan | Plots |", "|---|---|"]
        out += [f"| {k} | {len(v)} |" for k, v in sorted(missing.items())]
        out.append("")
    else:
        out += ["Every plan on a plot has rules: nothing for a person to read.", ""]

    # Answers that changed.
    cmp = old[["egrid", "buildability"]].merge(new[["egrid", "buildability"]], on="egrid", how="outer",
                                               suffixes=("_old", "_new"), indicator=True)
    added, gone = (cmp._merge == "right_only").sum(), (cmp._merge == "left_only").sum()
    both = cmp[cmp._merge == "both"]
    moved = both[both.buildability_old != both.buildability_new]
    out += ["### What changed", "",
            f"- Plots: {len(old):,} → {len(new):,} ({added:,} new, {gone:,} gone, e.g. merged or split)",
            f"- Plots whose buildability changed: {len(moved):,}", ""]
    if len(moved):
        t = moved.groupby(["buildability_old", "buildability_new"]).size().sort_values(ascending=False)
        out += ["| Was | Now | Plots |", "|---|---|---|"]
        out += [f"| {a} | {b} | {c:,} |" for (a, b), c in t.items()]
        out.append("")
    counts = pd.DataFrame({"before": old.buildability.value_counts(), "after": new.buildability.value_counts()}).fillna(0)
    out += ["| Buildability | Before | After |", "|---|---|---|"]
    out += [f"| {k} | {int(r.before):,} | {int(r.after):,} |" for k, r in counts.iterrows()]
    out.append("")

    # Source layers that grew or shrank (a new plan, a zone change).
    lo, ln = json.load(open(prev_layers)), json.load(open(os.path.join(WORK, "layers.json")))
    diff = [(k, lo.get(k, {}).get("count"), v.get("count")) for k, v in ln.items() if lo.get(k, {}).get("count") != v.get("count")]
    if diff:
        out += ["### Source layers that changed", "", "| Layer | Before | After |", "|---|---|---|"]
        out += [f"| {k} ({ln[k].get('layer', '')}) | {a} | {b} |" for k, a, b in diff]
        out.append("")

    qa = json.load(open(os.path.join(WORK, "qa.json")))
    o = qa.get("oereb_sample")
    if o:
        out += [f"Spot check against the official extract: primary zone right on {o['primary_zone_match']}/{o['fetched']} plots, "
                f"development zone on {o['dev_zone_match']}/{o['fetched']}.", ""]
    out.append("The audit regression tests and the server's golden-answer check passed (the job stops otherwise).")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
