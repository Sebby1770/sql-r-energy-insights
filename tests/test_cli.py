import json
from pathlib import Path

import pytest

from gridscope.cli import main

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "data" / "sample_energy_upload.csv"


def test_cli_writes_html_and_tables(tmp_path):
    html_path = tmp_path / "py-report.html"
    code = main([str(SAMPLE), "--html", str(html_path)])
    assert code == 0
    text = html_path.read_text(encoding="utf-8")
    assert "tariff-peak" in text
    assert "household-filter" in text
    assert "heatmap-chart" in text
    assert "compare-csv" in text
    assert "export-csv" in text
    assert "analysis.js" in text
    assert "studio.js" in text
    assert (tmp_path / "tables" / "py_monthly_usage.csv").is_file()
    assert (tmp_path / "tables" / "py_anomalies.csv").is_file()
    monthly = (tmp_path / "tables" / "py_monthly_usage.csv").read_text(encoding="utf-8")
    assert "month" in monthly
    assert "2025-01" in monthly


def test_cli_missing_columns_is_nonzero(tmp_path, capsys):
    bad = tmp_path / "bad.csv"
    bad.write_text("foo,bar\n1,2\n", encoding="utf-8")
    code = main([str(bad), "--json", str(tmp_path / "out.json")])
    assert code == 1
    err = capsys.readouterr().err
    assert "date column" in err
    assert not (tmp_path / "out.json").exists()


def test_cli_json_and_compare(tmp_path):
    payload_path = tmp_path / "analysis.json"
    code = main([str(SAMPLE), "--compare", str(SAMPLE), "--json", str(payload_path)])
    assert code == 0
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["totals"]["records"] == 18
    assert payload["compare"]["delta_kwh"] == 0
    assert payload["compare"]["shared_days"] == 18


def test_cli_household_and_custom_tariff(tmp_path):
    payload_path = tmp_path / "one.json"
    code = main(
        [
            str(SAMPLE),
            "--household",
            "H-101",
            "--tariff-peak",
            "1",
            "--tariff-shoulder",
            "0",
            "--tariff-offpeak",
            "0",
            "--tariff-export",
            "0",
            "--json",
            str(payload_path),
        ]
    )
    assert code == 0
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["totals"]["households"] == 1
    assert payload["totals"]["records"] == 3
    peak = sum(item["peak"] for item in payload["monthly"])
    assert payload["totals"]["tariff_bill"] == pytest.approx(peak)
