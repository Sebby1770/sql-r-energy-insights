"""Assemble the GitHub Pages studio (stdlib only).

    python3 scripts/build_site.py            # writes _site/
    python3 scripts/build_site.py --out DIR

web/index.html is the page shell (atmosphere, header, hero, footer) with a
{{STUDIO_PANEL}} placeholder. The studio markup itself comes from
assets/studio-panel.html, the same file every Python and R report embeds, so the
site and the reports cannot drift apart. Tokens are filled by
gridscope.report.load_studio_panel; the site adds data-autoload="sample" so the
sample is live on first visit.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gridscope.analysis import DEFAULT_TARIFF  # noqa: E402
from gridscope.report import load_studio_panel  # noqa: E402

PLACEHOLDER = "{{STUDIO_PANEL}}"
COPIES = {
    "web/404.html": "404.html",
    "assets/studio.css": "studio.css",
    "assets/studio.js": "studio.js",
    "assets/analysis.js": "analysis.js",
    "data/sample_energy_upload.csv": "sample_energy_upload.csv",
    "data/sample_nem12.csv": "sample_nem12.csv",
}


def build(out_dir: Path) -> list[Path]:
    template = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    if template.count(PLACEHOLDER) != 1:
        raise SystemExit(f"web/index.html must contain {PLACEHOLDER} exactly once")
    panel = load_studio_panel(
        "sample_energy_upload.csv",
        DEFAULT_TARIFF,
        nem12_href="sample_nem12.csv",
        autoload="sample",
    )
    page = template.replace(PLACEHOLDER, panel)
    if "{{" in page:
        raise SystemExit("index.html still contains an unfilled {{token}}")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    written = [out_dir / "index.html"]
    written[0].write_text(page, encoding="utf-8")
    for source, target in COPIES.items():
        destination = out_dir / target
        shutil.copyfile(ROOT / source, destination)
        written.append(destination)
    nojekyll = out_dir / ".nojekyll"
    nojekyll.write_text("", encoding="utf-8")
    written.append(nojekyll)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the GridScope Pages site.")
    parser.add_argument("--out", default=str(ROOT / "_site"), help="Output directory (default: _site)")
    args = parser.parse_args(argv)
    out_dir = Path(args.out).resolve()
    if out_dir == ROOT or ROOT.is_relative_to(out_dir):
        raise SystemExit("Refusing to build into the repository root or a parent of it")
    written = build(out_dir)
    print(f"Built {len(written)} files into {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
