# MediaWatcher for Windows

The desktop application hosts the existing frontend in a sandboxed Electron
window and runs the existing Express backend as a child process. No frontend
redesign or player rewrite is involved. `npm start`, browser access, the original
launcher and Tailscale access remain available.

## Build and launch

Build on Windows x64 with Node.js 20+ (verified with 24.17.0), npm, and a complete
FFmpeg distribution on PATH, including FFprobe and its license files. The existing
Gyan FFmpeg winget installation works. Network access is needed for npm packages,
Electron, installer tooling and the Node license.

```powershell
npm install
npm run desktop       # Develop against the existing project's .env and library
npm run desktop:pack  # dist/win-unpacked/MediaWatcher.exe and companion files
npm run dist          # dist/MediaWatcher-Setup-1.0.2-x64.exe
```

The installer creates Start menu and desktop shortcuts and supports choosing an
installation directory. It bundles Node, production npm dependencies, FFmpeg and
FFprobe, so the destination computer does not need those installed. Keep the
entire `win-unpacked` folder together if using that executable directly. The
installer is the single EXE to copy to another computer.

Build scripts stage an explicit allowlist of source files in `.desktop-build/`.
Real `.env` files, admin keys, databases, caches, downloads and media are excluded.
The build verifies the copied runtime can load dotenv, Express, Axios and native
SQLite, runs both FFmpeg executables, and byte-compares every frontend asset.
This verification runs against the actual packaged directory before the installer
is created, so missing backend dependencies fail the build.

The backend uses a copy of the build machine's Node executable and installs
`better-sqlite3` for that Node ABI. It does not rebuild the source project's
SQLite binary for Electron. Both the original server and desktop build therefore
remain usable. `MW_BUILD_FFMPEG` and `MW_BUILD_FFPROBE` can select absolute paths
to other complete FFmpeg distributions; otherwise the build uses PATH.

## Bring your current library

1. Stop the old server in its launcher. Two servers cannot use the same port.
2. Launch MediaWatcher and choose **Use existing library**.
3. Select the project folder containing `.env` and the `db` folder, not just
   the folder of movies.
4. Sign in using your existing password.

The desktop app remembers that folder and uses the database and files in place.
It does not move or duplicate your media. Keep that folder after installing the
desktop app. Browser-specific preferences, offline downloads and cookies belong
to their browser profile: the desktop window has its own profile, so sign in once
and set its device preferences there. Server-side watch history, queue, library
settings and remembered remote devices are preserved.

## New installations and your data

**Set up a new library** collects the same required TMDB key, AllDebrid key and
password as the existing `.env` configuration. New data defaults to
`%APPDATA%\MediaWatcher\data`, with these paths inside it:

- `.env` and `config/admin-key`
- `db/mediawatcher.db` and its SQLite sidecars
- `library/movies`, `library/shows`, `temp` and `cache`

Relative paths in `.env` resolve against the data folder. Absolute paths still
point to the configured drives. The bundled source and `.env.example` are read
from the application installation; Settings writes the data folder's `.env`.
Updates replace the application and preserve user data. Uninstalling deliberately
leaves user data in place.

`%APPDATA%\MediaWatcher\desktop.json` records the selected folder and window size.
`desktop.log` is a bounded, redacted startup log with one previous log retained.
The tray menu opens the data folder, configuration editor and log.

For isolated testing, `MW_DESKTOP_PROFILE` changes the Electron profile folder
and `MW_DATA_DIR` changes the backend data folder. `MW_NODE_PATH` can select the
Node executable for development. Packaged runs always use bundled Node.

## Updates

The packaged app checks GitHub Releases for the repository in
`desktop/release.json`, which is also what `npm run dist` publishes for: the
build writes `latest.yml` and `resources/app-update.yml` from it, and
electron-updater needs both to find and cache a release. Change the repository
in one place and the app and the build follow.

- Checks run once at launch and every six hours, never during a check already
  in flight. Nothing downloads on its own.
- The tray and application menus show the state: *Check for updates*,
  *Download update 1.1.0*, *Downloading update…*, *Restart & install update*.
  **Check for updates** opens the updates window.
- Downloading is explicit and playback continues while it runs. Installing is
  explicit too: it stops the backend cleanly, then hands over to the NSIS
  installer, which keeps your data folder.
- Running from source reports *Running from source* and contacts nobody; there
  is no installer to replace.
- The updates window is a local page with the same narrow bridge as first-run
  setup. It cannot name an installer path or reach the network itself; every
  channel checks that the message came from that window's own frame.
- The repository field takes `owner/repository` or a GitHub link, rejects
  anything else, and is stored in `desktop.json`. It cannot be changed while an
  update is downloaded and waiting.

To publish an update: raise `version` in `package.json`, run `npm run dist`, and
attach `dist/MediaWatcher-Setup-<version>-x64.exe`, `latest.yml` and the
installer's `.blockmap` to a public GitHub release. A release missing
`latest.yml` is invisible to the app.

## Desktop behavior

- Window close hides to the tray so downloads, conversions and remote viewers
  continue. Double-click the tray icon or launch the app again to restore it.
- Right-click the tray icon and choose **Quit MediaWatcher**, or press Ctrl+Q,
  for graceful shutdown of the backend and registered encoders.
- Settings' existing restart action is supervised and starts the server again.
  Unexpected exits retry with a bounded delay and eventually display an error.
- A custom dark title bar blends into the app, with native window buttons and
  drag/snap support. It disappears in fullscreen. Player controls float over a
  dark fade at the bottom of the video. Keyboard shortcuts and browser rendering
  remain available. Press Alt to show the small desktop application menu.
- External HTTP(S) links open in the system browser. The webpage cannot access
  Node or native desktop APIs; only the local first-run page has a narrow setup bridge.
- Tailscale uses the same configured port and password gate. The app does not
  configure Tailscale or silently choose a different port when one is occupied.
- Chromium integrations that depend on a full browser, notably Chromecast and
  browser web push, can use **Open in browser** in the tray/menu. Their existing
  website implementation remains intact. Desktop notifications and playback
  codec support depend on Electron and the host OS; FFmpeg handles the existing
  remux/transcode paths.

## Verification

```powershell
npm run test:desktop
npm run test:desktop-ui
$env:MW_TEST_EXE = "$PWD\dist\win-unpacked\MediaWatcher.exe"
npm run test:desktop-ui
```

The backend tests check isolated data, unchanged HTML, the authentication gate,
remembered sessions, graceful Windows IPC shutdown, supervised restart and an
occupied port. `npm test` includes `updates.test.mjs`, which drives the update
state machine against a fake updater and checks the updates window, its bridge,
the sender check and the published release source.
Real Electron tests cover fresh setup, login, original UI loading,
sandboxing, actual direct and HLS video playback, tray lifetime and process cleanup.
Test profiles and generated video clips are temporary; UI screenshots go in
`test-results/`.

Initial Windows validation: backend integration tests and both development and
packaged Electron smoke tests passed, including remembered login after relaunch,
Settings restart and reuse of an existing data folder. The existing regression
suite passed 55 of 56 suites with isolated runtime folders. Its live TMDB
`search-resolution` check for `thematrix` returned `tt8097048` instead of
`tt0133093`; the search implementation was left unchanged.

## Distribution

Local builds are unsigned unless a signing certificate is configured through
electron-builder. Windows may show an unknown-publisher/SmartScreen prompt.
Configure signing before broad public distribution. The package includes Node
and FFmpeg licenses and the FFmpeg distribution's README/documentation. FFmpeg
builds have their own licensing/source-distribution requirements; retain those
notices and satisfy the selected build's requirements when distributing it.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
and [electron-builder NSIS configuration](https://www.electron.build/docs/nsis/).
