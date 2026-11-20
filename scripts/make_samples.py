"""Generate the sample datasets deterministically (stdlib only).

    python3 scripts/make_samples.py          # rewrite data/sample_*.csv
    python3 scripts/make_samples.py --check  # exit 1 if the checked-in files differ

data/sample_energy_upload.csv
    A year (2025) of daily readings for four fictional households in three
    suburbs, with a southern-hemisphere seasonal shape, weekend uplift, rooftop
    solar on three of them, and four planted events the anomaly detector should
    find. They are its strongest flags; a couple of borderline weekend days
    (|z| around 4) also show up, as they would in real data:

      H-101  2025-01-30  heatwave, air-con all day        high spike
      H-102  2025-09-20 … 09-26  away on holiday          low dips
      H-201  2025-07-08 … 07-10  faulty panel heater      high spikes
      H-301  2025-04-15  pool pump left on overnight      high spike

data/sample_nem12.csv
    The same year for one NMI as a NEM12 file: 30-minute E1 (import) and B1
    (export) channels from a 6.6 kW rooftop system, with one estimated day, one
    day of mixed quality (V + 400 records), and a February heatwave (the top
    anomaly by a wide margin).

Only random.Random.random() is used, so output is identical on every
supported Python version.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAILY_PATH = ROOT / "data" / "sample_energy_upload.csv"
NEM12_PATH = ROOT / "data" / "sample_nem12.csv"
YEAR = 2025


def normal(rng: random.Random, sd: float, clip: float = 1.5) -> float:
    """Box-Muller from two uniforms, truncated at +/- clip standard deviations (1.5 by default).

    Truncation keeps the sample's only anomalies the planted ones; random.gauss
    is avoided so the output does not depend on its implementation.
    """
    u1 = max(rng.random(), 1e-12)
    u2 = rng.random()
    z = math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)
    return sd * max(-clip, min(clip, z))


def year_days() -> list[date]:
    start = date(YEAR, 1, 1)
    return [start + timedelta(days=offset) for offset in range(365)]


def season(day: date, peak_doy: int) -> float:
    """1.0 at the given day of year, -1.0 six months away."""
    doy = day.timetuple().tm_yday
    return math.cos(2.0 * math.pi * (doy - peak_doy) / 365.0)


HOUSEHOLDS = [
    # id, suburb, base kWh/day, tier shares (peak, shoulder, off-peak), solar kW, self-use share
    ("H-101", "Northbank", 19.0, (0.42, 0.33, 0.25), 6.6, 0.38),
    ("H-102", "Northbank", 8.5, (0.40, 0.30, 0.30), 0.0, 0.0),
    ("H-201", "East Park", 15.0, (0.30, 0.46, 0.24), 5.0, 0.55),
    ("H-301", "Harbourview", 23.0, (0.26, 0.24, 0.50), 3.0, 0.30),
]

EVENTS = {
    ("H-101", date(YEAR, 1, 30)): 2.7,
    ("H-201", date(YEAR, 7, 8)): 2.5,
    ("H-201", date(YEAR, 7, 9)): 2.6,
    ("H-201", date(YEAR, 7, 10)): 2.4,
    ("H-301", date(YEAR, 4, 15)): 2.3,
}
for offset in range(7):
    EVENTS[("H-102", date(YEAR, 9, 20) + timedelta(days=offset))] = 0.12


def daily_sample() -> str:
    rng = random.Random(20250101)
    lines = [
        "day,household_id,neighbourhood,peak_kwh,shoulder_kwh,offpeak_kwh,"
        "solar_export_kwh,grid_import_kwh,estimated_bill"
    ]
    for day in year_days():
        # Winter heating peaks mid-July; a smaller summer cooling bump in late January.
        heating = 0.16 * max(0.0, season(day, 196))
        cooling = 0.08 * max(0.0, season(day, 28))
        weekend = 0.08 if day.weekday() >= 5 else 0.0
        sun = 3.7 + 1.6 * season(day, 355)  # kWh per kW per day, best at midsummer
        cloud = 0.55 + 0.45 * rng.random()
        for household, suburb, base, shares, solar_kw, self_use in HOUSEHOLDS:
            # Real households swing well over 10% day to day.
            noise = max(0.4, 1.0 + normal(rng, 0.13))
            consumed = base * (1.0 + heating + cooling + weekend) * noise
            consumed *= EVENTS.get((household, day), 1.0)
            peak = consumed * shares[0]
            shoulder = consumed * shares[1]
            offpeak = consumed * shares[2]
            generation = solar_kw * sun * cloud
            self_used = min(generation * self_use, shoulder * 0.8)
            export = generation - self_used
            grid = peak + shoulder + offpeak - self_used
            bill = (
                peak * 0.41 + shoulder * 0.29 + offpeak * 0.19 + 1.05 - export * 0.07
            ) * 1.1
            lines.append(
                f"{day.isoformat()},{household},{suburb},{peak:.2f},{shoulder:.2f},"
                f"{offpeak:.2f},{export:.2f},{grid:.2f},{bill:.2f}"
            )
    return "\n".join(lines) + "\n"


def load_profile(hour: float, weekday: bool) -> float:
    """Household load in kWh per half hour, before weather and noise."""
    base = 0.14
    morning = 0.30 * math.exp(-((hour - 7.5) ** 2) / 1.2) if weekday else 0.22 * math.exp(-((hour - 9.0) ** 2) / 2.5)
    evening = 0.55 * math.exp(-((hour - 19.0) ** 2) / 3.0)
    midday = 0.0 if weekday else 0.06
    return base + morning + evening + midday


def nem12_sample() -> str:
    rng = random.Random(6408091234)
    nmi = "6408091234"
    imports: list[tuple[date, list[float], str]] = []
    exports: list[tuple[date, list[float], str]] = []
    heatwave = date(YEAR, 2, 12)
    estimated_day = date(YEAR, 5, 6)
    for day in year_days():
        weekday = day.weekday() < 5
        heating = 0.35 * max(0.0, season(day, 196))
        cloud = 0.5 + 0.5 * rng.random()
        # Day-level behaviour (guests, laundry, cooking) dwarfs interval noise.
        behaviour = max(0.4, 1.0 + normal(rng, 0.16))
        daylight = 12.2 + 2.2 * season(day, 355)  # hours
        sunrise = 12.6 - daylight / 2.0
        sunset = 12.6 + daylight / 2.0
        peak_output = 6.6 * 0.5 * (0.72 + 0.12 * season(day, 355)) * cloud  # kWh per 30 min
        imp_values: list[float] = []
        exp_values: list[float] = []
        for interval in range(48):
            hour = interval / 2.0 + 0.25
            load = load_profile(hour, weekday) * (1.0 + heating) * behaviour * (1.0 + normal(rng, 0.08))
            if day == heatwave and 12 <= hour <= 23:
                load += 1.3
            load = max(0.05, load)
            generation = 0.0
            if sunrise < hour < sunset:
                position = (hour - sunrise) / (sunset - sunrise)
                generation = peak_output * math.sin(math.pi * position) ** 1.5
            imp_values.append(max(0.0, load - generation))
            exp_values.append(max(0.0, generation - load))
        flag = "E" if day == estimated_day else "A"
        imports.append((day, imp_values, flag))
        exports.append((day, exp_values, flag))

    variable_day = date(YEAR, 8, 19)
    lines = ["100,NEM12,202601020300,MDPSAMPLE,GRIDSCOPE"]
    for suffix, register, series in (("E1", "E1", imports), ("B1", "B1", exports)):
        lines.append(f"200,{nmi},E1B1,{register},{suffix},N1,SAMPLE01,KWH,30,")
        for day, values, flag in series:
            stamp = day.strftime("%Y%m%d")
            cells = ",".join(f"{value:.3f}" for value in values)
            if day == variable_day and suffix == "E1":
                lines.append(f"300,{stamp},{cells},V,,,{stamp}235959,")
                lines.append("400,1,14,A,,")
                lines.append("400,15,20,S53,,Meter swapped; substituted")
                lines.append("400,21,48,A,,")
            else:
                lines.append(f"300,{stamp},{cells},{flag},,,{stamp}235959,")
    lines.append("900")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="Fail if files are stale")
    args = parser.parse_args(argv)
    outputs = {DAILY_PATH: daily_sample(), NEM12_PATH: nem12_sample()}
    stale = []
    for path, text in outputs.items():
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if args.check:
            if current != text:
                stale.append(path)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"Wrote {path.relative_to(ROOT)} ({len(text.splitlines())} lines)")
    if stale:
        for path in stale:
            print(f"{path.relative_to(ROOT)} is stale; run python3 scripts/make_samples.py", file=sys.stderr)
        return 1
    if args.check:
        print("Samples are up to date.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
