# GridScope Studio

![version](https://img.shields.io/badge/version-0.9.0-c6f35a)

**Live site:** [https://sebby1770.github.io/sql-r-energy-insights/](https://sebby1770.github.io/sql-r-energy-insights/)

GridScope turns a household energy file into a retailer-style bill, the cheapest plan, quantified savings, unusual days and a battery payback estimate. It reads billing/meter CSVs and **NEM12 smart-meter interval files**, the format Australian retailers and distributors export.

There are three ways to run it, all sharing one set of formulas:

- **The studio** on GitHub Pages runs entirely in the browser. The sample loads on first visit, and your file never leaves the tab.
- **The Python engine** (`python3 -m gridscope`) analyses the same files on the command line. It is stdlib only and needs no R.
- **The original R + SQLite pipeline** builds the demo portfolio report.

## Quick start

```sh
# Daily billing CSV
python3 -m gridscope data/sample_energy_upload.csv --html output/py-report.html --plans

# NEM12 interval file (detected automatically), with a battery payback estimate
python3 -m gridscope data/sample_nem12.csv --html output/py-nem12-report.html --battery-cost 9000

# or
make demo-py demo-nem12
```

The CLI always prints a summary. For the NEM12 sample with a $9,000 battery quote:

```text
GridScope 0.9.0
Source      NEM12 · 30-min intervals · 6408091234
Records     8760
Days        365
Households  1
Grid kWh    3093.2
Solar kWh   7176.7
Supply      $401.50
GST         $61.38
Ex GST      $613.82
Tariff bill $675.21
Cost/kWh    $0.218
Cheapest    Solar Plus
Weekday     2113.6 kWh / $524.95
Weekend     979.6 kWh / $150.26
Intervals   102 estimated/substituted, 0 missing
Switch save $258.33
Battery     10.0 kWh saves $513.59 ($514/yr annualised), payback 17.5 yr
```

R demo portfolio:

```sh
make demo                     # output/report.html
make custom INPUT=data/sample_energy_upload.csv OUTPUT=output/custom-report.html
```

## Input formats

### NEM12 (smart-meter interval data)

Download your interval data from your retailer or distributor portal (it is often called "NEM12", "interval data" or "detailed usage") and drop it in. GridScope reads:

- `200` channel records. Suffixes starting with **E** are import (usage) and become grid kWh. Suffixes starting with **B** are export (solar feed-in). Reactive channels (`Q`, `K`, kVArh) are skipped and named in the source badge.
- `300` interval days at 1, 5, 10, 15, 30 or 60-minute intervals, in Wh, kWh or MWh.
- `400` per-interval quality for `V` days. Estimated or substituted (`E`, `S`, `F`) and missing (`N` or blank) intervals are counted in data quality instead of being hidden.

Intervals roll up to one row per NMI, day and hour. Because the time of every kWh is known, import is tiered with the TOU windows below rather than the 44/34/22 split used for single-total CSVs. Times are NEM market time (AEST, no daylight saving), as the file states them.

### Column CSV

Required:

- `day` or `date` (also `reading_date`, `timestamp`)
- either `grid_import_kwh` or `total_kwh`, or the tiered fields `peak_kwh`, `shoulder_kwh` and `offpeak_kwh`

Optional:

- `household_id` (or `account_id`, `site_id`, `meter_id`)
- `neighbourhood` or `suburb`
- `solar_export_kwh`
- `estimated_bill`
- `hour`, or `time` / `interval_time` (`13:30`, `1:30 pm`), or a timestamp with a time. These enable the hour-of-day heatmap and optional TOU retiering.

If only a total or grid-import column is supplied, usage is split 44% peak / 34% shoulder / 22% off-peak so tariff maths still works.

Dates like `01/02/2025` default to **DMY** (1 February). Pass `--date-order mdy` or `auto`.

## Tariff and bill

Default rates are in AUD:

| Component | Rate |
| --- | ---: |
| Peak | 0.40 /kWh |
| Shoulder | 0.28 /kWh |
| Off-peak | 0.18 /kWh |
| Solar export credit | 0.08 /kWh |
| Daily supply | 1.10 /day |
| GST | 0.10 |

```text
energy  = peak×peak + shoulder×shoulder + off-peak×off-peak
export  = solar×export_credit
ex GST  = energy + daily_supply×distinct_days − export
inc GST = ex GST × (1 + gst)
```

The studio's tariff editor rebills live. On the CLI:

```sh
python3 -m gridscope data/sample_energy_upload.csv \
  --tariff-peak 0.42 --tariff-shoulder 0.28 --tariff-offpeak 0.16 \
  --tariff-export 0.07 --tariff-supply 1.10 --tariff-gst 0.10
```

**TOU windows** (used for NEM12, and for hourly CSVs with `--tou`): weekends are off-peak. On weekdays, 14–19 is peak, 7–13 and 20–21 are shoulder, and the rest is off-peak.

## Plans and switching

Three named plans are scored on the loaded usage, alongside your current tariff:

| Plan | Peak | Shoulder | Off-peak | Export | Supply |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flex Saver | 0.40 | 0.28 | 0.18 | 0.08 | 1.10 |
| Solar Plus | 0.38 | 0.27 | 0.17 | 0.12 | 1.35 |
| Flat Comfort | 0.32 | 0.32 | 0.32 | 0.05 | 1.60 |

The analysis reports what your current tariff bills (`plans.current_bill`) and how much the cheapest plan would save (`plans.switch_saving`). When a plan beats your tariff, a quantified **Switch to <plan>** recommendation is added.

Score the offers you have actually been quoted:

```sh
python3 -m gridscope my-usage.csv --plans --plans-file offers.json
```

```json
{
  "plans": [
    {"name": "Retailer A Night Saver", "peak": 0.52, "shoulder": 0.30, "offpeak": 0.12,
     "export_credit": 0.05, "daily_supply": 1.05},
    {"name": "Retailer B Flat", "peak": 0.31, "shoulder": 0.31, "offpeak": 0.31,
     "export_credit": 0.06, "daily_supply": 1.20}
  ]
}
```

GST follows the tariff GST setting.

## Battery what-if

Would a home battery pay for itself on *your* usage? GridScope runs one battery per household through the readings in time order:

1. In each reading, the battery charges from solar that would otherwise have been exported, up to its capacity.
2. It then discharges into grid import: peak first, then shoulder, then off-peak. Round-trip losses are taken on the way out.
3. Charge carries over between readings. With interval data, midday solar feeds the evening peak. With daily data, each day charges then discharges.

The saving is the difference between the GST-inclusive bills before and after, including the export credit you give up. It is annualised as `saving × 365 / days` and divided into the installed cost to give a payback period. There is no inverter power (kW) limit, so very short intervals are slightly flattered. A single season of data skews the annualised figure.

```sh
python3 -m gridscope data/sample_nem12.csv --battery-kwh 13.5 --battery-efficiency 0.9 --battery-cost 11000
```

The studio has a capacity slider (0–20 kWh) and a field for the installed cost from your quote.

## Unusual days

Anomalies are scored on **household-day totals**. Interval readings are summed per day first, so a busy evening hour is not "unusual". Each day is compared with a seasonal baseline: the same household's days within ±15 days, so a cold July day is judged against July and not against the whole year.

- With at least 7 days in that window and a non-zero spread, GridScope uses the **modified z-score**, `0.6745 × (kWh − median) / MAD` (MAD is the median absolute deviation). A day is flagged when |z| ≥ 3.5 (Iglewicz & Hoaglin). Medians are not dragged around by the spikes being hunted, unlike a mean.
- Short or perfectly flat histories fall back to a ratio rule against the median: at least 1.5× is a spike, at most 0.5× is a dip.
- Households with fewer than 4 days are compared against the median of every household-day.

Each flag reports `method` (`mad` or `ratio`), `z_score`, `baseline_kwh` and percent of baseline. The sample year has four planted events (a heatwave, a week away, a faulty heater, a pool pump left on). All four are caught, with |z| from about 4 (the week away) to 21 (the heatwave).

## Studio tools

- CSV or NEM12 upload, drag-and-drop (one file to analyse, two to compare), daily and NEM12 sample loaders, and a source badge
- A hero card showing what this usage could save, with peak-shift (0–30%), solar self-consumption (0–100%) and **battery** (0–20 kWh, with payback) what-ifs
- Plan cards with the winner outlined, plus the switch saving against your current tariff
- Household filter, date order, TOU toggle, duplicate merge and a live tariff editor
- Weekday/weekend split, a coverage callout, and data-quality flags (duplicates, negatives, estimated and missing intervals)
- Charts: monthly demand, cost, **daily trace with unusual days marked**, load mix, and a weekday × month/hour heatmap
- Ledger tables for months, groups and unusual days (with method and z), plus savings opportunities
- Compare a second file: Δ kWh, Δ bill, shared days and a monthly delta
- JSON and CSV export, copy summary, print bill, and a dark/daylight theme

## Development

```sh
python3 -m pip install pytest
make test          # pytest: engine, CLI, NEM12, battery, site build, Python↔JS parity (node)
make test-r        # base-R tests for the R + SQLite pipeline
make samples       # regenerate data/sample_*.csv (deterministic; CI runs make samples-check)
make site          # build the GitHub Pages studio into _site/
make verify-py     # tests + both Python reports
make verify        # R demo + custom pipelines
```

`gridscope/analysis.py` (plus `gridscope/nem12.py`) is the source of truth. `assets/analysis.js` reimplements the same formulas so the studio can analyse files in the browser. `tests/test_parity_golden.py` runs seven cases through both engines and compares every number, so the two copies cannot drift silently.

### Requirements

- Python 3.11+ (stdlib only at runtime)
- Optional: Node 18+ for the parity tests
- Optional: R 4.x and `sqlite3` for `make demo`, `make custom` and `make test-r`

## Project structure

```text
.
├── gridscope/            Python engine (analysis.py, nem12.py), CLI, HTML report
├── assets/
│   ├── analysis.js       Browser copy of the engine
│   ├── studio.js         Studio UI
│   ├── studio.css
│   └── studio-panel.html Studio markup shared by the site and every report
├── web/                  GitHub Pages page template (built by scripts/build_site.py)
├── scripts/
│   ├── make_samples.py   Deterministic sample generator
│   └── build_site.py     Pages site assembler
├── data/
│   ├── sample_energy_upload.csv   A year of daily readings, four households
│   └── sample_nem12.csv           A year of 30-minute NEM12 for one NMI
├── tests/                pytest suites, fixtures/, and test_analysis.R
├── R/run_analysis.R      R + SQLite pipeline
├── sql/                  Schema, seed and queries for the R pipeline
└── output/               Generated reports, tables and figures
```

## Outputs

- `output/py-report.html` and `output/py-nem12-report.html`: Python reports with the full studio embedded
- `output/report.html`: the R demo portfolio report
- `output/custom-report.html`: generated when an input CSV is supplied to R
- `output/tables/`: CSV summaries (`py_*.csv` from Python, including `py_daily.csv` and `py_battery.csv`, and `user_*.csv` from R)
- `output/figures/`: PNG charts generated by R
