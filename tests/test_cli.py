import json
from pathlib import Path

import pytest

from gridscope.cli import main

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "tests" / "fixtures" / "legacy_sample.csv"


def test_cli_writes_html_and_tables(tmp_path, capsys):
    html_path = tmp_path / "py-report.html"
    code = main([str(SAMPLE), "--html", str(html_path)])
    assert code == 0
    out = capsys.readouterr().out
    assert "Tariff bill" in out
    assert "Cheapest" in out
    assert "Cost/kWh" in out
    text = html_path.read_text(encoding="utf-8")
    assert "tariff-peak" in text
    assert "tariff-supply" in text
    assert "tariff-gst" in text
    assert "household-filter" in text
    assert "heatmap-chart" in text
    assert "compare-csv" in text
    assert "export-csv" in text
    assert "date-order" in text
    assert "tou-toggle" in text
    assert "onboarding-strip" in text
    assert "savings-hero" in text
    assert "plan-cards" in text
    assert "peak-shift" in text
    assert "solar-shift" in text
    assert "dedupe-toggle" in text
    assert "weekend-metrics" in text
    assert "quality-callout" in text
    assert "compare-monthly" in text
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
    assert payload["totals"]["grid"] == pytest.approx(272.7)
    assert payload["totals"]["solar"] == pytest.approx(60.3)
    assert payload["totals"]["cost_per_kwh"] == pytest.approx(
        payload["totals"]["tariff_bill"] / payload["totals"]["consumed"]
    )
    assert payload["what_if_solar"]["fraction"] == pytest.approx(0.50)
    assert payload["compare"]["delta_kwh"] == 0
    assert payload["compare"]["shared_days"] == 18
    assert payload["compare"]["monthly_delta"]
    assert payload["weekend"]["weekday_days"] + payload["weekend"]["weekend_days"] == 18
    assert payload["quality"]["duplicate_keys"] == 0
    assert payload["what_if"]["fraction"] == pytest.approx(0.10)
    assert payload["plans"]["cheapest"]
    winners = [item for item in payload["plans"]["plans"] if item["winner"]]
    assert len(winners) == 1


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
            "--tariff-supply",
            "1.10",
            "--tariff-gst",
            "0.10",
            "--json",
            str(payload_path),
        ]
    )
    assert code == 0
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["totals"]["households"] == 1
    assert payload["totals"]["records"] == 3
    peak = sum(item["peak"] for item in payload["monthly"])
    days = payload["totals"]["days"]
    expected = (peak + 1.10 * days) * 1.10
    assert payload["totals"]["tariff_bill"] == pytest.approx(expected)


def test_cli_date_order_supply_and_gst(tmp_path):
    csv_path = tmp_path / "ambiguous.csv"
    csv_path.write_text(
        "date,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh\n01/02/2025,10,0,0,0\n",
        encoding="utf-8",
    )
    dmy_path = tmp_path / "dmy.json"
    mdy_path = tmp_path / "mdy.json"
    assert main(
        [
            str(csv_path),
            "--date-order",
            "dmy",
            "--tariff-supply",
            "1.10",
            "--tariff-gst",
            "0.10",
            "--json",
            str(dmy_path),
        ]
    ) == 0
    dmy = json.loads(dmy_path.read_text(encoding="utf-8"))
    assert dmy["totals"]["first_day"] == "2025-02-01"
    assert dmy["totals"]["tariff_bill"] == pytest.approx(5.61)
    assert dmy["totals"]["supply_charge"] == pytest.approx(1.10)
    assert dmy["totals"]["gst_amount"] == pytest.approx(0.51)

    assert main([str(csv_path), "--date-order", "mdy", "--json", str(mdy_path)]) == 0
    mdy = json.loads(mdy_path.read_text(encoding="utf-8"))
    assert mdy["totals"]["first_day"] == "2025-01-02"


def test_cli_dedupe_merges_duplicate_keys(tmp_path):
    csv_path = tmp_path / "dup.csv"
    csv_path.write_text(
        "day,household_id,peak_kwh,shoulder_kwh,offpeak_kwh\n"
        "2025-01-01,H-1,5,0,0\n"
        "2025-01-01,H-1,5,0,0\n",
        encoding="utf-8",
    )
    payload_path = tmp_path / "dup.json"
    assert main([str(csv_path), "--dedupe", "--json", str(payload_path)]) == 0
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["totals"]["records"] == 1
    assert payload["quality"]["duplicate_keys"] == 0


def test_cli_plans_flag_prints_winner(tmp_path, capsys):
    payload_path = tmp_path / "plans.json"
    code = main([str(SAMPLE), "--plans", "--json", str(payload_path)])
    assert code == 0
    out = capsys.readouterr().out
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["plans"]["cheapest"] in out
    assert "Flex Saver" in out
    assert "Solar Plus" in out
    assert "Flat Comfort" in out


NEM12_SAMPLE = ROOT / "data" / "sample_nem12.csv"


def test_cli_reads_nem12_and_reports_source(tmp_path, capsys):
    payload_path = tmp_path / "nem12.json"
    code = main([str(NEM12_SAMPLE), "--json", str(payload_path), "--battery-cost", "9000"])
    assert code == 0
    out = capsys.readouterr().out
    assert "Source      NEM12 · 30-min intervals · 6408091234" in out
    assert "Intervals   102 estimated/substituted" in out
    assert "payback" in out
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert payload["source"]["format"] == "nem12"
    assert payload["source"]["interval_minutes"] == 30
    assert payload["source"]["nmis"] == ["6408091234"]
    assert payload["what_if_battery"]["cost_aud"] == pytest.approx(9000)
    assert payload["what_if_battery"]["payback_years"] > 0
    assert len(payload["daily"]) == 365


def test_cli_battery_flags_and_plans_file(tmp_path, capsys):
    plans = tmp_path / "offers.json"
    plans.write_text(
        json.dumps(
            [
                {"name": "Night Owl", "peak": 0.55, "shoulder": 0.30, "offpeak": 0.10, "daily_supply": 1.0},
                {"name": "Steady", "peak": 0.30, "shoulder": 0.30, "offpeak": 0.30, "daily_supply": 1.3},
            ]
        ),
        encoding="utf-8",
    )
    payload_path = tmp_path / "out.json"
    code = main(
        [
            str(SAMPLE),
            "--plans",
            "--plans-file",
            str(plans),
            "--battery-kwh",
            "5",
            "--battery-efficiency",
            "0.8",
            "--json",
            str(payload_path),
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert "Night Owl" in out and "Steady" in out
    assert "Battery     5.0 kWh" in out
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    assert [plan["name"] for plan in payload["plans"]["plans"]] == ["Night Owl", "Steady"]
    assert payload["what_if_battery"]["capacity_kwh"] == pytest.approx(5)
    assert payload["what_if_battery"]["efficiency"] == pytest.approx(0.8)
    assert payload["what_if_battery"]["payback_years"] is None


def test_cli_bad_plans_file_is_a_clean_error(tmp_path, capsys):
    plans = tmp_path / "offers.json"
    plans.write_text("[]", encoding="utf-8")
    assert main([str(SAMPLE), "--plans-file", str(plans)]) == 1
    assert "non-empty list of plans" in capsys.readouterr().err
