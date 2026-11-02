#!/usr/bin/env bash
# Compile the report with Tectonic (XeTeX). Figures in figs/out/ and the number
# macros in results/numbers.tex are committed, so this works from a clean clone.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TECTONIC="${TECTONIC:-tectonic}"
cd "$ROOT/report"

TECTONIC_CACHE_DIR="${TECTONIC_CACHE_DIR:-$ROOT/.texcache}" \
  "$TECTONIC" -X compile main.tex

cp main.pdf "$ROOT/ACPU-1_Technical_Report.pdf"
echo "report -> ACPU-1_Technical_Report.pdf"
