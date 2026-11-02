# Releasing

## 1. Build the installers

```bash
npm --prefix app install
scripts/package-app.sh              # mac + win + linux (dmg only on macOS)
# or one platform at a time
scripts/package-app.sh --mac
scripts/package-app.sh --win
scripts/package-app.sh --linux
```

Outputs land in `app/dist/`. Expect roughly:

| Artifact | Platform | Size |
|---|---|---|
| `ACPU-Studio-<v>-universal.dmg` | macOS universal | 245 MB |
| `ACPU Studio-<v>-universal-mac.zip` | macOS universal | 216 MB |
| `ACPU Studio-<v>-x64-setup.exe` | Windows x64 | 121 MB |
| `ACPU Studio-<v>-arm64-setup.exe` | Windows arm64 | 115 MB |
| `ACPU Studio-<v>-setup.exe` | Windows combined | 236 MB |
| `ACPU Studio-<v>-portable.exe` | Windows portable | 110 MB |
| `ACPU Studio-<v>.AppImage` | Linux x64 | 126 MB |
| `acpu-studio-<v>.tar.gz` | Linux x64 | 120 MB |

`dmg` creation uses `hdiutil` and therefore only works on macOS. The Windows and
Linux targets are built from macOS through electron-builder's cross tooling.

## 2. Checksums

```bash
cd app/dist
shasum -a 256 * > SHA256SUMS.txt
```

Update `release/README.md` and commit the new `release/SHA256SUMS.txt`.

## 3. Publish a GitHub Release

The installers cannot live in the git tree (100 MB per-file limit). Upload them
as release assets instead:

```bash
gh release create v1.0.0 \
  "app/dist/ACPU-Studio-1.0.0-universal.dmg" \
  "app/dist/ACPU Studio-1.0.0-universal-mac.zip" \
  "app/dist/ACPU Studio-1.0.0-x64-setup.exe" \
  "app/dist/ACPU Studio-1.0.0-arm64-setup.exe" \
  "app/dist/ACPU Studio-1.0.0-portable.exe" \
  "app/dist/ACPU Studio-1.0.0.AppImage" \
  "app/dist/acpu-studio-1.0.0.tar.gz" \
  --title "ACPU-1 Tempest v1.0.0" \
  --notes-file release/README.md
```

Or attach the files manually on the "Draft a new release" page.

## 4. Before tagging

- [ ] `python sim/run_all.py` reproduces `results/` (numbers in the report)
- [ ] `node app/tools/selftest.mjs` passes (246 assertions)
- [ ] `bash scripts/build-report.sh` produces `ACPU-1_Technical_Report.pdf`
- [ ] `bash scripts/build-figures.sh` regenerates the schematic PDFs
- [ ] version bumped in `app/package.json` and `CITATION.cff`
