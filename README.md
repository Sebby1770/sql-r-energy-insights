# GridScope Studio

![version](https://img.shields.io/badge/version-0.8.0-c6f35a)

**Live site:** [https://sebby1770.github.io/sql-r-energy-insights/](https://sebby1770.github.io/sql-r-energy-insights/)

[github.com/Sebby1770/sql-r-energy-insights](https://github.com/Sebby1770/sql-r-energy-insights)

A lightweight energy analysis studio for turning household billing or meter CSVs into retailer-style bills, dollar savings, plan comparison, charts, and short observations.

The GitHub Pages studio runs entirely in the browser (sample data loads on first visit; your CSV never leaves the tab). The Python engine (`python3 -m gridscope`) analyses the same files on the command line without R. The original R + SQLite pipeline is still available for the demo portfolio.

## Quick Start

Python path (no R):

```sh
python3 -m gridscope data/sample_energy_upload.csv --html output/py-report.html
# or
make demo-py
open output/py-report.html
```

R demo portfolio:

```sh
make demo
open output/report.html
```

Analyse your own CSV with R:

```sh
make custom INPUT=data/sample_energy_upload.csv OUTPUT=output/custom-report.html
open output/custom-report.html
```

## CSV Columns

Required:

- `day` or `date`
- either `grid_import_kwh` or `total_kwh`, or the tiered fields `peak_kwh`, `shoulder_kwh`, and `offpeak_kwh`

Optional:

- `household_id`
- `neighbourhood` or `suburb`
- `solar_export_kwh`
- `estimated_bill`
- `hour` (or a timestamp with a time component) for an hour-of-day heatmap and optional TOU retiering

The browser upload flow accepts the same columns and produces graphs immediately in the page.

If only a total or grid-import column is supplied, usage is split 44% peak / 34% shoulder / 22% off-peak so tariff math still works.

Dates like `01/02/2025` default to **DMY** (1 February). Pass `--date-order mdy` or `auto` (0.3 heuristic: first component is the month unless it is `> 12`).

## Tariff and bill

Default rates are AUD:

| Component | Rate |
| --- | ---: |
| Peak | 0.40 /kWh |
| Shoulder | 0.28 /kWh |
| Off-peak | 0.18 /kWh |
| Solar export credit | 0.08 /kWh |
| Daily supply | 1.10 /day |
| GST | 0.10 |

Bill:

```text
energy  = peak×peak + shoulder×shoulder + off-peak×off-peak
export  = solar×export_credit
ex GST  = energy + daily_supply×distinct_days − export
inc GST = ex GST × (1 + gst)
```

`estimate_bill` returns the GST-inclusive amount. Totals also expose `tariff_bill_ex_gst`, `supply_charge`, `gst_amount`, and `cost_per_kwh` (`tariff_bill / consumed`).

In the studio the tariff editor rebills live, including supply and GST. On the CLI:

```sh
python3 -m gridscope data/sample_energy_upload.csv \
  --tariff-peak 0.42 --tariff-shoulder 0.28 --tariff-offpeak 0.16 \
  --tariff-export 0.07 --tariff-supply 1.10 --tariff-gst 0.10 \
  --html output/py-report.html
```

## Plans

Three named plans are scored on the loaded usage (`--plans` on the CLI; three cards in the studio):

| Plan | Peak | Shoulder | Off-peak | Export | Supply |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flex Saver | 0.40 | 0.28 | 0.18 | 0.08 | 1.10 |
| Solar Plus | 0.38 | 0.27 | 0.17 | 0.12 | 1.35 |
| Flat Comfort | 0.32 | 0.32 | 0.32 | 0.05 | 1.60 |

GST follows the current tariff GST field. The cheapest plan is marked as the winner.

## Compare, household filter, TOU

- **Household filter**: when a file has more than one `household_id`, the studio shows a selector. CLI: `--household H-101`.
- **Compare**: upload a second CSV or click “Compare to sample”. Cards show Δ kWh, Δ tariff bill, and shared days, plus a monthly delta table for shared months. CLI: `--compare other.csv`.
- **TOU from hour**: `--tou` or the studio checkbox. If every row has an hour, grid kWh is retiered: weekends off-peak; weekday 14–19 peak; weekday 7–13 and 20–21 shoulder; otherwise off-peak.
- **Weekday vs weekend**: unique days, consumed kWh, and GST-inclusive bills for Sat/Sun versus the rest.
- **Data quality**: duplicate household+day keys, negative energy, and zero-grid days are flagged, not dropped. Optional `--dedupe` / studio checkbox merges duplicate keys by summing energy.
- **Peak-shift what-if**: studio slider (0–30%) estimates the saving if that share of peak kWh moved to off-peak on the current tariff.
- **Solar self-consumption what-if**: studio slider (0–100%) estimates the saving from using that share of solar export on-site.

Identical files produce a ~0 kWh and ~0 bill delta.

Anomalies compare each day to **that household’s** mean when the household has at least four rows, otherwise the global mean. Recommendations include `saving_aud` (peak shift 10%, solar self-consumption 50%) and a spend review with a projected 30-day cost.

## Tests

No R required:

```sh
python3 -m pip install pytest
make test
make verify-py
```

`make verify` still runs the R + SQLite pipeline.

## Requirements

- Python 3.11+ for the engine, CLI, and tests (stdlib only at runtime)
- Optional: R 4.x and `sqlite3` for `make demo` / `make custom`

On macOS, SQLite is usually already available. Check with:

```sh
sqlite3 --version
```

## Project Structure

```text
.
├── gridscope/           Python engine + CLI
├── tests/               pytest (no R)
├── R/
│   └── run_analysis.R
├── assets/
│   ├── analysis.js      Browser copy of the analysis formulas
│   ├── studio.js
│   ├── studio.css
│   └── studio-panel.html
├── web/                 GitHub Pages studio (assembled in Actions)
├── data/
│   └── sample_energy_upload.csv
├── sql/
│   ├── schema.sql
│   ├── seed.sql
│   ├── user_upload_schema.sql
│   └── queries/
└── output/
    ├── figures/
    ├── tables/
    ├── report.html
    └── py-report.html
```

Python `gridscope/analysis.py` is the source of truth for parse, totals, anomalies, recommendations, tariff bills, plans, compare, weekend split, data quality, peak-shift and solar self-consumption what-ifs, optional dedupe, TOU, and the weekday heatmap. `assets/analysis.js` reimplements the same formulas so the report can analyse uploads entirely in the browser.

## Outputs

- `output/report.html`: R demo report with the browser studio
- `output/py-report.html`: Python report with the same studio controls
- `output/custom-report.html`: generated when an input CSV is supplied to R
- `output/tables/`: CSV summaries (`user_*.csv` from R, `py_*.csv` from Python)
- `output/figures/`: PNG charts generated by R

## Analysis Included

- Monthly grid import and solar export trends
- Load mix across peak, shoulder, off-peak, and solar export
- Group comparison by neighbourhood or suburb
- Live tariff rebill with daily supply and GST
- Named plan comparison (Flex Saver / Solar Plus / Flat Comfort)
- Household filter when multiple sites are present
- Dataset compare (delta kWh, delta bill, shared days, monthly delta)
- Weekday vs weekend days, kWh, and bills
- Data-quality flags (duplicate days, negative energy, zero grid) and optional duplicate merge
- Live peak-shift what-if (move N% of peak to off-peak)
- Live solar self-consumption what-if (use N% of export on-site)
- Group kWh per household
- Optional NSW-style TOU retiering from hour
- Weekday × month heatmap (weekday × hour when a time is present)
- Unusual usage day detection versus household or global baseline
- Dollar savings for peak shifting, solar self-consumption, and spend review
- Dark mode, JSON export, and CSV export of the current monthly table

## Browser Tools

The demo and Python reports include:

- CSV upload with immediate charts and tables
- Three-step onboarding strip
- Hero card: this month you could save
- Peak-shift slider (0–30%) and solar self-consumption slider (0–100%) under the savings hero
- Weekday vs weekend metric cards and a data-quality callout
- Optional merge of duplicate household+day rows
- Three plan cards with the winner outlined
- Household filter
- Date-order select and TOU checkbox
- Tariff editor (peak / shoulder / off-peak / export / supply / GST) with live rebill
- Compare CSV / compare to sample, with a monthly delta table
- Weekday heatmap
- Dark mode toggle
- JSON export and CSV export of the current analysis table
- Sample data loader (fetches `data/sample_energy_upload.csv` over HTTP, inline fallback for `file://`)
