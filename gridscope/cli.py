"""Command-line interface: python3 -m gridscope path/to.csv --html out.html"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from gridscope.analysis import (
    DEFAULT_TARIFF,
    VERSION,
    GridScopeError,
    apply_tou,
    compare_datasets,
    dedupe_rows,
    filter_household,
    get_analysis,
    load_csv,
    serialise_analysis,
)
from gridscope.report import write_html_report, write_tables


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m gridscope",
        description="Analyse a household energy CSV without R.",
    )
    parser.add_argument("input", help="Path to a meter or billing CSV")
    parser.add_argument("--html", help="Write a studio HTML report to this path")
    parser.add_argument("--json", dest="json_path", help="Write analysis JSON to this path")
    parser.add_argument(
        "--tables",
        help="Directory for CSV tables (default: <html-dir>/tables when --html is set)",
    )
    parser.add_argument("--compare", help="Second CSV to compare against the primary file")
    parser.add_argument("--household", help="Restrict analysis to one household_id")
    parser.add_argument(
        "--date-order",
        choices=("dmy", "mdy", "auto"),
        default="dmy",
        help="How to read calendar dates such as 01/02/2025 (default: dmy)",
    )
    parser.add_argument("--tariff-peak", type=float, default=DEFAULT_TARIFF["peak"])
    parser.add_argument("--tariff-shoulder", type=float, default=DEFAULT_TARIFF["shoulder"])
    parser.add_argument("--tariff-offpeak", type=float, default=DEFAULT_TARIFF["offpeak"])
    parser.add_argument(
        "--tariff-export",
        type=float,
        default=DEFAULT_TARIFF["export_credit"],
        help="Solar export credit in AUD/kWh",
    )
    parser.add_argument(
        "--tariff-supply",
        type=float,
        default=DEFAULT_TARIFF["daily_supply"],
        help="Daily supply charge in AUD/day",
    )
    parser.add_argument(
        "--tariff-gst",
        type=float,
        default=DEFAULT_TARIFF["gst"],
        help="GST rate applied to energy + supply - export (default: 0.10)",
    )
    parser.add_argument(
        "--tou",
        action="store_true",
        help="Retier grid kWh from hour using NSW-style weekday windows",
    )
    parser.add_argument(
        "--plans",
        action="store_true",
        help="Compare Flex Saver / Solar Plus / Flat Comfort on this usage",
    )
    parser.add_argument(
        "--dedupe",
        action="store_true",
        help="Sum duplicate (household, day) rows before analysis",
    )
    parser.add_argument("--version", action="version", version=f"GridScope {VERSION}")
    return parser


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def _print_plans(plans: dict) -> None:
    rows = (plans or {}).get("plans") or []
    if not rows:
        return
    print("Plans")
    for item in rows:
        mark = "*" if item.get("winner") else " "
        print(
            f"{mark} {item['name']:<13} ${item['bill']:.2f}  "
            f"Δ ${item['delta_vs_cheapest']:.2f}"
        )
    cheapest = (plans or {}).get("cheapest")
    if cheapest:
        print(f"Cheapest     {cheapest}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    tariff = {
        "peak": args.tariff_peak,
        "shoulder": args.tariff_shoulder,
        "offpeak": args.tariff_offpeak,
        "export_credit": args.tariff_export,
        "daily_supply": args.tariff_supply,
        "gst": args.tariff_gst,
    }

    try:
        input_path = Path(args.input)
        rows = load_csv(input_path, date_order=args.date_order)
        analysis = get_analysis(
            rows,
            tariff=tariff,
            household=args.household,
            tou=args.tou,
            date_order=args.date_order,
            dedupe=args.dedupe,
        )
        comparison = None
        if args.compare:
            compare_rows = load_csv(args.compare, date_order=args.date_order)
            if args.household:
                filtered = filter_household(compare_rows, args.household)
                if filtered:
                    compare_rows = filtered
            if args.tou:
                compare_rows = apply_tou(compare_rows)
            if args.dedupe:
                compare_rows = dedupe_rows(compare_rows)
            comparison = compare_datasets(analysis["rows"], compare_rows, tariff)

        html_path = Path(args.html) if args.html else None
        tables_dir = Path(args.tables) if args.tables else None
        if html_path is not None and tables_dir is None:
            tables_dir = html_path.parent / "tables"

        if html_path is not None:
            if not html_path.is_absolute():
                html_path = (Path.cwd() / html_path).resolve()
            write_html_report(
                analysis,
                html_path,
                source_csv=_read_text(input_path),
                source_label=input_path.name,
                compare=comparison,
                tables_dir=tables_dir,
            )
            print(f"Wrote report: {html_path}")

        if tables_dir is not None and html_path is None:
            written = write_tables(analysis, tables_dir)
            for path in written:
                print(f"Wrote table: {path}")

        if args.json_path:
            payload = serialise_analysis(analysis)
            if comparison is not None:
                payload["compare"] = comparison
            json_path = Path(args.json_path)
            json_path.parent.mkdir(parents=True, exist_ok=True)
            json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            print(f"Wrote JSON: {json_path}")

        if html_path is None and args.json_path is None and tables_dir is None:
            totals = analysis["totals"]
            print(f"GridScope {VERSION}")
            print(f"Records     {totals['records']}")
            print(f"Days        {totals['days']}")
            print(f"Households  {totals['households']}")
            print(f"Grid kWh    {totals['grid']:.1f}")
            print(f"Solar kWh   {totals['solar']:.1f}")
            print(f"Supply      ${totals['supply_charge']:.2f}")
            print(f"GST         ${totals['gst_amount']:.2f}")
            print(f"Ex GST      ${totals['tariff_bill_ex_gst']:.2f}")
            print(f"Tariff bill ${totals['tariff_bill']:.2f}")
            if comparison is not None:
                print(f"Shared days {comparison['shared_days']}")
                print(f"Δ kWh       {comparison['delta_kwh']:.1f}")
                print(f"Δ bill      ${comparison['delta_bill']:.2f}")

        if args.plans:
            _print_plans(analysis.get("plans") or {})

        if tables_dir is not None and html_path is not None:
            print(f"Wrote tables: {tables_dir}")
        return 0
    except GridScopeError as exc:
        print(f"gridscope: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"gridscope: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
