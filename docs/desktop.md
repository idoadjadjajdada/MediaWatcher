# MediaWatcher for Windows

The desktop application hosts the existing frontend in a sandboxed Electron
window and runs the existing Express backend as a child process. No frontend
redesign or player rewrite is involved. `npm start`, browser access, the original
launcher and Tailscale access remain available.

This page is the Windows build. The same application builds and installs on
Linux, where FFmpeg comes from the system and only the AppImage updates itself;
that is [docs/linux.md](linux.md). Everything below about data locations,
updates, desktop behaviour and verification applies to both except where it
names a Windows path or the NSIS installer.

## Build and launch

Build on Windows x64 with Node.js 20+ (verified with 24.17.0), npm, and a complete
FFmpeg distribution on PATH, including FFprobe and its license files. The existing
Gyan FFmpeg winget installation works. Network access is needed for npm packages,
Electron, installer tooling and the Node license.

```powershell
npm install
npm run desktop         # Develop against the existing project's .env and library
npm run desktop:pack    # dist/win-unpacked/MediaWatcher.exe and companion files
npm run dist            # this platform's installer: dist/MediaWatcher-Setup-<version>-x64.exe
npm run dist:win        # the same, named explicitly
```

`npm run dist` builds for the machine it runs on. `dist:win` and `dist:linux`
name a platform outright; there is no cross-building, because the backend ships
a copy of the build machine's own Node.

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
remain usable. `MW_BUILD_NODE` selects a different Node to copy, for a build
meant to run on systems older than this one. `MW_BUILD_FFMPEG` and
`MW_BUILD_FFPROBE` can select absolute paths to other complete FFmpeg
distributions; otherwise the build uses PATH. `MW_BUILD_FFMPEG_MODE` decides
whether FFmpeg is copied into the package at all — `bundle` always, `system`
never, `auto` only when the binary is self-contained, which is the Linux
default and why the Linux package depends on FFmpeg instead.

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
`%APPDATA%\MediaWatcher\data` on Windows and `~/.config/MediaWatcher/data` on
Linux, with these paths inside it:

- `.env` and `config/admin-key`
- `db/mediawatcher.db` and its SQLite sidecars
- `library/movies`, `library/shows`, `temp` and `cache`

Relative paths in `.env` resolve against the data folder. Absolute paths still
point to the configured drives. The bundled source and `.env.example` are read
from the application installation; Settings writes the data folder's `.env`.
Updates replace the application and preserve user data. Uninstalling deliberately
leaves user data in place.

`desktop.json`, beside the data folder's parent, records the selected folder,
window size and preferences.
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
- Whether the app may install anything at all depends on who owns its files. A
  Windows installation and a Linux AppImage own theirs; a pacman, deb or rpm
  package does not. An install the app does not own still checks and still
  reports the newest release — that half is useful and safe — and then names
  whatever installed it rather than overwriting files a package manager is
  tracking. `desktop/platform.cjs` makes that call in one place, and the build
  and the runtime both read it from there.
- Running from source reports *Running from source* and contacts nobody; there
  is no installer to replace.
- The updates window is a local page with the same narrow bridge as first-run
  setup. It cannot name an installer path or reach the network itself; every
  channel checks that the message came from that window's own frame.
- The repository field takes `owner/repository` or a GitHub link, rejects
  anything else, and is stored in `desktop.json`. It cannot be changed while an
  update is downloaded and waiting.

### Publishing one

```powershell
# raise "version" in package.json, then write that version's section in CHANGELOG.md
npm run release
```

Run it once per platform. The first run creates the release from the changelog;
a second, on the other platform's machine, uploads that platform's build into
the release that already exists. Publishing the same platform twice is refused —
the manifest is already there, and that is the case where somebody meant to
raise the version instead.

`tools/release.mjs` builds the installer and creates the GitHub release from
one commit, and refuses rather than publishing something half-formed:

- the working tree must be clean and pushed, so the tag names a commit that
  exists somewhere other than this machine;
- `CHANGELOG.md` must have a `## <version>` section, which becomes the release
  notes verbatim — an installer with no notes asks people to close what they
  are watching without saying what for;
- the build must have produced this platform's artefacts and the manifest that
  names them: the installer, its `.blockmap` and `latest.yml` on Windows; the
  AppImage and `latest-linux.yml` on Linux, with the pacman package and tarball
  attached when the build made them. A release missing its manifest is invisible
  to every installed copy, and one whose manifest names a different build sends
  them after a file that is not there;
- the version must not already be released.

`--dry-run` builds and checks all of that without publishing.

## Desktop behavior

- Running the installer when MediaWatcher is already installed offers to update
  it, repair it (install the same version over the top), or uninstall it. The
  page is skipped for the silent and `--updated` runs that an in-app update
  performs, and skipped rather than shown if anything about the existing
  installation cannot be read — an installer that will not install is worse than
  one that does not offer a choice. It lives in `build/installer.nsh`.
- A light in the title bar, beside the version number. Green is the current
  version with a server answering. Flashing yellow is a newer release waiting,
  with **Update** beside it — which downloads, shows its progress, and becomes
  **Restart & install** when the installer is ready. Steady red is a server that
  has stopped answering, with **Reconnect**. Reconnect asks the cheap question
  first: one that has come back needs nothing started, and only a server that is
  really gone is replaced. The flash respects `prefers-reduced-motion`; the
  button beside it is the message either way.
- Window close asks, once, what it should do: keep MediaWatcher running in the
  tray, or quit. The prompt is drawn inside the app rather than by Windows, and
  saves the answer only if **Do this every time I close the window** is ticked.
  Escape leaves the window open.
- **Settings → Desktop app → Closing the window** holds the answer afterwards:
  Ask, Keep running, or Quit. It lives in `desktop.json`, because it belongs to
  the installation rather than to the device the page is open on, and the page
  reaches it through a bridge that carries that one value and nothing else.
- Kept running, downloads, conversions and remote viewers continue with the
  window shut. Double-click the tray icon or launch the app again to restore it.
- Right-click the tray icon and choose **Quit MediaWatcher**, or press Ctrl+Q,
  for graceful shutdown of the backend and registered encoders.
- Settings' existing restart action is supervised and starts the server again.
  Unexpected exits retry with a bounded delay and eventually display an error.
- A custom dark title bar blends into the app, with native window buttons and
  drag/snap support. It disappears in fullscreen. Player controls float over a
  dark fade at the bottom of the video. Keyboard shortcuts and browser rendering
  remain available. Press Alt to show the small desktop application menu.
- External HTTP(S) links open in the system browser. The webpage cannot access
  Node or native desktop APIs. The first-run page has a narrow setup bridge, and
  the app itself has one carrying what the X does and a request to show the
  window — nothing that is not already a tray click.
- The app shares the machine with a MediaWatcher started any other way. If the
  configured port is already serving *this* library — the launcher, `npm start`,
  a terminal left open — the window joins that server instead of starting a
  second one, and closing the window leaves it running. If the port belongs to
  something else, the app takes the next free one rather than refusing to open.
  Two servers over one data folder is the case worth preventing: each would
  scan, sweep and reconcile downloads over the other's work, and each would
  treat the other's in-flight segments as orphans to delete.
- Which server is which is decided by `/api/health`, which reports the data
  folder keyed by the admin key inside it. Only something that can already read
  `config/admin-key` can compute that, so joining is limited to a process on
  this machine with this library, and the endpoint tells a stranger nothing.
- A running server writes `config/serving.json` in its data folder, naming the
  port it is answering on, and removes it on the way out. That is how the app
  finds a server started with a different `PORT` than the one configured here,
  and it is what a second server checks before starting: one over a folder that
  is already being served exits with the address of the one already there. The
  file is advisory rather than a lock — one left behind by a crash names a port
  that answers nothing, and is ignored.
- Tailscale uses the same configured port and password gate. The app does not
  configure Tailscale. A window that moved to another port is reachable at that
  port; the tunnel still points at whatever holds the configured one.
- Notifications for finished and failed downloads are raised by the app itself,
  from the job poll it already runs, and appear with the window closed to the
  tray. Electron has no push service, so the browser's subscription switch is
  not offered where it could only fail. Being told while MediaWatcher is not
  running at all remains a browser feature — **Open in browser**, and turn them
  on there.
- Chromium integrations that depend on a full browser, notably Chromecast and
  browser web push, can use **Open in browser** in the tray/menu. Their existing
  website implementation remains intact. Desktop notifications and playback
  codec support depend on Electron and the host OS; FFmpeg handles the existing
  remux/transcode paths.

## Verification

```powershell
npm run test:desktop
npm run test:desktop-ui
npm run test:packaging
$env:MW_TEST_EXE = "$PWD\dist\win-unpacked\MediaWatcher.exe"
npm run test:desktop-ui
```

The backend tests check isolated data, unchanged HTML, the authentication gate,
remembered sessions, graceful Windows IPC shutdown, supervised restart and an
occupied port. `npm test` includes `updates.test.mjs`, which drives the update
state machine against a fake updater and checks the updates window, its bridge,
the sender check and the published release source. It also includes
`packaging.test.mjs`, which covers what a build cannot: per-platform executable
and icon names, that an install the package manager owns reports releases and
installs none of them, and that the Linux desktop entry, systemd unit and
PKGBUILD agree with the build config and with each other.
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
