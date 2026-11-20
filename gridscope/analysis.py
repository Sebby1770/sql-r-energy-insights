"""GridScope analysis engine (source of truth).

Formulas mirrored in assets/analysis.js for the browser upload UI.
Keep both copies aligned when changing parse rules or math.

  * Untiered split: peak 0.44 / shoulder 0.34 / off-peak 0.22 of supplied total
  * NEM12 interval files (gridscope/nem12.py): hourly rows, import tiered by the
    TOU windows below (tier_source "interval"), export as solar
  * consumed = peak + shoulder + off-peak
  * grid = supplied grid else max(0, consumed - solar)
  * anomalies are scored on household-day totals (intervals summed per day):
      baseline window = that household's days within +/- 15 days (whole history
        when the window holds < 7 days)
      household with >= 4 days, window >= 7 days and MAD > 0:
        modified z = 0.6745 * (x - window median) / window MAD, flag |z| >= 3.5 ("mad")
      household with >= 4 days otherwise: ratio to the window median ("ratio")
      otherwise: ratio to the median of every household-day (baseline "global")
      ratio rule: high_spike if x >= 1.5 * baseline; low_dip if x <= 0.5 * baseline
  * recommendations: peak share >= 35%; solar export share >= 10%; plan switch
    when a named plan beats the current tariff; spend review
    Each rec has saving_aud; sort descending
  * battery what-if: per household, rows in time order; charge from export up to
    capacity, deliver soc * efficiency into import (peak, then shoulder, then
    off-peak); saving = bill(before) - bill(after); annual = saving * 365 / days
  * energy = peak*peak_rate + shoulder*shoulder_rate + offpeak*offpeak_rate
  * export = solar * export_credit
  * ex_gst = energy + daily_supply * distinct_days - export
  * tariff bill (inc GST) = ex_gst * (1 + gst)
  * compare: delta_kwh = right.grid - left.grid; shared_days = |days ∩ days|
    join household+day when both sides have >1 household, else day
  * optional TOU: weekend off-peak; weekday 14-19 peak; 7-13 and 20-21 shoulder
    never retier rows whose tiers came from CSV peak/shoulder/offpeak columns
  * coverage: unique days vs first–last span; list missing days only when dense
  * totals peak_share / solar_share = 100 * peak|solar / consumed (else 0)
  * totals cost_per_kwh = tariff_bill / consumed (else None)
  * weekend_split: Sat/Sun vs rest; unique days, consumed kWh, GST-inclusive bills
  * data_quality: duplicate (household, day, hour) keys; negative peak/shoulder/offpeak/grid/solar;
    zero grid; estimated/substituted and missing NEM12 intervals
  * shift_peak: copy rows, move fraction * peak into off-peak; consumed unchanged
  * what_if_peak_shift: baseline vs shifted GST-inclusive bills and saving_aud
  * what_if_solar_self: fraction * solar * max(0, shoulder - export) * (1+gst); does not mutate rows
  * dedupe_rows: sum energy (+ bill when both present) for duplicate (household, day, hour) keys
  * groups kwh_per_household = grid / households (else None)
  * compare monthly_delta: shared month keys, delta_kwh = right.grid - left.grid
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping

VERSION = "0.9.0"

DEFAULT_TARIFF: dict[str, float] = {
    "peak": 0.40,
    "shoulder": 0.28,
    "offpeak": 0.18,
    "export_credit": 0.08,
    "daily_supply": 1.10,
    "gst": 0.10,
}

DEFAULT_PLANS: list[dict[str, Any]] = [
    {
        "name": "Flex Saver",
        "peak": 0.40,
        "shoulder": 0.28,
        "offpeak": 0.18,
        "export_credit": 0.08,
        "daily_supply": 1.10,
    },
    {
        "name": "Solar Plus",
        "peak": 0.38,
        "shoulder": 0.27,
        "offpeak": 0.17,
        "export_credit": 0.12,
        "daily_supply": 1.35,
    },
    {
        "name": "Flat Comfort",
        "peak": 0.32,
        "shoulder": 0.32,
        "offpeak": 0.32,
        "export_credit": 0.05,
        "daily_supply": 1.60,
    },
]

TIER_SPLIT = {"peak": 0.44, "shoulder": 0.34, "offpeak": 0.22}

HIGH_SPIKE_RATIO = 1.5
LOW_DIP_RATIO = 0.5
PEAK_SHARE_FLAG = 35.0
PEAK_SHARE_HIGH = 45.0
SOLAR_OFFSET_FLAG = 10.0
SOLAR_OFFSET_HIGH = 20.0
SPEND_HIGH = 8.0
SPEND_MEDIUM = 5.0
HOUSEHOLD_BASELINE_MIN_ROWS = 4
MAD_MIN_DAYS = 7
ANOMALY_WINDOW_DAYS = 15
MAD_Z_THRESHOLD = 3.5
MAD_SCALE = 0.6745
PLAN_SWITCH_HIGH = 0.10
PLAN_SWITCH_MEDIUM = 0.03

DEFAULT_BATTERY: dict[str, float] = {"capacity_kwh": 10.0, "efficiency": 0.90}

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
TOU_WEEKEND = {"Sat", "Sun"}

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
TIME_CANDIDATES = ("time", "interval_time", "start_time", "read_time", "interval_start")


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


def parse_hour_value(value: Any) -> int | None:
    """Hour of day from ``13``, ``13.0``, ``13:30``, ``13:30:00`` or ``1:30 pm``."""
    raw = str(value or "").strip().lower()
    if raw == "":
        return None
    match = re.match(r"^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$", raw)
    if match:
        hour = int(match.group(1))
        meridiem = match.group(3)
        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
        return hour if 0 <= hour <= 23 else None
    number = optional_number(raw)
    if number is None:
        return None
    return int(max(0, min(23, number)))


def _normalise_date_order(date_order: str | None) -> str:
    order = str(date_order or "dmy").strip().lower()
    if order not in ("dmy", "mdy", "auto"):
        return "dmy"
    return order


def parse_date_and_hour(
    value: Any, date_order: str = "dmy"
) -> tuple[date | None, int | None]:
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
        order = _normalise_date_order(date_order)
        if first > 12:
            day_n, month_n = first, second
        elif second > 12:
            day_n, month_n = second, first
        elif order == "mdy":
            month_n, day_n = first, second
        elif order == "auto":
            day_n, month_n = second, first
        else:
            day_n, month_n = first, second
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
        "daily_supply": ("daily_supply", "supply", "daily", "dailySupply"),
        "gst": ("gst", "gst_rate", "gstRate"),
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


def parse_energy_csv(text: str, date_order: str = "dmy") -> list[dict[str, Any]]:
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
        "time": pick_column(headers, TIME_CANDIDATES),
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

    order = _normalise_date_order(date_order)
    rows: list[dict[str, Any]] = []
    for raw in parsed[1:]:
        # Pad short rows so column lookups stay safe.
        if len(raw) < len(headers):
            raw = raw + [""] * (len(headers) - len(raw))

        parsed_date, parsed_hour = parse_date_and_hour(raw[col["day"]], order)
        if parsed_date is None:
            continue

        hour = parsed_hour
        for hour_col in (col["time"], col["hour"]):
            if hour_col != -1:
                hour_value = parse_hour_value(raw[hour_col])
                if hour_value is not None:
                    hour = hour_value

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
                "tier_source": "csv" if has_tiered else "split",
            }
        )

    if not rows:
        raise GridScopeError("No valid dated rows were found.")
    return rows


def detect_format(text: str) -> str:
    """``nem12`` for AEMO interval files, otherwise ``csv``."""
    from gridscope.nem12 import looks_like_nem12

    return "nem12" if looks_like_nem12(text) else "csv"


def parse_energy_text_details(
    text: str, date_order: str = "dmy"
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Parse either a NEM12 interval file or a column CSV, plus a source summary."""
    if detect_format(text) == "nem12":
        from gridscope.nem12 import parse_nem12_details

        return parse_nem12_details(text)
    rows = parse_energy_csv(text, date_order=date_order)
    return rows, {
        "format": "csv",
        "nmis": [],
        "channels": [],
        "interval_minutes": None,
        "skipped_channels": [],
        "interval_days": 0,
    }


def parse_energy_text(text: str, date_order: str = "dmy") -> list[dict[str, Any]]:
    rows, _ = parse_energy_text_details(text, date_order=date_order)
    return rows


def read_text_file(path: str | Path) -> str:
    file_path = Path(path)
    if not file_path.is_file():
        raise GridScopeError(f"File not found: {file_path}")
    try:
        return file_path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="latin-1")


def load_csv(path: str | Path, date_order: str = "dmy") -> list[dict[str, Any]]:
    """Load a column CSV or a NEM12 interval file (detected from its first line)."""
    return parse_energy_text(read_text_file(path), date_order=date_order)


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


def tou_bucket(weekday: str, hour: int) -> str:
    if weekday in TOU_WEEKEND:
        return "offpeak"
    if 14 <= hour <= 19:
        return "peak"
    if 7 <= hour <= 13 or hour in (20, 21):
        return "shoulder"
    return "offpeak"


def apply_tou(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Retier grid (or consumed) into peak/shoulder/off-peak from weekday hour.

    Rows that already have CSV peak/shoulder/off-peak columns are left alone.
    If no row has an hour, the list is returned unchanged.
    """
    materialised = [dict(row) for row in rows]
    if not materialised:
        return materialised
    if all(row.get("hour") is None for row in materialised):
        return materialised

    result: list[dict[str, Any]] = []
    for row in materialised:
        if row.get("tier_source") in ("csv", "interval") or row.get("hour") is None:
            result.append(row)
            continue
        hour = int(row["hour"])
        grid_value = row.get("grid")
        if grid_value is None:
            energy = float(row.get("consumed") or 0)
        else:
            energy = float(grid_value or 0)
        bucket = tou_bucket(str(row.get("weekday") or ""), hour)
        peak = shoulder = offpeak = 0.0
        if bucket == "peak":
            peak = energy
        elif bucket == "shoulder":
            shoulder = energy
        else:
            offpeak = energy
        row["peak"] = peak
        row["shoulder"] = shoulder
        row["offpeak"] = offpeak
        row["consumed"] = peak + shoulder + offpeak
        result.append(row)
    return result


def calendar_coverage(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Summarise unique days versus the first–last calendar span."""
    unique_days = sorted(
        {str(row["day"]) for row in rows if row.get("day")}
    )
    recorded = len(unique_days)
    if recorded == 0:
        return {
            "recorded": 0,
            "first": None,
            "last": None,
            "span_days": 0,
            "density": 0.0,
            "kind": "short",
            "missing_days": [],
            "missing_count": 0,
        }

    first = unique_days[0]
    last = unique_days[-1]
    first_d = date.fromisoformat(first)
    last_d = date.fromisoformat(last)
    span_days = (last_d - first_d).days + 1
    density = recorded / span_days if span_days else 0.0
    missing_count = span_days - recorded
    if recorded < 2:
        kind = "short"
    elif density >= 0.7:
        kind = "daily"
    else:
        kind = "sparse"

    missing_days: list[str] = []
    if kind == "daily" and missing_count:
        recorded_set = set(unique_days)
        cursor = first_d
        while cursor <= last_d:
            iso = cursor.isoformat()
            if iso not in recorded_set:
                missing_days.append(iso)
                if len(missing_days) >= 60:
                    break
            cursor += timedelta(days=1)

    return {
        "recorded": recorded,
        "first": first,
        "last": last,
        "span_days": span_days,
        "density": density,
        "kind": kind,
        "missing_days": missing_days,
        "missing_count": missing_count,
    }


def row_tariff_bill(row: Mapping[str, Any], tariff: Mapping[str, float]) -> float:
    return (
        float(row.get("peak") or 0) * tariff["peak"]
        + float(row.get("shoulder") or 0) * tariff["shoulder"]
        + float(row.get("offpeak") or 0) * tariff["offpeak"]
        - float(row.get("solar") or 0) * tariff["export_credit"]
    )


def _bill_components(
    rows: Iterable[Mapping[str, Any]], rates: Mapping[str, float]
) -> dict[str, float]:
    materialised = list(rows)
    energy = (
        _sum(materialised, "peak") * rates["peak"]
        + _sum(materialised, "shoulder") * rates["shoulder"]
        + _sum(materialised, "offpeak") * rates["offpeak"]
    )
    export = _sum(materialised, "solar") * rates["export_credit"]
    days = len({row.get("day") for row in materialised})
    supply = rates["daily_supply"] * days
    ex_gst = energy + supply - export
    gst_amount = ex_gst * rates["gst"]
    return {
        "energy": energy,
        "export": export,
        "days": float(days),
        "supply_charge": supply,
        "tariff_bill_ex_gst": ex_gst,
        "gst_amount": gst_amount,
        "tariff_bill": ex_gst * (1.0 + rates["gst"]),
    }


def estimate_bill(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
) -> float:
    rates = coerce_tariff(tariff)
    return _bill_components(rows, rates)["tariff_bill"]


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


def median(values: Iterable[float]) -> float | None:
    ordered = sorted(float(value) for value in values)
    count = len(ordered)
    if count == 0:
        return None
    middle = count // 2
    if count % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def daily_totals(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """One entry per (household, day): grid/solar/consumed summed over its rows.

    Interval files carry many rows per day; daily CSVs carry one, so for them
    this is the identity. Sorted by household, then day.
    """
    totals: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        household = str(row.get("household") or "Unknown")
        day = str(row.get("day") or "")
        key = (household, day)
        if key not in totals:
            totals[key] = {
                "day": day,
                "household": household,
                "neighbourhood": row.get("neighbourhood") or "Ungrouped",
                "grid": 0.0,
                "solar": 0.0,
                "consumed": 0.0,
                "bill": None,
            }
        item = totals[key]
        item["grid"] += float(row.get("grid") or 0)
        item["solar"] += float(row.get("solar") or 0)
        item["consumed"] += float(row.get("consumed") or 0)
        if row.get("bill") is not None:
            item["bill"] = (item["bill"] or 0.0) + float(row["bill"])
    return [totals[key] for key in sorted(totals)]


def daily_series(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Grid, solar and consumed kWh per calendar day across every household."""
    by_day: dict[str, dict[str, Any]] = {}
    for item in daily_totals(rows):
        day = item["day"]
        if day not in by_day:
            by_day[day] = {"day": day, "grid": 0.0, "solar": 0.0, "consumed": 0.0}
        for field in ("grid", "solar", "consumed"):
            by_day[day][field] += item[field]
    return [by_day[day] for day in sorted(by_day)]


def _ratio_type(value: float, baseline: float) -> str | None:
    if baseline <= 0:
        return None
    if value >= baseline * HIGH_SPIKE_RATIO:
        return "high_spike"
    if value <= baseline * LOW_DIP_RATIO:
        return "low_dip"
    return None


def get_anomalies(rows: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Unusual household-days, scored robustly against each household's own history.

    The median and MAD (median absolute deviation) are not dragged around by the
    spikes being hunted, unlike a mean; and scoring each household against itself
    stops a large house reading as permanently "high" next to a small one.
    """
    days = daily_totals(rows)
    if not days:
        return []
    global_median = median(item["grid"] for item in days) or 0.0
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in days:
        grouped.setdefault(item["household"], []).append(item)

    flagged: list[dict[str, Any]] = []
    for household, household_days in grouped.items():
        values = [item["grid"] for item in household_days]
        ordinals = [date.fromisoformat(item["day"]).toordinal() for item in household_days]
        count = len(values)
        for position, item in enumerate(household_days):
            grid = item["grid"]
            z_score = None
            # Seasonal baseline: the same household within +/- 15 days, so a cold
            # July is compared with July rather than with the whole year. Sparse
            # files fall back to the household's whole history.
            window = [
                values[other]
                for other in range(count)
                if abs(ordinals[other] - ordinals[position]) <= ANOMALY_WINDOW_DAYS
            ]
            if len(window) < MAD_MIN_DAYS:
                window = values
            window_median = median(window) or 0.0
            mad = None
            if len(window) >= MAD_MIN_DAYS:
                mad = median(abs(value - window_median) for value in window)
            if count >= HOUSEHOLD_BASELINE_MIN_ROWS and mad is not None and mad > 0:
                method = "mad"
                baseline = "household"
                baseline_kwh = window_median
                z_score = MAD_SCALE * (grid - window_median) / mad
                if z_score >= MAD_Z_THRESHOLD:
                    anomaly_type = "high_spike"
                elif z_score <= -MAD_Z_THRESHOLD:
                    anomaly_type = "low_dip"
                else:
                    continue
            else:
                method = "ratio"
                if count >= HOUSEHOLD_BASELINE_MIN_ROWS:
                    baseline = "household"
                    baseline_kwh = window_median
                else:
                    baseline = "global"
                    baseline_kwh = global_median
                anomaly_type = _ratio_type(grid, baseline_kwh)
                if anomaly_type is None:
                    continue
            flagged.append(
                {
                    "day": item["day"],
                    "neighbourhood": item["neighbourhood"],
                    "household": household,
                    "grid": grid,
                    "consumed": item["consumed"],
                    "bill": item["bill"],
                    "pct_of_average": (grid / baseline_kwh) * 100 if baseline_kwh > 0 else 0.0,
                    "anomaly_type": anomaly_type,
                    "baseline": baseline,
                    "baseline_kwh": baseline_kwh,
                    "method": method,
                    "z_score": z_score,
                }
            )
    flagged.sort(
        key=lambda item: (
            -abs(item["grid"] - float(item["baseline_kwh"])),
            str(item["day"]),
            str(item["household"]),
        )
    )
    return flagged


def _format_number(value: float, digits: int = 1) -> str:
    return f"{value:,.{digits}f}"


def _format_money(value: float) -> str:
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"


def get_recommendations(
    totals: Mapping[str, Any],
    tariff: Mapping[str, Any] | None = None,
    plans: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    recommendations: list[dict[str, Any]] = []
    rates = coerce_tariff(tariff)
    consumed = float(totals.get("consumed") or 0)
    peak_kwh = float(totals.get("peak") or 0)
    solar_kwh = float(totals.get("solar") or 0)
    peak_share = (peak_kwh / consumed) * 100 if consumed else 0.0
    solar_offset = (solar_kwh / consumed) * 100 if consumed else 0.0
    days = int(totals.get("days") or 0)
    csv_bill = totals.get("bill")
    tariff_bill = totals.get("tariff_bill")
    spend = csv_bill if csv_bill is not None else tariff_bill
    spend_label = "bill" if csv_bill is not None else "tariff bill"
    gst_factor = 1.0 + rates["gst"]

    if peak_share >= PEAK_SHARE_FLAG:
        saving = 0.10 * peak_kwh * (rates["peak"] - rates["offpeak"]) * gst_factor
        recommendations.append(
            {
                "opportunity": "Shift peak usage",
                "detail": (
                    f"Peak is {_format_number(peak_share)}% of consumption. "
                    "Moving 10% of peak into off-peak could save "
                    f"{_format_money(saving)}."
                ),
                "impact": "high" if peak_share >= PEAK_SHARE_HIGH else "medium",
                "saving_aud": saving,
            }
        )

    if solar_offset >= SOLAR_OFFSET_FLAG:
        spread = max(0.0, rates["shoulder"] - rates["export_credit"])
        saving = 0.50 * solar_kwh * spread * gst_factor
        recommendations.append(
            {
                "opportunity": "Increase solar self-consumption",
                "detail": (
                    f"Solar exports are {_format_number(solar_offset)}% of consumption. "
                    "Using 50% of export on-site could save "
                    f"{_format_money(saving)}."
                ),
                "impact": "high" if solar_offset >= SOLAR_OFFSET_HIGH else "medium",
                "saving_aud": saving,
            }
        )

    switch_saving = float((plans or {}).get("switch_saving") or 0)
    current_bill = float((plans or {}).get("current_bill") or 0)
    if switch_saving > 0.005 and current_bill > 0:
        share = switch_saving / current_bill
        if share >= PLAN_SWITCH_HIGH:
            impact = "high"
        elif share >= PLAN_SWITCH_MEDIUM:
            impact = "medium"
        else:
            impact = "low"
        cheapest = str((plans or {}).get("cheapest") or "the cheapest plan")
        recommendations.append(
            {
                "opportunity": f"Switch to {cheapest}",
                "detail": (
                    f"On this usage {cheapest} bills {_format_money(switch_saving)} "
                    f"less than your current tariff ({_format_number(share * 100)}%)."
                ),
                "impact": impact,
                "saving_aud": switch_saving,
            }
        )

    if spend is not None and days > 0:
        avg_daily = float(spend) / days
        projected = avg_daily * 30.0
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
                    f"across {_format_number(days, 0)} days. "
                    f"Projected 30-day cost is {_format_money(projected)}."
                ),
                "impact": impact,
                "saving_aud": 0.0,
            }
        )

    recommendations.sort(key=lambda item: (-float(item["saving_aud"]), item["opportunity"]))
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

    # One pass over the rows; interval files make the old weekday x bucket x row
    # triple loop noticeably slow.
    sums: dict[tuple[str, str], list[float]] = {}
    for row in materialised:
        bucket = bucket_of(row)
        weekday = row.get("weekday")
        if bucket is None or weekday not in WEEKDAYS:
            continue
        cell = sums.setdefault((str(weekday), bucket), [0.0, 0])
        cell[0] += float(row.get("grid") or 0)
        cell[1] += 1

    cells: list[dict[str, Any]] = []
    max_grid = 0.0
    for weekday in WEEKDAYS:
        for bucket in buckets:
            grid, records = sums.get((weekday, bucket), [0.0, 0])
            max_grid = max(max_grid, grid)
            cells.append(
                {
                    "weekday": weekday,
                    "bucket": bucket,
                    "grid": grid,
                    "records": int(records),
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
    components = _bill_components(rows, tariff)
    consumed = _sum(rows, "consumed")
    peak = _sum(rows, "peak")
    solar = _sum(rows, "solar")
    return {
        "records": len(rows),
        "days": len({row.get("day") for row in rows}),
        "households": len({row.get("household") for row in rows}),
        "grid": _sum(rows, "grid"),
        "solar": solar,
        "consumed": consumed,
        "peak": peak,
        "shoulder": _sum(rows, "shoulder"),
        "offpeak": _sum(rows, "offpeak"),
        "peak_share": (100.0 * peak / consumed) if consumed else 0.0,
        "solar_share": (100.0 * solar / consumed) if consumed else 0.0,
        "bill": sum(bill_values) if bill_values else None,
        "tariff_bill": components["tariff_bill"],
        "cost_per_kwh": (components["tariff_bill"] / consumed) if consumed else None,
        "tariff_bill_ex_gst": components["tariff_bill_ex_gst"],
        "supply_charge": components["supply_charge"],
        "gst_amount": components["gst_amount"],
        "first_day": min((row["day"] for row in rows), default=None),
        "last_day": max((row["day"] for row in rows), default=None),
    }


def weekend_split(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Weekday vs Saturday/Sunday consumed kWh and GST-inclusive bills."""
    rates = coerce_tariff(tariff)
    materialised = [dict(row) for row in rows]
    weekday_rows = [
        row for row in materialised if row.get("weekday") not in TOU_WEEKEND
    ]
    weekend_rows = [
        row for row in materialised if row.get("weekday") in TOU_WEEKEND
    ]
    return {
        "weekday_days": len({row.get("day") for row in weekday_rows}),
        "weekend_days": len({row.get("day") for row in weekend_rows}),
        "weekday_kwh": _sum(weekday_rows, "consumed"),
        "weekend_kwh": _sum(weekend_rows, "consumed"),
        "weekday_bill": estimate_bill(weekday_rows, rates) if weekday_rows else 0.0,
        "weekend_bill": estimate_bill(weekend_rows, rates) if weekend_rows else 0.0,
    }


def data_quality(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Count duplicate keys and energy issues. Never drop rows.

    A reading's key is (household, day, hour) so interval files, which carry
    one row per hour, are not reported as duplicates of themselves.
    """
    materialised = list(rows)
    counts: dict[tuple[str, str, str], int] = {}
    for row in materialised:
        key = _reading_key(row)
        counts[key] = counts.get(key, 0) + 1
    duplicate_keys = sum(1 for count in counts.values() if count > 1)
    negative_energy = 0
    zero_grid = 0
    estimated_intervals = 0
    missing_intervals = 0
    for row in materialised:
        estimated_intervals += int(row.get("estimated_intervals") or 0)
        missing_intervals += int(row.get("missing_intervals") or 0)
        energy_values = (
            float(row.get("peak") or 0),
            float(row.get("shoulder") or 0),
            float(row.get("offpeak") or 0),
            float(row.get("grid") or 0),
            float(row.get("solar") or 0),
        )
        if any(value < 0 for value in energy_values):
            negative_energy += 1
        if float(row.get("grid") or 0) == 0:
            zero_grid += 1
    return {
        "duplicate_keys": duplicate_keys,
        "negative_energy": negative_energy,
        "zero_grid": zero_grid,
        "estimated_intervals": estimated_intervals,
        "missing_intervals": missing_intervals,
    }


def _reading_key(row: Mapping[str, Any]) -> tuple[str, str, str]:
    hour = row.get("hour")
    return (
        str(row.get("household") or "Unknown"),
        str(row.get("day") or ""),
        "" if hour is None else str(int(hour)),
    )


def _clamp_fraction(fraction: Any) -> float:
    try:
        value = float(fraction)
    except (TypeError, ValueError):
        return 0.0
    if value != value:
        return 0.0
    return max(0.0, min(1.0, value))


def shift_peak(
    rows: Iterable[Mapping[str, Any]], fraction: float
) -> list[dict[str, Any]]:
    """Copy rows and move ``fraction`` of each row's peak kWh into off-peak."""
    frac = _clamp_fraction(fraction)
    shifted: list[dict[str, Any]] = []
    for row in rows:
        copied = dict(row)
        peak = float(copied.get("peak") or 0)
        moved = peak * frac
        copied["peak"] = peak - moved
        copied["offpeak"] = float(copied.get("offpeak") or 0) + moved
        copied["consumed"] = (
            copied["peak"]
            + float(copied.get("shoulder") or 0)
            + copied["offpeak"]
        )
        shifted.append(copied)
    return shifted


def what_if_peak_shift(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
    fraction: float = 0.10,
) -> dict[str, Any]:
    rates = coerce_tariff(tariff)
    materialised = [dict(row) for row in rows]
    frac = _clamp_fraction(fraction)
    baseline_bill = estimate_bill(materialised, rates)
    shifted_bill = estimate_bill(shift_peak(materialised, frac), rates)
    return {
        "fraction": frac,
        "baseline_bill": baseline_bill,
        "shifted_bill": shifted_bill,
        "saving_aud": baseline_bill - shifted_bill,
    }


def what_if_solar_self(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
    fraction: float = 0.5,
) -> dict[str, Any]:
    """Estimate GST-inclusive saving from using a fraction of solar on-site.

    Does not mutate ``rows``. Saving is
    ``fraction * total_solar * max(0, shoulder - export_credit) * (1+gst)``.
    """
    rates = coerce_tariff(tariff)
    materialised = [dict(row) for row in rows]
    frac = _clamp_fraction(fraction)
    total_solar = _sum(materialised, "solar")
    spread = max(0.0, rates["shoulder"] - rates["export_credit"])
    saving_aud = frac * total_solar * spread * (1.0 + rates["gst"])
    baseline_bill = estimate_bill(materialised, rates)
    return {
        "fraction": frac,
        "saving_aud": saving_aud,
        "baseline_bill": baseline_bill,
        "shifted_bill": baseline_bill - saving_aud,
    }


def _positive(value: Any) -> float:
    number = float(value or 0)
    return number if number > 0 else 0.0


def simulate_battery(
    rows: Iterable[Mapping[str, Any]],
    capacity_kwh: float = DEFAULT_BATTERY["capacity_kwh"],
    efficiency: float = DEFAULT_BATTERY["efficiency"],
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    """Run a home battery over the rows and return adjusted copies plus energy totals.

    Each household gets its own battery, starting empty. Rows are visited in
    time order (day, then hour); in each row the battery first charges from
    solar that would have been exported, up to its capacity, then discharges
    into grid import: peak first, then shoulder, then off-peak. Round-trip
    losses are taken on the way out (delivering x kWh drains x / efficiency).

    Daily rows therefore model "charge in the day, discharge in the evening";
    hourly and NEM12 rows carry the charge from midday into the evening peak.
    There is no power (kW) limit, which flatters very small intervals slightly.
    """
    capacity = max(0.0, float(capacity_kwh or 0))
    eff = _clamp_fraction(efficiency)
    adjusted = [dict(row) for row in rows]
    order = sorted(
        range(len(adjusted)),
        key=lambda index: (
            str(adjusted[index].get("household") or "Unknown"),
            str(adjusted[index].get("day") or ""),
            -1 if adjusted[index].get("hour") is None else int(adjusted[index]["hour"]),
            index,
        ),
    )
    state_of_charge: dict[str, float] = {}
    charged_total = 0.0
    delivered_total = 0.0
    for index in order:
        row = adjusted[index]
        household = str(row.get("household") or "Unknown")
        soc = state_of_charge.get(household, 0.0)

        export = _positive(row.get("solar"))
        charge = min(export, max(0.0, capacity - soc))
        if charge > 0:
            soc += charge
            row["solar"] = float(row.get("solar") or 0) - charge
            charged_total += charge

        if eff > 0 and soc > 0:
            tiers = {name: _positive(row.get(name)) for name in ("peak", "shoulder", "offpeak")}
            demand = min(_positive(row.get("grid")), sum(tiers.values()))
            deliver = min(soc * eff, demand)
            if deliver > 0:
                remaining = deliver
                for name in ("peak", "shoulder", "offpeak"):
                    take = min(remaining, tiers[name])
                    if take > 0:
                        row[name] = float(row.get(name) or 0) - take
                        remaining -= take
                row["grid"] = float(row.get("grid") or 0) - deliver
                soc = max(0.0, soc - deliver / eff)
                delivered_total += deliver
        state_of_charge[household] = soc

    return adjusted, {"charged_kwh": charged_total, "delivered_kwh": delivered_total}


def what_if_battery(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
    capacity_kwh: float = DEFAULT_BATTERY["capacity_kwh"],
    efficiency: float = DEFAULT_BATTERY["efficiency"],
    cost_aud: float | None = None,
) -> dict[str, Any]:
    """GST-inclusive bill saving from a home battery, annualised, with payback.

    Every household gets its own battery, so ``cost_aud`` is per battery and the
    payback uses ``cost_aud * batteries``; ``cycles`` is per battery.
    """
    rates = coerce_tariff(tariff)
    materialised = [dict(row) for row in rows]
    adjusted, energy = simulate_battery(materialised, capacity_kwh, efficiency)
    baseline_bill = estimate_bill(materialised, rates)
    battery_bill = estimate_bill(adjusted, rates)
    saving = baseline_bill - battery_bill
    days = len({row.get("day") for row in materialised})
    batteries = len({str(row.get("household") or "Unknown") for row in materialised})
    capacity = max(0.0, float(capacity_kwh or 0))
    annual_saving = saving * 365.0 / days if days else 0.0
    cost = None if cost_aud is None else max(0.0, float(cost_aud))
    total_cost = None if cost is None else cost * batteries
    payback_years = (
        total_cost / annual_saving
        if total_cost is not None and total_cost > 0 and annual_saving > 0
        else None
    )
    return {
        "capacity_kwh": capacity,
        "efficiency": _clamp_fraction(efficiency),
        "days": days,
        "batteries": batteries,
        "charged_kwh": energy["charged_kwh"],
        "delivered_kwh": energy["delivered_kwh"],
        "cycles": (
            energy["charged_kwh"] / (capacity * batteries)
            if capacity > 0 and batteries
            else 0.0
        ),
        "baseline_bill": baseline_bill,
        "battery_bill": battery_bill,
        "saving_aud": saving,
        "annual_saving_aud": annual_saving,
        "cost_aud": cost,
        "total_cost_aud": total_cost,
        "payback_years": payback_years,
    }


def dedupe_rows(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Merge rows that share a (household, day, hour) key.

    Energy fields are summed. Bill is summed when both sides have a value.
    Neighbourhood is taken from the first row. Daily rows have no hour, so for
    them the key is (household, day) as before. Original row dicts are not mutated.
    """
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    order: list[tuple[str, str, str]] = []
    for row in rows:
        key = _reading_key(row)
        if key not in grouped:
            grouped[key] = dict(row)
            order.append(key)
            continue
        target = grouped[key]
        for field in ("peak", "shoulder", "offpeak", "solar", "grid", "consumed"):
            target[field] = float(target.get(field) or 0) + float(row.get(field) or 0)
        if row.get("bill") is not None:
            extra = float(row["bill"])
            if target.get("bill") is not None:
                target["bill"] = float(target["bill"]) + extra
            else:
                target["bill"] = extra
        for field in ("estimated_intervals", "missing_intervals"):
            if row.get(field) is not None or target.get(field) is not None:
                target[field] = int(target.get(field) or 0) + int(row.get(field) or 0)
    return [grouped[key] for key in order]


def _month_grid_and_bill(
    rows: list[Mapping[str, Any]], rates: Mapping[str, float]
) -> dict[str, dict[str, float]]:
    by_month: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        month = str(row.get("month") or "")
        if not month:
            continue
        by_month.setdefault(month, []).append(row)
    return {
        month: {
            "kwh": _sum(month_rows, "grid"),
            "bill": estimate_bill(month_rows, rates),
        }
        for month, month_rows in by_month.items()
    }


def compare_plans(
    rows: Iterable[Mapping[str, Any]],
    plans: Iterable[Mapping[str, Any]] | None = None,
    gst: float | None = None,
    current: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Score named plans on this usage.

    With ``current`` (the tariff the household is on now), the result also says
    what that tariff bills and how much the cheapest plan would save.
    """
    materialised = [dict(row) for row in rows]
    gst_rate = DEFAULT_TARIFF["gst"] if gst is None else float(gst)
    if gst_rate < 0:
        gst_rate = 0.0
    source_plans = list(DEFAULT_PLANS if plans is None else plans)
    scored: list[dict[str, Any]] = []
    for plan in source_plans:
        name = str(plan.get("name") or "Plan")
        rates = coerce_tariff({**dict(plan), "gst": gst_rate})
        bill = estimate_bill(materialised, rates)
        scored.append(
            {
                "name": name,
                "tariff": rates,
                "bill": bill,
                "delta_vs_cheapest": 0.0,
                "winner": False,
            }
        )
    current_bill = None
    if current is not None:
        current_bill = estimate_bill(materialised, {**dict(current), "gst": gst_rate})
    if not scored:
        return {
            "plans": [],
            "cheapest": None,
            "current_bill": current_bill,
            "switch_saving": 0.0,
        }
    cheapest_bill = min(item["bill"] for item in scored)
    cheapest_index = next(
        index for index, item in enumerate(scored) if item["bill"] == cheapest_bill
    )
    for index, item in enumerate(scored):
        item["delta_vs_cheapest"] = item["bill"] - cheapest_bill
        item["winner"] = index == cheapest_index
    switch_saving = 0.0
    if current_bill is not None:
        switch_saving = max(0.0, current_bill - cheapest_bill)
    return {
        "plans": scored,
        "cheapest": scored[cheapest_index]["name"],
        "current_bill": current_bill,
        "switch_saving": switch_saving,
    }


def load_plans_file(path: str | Path) -> list[dict[str, Any]]:
    """Read retailer offers from JSON: a list (or {"plans": [...]}) of named rate sets."""
    import json

    try:
        payload = json.loads(read_text_file(path))
    except json.JSONDecodeError as exc:
        raise GridScopeError(f"Plans file is not valid JSON: {exc.msg}.") from exc
    items = payload.get("plans") if isinstance(payload, dict) else payload
    if not isinstance(items, list) or not items:
        raise GridScopeError("Plans file needs a non-empty list of plans.")
    plans: list[dict[str, Any]] = []
    for position, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise GridScopeError(f"Plan {position} is not an object.")
        name = str(item.get("name") or "").strip()
        if not name:
            raise GridScopeError(f"Plan {position} needs a name.")
        rates = coerce_tariff(item)
        rates.pop("gst", None)
        plans.append({"name": name, **rates})
    return plans


def get_analysis(
    rows: Iterable[Mapping[str, Any]],
    tariff: Mapping[str, Any] | None = None,
    household: str | None = None,
    tou: bool = False,
    date_order: str = "dmy",
    dedupe: bool = False,
    plans: Iterable[Mapping[str, Any]] | None = None,
    battery: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    rates = coerce_tariff(tariff)
    filtered = filter_household(rows, household)
    tou_applied = False
    tou_note = ""
    if tou:
        has_hour = any(row.get("hour") is not None for row in filtered)
        eligible = sum(
            1
            for row in filtered
            if row.get("tier_source") not in ("csv", "interval")
            and row.get("hour") is not None
        )
        interval_rows = any(row.get("tier_source") == "interval" for row in filtered)
        filtered = apply_tou(filtered)
        if not has_hour:
            tou_note = "TOU skipped: no hour on every row."
        elif eligible == 0 and interval_rows:
            tou_note = "TOU windows are already applied to NEM12 interval data."
        elif eligible == 0:
            tou_note = "TOU skipped: this CSV already has peak/shoulder/offpeak columns."
        else:
            tou_applied = True
            tou_note = f"TOU applied to {eligible} rows."
    if dedupe:
        filtered = dedupe_rows(filtered)
    rows_by_month: dict[str, list[dict[str, Any]]] = {}
    rows_by_group: dict[str, list[dict[str, Any]]] = {}
    for row in filtered:
        rows_by_month.setdefault(row["month"], []).append(row)
        rows_by_group.setdefault(row["neighbourhood"], []).append(row)

    monthly = _aggregate(filtered, lambda row: row["month"])
    monthly.sort(key=lambda item: item["key"])
    for index, item in enumerate(monthly):
        item["tariff_bill"] = estimate_bill(rows_by_month[item["key"]], rates)
        if index == 0:
            item["mom_grid"] = None
            item["mom_bill"] = None
        else:
            prev = monthly[index - 1]
            item["mom_grid"] = float(item["grid"]) - float(prev["grid"])
            item["mom_bill"] = float(item["tariff_bill"]) - float(prev["tariff_bill"])

    groups = _aggregate(filtered, lambda row: row["neighbourhood"])
    groups.sort(key=lambda item: (-item["grid"], item["key"]))
    for item in groups:
        item["tariff_bill"] = estimate_bill(rows_by_group[item["key"]], rates)
        households = item["households"]
        item["kwh_per_household"] = (
            float(item["grid"]) / households if households else None
        )

    totals = get_totals(filtered, rates)
    plan_scores = compare_plans(filtered, plans=plans, gst=rates["gst"], current=rates)
    coverage = calendar_coverage(filtered)
    battery_options = {**DEFAULT_BATTERY, "cost_aud": None, **dict(battery or {})}
    interval_rows = sum(1 for row in filtered if row.get("tier_source") == "interval")
    return {
        "rows": filtered,
        "monthly": monthly,
        "groups": groups,
        "daily": daily_series(filtered),
        "anomalies": get_anomalies(filtered),
        "recommendations": get_recommendations(totals, rates, plan_scores),
        "totals": totals,
        "heatmap": weekday_heatmap(filtered),
        "tariff": rates,
        "households": households_of(filtered),
        "household": household or "all",
        "plans": plan_scores,
        "source": {
            "format": "nem12" if interval_rows else "csv",
            "interval_rows": interval_rows,
            "hourly": any(row.get("hour") is not None for row in filtered),
        },
        "tou": bool(tou),
        "tou_applied": tou_applied,
        "tou_note": tou_note,
        "coverage": coverage,
        "date_order": _normalise_date_order(date_order),
        "weekend": weekend_split(filtered, rates),
        "quality": data_quality(filtered),
        "what_if": what_if_peak_shift(filtered, rates, 0.10),
        "what_if_solar": what_if_solar_self(filtered, rates, 0.50),
        "what_if_battery": what_if_battery(
            filtered,
            rates,
            capacity_kwh=float(battery_options["capacity_kwh"]),
            efficiency=float(battery_options["efficiency"]),
            cost_aud=battery_options.get("cost_aud"),
        ),
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

    left_households = {row.get("household") for row in left_rows}
    right_households = {row.get("household") for row in right_rows}
    join = (
        "household_day"
        if len(left_households) > 1 and len(right_households) > 1
        else "day"
    )
    if join == "household_day":
        left_keys = {(row.get("household"), row["day"]) for row in left_rows}
        right_keys = {(row.get("household"), row["day"]) for row in right_rows}
        shared_keys = left_keys & right_keys
        shared = sorted({day for _, day in shared_keys})
        left_shared = [
            row for row in left_rows if (row.get("household"), row["day"]) in shared_keys
        ]
        right_shared = [
            row
            for row in right_rows
            if (row.get("household"), row["day"]) in shared_keys
        ]
    else:
        left_days = {row["day"] for row in left_rows}
        right_days = {row["day"] for row in right_rows}
        shared = sorted(left_days & right_days)
        shared_set = set(shared)
        left_shared = [row for row in left_rows if row["day"] in shared_set]
        right_shared = [row for row in right_rows if row["day"] in shared_set]

    left_totals = get_totals(left_rows, rates)
    right_totals = get_totals(right_rows, rates)
    left_shared_totals = get_totals(left_shared, rates) if left_shared else None
    right_shared_totals = get_totals(right_shared, rates) if right_shared else None
    left_months = _month_grid_and_bill(left_rows, rates)
    right_months = _month_grid_and_bill(right_rows, rates)
    monthly_delta = [
        {
            "month": month,
            "delta_kwh": right_months[month]["kwh"] - left_months[month]["kwh"],
            "delta_bill": right_months[month]["bill"] - left_months[month]["bill"],
        }
        for month in sorted(set(left_months) & set(right_months))
    ]

    def delta(right_value: float | None, left_value: float | None) -> float | None:
        if right_value is None or left_value is None:
            return None
        return right_value - left_value

    return {
        "join": join,
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
        "monthly_delta": monthly_delta,
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
                "mom_grid": _round_optional(item.get("mom_grid"), 3),
                "mom_bill": _round_optional(item.get("mom_bill"), 2),
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
        "plans": analysis.get("plans"),
        "tou": analysis.get("tou"),
        "tou_applied": analysis.get("tou_applied"),
        "tou_note": analysis.get("tou_note"),
        "coverage": analysis.get("coverage"),
        "date_order": analysis.get("date_order"),
        "weekend": analysis.get("weekend"),
        "quality": analysis.get("quality"),
        "what_if": analysis.get("what_if"),
        "what_if_solar": analysis.get("what_if_solar"),
        "what_if_battery": analysis.get("what_if_battery"),
        "source": analysis.get("source"),
        "daily": analysis.get("daily"),
    }
