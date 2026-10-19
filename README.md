# ERRS Lab Wall

Big-screen display of the laboratory work of the Environmental Research and Radiation Safety (ERRS) Department, Environmental Protection Agency of Liberia.

The wall plays full-screen, rotating slides built from the department's reports: annual outputs against targets, the Q4 outlook, a quarter-by-quarter scorecard, one slide per unit (CMU, EMRU, RSU, WRU), laboratory results as heatmaps against the standards, field readings, a map of Liberia, recent activities, challenges and the plan — plus a notice board, field photos and a live lab sample board.

Drop in a report (PDF, Word, PowerPoint, Excel or text) and Claude reads it and pulls out the numbers; you check them before they go on the wall.

## Install on Windows

1. Open **Releases** on the right of this page and download `ERRS-Lab-Wall-Setup-<version>.exe` from the latest release.
2. Run it. If Windows says "Windows protected your PC", click **More info → Run anyway** (the app is not code-signed).
3. The wall opens full screen with the 2026 reports already loaded.

If Smart App Control blocks the installer, it cannot be allowed for an unsigned app; use a PC with Smart App Control off, or ask for a signed build.

## First-time setup (on the PC)

Press **M** (or move the mouse and click **Reports**), then open the **Computer** tab:

- **Anthropic API key** — needed for reading new reports and for the Ask tab. Create one at console.anthropic.com → API keys and paste it. It is stored encrypted on this PC only.
- **Data folder** — where reports, notices, samples and photos are kept as plain files. To show the same wall on several PCs (the big screen and an office laptop), point them all at one shared OneDrive or network folder.
- **Start the wall when Windows starts** — for the big-screen PC.

Keys: **F11** full screen · **← →** change slide · **Space** pause · **M** manage panel · **F5** reload · **Alt+F4** quit.

## Development

```
npm install
npm start          # builds renderer/ from wall/ and runs the app
npm run dist       # Windows installer + portable exe in dist/ (run on Windows)
```

`wall/` holds the display page itself (the same page as the online version); `tools/build-renderer.js` assembles it with the bundled fonts and libraries. `main.js` is the desktop shell (data folder, file store, Anthropic API); `renderer/desktop.js` connects the page to it.

Every push to `main` builds the Windows installer on GitHub Actions and publishes it as a release.

Map outline: Natural Earth (public domain) via world-atlas. County boundaries: UNMIL, OCHA ROWCA via geoBoundaries (CC BY 3.0 IGO). Fonts: Barlow Condensed, IBM Plex Sans and IBM Plex Mono (SIL Open Font Licence).
