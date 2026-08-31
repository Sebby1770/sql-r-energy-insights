"""HTML and table writers for the Python GridScope path."""

from __future__ import annotations

import html
import json
import os
from pathlib import Path
from typing import Any, Mapping

from gridscope.analysis import (
    DEFAULT_TARIFF,
    VERSION,
    analysis_table,
    coerce_tariff,
    table_to_csv,
)

STUDIO_PANEL = "studio-panel.html"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def os_relpath(target: Path, start: Path) -> str:
    return Path(os.path.relpath(target.resolve(), start.resolve())).as_posix()


def load_studio_panel(
    template_href: str,
    tariff: Mapping[str, float] | None = None,
) -> str:
    rates = coerce_tariff(DEFAULT_TARIFF if tariff is None else tariff)
    path = project_root() / "assets" / STUDIO_PANEL
    text = path.read_text(encoding="utf-8")
    replacements = {
        "{{TEMPLATE_HREF}}": template_href,
        "{{TARIFF_PEAK}}": f"{float(rates['peak']):.2f}",
        "{{TARIFF_SHOULDER}}": f"{float(rates['shoulder']):.2f}",
        "{{TARIFF_OFFPEAK}}": f"{float(rates['offpeak']):.2f}",
        "{{TARIFF_EXPORT}}": f"{float(rates['export_credit']):.2f}",
        "{{TARIFF_SUPPLY}}": f"{float(rates['daily_supply']):.2f}",
        "{{TARIFF_GST}}": f"{float(rates['gst']):.2f}",
    }
    for token, value in replacements.items():
        text = text.replace(token, value)
    return text


def _money(value: float | None) -> str:
    if value is None:
        return "Not supplied"
    sign = "-" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}"


def _number(value: float, digits: int = 1) -> str:
    return f"{value:,.{digits}f}"


def _table(rows: list[Mapping[str, Any]], columns: list[tuple[str, str]], limit: int = 12) -> str:
    if not rows:
        return "<p class=\"chart-note\">No rows.</p>"
    header = "".join(f"<th>{html.escape(label)}</th>" for _, label in columns)
    body_parts: list[str] = []
    for row in rows[:limit]:
        cells = []
        for key, _ in columns:
            value = row.get(key)
            if value is None:
                text = "—"
            elif isinstance(value, float):
                moneyish = any(
                    token in key
                    for token in ("bill", "gst", "supply", "saving", "delta")
                )
                text = _number(value, 2 if moneyish else 1)
            else:
                text = str(value)
            cells.append(f"<td>{html.escape(text)}</td>")
        body_parts.append("<tr>" + "".join(cells) + "</tr>")
    return (
        "<div class=\"table-wrap\"><table><thead><tr>"
        + header
        + "</tr></thead><tbody>"
        + "".join(body_parts)
        + "</tbody></table></div>"
    )


def _recs(recommendations: list[Mapping[str, Any]]) -> str:
    if not recommendations:
        return "<p>No major savings opportunities were flagged for this dataset.</p>"
    items = []
    for item in recommendations:
        impact = html.escape(str(item.get("impact") or "low"))
        saving = item.get("saving_aud")
        saving_html = ""
        if saving is not None:
            saving_html = f" <span class=\"saving\">{html.escape(_money(float(saving)))}</span>"
        items.append(
            "<li><strong>"
            + html.escape(str(item.get("opportunity") or ""))
            + "</strong> "
            + html.escape(str(item.get("detail") or ""))
            + saving_html
            + f' <span class="impact impact-{impact}">{impact} impact</span></li>'
        )
    return "<ul class=\"insight-list\">" + "".join(items) + "</ul>"


def write_tables(analysis: Mapping[str, Any], tables_dir: Path) -> list[Path]:
    tables_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    monthly_path = tables_dir / "py_monthly_usage.csv"
    monthly_path.write_text(table_to_csv(analysis_table(analysis)), encoding="utf-8")
    written.append(monthly_path)

    groups = []
    for item in analysis.get("groups") or []:
        groups.append(
            {
                "group": item["key"],
                "records": item["records"],
                "households": item["households"],
                "grid_kwh": round(float(item["grid"]), 3),
                "solar_kwh": round(float(item["solar"]), 3),
                "consumed_kwh": round(float(item["consumed"]), 3),
                "tariff_bill": None
                if item.get("tariff_bill") is None
                else round(float(item["tariff_bill"]), 2),
            }
        )
    group_path = tables_dir / "py_group_summary.csv"
    group_path.write_text(table_to_csv(groups), encoding="utf-8")
    written.append(group_path)

    anomaly_rows = []
    for item in analysis.get("anomalies") or []:
        anomaly_rows.append(
            {
                "day": item["day"],
                "household": item["household"],
                "neighbourhood": item["neighbourhood"],
                "grid_kwh": round(float(item["grid"]), 3),
                "pct_of_average": round(float(item["pct_of_average"]), 1),
                "anomaly_type": item["anomaly_type"],
                "baseline": item.get("baseline"),
                "baseline_kwh": None
                if item.get("baseline_kwh") is None
                else round(float(item["baseline_kwh"]), 3),
            }
        )
    anomaly_path = tables_dir / "py_anomalies.csv"
    anomaly_path.write_text(table_to_csv(anomaly_rows), encoding="utf-8")
    written.append(anomaly_path)

    rec_path = tables_dir / "py_recommendations.csv"
    rec_path.write_text(table_to_csv(list(analysis.get("recommendations") or [])), encoding="utf-8")
    written.append(rec_path)

    totals = analysis.get("totals") or {}
    quality_path = tables_dir / "py_quality.csv"
    quality_path.write_text(table_to_csv([totals]), encoding="utf-8")
    written.append(quality_path)

    heat_path = tables_dir / "py_heatmap.csv"
    heat_cells = []
    for item in (analysis.get("heatmap") or {}).get("cells") or []:
        heat_cells.append(
            {
                "weekday": item["weekday"],
                "bucket": item["bucket"],
                "grid": round(float(item["grid"]), 3),
                "records": item["records"],
            }
        )
    heat_path.write_text(table_to_csv(heat_cells), encoding="utf-8")
    written.append(heat_path)

    plan_payload = analysis.get("plans") or {}
    plan_rows = []
    for item in plan_payload.get("plans") or []:
        plan_rows.append(
            {
                "name": item.get("name"),
                "bill": round(float(item.get("bill") or 0), 2),
                "delta_vs_cheapest": round(float(item.get("delta_vs_cheapest") or 0), 2),
                "winner": bool(item.get("winner")),
            }
        )
    if plan_rows:
        plan_path = tables_dir / "py_plans.csv"
        plan_path.write_text(table_to_csv(plan_rows), encoding="utf-8")
        written.append(plan_path)

    return written


def write_html_report(
    analysis: Mapping[str, Any],
    html_path: Path,
    *,
    source_csv: str,
    source_label: str,
    compare: Mapping[str, Any] | None = None,
    tables_dir: Path | None = None,
) -> Path:
    root = project_root()
    html_path = Path(html_path)
    html_path.parent.mkdir(parents=True, exist_ok=True)
    assets = root / "assets"
    sample = root / "data" / "sample_energy_upload.csv"
    assets_href = os_relpath(assets, html_path.parent)
    sample_href = os_relpath(sample, html_path.parent)
    tariff = coerce_tariff(analysis.get("tariff") or DEFAULT_TARIFF)
    workspace = load_studio_panel(sample_href, tariff)

    totals = analysis["totals"]
    monthly = analysis["monthly"]
    groups = analysis["groups"]
    highest = max(monthly, key=lambda item: item["grid"]) if monthly else None
    lowest = min(monthly, key=lambda item: item["grid"]) if monthly else None
    consumed = float(totals.get("consumed") or 0)
    solar_pct = (float(totals.get("solar") or 0) / consumed) * 100 if consumed else 0.0
    peak_pct = (float(totals.get("peak") or 0) / consumed) * 100 if consumed else 0.0
    savings = sum(
        float(item.get("saving_aud") or 0)
        for item in (analysis.get("recommendations") or [])
    )
    plans = analysis.get("plans") or {}
    plan_rows = list(plans.get("plans") or [])
    cheapest = plans.get("cheapest") or "—"

    compare_html = ""
    if compare is not None:
        compare_html = f"""
<section class="report-section">
<h2>Engine compare snapshot</h2>
<div class="metrics">
<div class="metric"><span>Shared days</span><strong>{compare['shared_days']}</strong></div>
<div class="metric"><span>Δ grid import</span><strong>{_number(compare['delta_kwh'])} kWh</strong></div>
<div class="metric"><span>Δ tariff bill</span><strong>{_money(compare['delta_bill'])}</strong></div>
<div class="metric"><span>Shared-day Δ kWh</span><strong>{_number(compare['shared_delta_kwh'])} kWh</strong></div>
</div>
</section>
"""

    bootstrap = {
        "csv": source_csv,
        "label": source_label,
        "tariff": tariff,
        "household": analysis.get("household") or "all",
        "tou": bool(analysis.get("tou")),
        "date_order": analysis.get("date_order") or "dmy",
    }

    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GridScope Studio</title>
<link rel="stylesheet" href="{html.escape(assets_href)}/studio.css">
</head>
<body>
<header>
<p class="eyebrow">GridScope {html.escape(VERSION)}</p>
<h1>GridScope Studio</h1>
<p class="lede">Python engine snapshot plus the local studio: household filter, live tariff rebill, plan compare, weekday heatmap, and CSV export. Data stays in the browser after this page is written.</p>
</header>
<main>
{workspace}

<section class="report-section">
<h2>Python engine snapshot</h2>
<p class="chart-note">Static copy of the CLI analysis for {html.escape(source_label)}. Interactive charts above use the same formulas.</p>
<div class="metrics">
<div class="metric"><span>Records</span><strong>{totals['records']}</strong></div>
<div class="metric"><span>Days covered</span><strong>{totals['days']}</strong></div>
<div class="metric"><span>Households</span><strong>{totals['households']}</strong></div>
<div class="metric"><span>Grid import</span><strong>{_number(totals['grid'])} kWh</strong></div>
<div class="metric"><span>Solar export</span><strong>{_number(totals['solar'])} kWh</strong></div>
<div class="metric"><span>Supply charge</span><strong>{_money(totals.get('supply_charge'))}</strong></div>
<div class="metric"><span>GST</span><strong>{_money(totals.get('gst_amount'))}</strong></div>
<div class="metric"><span>Bill ex GST</span><strong>{_money(totals.get('tariff_bill_ex_gst'))}</strong></div>
<div class="metric"><span>Tariff bill</span><strong>{_money(totals['tariff_bill'])}</strong></div>
<div class="metric"><span>This month you could save</span><strong>{_money(savings)}</strong></div>
<div class="metric"><span>Cheapest plan</span><strong>{html.escape(str(cheapest))}</strong></div>
</div>
<ul class="insight-list">
<li>Highest grid import month: {html.escape(highest['key']) if highest else "—"} at {_number(highest['grid']) if highest else "0"} kWh.</li>
<li>Lowest grid import month: {html.escape(lowest['key']) if lowest else "—"} at {_number(lowest['grid']) if lowest else "0"} kWh.</li>
<li>Solar exports equal {_number(solar_pct)}% of recorded consumption.</li>
<li>Peak usage is {_number(peak_pct)}% of recorded consumption.</li>
<li>CSV estimated spend is {_money(totals.get('bill'))}.</li>
</ul>
<h3>Monthly table</h3>
{_table(analysis_table(analysis), [
    ("month", "Month"),
    ("grid_kwh", "Grid import"),
    ("solar_kwh", "Solar export"),
    ("consumed_kwh", "Consumed"),
    ("tariff_bill", "Tariff bill"),
])}
<h3>Plans</h3>
{_table(plan_rows, [
    ("name", "Plan"),
    ("bill", "Bill"),
    ("delta_vs_cheapest", "Δ vs cheapest"),
    ("winner", "Winner"),
])}
<h3>Groups</h3>
{_table(groups, [
    ("key", "Group"),
    ("records", "Records"),
    ("households", "Households"),
    ("grid", "Grid import"),
    ("solar", "Solar export"),
])}
<h3>Unusual days</h3>
{_table(list(analysis.get("anomalies") or []), [
    ("day", "Day"),
    ("household", "Household"),
    ("grid", "Grid import"),
    ("pct_of_average", "% of average"),
    ("anomaly_type", "Type"),
    ("baseline", "Baseline"),
    ("baseline_kwh", "Baseline kWh"),
])}
<h3>Savings opportunities</h3>
{_recs(list(analysis.get("recommendations") or []))}
</section>
{compare_html}
</main>
<script>window.GRIDSCOPE_BOOTSTRAP = {json.dumps(bootstrap, ensure_ascii=True)};</script>
<script src="{html.escape(assets_href)}/analysis.js"></script>
<script src="{html.escape(assets_href)}/studio.js"></script>
</body>
</html>
"""
    html_path.write_text(page, encoding="utf-8")
    if tables_dir is not None:
        write_tables(analysis, Path(tables_dir))
    return html_path
