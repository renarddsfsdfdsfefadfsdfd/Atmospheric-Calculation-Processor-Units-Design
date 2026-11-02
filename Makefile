PYTHON  ?= python3
RSCRIPT ?= Rscript
TECTONIC ?= tectonic

.PHONY: all sim figures figures-data figures-html report app-install app-test app-dist clean

all: sim figures report

sim:
	$(PYTHON) sim/run_all.py

figures: figures-data figures-html

figures-data:
	$(RSCRIPT) figs/src/f01.R
	$(RSCRIPT) figs/src/figs_data1.R
	$(RSCRIPT) figs/src/figs_data2.R

figures-html:
	bash scripts/build-figures.sh

report:
	bash scripts/build-report.sh

app-install:
	npm --prefix app install

app-test:
	node app/tools/selftest.mjs

app-dist:
	bash scripts/package-app.sh

clean:
	rm -rf .texcache report/main.pdf app/.cache app/dist app/node_modules
