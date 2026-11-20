"""0.9 engine: NEM12 intake, interval-aware quality, robust anomalies, battery, plan switch."""

from pathlib import Path

import pytest

from gridscope.analysis import (
    GridScopeError,
    compare_plans,
    data_quality,
    dedupe_rows,
    get_analysis,
    get_anomalies,
    load_plans_file,
    parse_energy_csv,
    parse_energy_text,
    parse_energy_text_details,
    parse_hour_value,
    simulate_battery,
    what_if_battery,
)
from gridscope.nem12 import looks_like_nem12, parse_nem12, parse_nem12_details

ROOT = Path(__file__).resolve().parents[1]


def nem12(days, interval=30, uom="KWH", flag="A", extra=None):
    """Build a NEM12 file with an E1 import and B1 export channel.

    ``days`` maps YYYYMMDD -> (import_fn, export_fn), each taking the 0-based
    interval index and returning kWh.
    """
    count = 1440 // interval
    lines = ["100,NEM12,202501010000,MDP1,RETAILER"]
    for suffix, pick in (("E1", 0), ("B1", 1)):
        lines.append(f"200,6123456789,E1B1,1,{suffix},N1,METER1,{uom},{interval},")
        for day, fns in days.items():
            values = [f"{fns[pick](i):.3f}" for i in range(count)]
            lines.append(f"300,{day}," + ",".join(values) + f",{flag},,,20250102000000,")
            if extra and suffix == "E1":
                lines.extend(extra)
    lines.append("900")
    return "\n".join(lines) + "\n"


def flat(value):
    return lambda _index: value


def test_detects_nem12_but_not_column_csv():
    assert looks_like_nem12("100,NEM12,202501010000,A,B\n200,...")
    assert looks_like_nem12("﻿200,6123,E1,1,E1,N1,M,KWH,30,\n")
    assert not looks_like_nem12("100,NEM13,x\n")
    assert not looks_like_nem12("day,grid_import_kwh\n2025-01-01,3\n")


def test_nem12_rolls_intervals_up_to_hourly_tou_rows():
    # Monday 6 Jan 2025: 0.5 kWh import every half hour, 0.25 kWh export.
    text = nem12({"20250106": (flat(0.5), flat(0.25))})
    rows, meta = parse_nem12_details(text)
    assert meta["format"] == "nem12"
    assert meta["nmis"] == ["6123456789"]
    assert meta["interval_minutes"] == 30
    assert meta["channels"] == ["6123456789:E1", "6123456789:B1"]
    assert len(rows) == 24
    assert {row["hour"] for row in rows} == set(range(24))
    assert all(row["grid"] == pytest.approx(1.0) for row in rows)
    assert all(row["solar"] == pytest.approx(0.5) for row in rows)
    assert all(row["tier_source"] == "interval" for row in rows)
    by_hour = {row["hour"]: row for row in rows}
    # Weekday windows: 14-19 peak, 7-13 and 20-21 shoulder, otherwise off-peak.
    assert by_hour[16]["peak"] == pytest.approx(1.0)
    assert by_hour[9]["shoulder"] == pytest.approx(1.0)
    assert by_hour[21]["shoulder"] == pytest.approx(1.0)
    assert by_hour[2]["offpeak"] == pytest.approx(1.0)
    assert sum(row["peak"] for row in rows) == pytest.approx(6.0)
    assert sum(row["shoulder"] for row in rows) == pytest.approx(9.0)
    assert sum(row["offpeak"] for row in rows) == pytest.approx(9.0)


def test_nem12_weekend_is_all_offpeak_and_wh_is_scaled():
    text = nem12({"20250104": (flat(500), flat(0))}, uom="WH")
    rows = parse_nem12(text)
    assert rows[0]["weekday"] == "Sat"
    assert sum(row["grid"] for row in rows) == pytest.approx(24.0)
    assert sum(row["offpeak"] for row in rows) == pytest.approx(24.0)
    assert sum(row["peak"] for row in rows) == pytest.approx(0)


def test_nem12_five_minute_intervals():
    text = nem12({"20250106": (flat(0.1), flat(0))}, interval=5)
    rows = parse_nem12(text)
    assert len(rows) == 24
    assert rows[0]["grid"] == pytest.approx(1.2)


def test_nem12_counts_estimated_and_variable_quality():
    estimated = nem12({"20250106": (flat(0.5), flat(0))}, flag="E")
    quality = data_quality(parse_nem12(estimated))
    # 48 import intervals and 48 export intervals, all forward-estimated.
    assert quality["estimated_intervals"] == 96
    assert quality["duplicate_keys"] == 0

    variable = nem12(
        {"20250106": (flat(0.5), flat(0))},
        flag="V",
        extra=["400,1,10,S14,,", "400,11,48,A,,"],
    )
    rows = parse_nem12(variable)
    # Only the import channel has 400 records; the export V day defaults to actual.
    assert data_quality(rows)["estimated_intervals"] == 10
    assert sum(row["grid"] for row in rows) == pytest.approx(24.0)


def test_nem12_blank_and_null_intervals_are_missing_not_zero_usage():
    text = nem12({"20250106": (lambda i: 1.0 if i else float("nan"), flat(0))})
    text = text.replace(",nan,", ",,")
    rows = parse_nem12(text)
    quality = data_quality(rows)
    assert quality["missing_intervals"] == 1
    assert sum(row["grid"] for row in rows) == pytest.approx(47.0)


def test_nem12_errors_are_user_facing():
    with pytest.raises(GridScopeError, match="expected 48"):
        parse_nem12("100,NEM12\n200,6123,E1,1,E1,N1,M,KWH,30,\n300,20250106,1,2,3,A\n900\n")
    with pytest.raises(GridScopeError, match="before any 200"):
        parse_nem12("100,NEM12\n300,20250106,1\n")
    with pytest.raises(GridScopeError, match="No kWh import or export"):
        parse_nem12("100,NEM12\n200,6123,Q1,1,Q1,N1,M,KVARH,30,\n" + "300,20250106," + ",".join(["1"] * 48) + ",A\n900\n")
    with pytest.raises(GridScopeError, match="interval length"):
        parse_nem12("100,NEM12\n200,6123,E1,1,E1,N1,M,KWH,7,\n")


def test_parse_energy_text_routes_by_format():
    rows, meta = parse_energy_text_details(nem12({"20250106": (flat(0.5), flat(0))}))
    assert meta["format"] == "nem12"
    assert len(rows) == 24
    rows, meta = parse_energy_text_details("day,grid_import_kwh\n2025-01-01,3\n")
    assert meta["format"] == "csv"
    assert rows[0]["grid"] == pytest.approx(3)


def test_tou_flag_explains_itself_on_interval_data():
    rows = parse_energy_text(nem12({"20250106": (flat(0.5), flat(0))}))
    analysis = get_analysis(rows, tou=True)
    assert analysis["tou_applied"] is False
    assert "already applied" in analysis["tou_note"]
    assert analysis["source"]["format"] == "nem12"
    assert analysis["heatmap"]["axis"] == "hour"


def test_time_column_and_hour_formats():
    assert parse_hour_value("13:30") == 13
    assert parse_hour_value("07:00:00") == 7
    assert parse_hour_value("1:30 pm") == 13
    assert parse_hour_value("12 am") == 0
    assert parse_hour_value("18") == 18
    assert parse_hour_value("") is None
    assert parse_hour_value("25:00") is None
    rows = parse_energy_csv("date,time,grid_import_kwh\n2025-01-06,16:30,2\n2025-01-06,16:00,1\n")
    assert [row["hour"] for row in rows] == [16, 16]


def test_hourly_rows_are_not_duplicates_and_dedupe_keeps_hours():
    text = (
        "timestamp,household_id,grid_import_kwh\n"
        "2025-01-06T08:00,H-1,2\n"
        "2025-01-06T18:00,H-1,5\n"
        "2025-01-06T18:00,H-1,1\n"
    )
    rows = parse_energy_csv(text)
    assert data_quality(rows)["duplicate_keys"] == 1
    merged = dedupe_rows(rows)
    assert len(merged) == 2
    evening = next(row for row in merged if row["hour"] == 18)
    assert evening["grid"] == pytest.approx(6)


def _daily_csv(values, household="H-1"):
    lines = ["day,household_id,grid_import_kwh"]
    for offset, value in enumerate(values):
        lines.append(f"2025-03-{offset + 1:02d},{household},{value}")
    return "\n".join(lines)


def test_mad_flags_spike_that_a_mean_rule_would_miss():
    # One huge spike drags a mean up so far that a moderate one hides under it.
    values = [10, 11, 9, 10, 12, 10, 11, 9, 10, 19, 10, 11, 9, 60]
    anomalies = get_anomalies(parse_energy_csv(_daily_csv(values)))
    days = {item["day"]: item for item in anomalies}
    assert set(days) == {"2025-03-10", "2025-03-14"}
    spike = days["2025-03-10"]
    assert spike["method"] == "mad"
    assert spike["baseline_kwh"] == pytest.approx(10)
    assert spike["z_score"] == pytest.approx(0.6745 * 9 / 1)
    mean = sum(values) / len(values)
    assert 19 < mean * 1.5  # the 0.8 mean rule would not have flagged 2025-03-10


def test_mad_flags_low_dip_and_ignores_house_size():
    small = [4.0, 4.2, 3.8, 4.1, 3.9, 4.0, 4.1, 0.2]
    big = [40, 42, 38, 41, 39, 40, 41, 40]
    text = _daily_csv(small, "H-small") + "\n" + "\n".join(_daily_csv(big, "H-big").splitlines()[1:])
    anomalies = get_anomalies(parse_energy_csv(text))
    assert [(item["household"], item["anomaly_type"]) for item in anomalies] == [("H-small", "low_dip")]


def test_anomalies_are_scored_on_daily_totals_for_interval_data():
    days = {f"202501{day:02d}": (flat(0.5), flat(0)) for day in range(6, 20)}
    days["20250115"] = (flat(2.0), flat(0))
    rows = parse_energy_text(nem12(days))
    anomalies = get_anomalies(rows)
    assert len(anomalies) == 1
    assert anomalies[0]["day"] == "2025-01-15"
    assert anomalies[0]["grid"] == pytest.approx(96)
    assert anomalies[0]["baseline_kwh"] == pytest.approx(24)


def test_flat_series_falls_back_to_ratio_rule():
    values = [10] * 8 + [30]
    anomalies = get_anomalies(parse_energy_csv(_daily_csv(values)))
    assert len(anomalies) == 1
    assert anomalies[0]["method"] == "ratio"


def test_battery_daily_rows_charge_from_export_and_cut_peak():
    text = "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh,grid_import_kwh\n2025-01-06,6,4,2,8,12\n"
    rows = parse_energy_csv(text)
    adjusted, energy = simulate_battery(rows, capacity_kwh=10, efficiency=0.9)
    assert energy["charged_kwh"] == pytest.approx(8)
    assert energy["delivered_kwh"] == pytest.approx(7.2)
    assert adjusted[0]["peak"] == pytest.approx(0)
    assert adjusted[0]["shoulder"] == pytest.approx(4 - 1.2)
    assert adjusted[0]["solar"] == pytest.approx(0)
    assert adjusted[0]["grid"] == pytest.approx(12 - 7.2)
    assert rows[0]["peak"] == pytest.approx(6)  # inputs untouched

    result = what_if_battery(rows, capacity_kwh=10, efficiency=0.9, cost_aud=3650)
    # Saving = (6*0.40 + 1.2*0.28 - 8*0.08) * 1.10
    assert result["saving_aud"] == pytest.approx((2.4 + 0.336 - 0.64) * 1.1)
    assert result["annual_saving_aud"] == pytest.approx(result["saving_aud"] * 365)
    assert result["payback_years"] == pytest.approx(3650 / result["annual_saving_aud"])
    assert result["cycles"] == pytest.approx(0.8)


def test_battery_carries_midday_charge_into_evening_peak():
    # 2 kWh export at 12:00, 3 kWh import at 18:00 on a Monday.
    text = (
        "timestamp,household_id,grid_import_kwh,solar_export_kwh\n"
        "2025-01-06T18:00,H-1,3,0\n"
        "2025-01-06T12:00,H-1,0,2\n"
        "2025-01-06T12:00,H-2,0,5\n"
    )
    rows = parse_energy_csv(text)
    from gridscope.analysis import apply_tou

    adjusted, energy = simulate_battery(apply_tou(rows), capacity_kwh=5, efficiency=1.0)
    evening = next(row for row in adjusted if row["hour"] == 18)
    assert evening["grid"] == pytest.approx(1)
    assert evening["peak"] == pytest.approx(1)
    # H-2 has its own battery: its charge never reaches H-1.
    assert energy["charged_kwh"] == pytest.approx(7)
    assert energy["delivered_kwh"] == pytest.approx(2)


def test_battery_zero_capacity_is_a_no_op():
    rows = parse_energy_csv("day,grid_import_kwh,solar_export_kwh\n2025-01-06,10,4\n")
    result = what_if_battery(rows, capacity_kwh=0)
    assert result["saving_aud"] == pytest.approx(0)
    assert result["payback_years"] is None
    assert result["cycles"] == 0


def test_plan_switch_saving_and_recommendation():
    rows = parse_energy_csv(
        "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh\n2025-01-06,10,2,1,0\n"
    )
    scores = compare_plans(rows, current={"peak": 0.60, "shoulder": 0.30, "offpeak": 0.20})
    cheapest = min(item["bill"] for item in scores["plans"])
    assert scores["current_bill"] > cheapest
    assert scores["switch_saving"] == pytest.approx(scores["current_bill"] - cheapest)

    analysis = get_analysis(rows, tariff={"peak": 0.60, "shoulder": 0.30, "offpeak": 0.20})
    switch = next(
        item for item in analysis["recommendations"] if item["opportunity"].startswith("Switch to")
    )
    assert switch["saving_aud"] == pytest.approx(analysis["plans"]["switch_saving"])
    assert switch["impact"] == "high"


def test_custom_plans_file(tmp_path):
    path = tmp_path / "plans.json"
    path.write_text(
        '{"plans": [{"name": "Cheap Nights", "peak": 0.5, "shoulder": 0.3, "offpeak": 0.1, '
        '"export_credit": 0.05, "daily_supply": 1.0}, {"name": "Flat", "peak": 0.3, '
        '"shoulder": 0.3, "offpeak": 0.3, "daily_supply": 1.2}]}'
    )
    plans = load_plans_file(path)
    assert [plan["name"] for plan in plans] == ["Cheap Nights", "Flat"]
    assert "gst" not in plans[0]
    rows = parse_energy_csv("day,peak_kwh,shoulder_kwh,offpeak_kwh\n2025-01-06,0,0,20\n")
    analysis = get_analysis(rows, plans=plans)
    assert analysis["plans"]["cheapest"] == "Cheap Nights"

    bad = tmp_path / "bad.json"
    bad.write_text('[{"peak": 0.3}]')
    with pytest.raises(GridScopeError, match="needs a name"):
        load_plans_file(bad)
    bad.write_text("not json")
    with pytest.raises(GridScopeError, match="valid JSON"):
        load_plans_file(bad)


def test_analysis_exposes_daily_series_and_battery():
    rows = parse_energy_csv(_daily_csv([10, 12, 11]))
    analysis = get_analysis(rows, battery={"capacity_kwh": 5, "cost_aud": 1000})
    assert [item["day"] for item in analysis["daily"]] == ["2025-03-01", "2025-03-02", "2025-03-03"]
    assert analysis["daily"][1]["grid"] == pytest.approx(12)
    assert analysis["what_if_battery"]["capacity_kwh"] == pytest.approx(5)
    assert analysis["what_if_battery"]["cost_aud"] == pytest.approx(1000)


def test_generated_samples_are_current_and_flag_the_planted_events():
    import subprocess
    import sys

    check = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "make_samples.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert check.returncode == 0, check.stderr

    from gridscope.analysis import load_csv

    daily = get_analysis(load_csv(ROOT / "data" / "sample_energy_upload.csv"))
    assert daily["totals"]["records"] == 1460
    assert daily["totals"]["households"] == 4
    flagged = {(item["household"], item["day"]): item for item in daily["anomalies"]}
    planted = [("H-101", "2025-01-30"), ("H-301", "2025-04-15")]
    planted += [("H-201", f"2025-07-{day:02d}") for day in (8, 9, 10)]
    planted += [("H-102", f"2025-09-{day}") for day in range(20, 27)]
    for key in planted:
        assert key in flagged, key
    assert all(flagged[key]["method"] == "mad" for key in planted)
    planted_min_z = min(abs(flagged[key]["z_score"]) for key in planted)
    others = [item for key, item in flagged.items() if key not in planted]
    assert all(abs(item["z_score"]) < planted_min_z + 0.5 for item in others)
    assert len(others) <= 3

    interval = get_analysis(load_csv(ROOT / "data" / "sample_nem12.csv"))
    assert interval["source"]["format"] == "nem12"
    assert interval["totals"]["days"] == 365
    assert interval["anomalies"][0]["day"] == "2025-02-12"
    assert interval["anomalies"][0]["z_score"] > 10
    # One estimated day (2 channels x 48) plus six substituted intervals on the V day.
    assert interval["quality"]["estimated_intervals"] == 102
    assert interval["what_if_battery"]["saving_aud"] > 0
