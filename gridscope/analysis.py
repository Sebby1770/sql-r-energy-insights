"""GridScope analysis engine (source of truth).

Formulas mirrored in assets/analysis.js for the browser upload UI.
Keep both copies aligned when changing parse rules or math.

  * Untiered split: peak 0.44 / shoulder 0.34 / off-peak 0.22 of supplied total
  * consumed = peak + shoulder + off-peak
  * grid = supplied grid else max(0, consumed - solar)
  * anomaly: high_spike if grid >= 1.5 * mean(grid); low_dip if grid <= 0.5 * mean
  * recommendations: peak share >= 35%; solar export share >= 10%; spend review
  * tariff bill = peak*peak_rate + shoulder*shoulder_rate + offpeak*offpeak_rate
                 - solar*export_credit
  * compare: delta_kwh = right.grid - left.grid; shared_days = |days ∩ days|
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

VERSION = "0.3.0"

DEFAULT_TARIFF: dict[str, float] = {
    "peak": 0.40,
    "shoulder": 0.28,
    "offpeak": 0.18,
    "export_credit": 0.08,
}

TIER_SPLIT = {"peak": 0.44, "shoulder": 0.34, "offpeak": 0.22}

HIGH_SPIKE_RATIO = 1.5
LOW_DIP_RATIO = 0.5
PEAK_SHARE_FLAG = 35.0
PEAK_SHARE_HIGH = 45.0
SOLAR_OFFSET_FLAG = 10.0
SOLAR_OFFSET_HIGH = 20.0
SPEND_HIGH = 8.0
SPEND_MEDIUM = 5.0

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

DATE_CANDIDATES = ("day", "date", "reading_date", "timestamp", "meter_date")
HOUSEHOLD_CANDIDATES = (
    "household_id",
    "account_id",
    "site_id",
    "meter_id",
    "customer_id",
)
NEIGHBOURHOOD_CANDIDATES = (
    "neighbourhood",
    "neighborhood",
    "suburb",
    "area",
    "region",
)
PEAK_CANDIDATES = ("peak_kwh", "peak", "peak_usage_kwh")
SHOULDER_CANDIDATES = ("shoulder_kwh", "shoulder", "shoulder_usage_kwh")
OFFPEAK_CANDIDATES = ("offpeak_kwh", "off_peak_kwh", "offpeak", "off_peak")
SOLAR_CANDIDATES = ("solar_export_kwh", "solar_kwh", "export_kwh", "solar_export")
GRID_CANDIDATES = (
    "grid_import_kwh",
    "import_kwh",
    "grid_kwh",
    "usage_kwh",
    "consumption_kwh",
)
TOTAL_CANDIDATES = ("total_kwh", "consumed_kwh", "energy_kwh", "kwh")
BILL_CANDIDATES = ("estimated_bill", "bill", "cost", "amount", "charge")
HOUR_CANDIDATES = ("hour", "interval_hour", "tod_hour", "hour_of_day")


class GridScopeError(ValueError):
    """User-facing parse or analysis error."""


def normalise_key(value: Any) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower())
    return text.strip("_")


def pick_column(headers: list[str], candidates: Iterable[str]) -> int:
    for candidate in candidates:
        try:
            return headers.index(candidate)
        except ValueError:
            continue
    return -1


def to_number(value: Any) -> float:
    cleaned = re.sub(r"[$,\s]", "", str(value or ""))
    if cleaned == "":
        return 0.0
    try:
        parsed = float(cleaned)
    except ValueError:
        return 0.0
    return parsed if parsed == parsed else 0.0  # NaN check


def optional_number(value: Any) -> float | None:
    cleaned = re.sub(r"[$,\s]", "", str(value or ""))
    if cleaned == "":
        return None
    try:
        parsed = float(cleaned)
    except ValueError:
        return None
    return parsed if parsed == parsed else None


def parse_date_and_hour(value: Any) -> tuple[date | None, int | None]:
    raw = str(value or "").strip()
    if not raw:
        return None, None

    hour: int | None = None
    iso = re.match(
        r"^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{1,2})(?::(\d{2}))?(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?",
        raw,
    )
    if iso:
        try:
            parsed = date.fromisoformat(iso.group(1))
        except ValueError:
            parsed = None
        if iso.group(2) is not None:
            hour = max(0, min(23, int(iso.group(2))))
        return parsed, hour

    parts = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[T\s](\d{1,2}))?", raw)
    if parts:
        first = int(parts.group(1))
        second = int(parts.group(2))
        year_raw = parts.group(3)
        year = int(year_raw) + 2000 if len(year_raw) == 2 else int(year_raw)
        day_n = first if first > 12 else second
        month_n = second if first > 12 else first
        try:
            parsed = date(year, month_n, day_n)
        except ValueError:
            parsed = None
        if parts.group(4) is not None:
            hour = max(0, min(23, int(parts.group(4))))
        return parsed, hour

    try:
        stamp = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return stamp.date(), stamp.hour
    except ValueError:
        return None, None


def month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def weekday_name(value: date) -> str:
    return WEEKDAYS[value.weekday()]


def iso_day(value: date) -> str:
    return value.isoformat()


def coerce_tariff(tariff: Mapping[str, Any] | None = None) -> dict[str, float]:
    source = DEFAULT_TARIFF if tariff is None else tariff
    result: dict[str, float] = {}
    aliases = {
        "peak": ("peak", "peak_rate"),
        "shoulder": ("shoulder", "shoulder_rate"),
        "offpeak": ("offpeak", "off_peak", "offpeak_rate"),
        "export_credit": ("export_credit", "exportCredit", "export", "feed_in"),
    }
    for key, names in aliases.items():
        raw = None
        for name in names:
            if name in source and source[name] is not None and source[name] != "":
                raw = source[name]
                break
        parsed = to_number(raw if raw is not None else DEFAULT_TARIFF[key])
        if raw is None:
            parsed = DEFAULT_TARIFF[key]
        result[key] = parsed if parsed >= 0 else 0.0
    return result


def parse_csv_rows(text: str) -> list[list[str]]:
    cleaned = text.replace("\ufeff", "")
    reader = csv.reader(io.StringIO(cleaned))
    rows: list[list[str]] = []
    for row in reader:
        if any(str(cell).strip() != "" for cell in row):
            rows.append([str(cell) for cell in row])
    return rows


def parse_energy_csv(text: str) -> list[dict[str, Any]]:
    """Parse CSV text into normalised reading dicts."""
    parsed = parse_csv_rows(text)
    if len(parsed) < 2:
        raise GridScopeError("The CSV needs a header row and at least one data row.")

    headers = [normalise_key(value) for value in parsed[0]]
    col = {
        "day": pick_column(headers, DATE_CANDIDATES),
        "household": pick_column(headers, HOUSEHOLD_CANDIDATES),
        "neighbourhood": pick_column(headers, NEIGHBOURHOOD_CANDIDATES),
        "peak": pick_column(headers, PEAK_CANDIDATES),
        "shoulder": pick_column(headers, SHOULDER_CANDIDATES),
        "offpeak": pick_column(headers, OFFPEAK_CANDIDATES),
        "solar": pick_column(headers, SOLAR_CANDIDATES),
        "grid": pick_column(headers, GRID_CANDIDATES),
        "total": pick_column(headers, TOTAL_CANDIDATES),
        "bill": pick_column(headers, BILL_CANDIDATES),
        "hour": pick_column(headers, HOUR_CANDIDATES),
    }

    if col["day"] == -1:
        raise GridScopeError(
            "Add a date column named day, date, reading_date, or timestamp."
        )

    has_tiered = col["peak"] != -1 or col["shoulder"] != -1 or col["offpeak"] != -1
    has_total = col["grid"] != -1 or col["total"] != -1
    if not has_tiered and not has_total:
        raise GridScopeError(
            "Add energy columns such as grid_import_kwh, total_kwh, "
            "peak_kwh, shoulder_kwh, or offpeak_kwh."
        )

    rows: list[dict[str, Any]] = []
    for raw in parsed[1:]:
        # Pad short rows so column lookups stay safe.
        if len(raw) < len(headers):
            raw = raw + [""] * (len(headers) - len(raw))

        parsed_date, parsed_hour = parse_date_and_hour(raw[col["day"]])
        if parsed_date is None:
            continue

        hour = parsed_hour
        if col["hour"] != -1:
            hour_value = optional_number(raw[col["hour"]])
            if hour_value is not None:
                hour = int(max(0, min(23, hour_value)))

        if col["total"] != -1:
            supplied_total = to_number(raw[col["total"]])
        elif col["grid"] != -1:
            supplied_total = to_number(raw[col["grid"]])
        else:
            supplied_total = 0.0

        peak = to_number(raw[col["peak"]]) if col["peak"] != -1 else 0.0
        shoulder = to_number(raw[col["shoulder"]]) if col["shoulder"] != -1 else 0.0
        offpeak = to_number(raw[col["offpeak"]]) if col["offpeak"] != -1 else 0.0

        if not has_tiered and supplied_total > 0:
            peak = supplied_total * TIER_SPLIT["peak"]
            shoulder = supplied_total * TIER_SPLIT["shoulder"]
            offpeak = supplied_total * TIER_SPLIT["offpeak"]

        consumed = peak + shoulder + offpeak
        solar = to_number(raw[col["solar"]]) if col["solar"] != -1 else 0.0
        if col["grid"] != -1:
            grid = to_number(raw[col["grid"]])
        else:
            grid = max(0.0, consumed - solar)

        bill = optional_number(raw[col["bill"]]) if col["bill"] != -1 else None
        household = (
            str(raw[col["household"]]).strip()
            if col["household"] != -1 and str(raw[col["household"]]).strip()
            else "Unknown"
        )
        neighbourhood = (
            str(raw[col["neighbourhood"]]).strip()
            if col["neighbourhood"] != -1 and str(raw[col["neighbourhood"]]).strip()
            else "Ungrouped"
        )

        rows.append(
            {
                "day": iso_day(parsed_date),
                "month": month_key(parsed_date),
                "weekday": weekday_name(parsed_date),
                "hour": hour,
                "household": household,
                "neighbourhood": neighbourhood,
                "peak": peak,
                "shoulder": shoulder,
                "offpeak": offpeak,
                "solar": solar,
                "grid": grid,
                "bill": bill,
                "consumed": consumed,
            }
        )

    if not rows:
        raise GridScopeError("No valid dated rows were found.")
    return rows


def load_csv(path: str | Path) -> list[dict[str, Any]]:
    file_path = Path(path)
    if not file_path.is_file():
        raise GridScopeError(f"File not found: {file_path}")
    try:
        text = file_path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = file_path.read_text(encoding="latin-1")
    return parse_energy_csv(text)


def households_of(rows: Iterable[Mapping[str, Any]]) -> list[str]:
    seen: list[str] = []
    for row in rows:
        name = str(row.get("household") or "Unknown")
        if name not in seen:
            seen.append(name)
    return seen


def filter_household(
    rows: Iterable[Mapping[str, Any]], household: str | None
) -> list[dict[str, Any]]:
    materialised = [dict(row) for row in rows]
    if not household or household == "all":
        return materialised
    return [row for row in materialised if row.get("household") == household]


def _sum(rows: Iterable[Mapping[str, Any]], key: str) -> float:
    return float(sum(float(row.get(key) or 0) for row in rows))


def row_tariff_bill(row: Mapping[str, Any], tariff: Mapping[str, float]) -> float:
    return (
        float(row.get("peak") or 0) * tariff["peak"]
        + float(row.get("shoulder") or 0) * tariff["shoulder"]
        + float(row.get("offpeak") or 0) * tariff["offpeak"]
        - float(row.get("solar") or 0) * tariff["export_credit"]
    )


def estimate_bill(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
) -> float:
    rates = coerce_tariff(tariff)
    return sum(row_tariff_bill(row, rates) for row in rows)


def _aggregate(rows: Iterable[Mapping[str, Any]], key_fn) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = key_fn(row)
        if key not in groups:
            groups[key] = {
                "key": key,
                "records": 0,
                "households": set(),
                "peak": 0.0,
                "shoulder": 0.0,
                "offpeak": 0.0,
                "solar": 0.0,
                "grid": 0.0,
                "bill": 0.0,
                "bill_rows": 0,
                "consumed": 0.0,
                "tariff_bill": 0.0,
            }
        group = groups[key]
        group["records"] += 1
        group["households"].add(row.get("household") or "Unknown")
        for field in ("peak", "shoulder", "offpeak", "solar", "grid", "consumed"):
            group[field] += float(row.get(field) or 0)
        if row.get("bill") is not None:
            group["bill"] += float(row["bill"])
            group["bill_rows"] += 1
    result = []
    for group in groups.values():
        item = dict(group)
        item["households"] = len(group["households"])
        item["bill"] = group["bill"] if group["bill_rows"] > 0 else None
        result.append(item)
    return result


def get_anomalies(rows: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    avg_grid = _sum(rows, "grid") / len(rows)
    flagged: list[dict[str, Any]] = []
    for row in rows:
        grid = float(row.get("grid") or 0)
        pct = (grid / avg_grid) * 100 if avg_grid > 0 else 0.0
        if grid >= avg_grid * HIGH_SPIKE_RATIO:
            anomaly_type = "high_spike"
        elif grid <= avg_grid * LOW_DIP_RATIO:
            anomaly_type = "low_dip"
        else:
            continue
        flagged.append(
            {
                "day": row.get("day"),
                "neighbourhood": row.get("neighbourhood"),
                "household": row.get("household"),
                "grid": grid,
                "consumed": float(row.get("consumed") or 0),
                "bill": row.get("bill"),
                "pct_of_average": pct,
                "anomaly_type": anomaly_type,
            }
        )
    flagged.sort(
        key=lambda item: (-abs(item["grid"] - avg_grid), str(item["day"]))
    )
    return flagged


def _format_number(value: float, digits: int = 1) -> str:
    return f"{value:,.{digits}f}"


def _format_money(value: float) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"


def get_recommendations(totals: Mapping[str, Any]) -> list[dict[str, str]]:
    recommendations: list[dict[str, str]] = []
    consumed = float(totals.get("consumed") or 0)
    peak_share = (float(totals.get("peak") or 0) / consumed) * 100 if consumed else 0.0
    solar_offset = (float(totals.get("solar") or 0) / consumed) * 100 if consumed else 0.0
    days = int(totals.get("days") or 0)
    csv_bill = totals.get("bill")
    tariff_bill = totals.get("tariff_bill")
    spend = csv_bill if csv_bill is not None else tariff_bill
    spend_label = "bill" if csv_bill is not None else "tariff bill"

    if peak_share >= PEAK_SHARE_FLAG:
        recommendations.append(
            {
                "opportunity": "Shift peak usage",
                "detail": (
                    f"Peak is {_format_number(peak_share)}% of consumption. "
                    "Moving 10% of peak into off-peak could reduce demand charges."
                ),
                "impact": "high" if peak_share >= PEAK_SHARE_HIGH else "medium",
            }
        )

    if solar_offset >= SOLAR_OFFSET_FLAG:
        recommendations.append(
            {
                "opportunity": "Increase solar self-consumption",
                "detail": (
                    f"Solar exports are {_format_number(solar_offset)}% of consumption. "
                    "Battery or load shifting could capture more value."
                ),
                "impact": "high" if solar_offset >= SOLAR_OFFSET_HIGH else "medium",
            }
        )

    if spend is not None and days > 0:
        avg_daily = float(spend) / days
        if avg_daily >= SPEND_HIGH:
            impact = "high"
        elif avg_daily >= SPEND_MEDIUM:
            impact = "medium"
        else:
            impact = "low"
        recommendations.append(
            {
                "opportunity": "Review estimated spend",
                "detail": (
                    f"Average daily {spend_label} is {_format_money(avg_daily)} "
                    f"across {_format_number(days, 0)} days."
                ),
                "impact": impact,
            }
        )

    return recommendations


def weekday_heatmap(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    materialised = list(rows)
    has_hour = any(row.get("hour") is not None for row in materialised)
    if has_hour:
        axis = "hour"
        buckets = [f"{hour:02d}" for hour in range(24)]

        def bucket_of(row: Mapping[str, Any]) -> str | None:
            hour = row.get("hour")
            if hour is None:
                return None
            return f"{int(hour):02d}"

    else:
        axis = "month"
        buckets = sorted({str(row.get("month")) for row in materialised})

        def bucket_of(row: Mapping[str, Any]) -> str | None:
            return str(row.get("month")) if row.get("month") else None

    cells: list[dict[str, Any]] = []
    max_grid = 0.0
    for weekday in WEEKDAYS:
        for bucket in buckets:
            grid = 0.0
            records = 0
            for row in materialised:
                if row.get("weekday") != weekday:
                    continue
                if bucket_of(row) != bucket:
                    continue
                grid += float(row.get("grid") or 0)
                records += 1
            max_grid = max(max_grid, grid)
            cells.append(
                {
                    "weekday": weekday,
                    "bucket": bucket,
                    "grid": grid,
                    "records": records,
                }
            )

    return {
        "axis": axis,
        "buckets": buckets,
        "weekdays": list(WEEKDAYS),
        "cells": cells,
        "max_grid": max_grid,
    }


def get_totals(
    rows: list[Mapping[str, Any]], tariff: Mapping[str, float]
) -> dict[str, Any]:
    bill_values = [float(row["bill"]) for row in rows if row.get("bill") is not None]
    return {
        "records": len(rows),
        "days": len({row.get("day") for row in rows}),
        "households": len({row.get("household") for row in rows}),
        "grid": _sum(rows, "grid"),
        "solar": _sum(rows, "solar"),
        "consumed": _sum(rows, "consumed"),
        "peak": _sum(rows, "peak"),
        "shoulder": _sum(rows, "shoulder"),
        "offpeak": _sum(rows, "offpeak"),
        "bill": sum(bill_values) if bill_values else None,
        "tariff_bill": estimate_bill(rows, tariff),
        "first_day": min((row["day"] for row in rows), default=None),
        "last_day": max((row["day"] for row in rows), default=None),
    }


def get_analysis(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
    household: str | None = None,
) -> dict[str, Any]:
    rates = coerce_tariff(tariff)
    filtered = filter_household(rows, household)
    monthly = _aggregate(filtered, lambda row: row["month"])
    monthly.sort(key=lambda item: item["key"])
    for item in monthly:
        month_rows = [row for row in filtered if row["month"] == item["key"]]
        item["tariff_bill"] = estimate_bill(month_rows, rates)

    groups = _aggregate(filtered, lambda row: row["neighbourhood"])
    groups.sort(key=lambda item: (-item["grid"], item["key"]))
    for item in groups:
        group_rows = [
            row for row in filtered if row["neighbourhood"] == item["key"]
        ]
        item["tariff_bill"] = estimate_bill(group_rows, rates)

    totals = get_totals(filtered, rates)
    return {
        "rows": filtered,
        "monthly": monthly,
        "groups": groups,
        "anomalies": get_anomalies(filtered),
        "recommendations": get_recommendations(totals),
        "totals": totals,
        "heatmap": weekday_heatmap(filtered),
        "tariff": rates,
        "households": households_of(filtered),
        "household": household or "all",
    }


def compare_datasets(
    left: Iterable[Mapping[str, Any]],
    right: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    rates = coerce_tariff(tariff)
    left_rows = [dict(row) for row in left]
    right_rows = [dict(row) for row in right]
    if not left_rows or not right_rows:
        raise GridScopeError("Compare needs two non-empty datasets.")

    left_days = {row["day"] for row in left_rows}
    right_days = {row["day"] for row in right_rows}
    shared = sorted(left_days & right_days)

    left_totals = get_totals(left_rows, rates)
    right_totals = get_totals(right_rows, rates)
    left_shared = [row for row in left_rows if row["day"] in set(shared)]
    right_shared = [row for row in right_rows if row["day"] in set(shared)]
    left_shared_totals = get_totals(left_shared, rates) if left_shared else None
    right_shared_totals = get_totals(right_shared, rates) if right_shared else None

    def delta(right_value: float | None, left_value: float | None) -> float | None:
        if right_value is None or left_value is None:
            return None
        return right_value - left_value

    return {
        "shared_days": len(shared),
        "shared_day_list": shared,
        "delta_kwh": right_totals["grid"] - left_totals["grid"],
        "delta_bill": right_totals["tariff_bill"] - left_totals["tariff_bill"],
        "delta_csv_bill": delta(right_totals["bill"], left_totals["bill"]),
        "shared_delta_kwh": (
            right_shared_totals["grid"] - left_shared_totals["grid"]
            if left_shared_totals and right_shared_totals
            else 0.0
        ),
        "shared_delta_bill": (
            right_shared_totals["tariff_bill"] - left_shared_totals["tariff_bill"]
            if left_shared_totals and right_shared_totals
            else 0.0
        ),
        "left": left_totals,
        "right": right_totals,
    }


def _round_optional(value: Any, digits: int) -> float | None:
    if value is None:
        return None
    return round(float(value), digits)


def analysis_table(analysis: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Monthly analysis table used by CSV export."""
    table: list[dict[str, Any]] = []
    for item in analysis.get("monthly") or []:
        table.append(
            {
                "month": item["key"],
                "records": item["records"],
                "households": item["households"],
                "grid_kwh": round(float(item["grid"]), 3),
                "solar_kwh": round(float(item["solar"]), 3),
                "consumed_kwh": round(float(item["consumed"]), 3),
                "peak_kwh": round(float(item["peak"]), 3),
                "shoulder_kwh": round(float(item["shoulder"]), 3),
                "offpeak_kwh": round(float(item["offpeak"]), 3),
                "csv_bill": _round_optional(item["bill"], 2),
                "tariff_bill": _round_optional(item.get("tariff_bill"), 2),
            }
        )
    return table


def table_to_csv(rows: list[Mapping[str, Any]]) -> str:
    if not rows:
        return ""
    fieldnames = list(rows[0].keys())
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: row.get(key, "") for key in fieldnames})
    return buffer.getvalue()


def serialise_analysis(analysis: Mapping[str, Any]) -> dict[str, Any]:
    """JSON-safe analysis payload (no per-row dump unless small)."""
    return {
        "generated_by": f"gridscope {VERSION}",
        "tariff": analysis.get("tariff"),
        "household": analysis.get("household"),
        "households": analysis.get("households"),
        "totals": analysis.get("totals"),
        "monthly": analysis.get("monthly"),
        "groups": analysis.get("groups"),
        "anomalies": analysis.get("anomalies"),
        "recommendations": analysis.get("recommendations"),
        "heatmap": analysis.get("heatmap"),
    }
