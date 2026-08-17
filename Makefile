.PHONY: demo custom clean verify help demo-py verify-py test

INPUT ?= data/sample_energy_upload.csv
OUTPUT ?= output/custom-report.html

help:
	@echo "Targets:"
	@echo "  make demo       Build the demo portfolio report (R + SQLite)"
	@echo "  make custom     Analyse a CSV with R (override INPUT and OUTPUT)"
	@echo "  make demo-py    Analyse the sample CSV with the Python engine"
	@echo "  make test       Run pytest (no R required)"
	@echo "  make verify     Run the R pipeline and check required outputs"
	@echo "  make verify-py  Run pytest and the Python report path"
	@echo "  make clean      Remove generated outputs"

demo:
	Rscript R/run_analysis.R
	@echo "Open output/report.html"

custom:
	Rscript R/run_analysis.R --input $(INPUT) --output $(OUTPUT)
	@echo "Open $(OUTPUT)"

demo-py:
	python3 -m gridscope data/sample_energy_upload.csv --html output/py-report.html
	@echo "Open output/py-report.html"

test:
	python3 -m pytest -q

verify: demo custom
	test -f output/report.html
	test -f output/custom-report.html
	test -f output/tables/user_anomalies.csv
	test -f output/tables/user_savings_opportunities.csv
	@echo "Verification passed."

verify-py: test demo-py
	test -f output/py-report.html
	test -f output/tables/py_monthly_usage.csv
	test -f output/tables/py_anomalies.csv
	@echo "Python verification passed."

clean:
	rm -rf output/tables/*.csv output/figures/*.png output/report.html output/custom-report.html output/py-report.html data/*.sqlite data/user_*.csv
