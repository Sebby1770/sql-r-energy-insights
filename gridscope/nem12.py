"""NEM12 smart-meter interval files (AEMO Meter Data File Format).

Australian retailers and distributors hand out interval data as NEM12: a CSV of
numbered records rather than a header row.

  100  header (version must be NEM12)
  200  NMI data details: NMI, suffix (E1 import, B1 export, ...), UOM, interval length
  300  one day of interval values for the current 200 channel, plus a quality flag
  400  per-interval quality when the 300 flag is V (variable)
  500  B2B details (ignored)
  900  end of data

Intervals are rolled up to one row per (NMI, day, hour). Import channels (suffix
starting with E) become ``grid``; export channels (suffix starting with B) become
``solar``. Because the time of every kWh is known, import is tiered with the same
TOU windows as ``apply_tou`` (``tier_source = "interval"``) instead of the
44/34/22 split used for single-total CSVs.

Times are NEM market time (AEST, no daylight saving), as the file states them.

Mirrored in assets/analysis.js (parseNem12).
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from gridscope.analysis import (
    GridScopeError,
    iso_day,
    month_key,
    parse_csv_rows,
    tou_bucket,
    weekday_name,
)

UOM_TO_KWH = {"KWH": 1.0, "WH": 0.001, "MWH": 1000.0}
ESTIMATED_FLAGS = {"S", "F", "E"}
VALID_INTERVALS = {1, 5, 10, 15, 30, 60}


def looks_like_nem12(text: str) -> bool:
    """True when the first non-blank line is a NEM12 100 or 200 record."""
    for line in text.replace("﻿", "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        cells = [cell.strip().strip('"').upper() for cell in stripped.split(",")]
        if cells[0] == "100":
            return len(cells) > 1 and cells[1] == "NEM12"
        return cells[0] == "200"
    return False


def _channel_kind(suffix: str) -> str | None:
    first = suffix.strip().upper()[:1]
    if first == "E":
        return "import"
    if first == "B":
        return "export"
    return None


def _interval_date(raw: str) -> date:
    text = raw.strip()
    if len(text) != 8 or not text.isdigit():
        raise GridScopeError(f"NEM12 300 record has an unreadable date: {raw!r}.")
    try:
        return date(int(text[:4]), int(text[4:6]), int(text[6:8]))
    except ValueError as exc:
        raise GridScopeError(f"NEM12 300 record has an invalid date: {raw!r}.") from exc


def _interval_value(raw: str) -> float | None:
    text = raw.strip()
    if text == "":
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def parse_nem12_details(text: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Parse NEM12 text into hourly reading rows plus a summary of the file."""
    records = parse_csv_rows(text)
    if not records:
        raise GridScopeError("The NEM12 file is empty.")

    channel: dict[str, Any] | None = None
    # (nmi, day iso, hour) -> accumulator
    buckets: dict[tuple[str, str, int], dict[str, Any]] = {}
    nmis: list[str] = []
    channels: list[str] = []
    interval_minutes: set[int] = set()
    skipped_channels: set[str] = set()
    days_seen = 0

    def bucket_for(nmi: str, day: date, hour: int) -> dict[str, Any]:
        key = (nmi, iso_day(day), hour)
        if key not in buckets:
            buckets[key] = {
                "nmi": nmi,
                "date": day,
                "hour": hour,
                "import": 0.0,
                "export": 0.0,
                "estimated": 0,
                "missing": 0,
            }
        return buckets[key]

    def add_day(
        values: list[float | None],
        flags: list[str],
        day: date,
        current: dict[str, Any],
    ) -> None:
        length = current["interval"]
        for index, value in enumerate(values):
            hour = (index * length) // 60
            bucket = bucket_for(current["nmi"], day, hour)
            if value is None or flags[index] == "N":
                bucket["missing"] += 1
                continue
            kwh = value * current["scale"]
            bucket[current["kind"]] += kwh
            if flags[index] in ESTIMATED_FLAGS:
                bucket["estimated"] += 1

    # A 300 record flagged V keeps its per-interval flags in the 400 records
    # that follow it, so that day is held open until a non-400 record arrives.
    pending: dict[str, Any] | None = None

    def flush_pending() -> None:
        nonlocal pending
        if pending is not None:
            add_day(pending["values"], pending["flags"], pending["day"], pending["channel"])
            pending = None

    for record in records:
        kind = record[0].strip()
        if kind != "400":
            flush_pending()
        if kind == "100":
            version = record[1].strip().upper() if len(record) > 1 else ""
            if version != "NEM12":
                raise GridScopeError(
                    "Only NEM12 interval files are supported "
                    f"(this header says {version or 'nothing'})."
                )
            continue
        if kind == "200":
            if len(record) < 9:
                raise GridScopeError("NEM12 200 record is missing fields.")
            nmi = record[1].strip()
            suffix = record[4].strip().upper()
            uom = record[7].strip().upper()
            try:
                interval = int(record[8].strip())
            except ValueError as exc:
                raise GridScopeError(
                    f"NEM12 200 record has an unreadable interval length: {record[8]!r}."
                ) from exc
            if interval not in VALID_INTERVALS:
                raise GridScopeError(f"NEM12 interval length {interval} is not supported.")
            channel_kind = _channel_kind(suffix)
            scale = UOM_TO_KWH.get(uom)
            if channel_kind is None or scale is None:
                skipped_channels.add(f"{suffix} ({uom})")
                channel = {"skip": True}
                continue
            channel = {
                "skip": False,
                "nmi": nmi,
                "suffix": suffix,
                "kind": channel_kind,
                "scale": scale,
                "interval": interval,
            }
            interval_minutes.add(interval)
            if nmi not in nmis:
                nmis.append(nmi)
            label = f"{nmi}:{suffix}"
            if label not in channels:
                channels.append(label)
            continue
        if kind == "300":
            if channel is None:
                raise GridScopeError("NEM12 300 record appears before any 200 record.")
            if channel.get("skip"):
                continue
            count = 1440 // channel["interval"]
            if len(record) < 2 + count:
                raise GridScopeError(
                    f"NEM12 300 record has {max(0, len(record) - 2)} values; "
                    f"expected {count} for {channel['interval']}-minute intervals."
                )
            day = _interval_date(record[1])
            values = [_interval_value(cell) for cell in record[2 : 2 + count]]
            flag = ""
            if len(record) > 2 + count:
                flag = record[2 + count].strip().upper()[:1]
            flag = flag or "A"
            days_seen += 1
            if flag == "V":
                pending = {
                    "channel": channel,
                    "day": day,
                    "values": values,
                    "flags": ["A"] * count,
                }
                continue
            add_day(values, [flag] * count, day, channel)
            continue
        if kind == "400":
            if pending is None or len(record) < 4:
                continue
            try:
                start = int(record[1].strip())
                end = int(record[2].strip())
            except ValueError:
                continue
            flag = record[3].strip().upper()[:1] or "A"
            flags = pending["flags"]
            for position in range(max(1, start), min(len(flags), end) + 1):
                flags[position - 1] = flag
            continue
        # 500 (B2B details), 900 (end of data) and anything unknown are ignored.
    flush_pending()

    if not buckets:
        raise GridScopeError(
            "No kWh import or export channels were found in this NEM12 file."
        )

    rows: list[dict[str, Any]] = []
    for key in sorted(buckets):
        bucket = buckets[key]
        day = bucket["date"]
        weekday = weekday_name(day)
        grid = bucket["import"]
        tier = tou_bucket(weekday, bucket["hour"])
        rows.append(
            {
                "day": iso_day(day),
                "month": month_key(day),
                "weekday": weekday,
                "hour": bucket["hour"],
                "household": bucket["nmi"],
                "neighbourhood": "Ungrouped",
                "peak": grid if tier == "peak" else 0.0,
                "shoulder": grid if tier == "shoulder" else 0.0,
                "offpeak": grid if tier == "offpeak" else 0.0,
                "solar": bucket["export"],
                "grid": grid,
                "bill": None,
                "consumed": grid,
                "tier_source": "interval",
                "estimated_intervals": bucket["estimated"],
                "missing_intervals": bucket["missing"],
            }
        )

    meta = {
        "format": "nem12",
        "nmis": nmis,
        "channels": channels,
        "interval_minutes": min(interval_minutes) if interval_minutes else None,
        "skipped_channels": sorted(skipped_channels),
        "interval_days": days_seen,
    }
    return rows, meta


def parse_nem12(text: str) -> list[dict[str, Any]]:
    rows, _ = parse_nem12_details(text)
    return rows
