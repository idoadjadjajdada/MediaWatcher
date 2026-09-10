# MediaWatcher on Linux

The desktop application is the same one Windows gets: the existing frontend in a
sandboxed Electron window, the existing Express backend as a child process, and
the same data folder either can be pointed at. Nothing about the server, the
player or the library is platform-specific — `npm start` and browser access work
on Linux as they always have. What follows is the part that is new: installing
it as an application, with a launcher entry, an icon, a tray and updates.

Arch is the distribution this was tested on and the one with a package here.
Everything except the PKGBUILD applies to any distribution.

## The short version, on Arch

```bash
git clone https://github.com/idoadjadjajdada/MediaWatcher.git
cd MediaWatcher/packaging/arch
makepkg -si
```

That builds and installs `mediawatcher` — an entry in your application menu, a
launcher at `/usr/bin/mediawatcher`, the application under `/opt/mediawatcher`,
and `ffmpeg` pulled in as a dependency. Launch it and choose **Set up a new
library**, or **Use existing library** and select a folder you already have.

It packages the clone it is sitting in, at the commit you have checked out, and
pins that commit so the build is reproducible. Nothing has to be published for
this to work: the package you install is the code you are looking at. To build
some other ref from the same clone, or to fetch a published tag from GitHub
without a clone at all:

```bash
_ref=v1.4.1 makepkg -si              # another commit, tag or branch, from this clone
_upstream=1 _ref=v1.4.1 makepkg -si  # from GitHub instead
```

To run it from a checkout without installing anything:

```bash
./mediawatcher setup     # dependencies and a .env, once
./mediawatcher app       # the desktop window
./mediawatcher           # or just the server, at http://localhost:3000
./mediawatcher doctor    # what is missing, and the command to install it
```

## What gets built

`npm run dist:linux` produces three things in `dist/`:

| | |
|---|---|
| **AppImage** | One file, runs anywhere, and the only Linux format the app can update by itself. |
| **pacman package** | `.pkg.tar.zst` for Arch. Owned by pacman, which is also what updates it. |
| **tar.gz** | Unpack anywhere. Nothing manages it, including the app. |

`npm run desktop:pack:linux` stops at `dist/linux-unpacked/` if you only want to
run the built application without packaging it.

`packaging/arch/PKGBUILD` builds the same application through makepkg instead,
which avoids electron-builder downloading `fpm` in the middle of the run. It is
the recommended path on Arch. Both need the network for npm packages, Electron
and the Node license.

`pkgver` in the PKGBUILD is the version the package reports; it does not choose
what gets built. There is deliberately no `pkgver()` function, because makepkg
would rewrite the PKGBUILD mid-build and dirty the working tree it just
packaged — `packaging.test.mjs` fails instead if it drifts from `package.json`.

## FFmpeg is a dependency, not a payload

The Windows build bundles FFmpeg because there is one obvious complete
distribution of it and a Windows machine usually has none installed. Neither
holds on Linux: your distribution's FFmpeg is dynamically linked against a dozen
system libraries, so a copy of it inside a package runs on the machine that
built it and nowhere else — and pacman keeps FFmpeg more current than this
package ever would.

So the Linux build depends on the system copy, which is what
`FFMPEG_PATH`/`FFPROBE_PATH` already default to. The build proves it exists and
runs before packaging anything.

If you are distributing an AppImage to machines that may not have FFmpeg, point
the build at a static one and it will travel with the application:

```bash
MW_BUILD_FFMPEG=/opt/ffmpeg-static/bin/ffmpeg \
MW_BUILD_FFPROBE=/opt/ffmpeg-static/bin/ffprobe \
MW_BUILD_FFMPEG_MODE=bundle npm run dist:linux
```

`MW_BUILD_FFMPEG_MODE` takes `auto` (the Linux default: bundle a self-contained
build, otherwise depend on the system), `bundle`, or `system`. A dynamically
linked binary under `bundle` is refused rather than copied, because copying it
produces a package that fails on the first file it has to remux.

## Updates

The packaged app checks the GitHub repository in `desktop/release.json` at
launch and every six hours. What it can do about a new release depends on how it
was installed, and it says so rather than guessing:

- **AppImage** — one file the app owns, so the whole flow works: download,
  progress, and **Restart & install**, exactly as on Windows.
- **pacman package, tarball, or an unpacked build** — the app checks, tells you
  a newer version exists, and points at whatever installed it. It never replaces
  files a package manager is tracking; a system that lies about what is
  installed is worse than a manual `pacman -Syu`.

The title bar light behaves the same either way: green for current and
connected, yellow when a newer release is out, red when the server stops
answering. On an unmanaged install the yellow light's button opens the updates
window instead of downloading.

## Data locations

New libraries default to `~/.config/MediaWatcher/data`, with `.env`,
`config/admin-key`, `db/mediawatcher.db`, `library/movies`, `library/shows`,
`temp` and `cache` inside it. `~/.config/MediaWatcher/desktop.json` records the
chosen folder, window size and preferences; `desktop.log` is the bounded,
redacted startup log. All of it survives reinstalling and uninstalling the
package.

Relative paths in `.env` resolve against the data folder; absolute ones still
point wherever you set them, which is what a library on another disk wants.

## The title bar, and window managers that do not draw one

By default the window has no system frame: Electron draws the caption buttons
over the app's own dark title bar, which is where the version and the status
light live. That depends on the desktop drawing client-side decorations, and on
a minimal or tiling window manager a frameless window can arrive with no way to
move, resize or close it.

If that happens, ask for an ordinary frame:

```bash
MW_TITLEBAR=native mediawatcher
```

The in-page bar stays — it carries the status light — and simply stops reserving
space for buttons that are now the window manager's. To make it permanent, set
`"titleBar": "native"` in `~/.config/MediaWatcher/desktop.json`.

## The tray

The tray icon needs a panel that implements the StatusNotifierItem or legacy
tray protocol. GNOME needs an extension for this (AppIndicator support);
KDE, Xfce, Cinnamon and most panels have it already.

Where there is no tray, nothing breaks — but "keep running in the tray" leaves
you with a running server and no icon to click. Either quit on close
(**Settings → Desktop app → Closing the window → Quit**), or run the server as a
service and use the window as a client:

```bash
systemctl --user enable --now mediawatcher-server
```

The unit ships with the package, runs the packaged backend over the same
`~/.config/MediaWatcher/data`, and restarts it if it fails. The app then finds
that server on the port and joins it rather than starting a second one — closing
the window leaves the library serving. `sudo loginctl enable-linger "$USER"`
makes it run without a login session, for a machine that is only a server.

## Wayland

Electron runs under XWayland by default, which works. For native Wayland —
better fractional scaling, no blurry text on a HiDPI screen:

```bash
mediawatcher --ozone-platform-hint=auto
```

Add it to `Exec=` in `~/.local/share/applications/mediawatcher.desktop` to make
it stick without editing the packaged entry. Hardware video decoding under
Wayland varies by driver; if playback stutters, drop the flag first.

## Verification

```bash
npm test                 # includes packaging.test.mjs
npm run test:packaging   # just the packaging surface
npm run test:desktop     # the backend, with isolated desktop data
npm run test:desktop-ui  # a real Electron window, from source
MW_TEST_EXE="$PWD/dist/linux-unpacked/mediawatcher" npm run test:desktop-ui
```

`packaging.test.mjs` checks the parts a build cannot: that the desktop entry's
`Exec` names the executable the build actually produces, that the systemd unit
and the app point at one data folder, that the PKGBUILD's version has not
drifted from `package.json`, and that a copy the package manager owns refuses to
install an update over it.

`test:desktop-ui` needs a display. Under a headless session, run it through
`xvfb-run -a`.

## Distribution notes

Builds are unsigned. The AppImage needs its execute bit (`chmod +x`) and, on
some systems, FUSE 2 — `pacman -S fuse2` on Arch, or run it with
`--appimage-extract-and-run`.

The package carries Electron's, Chromium's and Node's license notices. Where
FFmpeg is bundled rather than depended on, that build's own licensing and
source-distribution requirements come with it; the staging step copies its
LICENSE and documentation and refuses to build without them.
