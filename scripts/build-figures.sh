#!/usr/bin/env bash
# Render the schematic figures (HTML/CSS) to vector PDF + PNG previews.
# Requires Electron, which is a devDependency of app/:  npm --prefix app install
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -x app/node_modules/.bin/electron ]; then
  ELECTRON="app/node_modules/.bin/electron"
elif command -v electron >/dev/null 2>&1; then
  ELECTRON="electron"
else
  echo "Electron not found. Run: npm --prefix app install" >&2
  exit 1
fi

"$ELECTRON" tools/htmlfig.js figs/html figs/out
echo "schematics -> figs/out"
