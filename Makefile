.PHONY: demo custom clean verify help demo-py demo-nem12 verify-py test test-r test-all samples samples-check site

INPUT ?= data/sample_energy_upload.csv
OUTPUT ?= output/custom-report.html

help:
	@echo "Targets:"
	@echo "  make demo-py      Analyse the daily sample with the Python engine"
	@echo "  make demo-nem12   Analyse the NEM12 interval sample with the Python engine"
	@echo "  make test         Run pytest (no R required; uses node for parity tests if present)"
	@echo "  make test-r       Run the base-R tests for the R + SQLite pipeline"
	@echo "  make test-all     Run both test suites"
	@echo "  make samples      Regenerate data/sample_*.csv (deterministic)"
	@echo "  make samples-check  Fail if the checked-in samples are stale"
	@echo "  make site         Build the GitHub Pages studio into _site/"
	@echo "  make demo         Build the demo portfolio report (R + SQLite)"
	@echo "  make custom       Analyse a CSV with R (override INPUT and OUTPUT)"
	@echo "  make verify       Run the R pipeline and check required outputs"
	@echo "  make verify-py    Run pytest and the Python report paths"
	@echo "  make clean        Remove generated outputs"

demo:
	Rscript R/run_analysis.R
	@echo "Open output/report.html"

custom:
	Rscript R/run_analysis.R --input $(INPUT) --output $(OUTPUT)
	@echo "Open $(OUTPUT)"

demo-py:
	python3 -m gridscope data/sample_energy_upload.csv --html output/py-report.html --plans
	@echo "Open output/py-report.html"

demo-nem12:
	python3 -m gridscope data/sample_nem12.csv --html output/py-nem12-report.html \
		--tables output/tables/nem12 --plans --battery-cost 9000
	@echo "Open output/py-nem12-report.html"

test:
	python3 -m pytest -q

test-r:
	Rscript tests/test_analysis.R

test-all: test test-r

samples:
	python3 scripts/make_samples.py

samples-check:
	python3 scripts/make_samples.py --check

site:
	python3 scripts/build_site.py
	@echo "Serve with: python3 -m http.server --directory _site 8000"

verify: demo custom
	test -f output/report.html
	test -f output/custom-report.html
	test -f output/tables/user_anomalies.csv
	test -f output/tables/user_savings_opportunities.csv
	@echo "Verification passed."

verify-py: test samples-check demo-py demo-nem12
	test -f output/py-report.html
	test -f output/py-nem12-report.html
	test -f output/tables/py_monthly_usage.csv
	test -f output/tables/py_anomalies.csv
	test -f output/tables/py_battery.csv
	@echo "Python verification passed."

clean:
	rm -rf output/tables/*.csv output/tables/nem12 output/figures/*.png output/report.html \
		output/custom-report.html output/py-report.html output/py-nem12-report.html \
		data/*.sqlite data/user_*.csv _site
