from pathlib import Path

import pytest

from gridscope.analysis import (
    DEFAULT_TARIFF,
    GridScopeError,
    apply_tou,
    calendar_coverage,
    coerce_tariff,
    compare_datasets,
    compare_plans,
    data_quality,
    dedupe_rows,
    estimate_bill,
    filter_household,
    get_analysis,
    get_anomalies,
    load_csv,
    parse_date_and_hour,
    parse_energy_csv,
    shift_peak,
    weekday_heatmap,
    weekend_split,
    what_if_peak_shift,
    what_if_solar_self,
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
    assert rows[0]["tier_source"] == "csv"
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
    assert rows[0]["tier_source"] == "split"


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


def test_date_order_dmy_vs_mdy():
    text = "date,grid_import_kwh\n01/02/2025,10\n"
    dmy = parse_energy_csv(text, date_order="dmy")
    mdy = parse_energy_csv(text, date_order="mdy")
    auto = parse_energy_csv(text, date_order="auto")
    assert dmy[0]["day"] == "2025-02-01"
    assert mdy[0]["day"] == "2025-01-02"
    assert auto[0]["day"] == "2025-01-02"
    parsed_dmy, _ = parse_date_and_hour("01/02/2025", "dmy")
    parsed_mdy, _ = parse_date_and_hour("01/02/2025", "mdy")
    assert parsed_dmy.isoformat() == "2025-02-01"
    assert parsed_mdy.isoformat() == "2025-01-02"


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
    spike = next(item for item in anomalies if item["day"] == "2025-01-06")
    assert spike["baseline"] == "household"
    assert spike["baseline_kwh"] == pytest.approx((10 * 5 + 30) / 6)


def test_anomaly_flags_low_dip():
    text = "day,grid_import_kwh\n2025-01-01,20\n2025-01-02,20\n2025-01-03,2\n"
    anomalies = get_anomalies(parse_energy_csv(text))
    assert len(anomalies) == 1
    assert anomalies[0]["day"] == "2025-01-03"
    assert anomalies[0]["anomaly_type"] == "low_dip"
    assert anomalies[0]["baseline"] == "global"


def test_anomaly_uses_household_baseline_when_enough_rows():
    lines = ["day,household_id,grid_import_kwh"]
    for day in range(1, 6):
        lines.append(f"2025-01-0{day},H-small,4")
    lines.append("2025-01-06,H-small,20")
    for day in range(1, 6):
        lines.append(f"2025-02-0{day},H-big,40")
    lines.append("2025-03-01,H-new,2")
    anomalies = get_anomalies(parse_energy_csv("\n".join(lines)))
    by_day = {item["day"]: item for item in anomalies}
    assert "2025-01-06" in by_day
    assert by_day["2025-01-06"]["baseline"] == "household"
    assert by_day["2025-01-06"]["anomaly_type"] == "high_spike"
    assert by_day["2025-01-06"]["household"] == "H-small"
    assert not any(item["household"] == "H-big" for item in anomalies)
    assert "2025-03-01" in by_day
    assert by_day["2025-03-01"]["baseline"] == "global"
    assert by_day["2025-03-01"]["anomaly_type"] == "low_dip"


def test_known_bill_one_day_peak_only():
    # energy = 10 * 0.40 = 4.00
    # supply = 1.10 * 1 day
    # ex GST = 5.10
    # inc GST = 5.10 * 1.10 = 5.61
    text = "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh\n2025-01-01,10,0,0,0\n"
    rows = parse_energy_csv(text)
    assert estimate_bill(rows) == pytest.approx(5.61)
    analysis = get_analysis(rows)
    assert analysis["totals"]["tariff_bill"] == pytest.approx(5.61)
    assert analysis["totals"]["tariff_bill_ex_gst"] == pytest.approx(5.10)
    assert analysis["totals"]["supply_charge"] == pytest.approx(1.10)
    assert analysis["totals"]["gst_amount"] == pytest.approx(0.51)
    assert analysis["totals"]["cost_per_kwh"] == pytest.approx(
        analysis["totals"]["tariff_bill"] / 10
    )


def test_tariff_bill_is_deterministic():
    rows = load_csv(SAMPLE)
    first = rows[0]
    energy = (
        first["peak"] * 0.40
        + first["shoulder"] * 0.28
        + first["offpeak"] * 0.18
    )
    export = first["solar"] * 0.08
    expected = (energy + 1.10 - export) * 1.10
    assert estimate_bill([first], DEFAULT_TARIFF) == pytest.approx(expected)
    assert estimate_bill([first]) == pytest.approx(expected)
    whole = estimate_bill(rows)
    assert estimate_bill(rows) == pytest.approx(whole)
    days = len({row["day"] for row in rows})
    assert estimate_bill(
        rows, {"peak": 0, "shoulder": 0, "offpeak": 0, "export_credit": 0}
    ) == pytest.approx(1.10 * days * 1.10)


def test_coerce_tariff_aliases():
    rates = coerce_tariff({"supply": 2, "gst_rate": 0.2, "peak_rate": 0.5})
    assert rates["daily_supply"] == pytest.approx(2)
    assert rates["gst"] == pytest.approx(0.2)
    assert rates["peak"] == pytest.approx(0.5)
    assert rates["shoulder"] == pytest.approx(DEFAULT_TARIFF["shoulder"])


def test_compare_identical_frames_zero_delta():
    rows = load_csv(SAMPLE)
    comparison = compare_datasets(rows, rows)
    assert comparison["shared_days"] == 18
    assert comparison["delta_kwh"] == pytest.approx(0)
    assert comparison["delta_bill"] == pytest.approx(0)
    assert comparison["shared_delta_kwh"] == pytest.approx(0)
    assert comparison["shared_delta_bill"] == pytest.approx(0)
    assert comparison["monthly_delta"]
    assert all(item["delta_kwh"] == pytest.approx(0) for item in comparison["monthly_delta"])
    assert all(item["delta_bill"] == pytest.approx(0) for item in comparison["monthly_delta"])


def test_compare_detects_usage_delta():
    left = parse_energy_csv("day,grid_import_kwh\n2025-01-01,10\n2025-01-02,10\n")
    right = parse_energy_csv("day,grid_import_kwh\n2025-01-01,12\n2025-01-03,8\n")
    comparison = compare_datasets(left, right)
    assert comparison["shared_days"] == 1
    assert comparison["delta_kwh"] == pytest.approx(0)
    assert comparison["shared_delta_kwh"] == pytest.approx(2)
    assert [item["month"] for item in comparison["monthly_delta"]] == ["2025-01"]
    assert comparison["monthly_delta"][0]["delta_kwh"] == pytest.approx(0)


def test_compare_monthly_delta_only_shared_months():
    left = parse_energy_csv("day,grid_import_kwh\n2025-01-01,10\n2025-02-01,10\n")
    right = parse_energy_csv("day,grid_import_kwh\n2025-01-01,12\n2025-03-01,8\n")
    comparison = compare_datasets(left, right)
    assert [item["month"] for item in comparison["monthly_delta"]] == ["2025-01"]
    assert comparison["monthly_delta"][0]["delta_kwh"] == pytest.approx(2)


def test_get_analysis_sample_totals_and_heatmap():
    analysis = get_analysis(load_csv(SAMPLE))
    assert analysis["totals"]["records"] == 18
    assert analysis["totals"]["days"] == 18
    assert analysis["totals"]["households"] == 8
    consumed = analysis["totals"]["consumed"]
    assert analysis["totals"]["peak_share"] == pytest.approx(
        100 * analysis["totals"]["peak"] / consumed
    )
    assert analysis["totals"]["solar_share"] == pytest.approx(
        100 * analysis["totals"]["solar"] / consumed
    )
    assert analysis["heatmap"]["axis"] == "month"
    assert "2025-01" in analysis["heatmap"]["buckets"]
    assert len(analysis["heatmap"]["weekdays"]) == 7
    assert analysis["recommendations"]
    assert any(item["opportunity"] == "Shift peak usage" for item in analysis["recommendations"])
    assert analysis["weekend"]["weekday_days"] + analysis["weekend"]["weekend_days"] == 18
    assert analysis["quality"]["duplicate_keys"] == 0
    assert analysis["what_if"]["fraction"] == pytest.approx(0.10)
    assert analysis["what_if_solar"]["fraction"] == pytest.approx(0.50)
    assert analysis["totals"]["cost_per_kwh"] == pytest.approx(
        analysis["totals"]["tariff_bill"] / analysis["totals"]["consumed"]
    )
    for item in analysis["groups"]:
        assert item["kwh_per_household"] == pytest.approx(
            item["grid"] / item["households"]
        )


def test_recommendations_include_saving_aud():
    analysis = get_analysis(load_csv(SAMPLE))
    recs = analysis["recommendations"]
    assert recs
    assert all("saving_aud" in item for item in recs)
    peak = next(item for item in recs if item["opportunity"] == "Shift peak usage")
    assert peak["saving_aud"] > 0
    assert "$" in peak["detail"]
    spend = next(item for item in recs if item["opportunity"] == "Review estimated spend")
    assert spend["saving_aud"] == pytest.approx(0)
    assert "30-day" in spend["detail"]
    savings = [item["saving_aud"] for item in recs]
    assert savings == sorted(savings, reverse=True)


def test_compare_plans_winner_is_deterministic():
    rows = load_csv(SAMPLE)
    first = compare_plans(rows)
    second = compare_plans(rows)
    assert first["cheapest"] == second["cheapest"]
    assert first["cheapest"] == "Solar Plus"
    names = [item["name"] for item in first["plans"]]
    assert names == ["Flex Saver", "Solar Plus", "Flat Comfort"]
    winners = [item for item in first["plans"] if item["winner"]]
    assert len(winners) == 1
    assert winners[0]["name"] == first["cheapest"]
    assert winners[0]["delta_vs_cheapest"] == pytest.approx(0)
    assert first["cheapest"] in names
    for item in first["plans"]:
        if item["name"] != first["cheapest"]:
            assert item["bill"] >= winners[0]["bill"]
            assert item["delta_vs_cheapest"] == pytest.approx(item["bill"] - winners[0]["bill"])


def test_tou_retiers_weekday_hours():
    monday = parse_energy_csv("timestamp,grid_import_kwh\n2025-01-06T16:00:00,10\n")
    assert monday[0]["weekday"] == "Mon"
    peaked = apply_tou(monday)
    assert peaked[0]["peak"] == pytest.approx(10)
    assert peaked[0]["shoulder"] == pytest.approx(0)
    assert peaked[0]["offpeak"] == pytest.approx(0)
    saturday = parse_energy_csv("timestamp,grid_import_kwh\n2025-01-04T16:00:00,10\n")
    weekend = get_analysis(saturday, tou=True)
    assert weekend["rows"][0]["offpeak"] == pytest.approx(10)
    assert weekend["rows"][0]["peak"] == pytest.approx(0)


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


def test_tou_does_not_clobber_csv_tiers():
    text = "day,hour,peak_kwh,shoulder_kwh,offpeak_kwh\n2025-01-06,16,9,1,0\n"
    rows = parse_energy_csv(text)
    assert rows[0]["tier_source"] == "csv"
    assert rows[0]["peak"] == pytest.approx(9)
    analysis = get_analysis(rows, tou=True)
    assert analysis["rows"][0]["peak"] == pytest.approx(9)
    assert analysis["rows"][0]["shoulder"] == pytest.approx(1)
    assert analysis["rows"][0]["offpeak"] == pytest.approx(0)
    assert analysis["tou_applied"] is False
    assert "already has peak/shoulder/offpeak columns" in analysis["tou_note"]


def test_calendar_coverage_sample_is_sparse():
    analysis = get_analysis(load_csv(SAMPLE))
    coverage = analysis["coverage"]
    assert coverage["kind"] == "sparse"
    assert coverage["recorded"] == 18
    assert coverage["first"] == "2025-01-01"
    assert coverage["last"] == "2025-06-03"
    assert coverage["span_days"] == 154
    assert coverage["missing_days"] == []
    assert coverage["missing_count"] == coverage["span_days"] - coverage["recorded"]
    assert coverage["density"] == pytest.approx(18 / 154)
    assert coverage["density"] < 0.7


def test_calendar_coverage_daily_lists_missing():
    text = "day,grid_import_kwh\n2025-01-01,1\n2025-01-02,1\n2025-01-04,1\n"
    coverage = calendar_coverage(parse_energy_csv(text))
    assert coverage["kind"] == "daily"
    assert coverage["recorded"] == 3
    assert coverage["span_days"] == 4
    assert coverage["missing_days"] == ["2025-01-03"]
    assert coverage["missing_count"] == 1


def test_calendar_coverage_short_window():
    coverage = calendar_coverage(parse_energy_csv("day,grid_import_kwh\n2025-01-01,1\n"))
    assert coverage["kind"] == "short"
    assert coverage["missing_days"] == []


def test_month_over_month_deltas():
    text = "day,grid_import_kwh\n2025-01-01,10\n2025-02-01,15\n"
    monthly = get_analysis(parse_energy_csv(text))["monthly"]
    assert monthly[0]["mom_grid"] is None
    assert monthly[0]["mom_bill"] is None
    assert monthly[1]["mom_grid"] == pytest.approx(5)
    assert monthly[1]["mom_bill"] == pytest.approx(
        monthly[1]["tariff_bill"] - monthly[0]["tariff_bill"]
    )


def test_compare_joins_household_day_when_both_multi():
    left = parse_energy_csv(
        "day,household_id,grid_import_kwh\n"
        "2025-01-01,H-1,10\n"
        "2025-01-01,H-2,20\n"
        "2025-01-02,H-1,5\n"
    )
    right = parse_energy_csv(
        "day,household_id,grid_import_kwh\n"
        "2025-01-01,H-1,12\n"
        "2025-01-03,H-3,8\n"
    )
    comparison = compare_datasets(left, right)
    assert comparison["join"] == "household_day"
    assert comparison["shared_days"] == 1
    assert comparison["shared_day_list"] == ["2025-01-01"]
    assert comparison["shared_delta_kwh"] == pytest.approx(2)


def test_weekend_split_sat_and_mon_peak_only():
    # Sat 4 Jan 2025, Mon 6 Jan 2025 — same 10 kWh peak, no TOU retier.
    text = (
        "day,peak_kwh,shoulder_kwh,offpeak_kwh\n"
        "2025-01-04,10,0,0\n"
        "2025-01-06,10,0,0\n"
    )
    rows = parse_energy_csv(text)
    assert rows[0]["weekday"] == "Sat"
    assert rows[1]["weekday"] == "Mon"
    split = weekend_split(rows)
    assert split["weekday_days"] == 1
    assert split["weekend_days"] == 1
    assert split["weekday_kwh"] == pytest.approx(10)
    assert split["weekend_kwh"] == pytest.approx(10)
    assert split["weekday_kwh"] == pytest.approx(split["weekend_kwh"])
    # Default tariff is TOU-less: weekend peak stays peak, so bills match.
    assert split["weekday_bill"] == pytest.approx(split["weekend_bill"])
    assert split["weekday_bill"] == pytest.approx(5.61)
    analysis = get_analysis(rows)
    assert analysis["weekend"]["weekday_days"] == 1
    assert analysis["weekend"]["weekend_days"] == 1


def test_data_quality_flags_duplicate_household_day():
    text = (
        "day,household_id,grid_import_kwh\n"
        "2025-01-01,H-1,10\n"
        "2025-01-01,H-1,12\n"
        "2025-01-02,H-1,8\n"
    )
    rows = parse_energy_csv(text)
    quality = data_quality(rows)
    assert quality["duplicate_keys"] == 1
    assert quality["negative_energy"] == 0
    assert get_analysis(rows)["quality"]["duplicate_keys"] == 1


def test_peak_shift_ten_percent_saves_spread():
    text = "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh\n2025-01-01,10,0,0,0\n"
    rows = parse_energy_csv(text)
    expected = 0.10 * 10 * (DEFAULT_TARIFF["peak"] - DEFAULT_TARIFF["offpeak"]) * (
        1 + DEFAULT_TARIFF["gst"]
    )
    result = what_if_peak_shift(rows, DEFAULT_TARIFF, 0.10)
    assert result["fraction"] == pytest.approx(0.10)
    assert result["saving_aud"] == pytest.approx(expected)
    shifted = shift_peak(rows, 0.10)
    assert shifted[0]["peak"] == pytest.approx(9)
    assert shifted[0]["offpeak"] == pytest.approx(1)
    assert shifted[0]["consumed"] == pytest.approx(10)
    assert rows[0]["peak"] == pytest.approx(10)
    analysis = get_analysis(rows)
    assert analysis["what_if"]["saving_aud"] == pytest.approx(expected)


def test_cost_per_kwh_peak_only():
    text = "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh\n2025-01-01,10,0,0,0\n"
    analysis = get_analysis(parse_energy_csv(text))
    assert analysis["totals"]["consumed"] == pytest.approx(10)
    assert analysis["totals"]["cost_per_kwh"] == pytest.approx(
        analysis["totals"]["tariff_bill"] / 10
    )


def test_solar_self_consumption_what_if():
    text = (
        "day,peak_kwh,shoulder_kwh,offpeak_kwh,solar_export_kwh,grid_import_kwh\n"
        "2025-01-01,0,0,0,10,0\n"
    )
    rows = parse_energy_csv(text)
    expected = 0.5 * 10 * (0.28 - 0.08) * 1.1
    result = what_if_solar_self(rows, DEFAULT_TARIFF, 0.5)
    assert result["fraction"] == pytest.approx(0.50)
    assert result["saving_aud"] == pytest.approx(expected)
    assert result["shifted_bill"] == pytest.approx(result["baseline_bill"] - expected)
    assert rows[0]["solar"] == pytest.approx(10)
    assert rows[0]["peak"] == pytest.approx(0)
    analysis = get_analysis(rows)
    assert analysis["what_if_solar"]["fraction"] == pytest.approx(0.50)
    assert analysis["what_if_solar"]["saving_aud"] == pytest.approx(expected)


def test_dedupe_sums_duplicate_household_day():
    text = (
        "day,household_id,peak_kwh,shoulder_kwh,offpeak_kwh\n"
        "2025-01-01,H-1,5,0,0\n"
        "2025-01-01,H-1,5,0,0\n"
    )
    rows = parse_energy_csv(text)
    assert len(rows) == 2
    merged = dedupe_rows(rows)
    assert len(merged) == 1
    assert merged[0]["peak"] == pytest.approx(10)
    assert merged[0]["household"] == "H-1"
    assert merged[0]["day"] == "2025-01-01"
    assert rows[0]["peak"] == pytest.approx(5)
    assert data_quality(rows)["duplicate_keys"] == 1
    analysis = get_analysis(rows, dedupe=True)
    assert len(analysis["rows"]) == 1
    assert analysis["rows"][0]["peak"] == pytest.approx(10)
    assert analysis["quality"]["duplicate_keys"] == 0
    assert get_analysis(rows)["quality"]["duplicate_keys"] == 1
