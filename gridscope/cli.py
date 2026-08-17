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
    compare_datasets,
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
    parser.add_argument("--tariff-peak", type=float, default=DEFAULT_TARIFF["peak"])
    parser.add_argument("--tariff-shoulder", type=float, default=DEFAULT_TARIFF["shoulder"])
    parser.add_argument("--tariff-offpeak", type=float, default=DEFAULT_TARIFF["offpeak"])
    parser.add_argument(
        "--tariff-export",
        type=float,
        default=DEFAULT_TARIFF["export_credit"],
        help="Solar export credit in AUD/kWh",
    )
    parser.add_argument("--version", action="version", version=f"GridScope {VERSION}")
    return parser


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    tariff = {
        "peak": args.tariff_peak,
        "shoulder": args.tariff_shoulder,
        "offpeak": args.tariff_offpeak,
        "export_credit": args.tariff_export,
    }

    try:
        input_path = Path(args.input)
        rows = load_csv(input_path)
        analysis = get_analysis(rows, tariff=tariff, household=args.household)
        comparison = None
        if args.compare:
            compare_rows = load_csv(args.compare)
            if args.household:
                filtered = filter_household(compare_rows, args.household)
                if filtered:
                    compare_rows = filtered
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
            print(f"Tariff bill ${totals['tariff_bill']:.2f}")
            if comparison is not None:
                print(f"Shared days {comparison['shared_days']}")
                print(f"Δ kWh       {comparison['delta_kwh']:.1f}")
                print(f"Δ bill      ${comparison['delta_bill']:.2f}")

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
