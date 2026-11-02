#!/usr/bin/env bash
# Package ACPU Studio. With no arguments: macOS (universal zip + dmg), Windows
# (NSIS x64/arm64 + portable) and Linux (AppImage + tar.gz).
#
#   scripts/package-app.sh --mac
#   scripts/package-app.sh --win
#   scripts/package-app.sh --linux
#   scripts/package-app.sh --dir        # quick unpacked build for the host
#
# Outputs go to app/dist/. dmg files can only be produced on macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/app"

if [ ! -d node_modules ]; then
  echo "installing app dependencies..."
  npm install
fi

export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$ROOT/app/.cache/electron-builder}"
export ELECTRON_CACHE="${ELECTRON_CACHE:-$ROOT/app/.cache/electron}"
mkdir -p "$ELECTRON_BUILDER_CACHE" "$ELECTRON_CACHE"

if [ "$#" -eq 0 ]; then
  set -- --mac --win --linux
fi

npx electron-builder "$@"
echo "artifacts -> app/dist"
