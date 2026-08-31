# GridScope 0.5 — Implementation Plan

**From:** 0.4.1  
**To:** 0.5.0 — weekday vs weekend cost, data-quality flags, live “what if I shift peak” slider, compare-by-month

Python remains source of truth; mirror in `assets/analysis.js`. No new runtime deps.

## Why

0.4 answers “what did I use and which plan is cheapest.” 0.5 answers the next three questions people ask after that:

1. Is the expensive usage on weekdays (shift-able) or weekends?
2. Is this CSV even trustworthy (duplicate days, negative kWh)?
3. If I moved N% of peak to off-peak, what would I save *on my tariff*?

## Work packages

1. **`weekend_split(rows, tariff)`** — weekday vs weekend kWh + GST-inclusive bills. Attach to `get_analysis` as `weekend`. Totals also gain `peak_share` and `solar_share` percents.
2. **`data_quality(rows)`** — duplicate `(household, day)` counts, negative energy rows, zero-grid days. Studio callout; never hide rows, only flag.
3. **`shift_peak(rows, fraction)`** — copy rows, move `fraction` of each row’s peak kWh into off-peak. `what_if_peak_shift(rows, tariff, fraction)` returns `{fraction, baseline_bill, shifted_bill, saving_aud}`. Studio slider 0–30%, live.
4. **Compare monthly** — when compare is on, emit `monthly_delta` list `{month, delta_kwh, delta_bill}` for shared months. Studio table.
5. Tests + JS parity extras for weekend split and a 10% peak shift on a 1-row fixture.
6. CHANGELOG / README / VERSION 0.5.0.

---

# GridScope 0.4 — Implementation Plan

**Product:** GridScope Studio  
**From:** 0.3.0 (stdlib Python engine + static studio + optional R portfolio)  
**To:** 0.4.0 — retailer-grade bills, dollar savings, honest dates, smarter anomalies, plan comparison

Python `gridscope/analysis.py` remains the source of truth. `assets/analysis.js` must stay aligned. Existing 0.3 tests must keep passing.

---

## Why this upgrade

0.3 turns a CSV into charts. That is a demo. A household actually wants:

1. What will my bill be, including the boring charges retailers add?
2. How many dollars do I save if I shift peak or use more of my solar?
3. Which of three plans is cheapest on *my* usage?
4. Which days look unusual *for this house*, not versus a neighbour’s mansion?

Those four questions are the 0.4 scope. No backend, no new runtime deps.

---

## Decision log

| Decision | Choice | Why |
| --- | --- | --- |
| Runtime deps | Still Python stdlib only | Keeps `make demo-py` and CI tiny |
| Date default | `dmy` (AU) with `--date-order mdy\|auto` | `01/02/2025` was silently 1 Feb |
| Anomalies | Per-household mean, then global fallback | Stops apartments being “low dips” forever |
| Bill extras | Daily supply + GST on energy+supply (export credit excluded) | Matches AU retail bills better than kWh-only |
| Plans | Three named presets in both Python and JS | The R demo already had this; the product path did not |
| Savings | Always compute dollars, even if small | Recs without $ are slogans |
| TOU | Optional NSW-style weekday windows when hour is present | Only used when timestamps exist; otherwise keep 44/34/22 |
| JS parity | Golden fixture tests via a shared JSON snapshot | Dual engines otherwise drift |

---

## Work packages

### WP1 — Tariff and bill model

Extend `DEFAULT_TARIFF` / `coerce_tariff`:

```
peak, shoulder, offpeak, export_credit, daily_supply, gst
```

Defaults: existing rates + `daily_supply=1.10` AUD/day + `gst=0.10`.

Bill:

```
energy = peak*peak + shoulder*shoulder + offpeak*offpeak
export = solar * export_credit
ex_gst = energy + daily_supply * distinct_days - export
inc_gst = ex_gst * (1 + gst)
```

`estimate_bill` returns GST-inclusive. Expose both `tariff_bill` (inc GST) and `tariff_bill_ex_gst` on totals.

CLI: `--tariff-supply`, `--tariff-gst`. Studio tariff editor gets the two extra fields.

Keep 0.3 behaviour for callers that omit the new keys by using the new defaults *only after* coerce — **do not** change sample CSV numbers in a way that breaks tests without updating assertions. Existing tests that assert exact bill amounts must be updated to the new formula, documented in CHANGELOG.

### WP2 — Date order

`parse_date_and_hour(value, date_order="dmy")`

- `dmy`: first component is day when both ≤ 12
- `mdy`: first component is month when both ≤ 12
- `auto`: keep 0.3 heuristic (`first > 12` ⇒ day-first)

`parse_energy_csv(text, date_order=...)`, `load_csv(..., date_order=...)`, CLI `--date-order`. JS `GridScope.parseEnergyCsv(text, {dateOrder})`. Studio select default **dmy**.

### WP3 — Household-aware anomalies

`get_anomalies(rows)`:

1. Group by household.
2. If a household has ≥ 4 days, compare each day to **that household’s** mean grid.
3. Else compare to the global mean of the current row set.
4. Add `baseline` (`household` or `global`) and `baseline_kwh`.

### WP4 — Quantified recommendations

Each rec gains `saving_aud` (number) plus a rewritten `detail` that names the dollars.

- Peak shift 10%: `0.10 * peak_kwh * (peak_rate - offpeak_rate) * (1+gst)`
- Solar self-consumption 50% of export: `0.50 * solar_kwh * (shoulder_rate - export_credit) * (1+gst)` (use shoulder as the daytime substitute)
- Spend review: keep daily average, plus projected month = `avg_daily * 30`

Sort recs by `saving_aud` descending. Studio shows a **This month you could save** hero card.

### WP5 — Plan comparison

Named plans (AUD):

| Plan | Peak | Shoulder | Off-peak | Export | Supply |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flex Saver | 0.40 | 0.28 | 0.18 | 0.08 | 1.10 |
| Solar Plus | 0.38 | 0.27 | 0.17 | 0.12 | 1.35 |
| Flat Comfort | 0.32 | 0.32 | 0.32 | 0.05 | 1.60 |

`compare_plans(rows, plans=None, gst=0.10)` returns bill, delta vs cheapest, and winner.

Studio: three plan cards; winner outlined. CLI `--plans` flag writes the table.

### WP6 — TOU from hour (opt-in)

When **any** row has `hour` and the caller passes `tou=True` (CLI `--tou`, studio checkbox):

NSW-ish windows on weekdays: peak 14–19, shoulder 7–13 and 20–21, else off-peak. Weekends all off-peak.

If the CSV already has peak/shoulder/offpeak columns, do **not** overwrite. Only retier from `grid`/`total`/`consumed`.

### WP7 — Studio UI (static, no framework)

Keep vanilla HTML/CSS/JS. Upgrade, don’t replace:

- Onboarding strip: “1. Load a CSV  2. Set your tariff  3. Read the $ savings”
- Hero savings + plan winner
- Date-order control, TOU toggle, supply/GST fields
- Anomaly table shows baseline
- Dark mode stays
- Sample CSV loaded from `data/sample_energy_upload.csv` via fetch when served over HTTP; keep a short inline fallback for `file://`

### WP8 — Tests

- Date order: `01/02/2025` is 1 Feb under dmy, 2 Jan under mdy
- Bill: 1 day, 10 kWh peak, rest 0, known supply/GST
- Anomalies: two households with different means
- Recs include `saving_aud` > 0 when peak share high
- Plan winner is deterministic on the sample CSV
- CLI `--date-order`, `--tariff-supply`, `--html` still contains studio IDs
- Existing sample parse totals (272.7 grid, 60.3 solar) **unchanged**

### Out of scope

NEM12 parser, weather regression, Python PNG export, rewriting the R pipeline, accounts/auth.

---

## Files

- `gridscope/analysis.py`, `cli.py`, `report.py`, `__init__.py`
- `assets/analysis.js`, `studio.js`, `studio.css`, `studio-panel.html`
- `tests/test_analysis.py`, `tests/test_cli.py`
- `README.md`, `CHANGELOG.md`, `Makefile`

## Acceptance

```
cd sql-r-energy-insights
python3 -m pytest -q
python3 -m gridscope data/sample_energy_upload.csv --html output/py-report.html
```

Studio opens, sample loads, plan cards and savings appear, tariff rebill still live.
