"""Golden parity: gridscope/analysis.py and assets/analysis.js must agree.

Every case is analysed by both engines and the results are compared field by
field (numbers to 1e-9 relative), so a formula changed in one copy and not the
other fails here rather than in someone's browser.
"""

import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

from gridscope.analysis import get_analysis, parse_energy_text

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")

HOURLY_CSV = """date,time,household_id,total_kwh,solar_export_kwh
2025-01-06,08:00,H-1,1.2,0
2025-01-06,12:30,H-1,0.4,1.8
2025-01-06,18:00,H-1,2.6,0
2025-01-06,18:00,H-1,0.4,0
2025-01-07,08:00,H-1,1.1,0
2025-01-07,12:00,H-1,0.3,2.2
2025-01-07,19:00,H-1,2.4,0
2025-01-11,13:00,H-2,0.9,1.0
2025-01-11,20:00,H-2,1.9,0
"""

PLANS = [
    {"name": "Night Owl", "peak": 0.52, "shoulder": 0.30, "offpeak": 0.12, "export_credit": 0.05, "daily_supply": 1.05},
    {"name": "Sunny Days", "peak": 0.42, "shoulder": 0.22, "offpeak": 0.22, "export_credit": 0.10, "daily_supply": 1.25},
]

CASES = [
    {"name": "legacy", "file": "tests/fixtures/legacy_sample.csv"},
    {"name": "daily-year", "file": "data/sample_energy_upload.csv"},
    {
        "name": "daily-year-household",
        "file": "data/sample_energy_upload.csv",
        "household": "H-201",
        "tariff": {"peak": 0.47, "shoulder": 0.31, "offpeak": 0.2, "export_credit": 0.05, "daily_supply": 1.3, "gst": 0.1},
        "battery": {"capacity_kwh": 13.5, "efficiency": 0.88, "cost_aud": 11000},
    },
    {"name": "nem12-year", "file": "data/sample_nem12.csv", "tou": True},
    {"name": "nem12-plans", "file": "data/sample_nem12.csv", "plans": PLANS, "battery": {"capacity_kwh": 5, "cost_aud": 6000}},
    {"name": "hourly-tou", "text": HOURLY_CSV, "tou": True},
    {"name": "hourly-dedupe", "text": HOURLY_CSV, "dedupe": True, "date_order": "mdy"},
]

JS_DRIVER = r"""
const fs = require("fs");
const vm = require("vm");
const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("assets/analysis.js", "utf8"), context);
const GS = context.window.GridScope;
const cases = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
for (const c of cases) {
  const text = c.text !== undefined ? c.text : fs.readFileSync(c.file, "utf8");
  const rows = GS.parseEnergyText(text, { dateOrder: c.date_order || "dmy" });
  const options = {};
  if (c.plans) options.plans = c.plans;
  if (c.battery) options.battery = c.battery;
  const analysis = GS.getAnalysis(rows, c.tariff || null, c.household || "all", Boolean(c.tou), Boolean(c.dedupe), options);
  delete analysis.rows;
  out[c.name] = analysis;
}
process.stdout.write(JSON.stringify(out));
"""


def project(analysis):
    """The fields that must match, in snake_case, from either engine."""
    def pick(item, keys):
        return {key: item.get(key) for key in keys}

    totals_keys = [
        "records", "days", "households", "grid", "solar", "consumed", "peak", "shoulder",
        "offpeak", "peak_share", "solar_share", "bill", "tariff_bill", "cost_per_kwh",
        "tariff_bill_ex_gst", "supply_charge", "gst_amount", "first_day", "last_day",
    ]
    plans = analysis["plans"]
    return {
        "totals": pick(analysis["totals"], totals_keys),
        "monthly": [
            pick(item, ["key", "records", "households", "grid", "solar", "consumed", "bill", "tariff_bill", "mom_grid", "mom_bill"])
            for item in analysis["monthly"]
        ],
        "groups": [
            pick(item, ["key", "records", "households", "grid", "solar", "tariff_bill", "kwh_per_household"])
            for item in analysis["groups"]
        ],
        "daily": analysis["daily"],
        "anomalies": [
            pick(item, ["day", "household", "neighbourhood", "grid", "consumed", "anomaly_type", "baseline", "baseline_kwh", "method", "z_score", "pct_of_average"])
            for item in analysis["anomalies"]
        ],
        "recommendations": [
            # detail is prose; the browser formats money with Intl ("A$"), Python with "$".
            pick(item, ["opportunity", "impact", "saving_aud"]) for item in analysis["recommendations"]
        ],
        "plans": {
            "cheapest": plans["cheapest"],
            "current_bill": plans.get("current_bill"),
            "switch_saving": plans.get("switch_saving"),
            "plans": [pick(item, ["name", "bill", "delta_vs_cheapest", "winner"]) for item in plans["plans"]],
        },
        "heatmap": {
            "axis": analysis["heatmap"]["axis"],
            "buckets": analysis["heatmap"]["buckets"],
            "cells": analysis["heatmap"]["cells"],
            "max_grid": analysis["heatmap"]["max_grid"],
        },
        "coverage": pick(analysis["coverage"], ["recorded", "first", "last", "span_days", "density", "kind", "missing_days"]),
        "weekend": pick(analysis["weekend"], ["weekday_days", "weekend_days", "weekday_kwh", "weekend_kwh", "weekday_bill", "weekend_bill"]),
        "quality": pick(analysis["quality"], ["duplicate_keys", "negative_energy", "zero_grid", "estimated_intervals", "missing_intervals"]),
        "what_if": pick(analysis["what_if"], ["fraction", "baseline_bill", "shifted_bill", "saving_aud"]),
        "what_if_solar": pick(analysis["what_if_solar"], ["fraction", "baseline_bill", "shifted_bill", "saving_aud"]),
        "what_if_battery": pick(
            analysis["what_if_battery"],
            ["capacity_kwh", "efficiency", "days", "batteries", "charged_kwh", "delivered_kwh", "cycles", "baseline_bill",
             "battery_bill", "saving_aud", "annual_saving_aud", "cost_aud", "total_cost_aud", "payback_years"],
        ),
        "source": analysis["source"],
        "tou_note": analysis.get("tou_note"),
        "households": analysis["households"],
    }


def assert_same(py, js, path="analysis"):
    problems = []
    _compare(py, js, path, problems)
    assert not problems, "\n".join(problems[:25])


def _compare(py, js, path, problems):
    try:
        _compare_strict(py, js, path, problems)
    except AssertionError as exc:
        problems.append(str(exc).splitlines()[0])


def _compare_strict(py, js, path, problems):
    if isinstance(py, dict):
        assert isinstance(js, dict), path
        assert sorted(py) == sorted(js), f"{path}: keys {sorted(py)} != {sorted(js)}"
        for key in py:
            _compare(py[key], js[key], f"{path}.{key}", problems)
    elif isinstance(py, list):
        assert isinstance(js, list) and len(py) == len(js), f"{path}: length {len(py)} != {len(js) if isinstance(js, list) else js}"
        for index, (left, right) in enumerate(zip(py, js)):
            _compare(left, right, f"{path}[{index}]", problems)
    elif isinstance(py, bool) or py is None or isinstance(py, str):
        assert py == js, f"{path}: {py!r} != {js!r}"
    elif isinstance(py, (int, float)):
        assert isinstance(js, (int, float)) and not isinstance(js, bool), f"{path}: {py!r} != {js!r}"
        assert math.isclose(py, js, rel_tol=1e-9, abs_tol=1e-9), f"{path}: {py!r} != {js!r}"
    else:  # pragma: no cover - unexpected type in the projection
        raise AssertionError(f"{path}: unexpected {type(py)}")


@pytest.fixture(scope="module")
def js_results():
    if NODE is None:
        pytest.skip("node is not installed")
    result = subprocess.run(
        [NODE, "-e", JS_DRIVER],
        cwd=ROOT,
        input=json.dumps(CASES),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_python_and_browser_engines_agree(case, js_results):
    text = case.get("text")
    if text is None:
        text = (ROOT / case["file"]).read_text(encoding="utf-8")
    rows = parse_energy_text(text, date_order=case.get("date_order", "dmy"))
    py = get_analysis(
        rows,
        tariff=case.get("tariff"),
        household=case.get("household"),
        tou=bool(case.get("tou")),
        date_order=case.get("date_order", "dmy"),
        dedupe=bool(case.get("dedupe")),
        plans=case.get("plans"),
        battery=case.get("battery"),
    )
    py_projection = json.loads(json.dumps(project(py)))
    js_projection = project(js_results[case["name"]])
    assert_same(py_projection, js_projection)
