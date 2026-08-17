from pathlib import Path

import pytest

from gridscope.analysis import (
    DEFAULT_TARIFF,
    GridScopeError,
    compare_datasets,
    estimate_bill,
    filter_household,
    get_analysis,
    get_anomalies,
    load_csv,
    parse_energy_csv,
    weekday_heatmap,
)

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "data" / "sample_energy_upload.csv"


def test_parse_sample_csv():
    rows = load_csv(SAMPLE)
    assert len(rows) == 18
    assert {row["household"] for row in rows} == {
        "H-101",
        "H-102",
        "H-201",
        "H-202",
        "H-301",
        "H-302",
        "H-401",
        "H-402",
    }
    assert rows[0]["day"] == "2025-01-01"
    assert rows[0]["neighbourhood"] == "Northbank"
    assert rows[0]["peak"] == pytest.approx(7.2)
    assert rows[0]["grid"] == pytest.approx(13.8)
    assert rows[0]["consumed"] == pytest.approx(7.2 + 5.8 + 3.4)
    assert sum(row["grid"] for row in rows) == pytest.approx(272.7)
    assert sum(row["solar"] for row in rows) == pytest.approx(60.3)


def test_parse_total_kwh_splits_tiers():
    text = "date,total_kwh\n2025-07-01,10\n"
    rows = parse_energy_csv(text)
    assert len(rows) == 1
    assert rows[0]["peak"] == pytest.approx(4.4)
    assert rows[0]["shoulder"] == pytest.approx(3.4)
    assert rows[0]["offpeak"] == pytest.approx(2.2)
    assert rows[0]["consumed"] == pytest.approx(10)
    assert rows[0]["grid"] == pytest.approx(10)


def test_parse_aliases_and_quoted_fields():
    text = (
        "reading_date,account_id,suburb,usage_kwh,solar_export,cost\n"
        '"13/03/2025","H-9","East Park",8.0,1.5,"$3.20"\n'
    )
    rows = parse_energy_csv(text)
    assert rows[0]["day"] == "2025-03-13"
    assert rows[0]["household"] == "H-9"
    assert rows[0]["neighbourhood"] == "East Park"
    assert rows[0]["bill"] == pytest.approx(3.2)
    assert rows[0]["grid"] == pytest.approx(8.0)


def test_missing_date_column_errors_cleanly():
    with pytest.raises(GridScopeError, match="date column"):
        parse_energy_csv("foo,bar\n1,2\n")


def test_missing_energy_columns_errors_cleanly():
    with pytest.raises(GridScopeError, match="energy columns"):
        parse_energy_csv("day,household_id\n2025-01-01,H-1\n")


def test_empty_csv_errors_cleanly():
    with pytest.raises(GridScopeError, match="header row"):
        parse_energy_csv("day,grid_import_kwh\n")


def test_anomaly_flags_high_usage_day():
    lines = ["day,household_id,grid_import_kwh"]
    for day in range(1, 6):
        lines.append(f"2025-01-0{day},H-1,10")
    lines.append("2025-01-06,H-1,30")
    rows = parse_energy_csv("\n".join(lines))
    anomalies = get_anomalies(rows)
    assert any(
        item["day"] == "2025-01-06" and item["anomaly_type"] == "high_spike"
        for item in anomalies
    )
    assert all(item["anomaly_type"] != "normal" for item in anomalies)


def test_anomaly_flags_low_dip():
    text = "day,grid_import_kwh\n2025-01-01,20\n2025-01-02,20\n2025-01-03,2\n"
    anomalies = get_anomalies(parse_energy_csv(text))
    assert len(anomalies) == 1
    assert anomalies[0]["day"] == "2025-01-03"
    assert anomalies[0]["anomaly_type"] == "low_dip"


def test_tariff_bill_is_deterministic():
    rows = load_csv(SAMPLE)
    first = rows[0]
    expected = (
        first["peak"] * 0.40
        + first["shoulder"] * 0.28
        + first["offpeak"] * 0.18
        - first["solar"] * 0.08
    )
    assert estimate_bill([first], DEFAULT_TARIFF) == pytest.approx(expected)
    assert estimate_bill([first]) == pytest.approx(4.628)
    whole = estimate_bill(rows)
    assert estimate_bill(rows) == pytest.approx(whole)
    assert estimate_bill(rows, {"peak": 0, "shoulder": 0, "offpeak": 0, "export_credit": 0}) == 0


def test_compare_identical_frames_zero_delta():
    rows = load_csv(SAMPLE)
    comparison = compare_datasets(rows, rows)
    assert comparison["shared_days"] == 18
    assert comparison["delta_kwh"] == pytest.approx(0)
    assert comparison["delta_bill"] == pytest.approx(0)
    assert comparison["shared_delta_kwh"] == pytest.approx(0)
    assert comparison["shared_delta_bill"] == pytest.approx(0)


def test_compare_detects_usage_delta():
    left = parse_energy_csv("day,grid_import_kwh\n2025-01-01,10\n2025-01-02,10\n")
    right = parse_energy_csv("day,grid_import_kwh\n2025-01-01,12\n2025-01-03,8\n")
    comparison = compare_datasets(left, right)
    assert comparison["shared_days"] == 1
    assert comparison["delta_kwh"] == pytest.approx(0)
    assert comparison["shared_delta_kwh"] == pytest.approx(2)


def test_get_analysis_sample_totals_and_heatmap():
    analysis = get_analysis(load_csv(SAMPLE))
    assert analysis["totals"]["records"] == 18
    assert analysis["totals"]["days"] == 18
    assert analysis["totals"]["households"] == 8
    assert analysis["heatmap"]["axis"] == "month"
    assert "2025-01" in analysis["heatmap"]["buckets"]
    assert len(analysis["heatmap"]["weekdays"]) == 7
    assert analysis["recommendations"]
    assert any(item["opportunity"] == "Shift peak usage" for item in analysis["recommendations"])


def test_household_filter_limits_rows():
    rows = load_csv(SAMPLE)
    filtered = filter_household(rows, "H-101")
    assert {row["household"] for row in filtered} == {"H-101"}
    analysis = get_analysis(rows, household="H-101")
    assert analysis["totals"]["households"] == 1
    assert analysis["totals"]["records"] == 3


def test_heatmap_uses_hour_when_present():
    text = (
        "timestamp,grid_import_kwh\n"
        "2025-01-06T08:00:00,4\n"
        "2025-01-06T18:00:00,9\n"
        "2025-01-07T08:00:00,3\n"
    )
    heat = weekday_heatmap(parse_energy_csv(text))
    assert heat["axis"] == "hour"
    assert "08" in heat["buckets"]
    morning = next(cell for cell in heat["cells"] if cell["weekday"] == "Mon" and cell["bucket"] == "08")
    assert morning["grid"] == pytest.approx(4)


def test_file_not_found():
    with pytest.raises(GridScopeError, match="File not found"):
        load_csv(ROOT / "data" / "missing.csv")
