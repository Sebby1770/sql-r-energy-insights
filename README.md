# SQL + R Energy Insights

A small analytics project that uses SQL to model and query household energy data, then uses R to generate CSV summaries, charts, and an HTML report.

The project is intentionally lightweight: it uses base R and the `sqlite3` command line tool, so there are no R package installs required.

## What It Does

- Builds a SQLite database from `sql/schema.sql` and `sql/seed.sql`
- Generates one year of synthetic household energy readings with SQL
- Runs reusable SQL analysis queries from `sql/queries/`
- Exports analysis tables to `output/tables/`
- Creates PNG charts in `output/figures/`
- Writes a readable report to `output/report.html`

## Quick Start

```sh
Rscript R/run_analysis.R
```

Then open:

```sh
open output/report.html
```

## Requirements

- R 4.x
- SQLite CLI: `sqlite3`

On macOS, SQLite is usually already available. Check with:

```sh
sqlite3 --version
```

## Project Structure

```text
.
├── R/
│   └── run_analysis.R
├── sql/
│   ├── schema.sql
│   ├── seed.sql
│   └── queries/
├── data/
│   └── energy_insights.sqlite  # generated locally, not committed
└── output/
    ├── figures/
    ├── tables/
    └── report.html
```

## SQL Highlights

- Recursive CTEs generate a daily 2025 calendar
- Window functions rank household efficiency
- Aggregate queries compare energy plans, neighbourhood load mix, solar exports, and monthly demand
- Views provide a reusable daily load profile

## R Highlights

- Rebuilds the database from SQL files
- Executes SQL query files through SQLite
- Reads query results into base R data frames
- Produces charts with base R graphics
- Generates a static HTML report
