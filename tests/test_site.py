"""The Pages site and the Python report embed the same studio panel."""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUDIO_JS = (ROOT / "assets" / "studio.js").read_text(encoding="utf-8")


def studio_ids() -> set[str]:
    """Every element id studio.js looks up, so markup drift fails here."""
    ids = set(re.findall(r'\$\("#([A-Za-z0-9_-]+)"\)', STUDIO_JS))
    ids |= set(re.findall(r'getElementById\("([A-Za-z0-9_-]+)"\)', STUDIO_JS))
    for group in re.findall(r"\[((?:\"[a-z0-9-]+\",?\s*)+)\]\.forEach", STUDIO_JS):
        # Element ids are kebab-case; event-name lists ("dragenter") are not.
        ids |= set(re.findall(r'"([a-z0-9]+-[a-z0-9-]+)"', group))
    # The site clock lives in the page shell, not the shared panel.
    return ids - {"grid-clock"}


def test_build_site_embeds_the_shared_panel(tmp_path):
    out = tmp_path / "site"
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_site.py"), "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    index = (out / "index.html").read_text(encoding="utf-8")
    assert "{{" not in index
    assert 'id="upload-studio" data-autoload="sample"' in index
    ids = studio_ids()
    assert len(ids) > 40
    missing = sorted(i for i in ids if f'id="{i}"' not in index)
    assert not missing, missing
    assert 'id="grid-clock"' in index
    assert 'data-href="sample_nem12.csv"' in index
    assert 'href="sample_energy_upload.csv"' in index
    for name in (
        "404.html",
        "studio.css",
        "studio.js",
        "analysis.js",
        "sample_energy_upload.csv",
        "sample_nem12.csv",
        ".nojekyll",
    ):
        assert (out / name).is_file(), name
    assert (out / "sample_nem12.csv").read_bytes() == (ROOT / "data" / "sample_nem12.csv").read_bytes()


def test_build_site_refuses_the_repo_root():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_site.py"), "--out", str(ROOT)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert (ROOT / "gridscope").is_dir()


def test_python_report_links_samples_and_does_not_autoload(tmp_path):
    from gridscope.cli import main

    html_path = tmp_path / "reports" / "r.html"
    assert main([str(ROOT / "data" / "sample_nem12.csv"), "--html", str(html_path)]) == 0
    text = html_path.read_text(encoding="utf-8")
    assert "{{" not in text
    assert "data-autoload" not in text
    match = re.search(r'id="load-nem12-sample" type="button" data-href="([^"]+)"', text)
    assert match, "NEM12 sample button missing"
    assert (html_path.parent / match.group(1)).resolve().is_file()
    template = re.search(r'class="template-link" href="([^"]+)"', text)
    assert template and (html_path.parent / template.group(1)).resolve().is_file()
    missing = sorted(i for i in studio_ids() if f'id="{i}"' not in text)
    assert not missing, missing
    # The live studio re-runs the engine with the CLI's plans and battery settings.
    assert '"plans": [' in text and '"battery": {' in text
