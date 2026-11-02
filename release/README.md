# Release artifacts

The installers are **not stored in this repository**: each is 100-250 MB and
GitHub rejects files over 100 MB. They belong to a GitHub **Release**, where
assets can be up to 2 GB each.

| Platform | File | Size |
|---|---|---|
| macOS (universal, x86_64 + arm64) | `ACPU-Studio-1.0.0-universal.dmg` | 245 MB |
| macOS (universal, zipped) | `ACPU Studio-1.0.0-universal-mac.zip` | 216 MB |
| Windows x64 installer | `ACPU Studio-1.0.0-x64-setup.exe` | 121 MB |
| Windows arm64 installer | `ACPU Studio-1.0.0-arm64-setup.exe` | 115 MB |
| Windows combined installer | `ACPU Studio-1.0.0-setup.exe` | 236 MB |
| Windows portable | `ACPU Studio-1.0.0-portable.exe` | 110 MB |
| Linux x64 AppImage | `ACPU Studio-1.0.0.AppImage` | 126 MB |
| Linux x64 tarball | `acpu-studio-1.0.0.tar.gz` | 120 MB |

`SHA256SUMS.txt` contains the checksums of this exact build:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The builds are **unsigned** (no Apple Developer ID, no Authenticode
certificate), so macOS Gatekeeper and Windows SmartScreen will ask for
confirmation on first launch. See `../RELEASING.md` for how to rebuild and
upload them.
