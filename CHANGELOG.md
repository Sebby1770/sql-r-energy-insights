# Changelog

All notable changes to GridScope Studio are documented in this file.

## [0.3.0] - 2026-08-22

### Fixed
- **sqlite3 warnings corrupted query results.** `query_to_frame` ran sqlite with
  `stdout = TRUE, stderr = TRUE`, so anything written to stderr was spliced into
  the CSV it then parsed. stderr is now captured separately and reported.
- **Date formats were guessed per row.** A column containing both `1/2/2024` and
  `13/2/2024` was read under two different conventions at once. One layout is
  now chosen for the whole column; ambiguous day/month columns are read
  day-first and say so.
- **`as.Date` accepted partial matches.** `as.Date("1/2/2024", "%Y/%m/%d")`
  returns the year 1 — a wrong date that also won on parse count. Layouts are
  now matched by regex against the whole string and built from their parts, and
  impossible days like 31 February are rejected instead of rolling forward.
- **Browser dates were off by one day.** `toISOString()` on a local-midnight
  Date shifts backwards in every timezone ahead of UTC, mislabelling every row
  of the anomaly table and miscounting distinct days.
- **Anomaly detection was neither robust nor per-household.** Readings were
  compared to the mean of all readings at ±50%. On the sample dataset that
  flagged 169 of 1,460 rows, mostly differences in house size, and an extreme
  outlier could inflate the mean enough to hide a genuine second spike. Each
  household is now scored against its own median and MAD (modified z-score,
  |z| >= 3.5), with a ratio fallback for short or flat series. The same rule
  now runs in the browser, so both paths return identical results.
- **Empty result sets crashed the report writers.** `frame[order(...), ][1, ]`
  on zero rows produced a row of NAs that reached the page as "NA kWh".
- **`--output` outside `output/` produced an unstyled page.** Reports linked
  `../assets/studio.css`; the stylesheet is now inlined, making each report a
  single portable file.
- **Non-numeric values were silently read as zero.** They are now counted and
  reported; blank cells still mean "no reading".

### Added
- `tests/test_analysis.R` — 39 tests over parsing, HTML rendering, and the SQL
  queries end-to-end against a temporary database. Base R only, no testthat.
- `tests/js/run.mjs` — 34 tests over the browser analysis code, which
  `assets/studio.js` now exports for the purpose.
- `make test`, `make test-r`, `make test-js`, `make sample`.
- `scripts/make_sample_csv.R` and a realistic sample dataset: a year of daily
  readings for four households with three planted anomalies, replacing 18 rows
  spread over eight households that gave the detector nothing to work with.
- A `tier_source` column, and an explicit notice in the report when the
  peak/shoulder/off-peak split was modelled from a single total rather than
  measured — every peak-share figure depends on that assumption.
- Data-quality reporting: skipped rows, unreadable values, negative readings.
- GitHub Pages publishing of the demo report.
- Indexes on `user_readings(household_id)` and `(day)`.

### Changed
- The "Try Sample" button loads the full sample dataset when the page is served
  over http, falling back to an embedded extract offline.
- CI runs both test suites and checks the sample dataset is reproducible.

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