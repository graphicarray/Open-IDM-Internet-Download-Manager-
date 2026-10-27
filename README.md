# Open IDM

**Open IDM by Graphicarray** is a Windows download manager with segmented transfers and a Chrome/Edge extension for video capture.


## Build the Windows EXE

GitHub builds it for you. Push to `main`, or push a tag like `v0.1.0`.
The workflow `.github/workflows/build-windows.yml` makes:

- `Open-IDM-Setup.exe` (NSIS installer)
- `Open-IDM-<version>-Portable.exe`
- `Open-IDM-Extension-<version>.zip` (browser extension)
- `SHA256SUMS.txt`

Find them under **Actions → run → Artifacts**. Tag builds also create a GitHub Release.

Local build (Windows): `npm ci`, put `yt-dlp.exe` in `vendor/`, then `npm run dist`.

Brand rules: Graphicarray Brand Guidelines. Logo: `brand/logo.svg`.
