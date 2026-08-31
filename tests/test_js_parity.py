import json
import shutil
import subprocess
from pathlib import Path

import pytest

from gridscope.analysis import get_analysis, load_csv

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_js_parity_with_sample_csv():
    script = r"""
const fs = require("fs");
const vm = require("vm");
const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("assets/analysis.js", "utf8"), context);
const GS = context.window.GridScope || context.GridScope;
if (!GS) {
  throw new Error("GridScope was not attached to the VM context");
}
const text = fs.readFileSync("data/sample_energy_upload.csv", "utf8");
const rows = GS.parseEnergyCsv(text);
const analysis = GS.getAnalysis(rows);
const dmy = GS.parseEnergyCsv("date,grid_import_kwh\n01/02/2025,10\n", { dateOrder: "dmy" });
console.log(JSON.stringify({
  grid: analysis.totals.grid,
  solar: analysis.totals.solar,
  records: analysis.totals.records,
  peak_share: analysis.totals.peak_share,
  cheapest: analysis.plans.cheapest,
  dmy: dmy[0].day
}));
"""
    result = subprocess.run(
        [NODE, "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    payload = json.loads(result.stdout)
    assert payload["grid"] == pytest.approx(272.7)
    assert payload["solar"] == pytest.approx(60.3)
    assert payload["records"] == 18
    assert payload["cheapest"] == "Solar Plus"
    assert payload["dmy"] == "2025-02-01"
    py_totals = get_analysis(load_csv(ROOT / "data" / "sample_energy_upload.csv"))["totals"]
    assert payload["peak_share"] == pytest.approx(py_totals["peak_share"])
