// Checks that server/geneva.ts answers every Geneva plot exactly as the audited
// reference (geneva/build/compose.py) does: the golden answers written by
// geneva/build/export.py (400 random plots, every plot from the audit
// regression list, 150 plots inside plans) must come out identical, and every
// plot in the index must load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { genevaAnswer, genevaEgridsByPlot, isGenevaEgrid } from "../server/geneva";

const DIR = path.resolve(process.cwd(), "geneva");
const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(path.join(DIR, f))).toString("utf8"));
const EMPTY = new Set(["", "nan", "None", "n/a"]);

// Column groups carry only the values a plot has; the reference prints empty ones too.
function normalize(a: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, string>).filter(([, x]) => !EMPTY.has(x)));
    } else out[k] = v;
  }
  if (out.other && !Object.keys(out.other).length) delete out.other;
  return out;
}

const golden = gz("data/golden.json.gz") as Record<string, Record<string, any>>;
let n = 0;
for (const [egrid, want] of Object.entries(golden)) {
  const got = genevaAnswer(egrid);
  assert.ok(got, `${egrid}: no answer`);
  assert.deepEqual(normalize(got), normalize(want), `${egrid}: answer differs from compose.py`);
  n++;
}

const index = gz("data/index.json.gz") as { egrid: Record<string, string>; plot: Record<string, string> };
const schema = JSON.parse(readFileSync(path.join(DIR, "data/schema.json"), "utf8"));
assert.equal(Object.keys(index.egrid).length, schema.parcels, "index covers every parcel");
const communes = new Set(Object.values(index.egrid));
for (const c of communes) {
  const egrid = Object.keys(index.egrid).find((e) => index.egrid[e] === c)!;
  assert.ok(genevaAnswer(egrid)?.status.buildability, `commune ${c} loads`);
}
assert.ok(isGenevaEgrid("CH768265634625") && !isGenevaEgrid("CH890977745220"), "Bernex 6036 is Geneva, Oberrieden is not");
assert.deepEqual(genevaEgridsByPlot("Bernex", "6036"), ["CH768265634625"], "commune + plot number");
assert.ok(genevaEgridsByPlot("Genève", "5475").length >= 1, "'Genève' searches the four city sections");

// Our scores' built-area ranges must hold 95% of the time on held-out halves (geneva/build/scores.py).
const qa = JSON.parse(readFileSync(path.join(DIR, "data/scores_qa.json"), "utf8"));
for (const [kind, c] of Object.entries<any>(qa.calibration_95pct_ranges)) {
  assert.ok(c.heldout_worst >= 0.95, `built-area range for ${kind} holds only ${c.heldout_worst} on its worst held-out half`);
}
assert.ok(qa.coverage.score_shape >= 0.99, "every plot has a shape score");
// Rebuild potential must still rank what owners did next (permits after the 3D survey) on held-out plots.
assert.ok(qa.rebuild.backtest.heldout_auc_worst >= 0.7, `rebuild score AUC only ${qa.rebuild.backtest.heldout_auc_worst} on its worst held-out fold`);
assert.ok(qa.rebuild.backtest.top_decile_lift >= 2, `rebuild score top 10% only ${qa.rebuild.backtest.top_decile_lift}x the average`);

console.log(`geneva: ${n} answers identical to compose.py, ${schema.parcels} plots in ${communes.size} communes ✓`);
