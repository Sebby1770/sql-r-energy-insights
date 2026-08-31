# Changelog

All notable changes to GridScope Studio are documented in this file.

## [0.6.0] - 2026-08-31

### Added
- Totals `cost_per_kwh` (`tariff_bill / consumed`, else null). Studio metric card.
- Solar self-consumption what-if: `what_if_solar_self` estimates GST-inclusive saving without mutating rows (`fraction * solar * max(0, shoulder − export) * (1+gst)`). Analysis includes a 50% default (`what_if_solar`); studio slider 0–100% rebills live.
- `dedupe_rows`: merge duplicate `(household, day)` keys by summing energy (and bill when both present). `get_analysis(..., dedupe=False)`, CLI `--dedupe`, studio checkbox. `data_quality` still counts duplicates on the raw set; after dedupe, `analysis.quality.duplicate_keys` is 0.
- Group `kwh_per_household` (`grid / households`). Studio group table column.

### Changed
- VERSION 0.6.0. Sample CSV parse totals are unchanged (18 rows, 272.7 grid, 60.3 solar).

## [0.5.0] - 2026-08-31

### Added
- Totals `peak_share` and `solar_share` (percent of consumed).
- `weekend_split`: weekday vs Saturday/Sunday unique days, consumed kWh, and GST-inclusive bills (`analysis["weekend"]`).
- `data_quality`: duplicate `(household, day)` keys, negative energy rows, and zero-grid days (`analysis["quality"]`). Studio callout when duplicates or negatives are present; rows are never dropped.
- Peak-shift what-if: `shift_peak` copies rows and moves a fraction of peak kWh into off-peak; `what_if_peak_shift` returns baseline/shifted bills and `saving_aud`. Analysis includes a 10% default; studio slider 0–30% rebills live.
- Compare `monthly_delta`: `{month, delta_kwh, delta_bill}` for months present on both sides. Studio table when compare is on.

### Changed
- VERSION 0.5.0. Sample CSV parse totals are unchanged (18 rows, 272.7 grid, 60.3 solar).

## [0.4.1] - 2026-08-31

### Added
- Calendar coverage summary (`coverage`): recorded days, span, density, and `kind` (`daily` / `sparse` / `short`). Missing dates are listed only for dense daily series (cap 60).
- Month-over-month `mom_grid` and `mom_bill` on monthly aggregates, with studio table columns.
- Compare join mode: `household_day` when both files have more than one household, otherwise `day`.
- Studio coverage callout and TOU status banner.
- Node/JS parity test against `assets/analysis.js` (skipped if `node` is missing).

### Changed
- TOU retiering no longer overwrites peak/shoulder/off-peak values that came from CSV columns (`tier_source: "csv"`). Split-from-total rows remain eligible.
- `apply_tou` skips the whole frame only when every row lacks an hour, not when a single row is missing one.
- Sample CSV parse totals are unchanged (18 rows, 272.7 grid, 60.3 solar).

## [0.4.0] - 2026-08-31

### Added
- Daily supply charge (`1.10` AUD/day) and GST (`0.10`) on the retailer-style bill.
- Named plan comparison: Flex Saver, Solar Plus, Flat Comfort (`compare_plans`, CLI `--plans`, studio cards).
- Quantified recommendation savings (`saving_aud`) plus a studio hero card.
- Date-order control (`dmy` default, `mdy`, `auto`) on parse, CLI, and studio.
- Household-aware anomalies: per-household mean when that household has ≥ 4 rows, else global; `baseline` and `baseline_kwh` on each flag.
- Optional NSW-style TOU retiering from hour (`--tou`, studio checkbox).
- Studio onboarding strip, supply/GST tariff fields, and anomaly baseline column.

### Changed
- `estimate_bill` is now GST-inclusive: `(energy + daily_supply × distinct_days − export) × (1 + gst)`.
- Totals expose `tariff_bill` (inc GST), `tariff_bill_ex_gst`, `supply_charge`, and `gst_amount`.
- Ambiguous dates such as `01/02/2025` are 1 February under the new `dmy` default (was the 0.3 `auto` heuristic).
- Recommendations are sorted by `saving_aud` descending; spend review includes a projected 30-day cost.
- Existing tests that asserted kWh-only bills were updated to the supply + GST formula. Sample CSV parse totals are unchanged (18 rows, 272.7 grid, 60.3 solar).

## [0.3.0] - 2026-08-17

### Added
- Python analysis engine and CLI (`python3 -m gridscope`) that does not need R.
- `make demo-py`, `make test`, and `make verify-py` targets.
- Tariff bill math (peak / shoulder / off-peak / export credit) with live studio rebill.
- Dataset compare: delta kWh, delta bill, and shared days.
- Household filter when a file contains multiple `household_id` values.
- Weekday heatmap (month buckets, or hour when a timestamp hour is present).
- CSV export of the current monthly analysis table.
- pytest coverage for parse, anomalies, tariff bills, compare, and missing columns.
- GitHub Actions job that always runs pytest on Python 3.11.

### Changed
- Browser analysis extracted to `assets/analysis.js`; formulas stay aligned with `gridscope/analysis.py`.
- R and Python HTML reports share `assets/studio-panel.html` so both UIs get the new controls.
- R pipeline job in CI is `continue-on-error` so the Python tests remain the required gate.

## [0.2.0] - 2026-07-06

### Added
- SQL queries for unusual usage days and savings opportunities.
- Anomaly chart and recommendation cards in custom HTML reports.
- Browser-side anomaly detection, savings recommendations, and JSON export.
- Dark mode toggle with persisted theme preference.
- `Makefile` with `demo`, `custom`, `verify`, and `clean` targets.
- GitHub Actions CI to run the R/SQLite pipeline and verify outputs.

### Changed
- Personal analysis panel now includes unusual-day charts and savings guidance.
- Studio styling updated with theme variables for light and dark modes.
- README expanded with new analysis outputs and workflow commands.

## [0.1.0] - 2026-05-06

### Added
- R + SQLite analytics pipeline with reusable SQL query files.
- Browser report with local CSV upload and sample data.
- Demo portfolio analysis with charts, tables, and observations.
