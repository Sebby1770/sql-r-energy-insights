# Changelog

All notable changes to GridScope Studio are documented in this file.

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
