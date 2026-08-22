.PHONY: demo custom clean verify test test-r test-js sample help

INPUT ?= data/sample_energy_upload.csv
OUTPUT ?= output/custom-report.html

help:
	@echo "Targets:"
	@echo "  make demo     Build the demo portfolio report"
	@echo "  make custom   Analyse a CSV (override INPUT and OUTPUT)"
	@echo "  make test     Run the R and browser test suites"
	@echo "  make sample   Regenerate data/sample_energy_upload.csv"
	@echo "  make verify   Run the pipeline and check required outputs"
	@echo "  make clean    Remove generated outputs"

demo:
	Rscript R/run_analysis.R
	@echo "Open output/report.html"

custom:
	Rscript R/run_analysis.R --input $(INPUT) --output $(OUTPUT)
	@echo "Open $(OUTPUT)"

test: test-r test-js

test-r:
	Rscript tests/test_analysis.R

test-js:
	node tests/js/run.mjs

sample:
	Rscript scripts/make_sample_csv.R

verify: test demo custom
	test -f output/report.html
	test -f output/custom-report.html
	test -f output/tables/user_anomalies.csv
	test -f output/tables/user_savings_opportunities.csv
	@echo "Verification passed."

clean:
	rm -rf output/tables/*.csv output/figures/*.png output/report.html output/custom-report.html data/*.sqlite data/user_*.csv
