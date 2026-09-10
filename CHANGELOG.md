# Changelog

What changed in each release, newest first. Every version here has a GitHub
release carrying these notes and the application built from that commit —
`node tools/release.mjs` will not publish one without both. A release built on
more than one platform carries each platform's build in the same release.

Versions follow [semantic versioning](https://semver.org): the minor number
moves for new behaviour, the patch number for fixes alone.

## 1.5.0

### Added

- **MediaWatcher installs as an application on Linux.** The same window, the
  same backend, the same library folder — what was missing was everything
  around it: a build that would run, a package to install, an entry in the
  application menu and an icon that is not a `.ico`. On Arch that is now
  `cd packaging/arch && makepkg -si`, and everywhere else
  `npm run dist:linux` builds an AppImage, a pacman package and a tarball.

  The differences between the two platforms are now asked for rather than
  assumed. `desktop/platform.cjs` answers what the executables are called, which
  icon a window and a tray can each use, and who owns the installed files — and
  the staging build, the packaged-output check and the running shell all read
  their answers from it instead of from string literals they each carried
  separately. A payload staged as `node.exe` for a runtime that forks `node` is
  not a bug anybody finds by reading either file.

  The PKGBUILD packages the clone it is sitting in, and has no `source=` line
  at all. A git source has three ways to fail before the build compiles a line:
  a ref that has to exist, a working copy makepkg has to create, and a
  `git rev-parse` that quietly returns nothing when git distrusts a directory's
  ownership. Each ends in "invalid reference" about a tag that was never the
  point — which is what packaging an unreleased branch means. `prepare()`
  exports the tree from a path worked out from the PKGBUILD's own location, so
  none of that machinery is there to fail; `_ref` selects a different commit.

  From a checkout there is `./mediawatcher`, which is what `start.bat` is on
  Windows: first-run setup, then the server, with `app` for the desktop window
  and `doctor` for what is missing and the command to install it. There is no
  PowerShell launcher and there does not need to be — the desktop app has been
  the control panel since 1.1.0.

- **The Arch package installs its own dependencies.** `makepkg -si` has pacman
  pull everything: FFmpeg, the system libraries Chromium links against, a font,
  and the indicator library that draws the tray — which is a hard dependency
  rather than an optional one, because closing the window keeps the server
  running by default and an optional dependency is one pacman does not install.
  Nothing needs Node installed to run the app; the package carries its own copy
  for the backend and leaves whatever Node is already there alone.

  Every package name was checked against Arch's repositories rather than
  remembered. `libappindicator-gtk3`, the name this would otherwise have used,
  no longer exists there. And `packaging.test.mjs` now fails if the PKGBUILD and
  the electron-builder pacman target ever disagree about what is needed: two
  packaging paths installing one application cannot need different things.

### Changed

- **better-sqlite3 moves to 13.** Arch ships Node well ahead of most native
  modules, and 11.10.0 does not compile against Node 26 at all — `makepkg`
  stopped a long way into the build with a wall of C++ from a file nobody in
  this project wrote. 13.0.3 has prebuilds for it and installs without a
  compiler. The application uses five of its methods and none of them changed.

  The PKGBUILD now catches that failure whenever it comes back — a newer Node
  will eventually outrun 13 too — and says what happened in a sentence, with the
  fix, instead of leaving the compiler's output as the explanation.

- **FFmpeg is a dependency on Linux, not a payload.** The Windows build bundles
  it because there is one obvious complete distribution and a Windows machine
  usually has none installed. Neither is true on Linux: a distribution's FFmpeg
  is linked against a dozen of its own system libraries, so a copy of it inside
  a package runs on the machine that built it and nowhere else. The Linux
  package depends on it instead, which is also how it stays current.

  The build decides by looking rather than by platform: a self-contained binary
  is bundled, a dynamically linked one is left to the system, and asking for
  `MW_BUILD_FFMPEG_MODE=bundle` with a dynamic binary is refused rather than
  quietly producing a package that fails at the first file it has to remux.
  Either way it proves both executables run before packaging anything, and
  records which it did — so the check that runs against the finished package
  can tell a build that shipped without a bundled FFmpeg from one that never
  meant to have one.

- **An update it cannot install is now said rather than attempted.** A Windows
  installation and a Linux AppImage own their own files; a pacman package does
  not, and an app that overwrites one leaves pacman describing a version that is
  no longer on disk. So those copies do the half that is useful and safe: they
  check GitHub, report that a newer release exists, and name whatever installed
  it. The title-bar light still turns yellow; its button opens the updates
  window instead of downloading. Nothing reaches for electron-updater, which
  would otherwise work out how to replace an installation it does not own and
  fail late and obscurely.

- **`npm run release` builds for the machine it runs on**, and a second platform
  joins the release the first one created rather than colliding with it. Each
  platform's manifest is checked against the artefact it names — `latest.yml`
  and the installer on Windows, `latest-linux.yml` and the AppImage on Linux —
  because a release whose manifest names a different build sends every installed
  copy after a file that is not there. Publishing the same platform twice is
  still refused: that is the case where somebody meant to raise the version.

### Fixed

- **A window nobody can move is worse than one that is the wrong colour.** The
  dark title bar with Electron's caption buttons drawn over it depends on the
  desktop drawing client-side decorations, and on a tiling or minimal window
  manager a frameless window can arrive with no way to move, resize or close it.
  `MW_TITLEBAR=native`, or `"titleBar": "native"` in `desktop.json`, asks for an
  ordinary frame. The in-page bar stays either way — it carries the status light
  — and stops reserving space for buttons that are now the window manager's.

  The page had to be told which of the two it is in. Its fullscreen detection
  reads the caption overlay's visibility, and an overlay that is not in use
  reports "not visible" forever, which would have hidden the title bar, and the
  status light in it, for the whole life of the window.

- **The tray icon and the configuration editor now work on Linux.** The tray was
  handed a `.ico`, which Linux cannot draw, and it now gets a PNG sized for a
  panel rather than a 512px one squeezed into a 22px slot. Linux panels also
  deliver a single click and never a double one, so a click opens the window
  there. And **Edit configuration** falls back to `xdg-open` and then to opening
  the containing folder, because a dotfile with no extension is the case every
  desktop handles worst — a path somebody can see beats an error box naming a
  file they cannot reach.

## 1.4.1

### Changed

- **A new mark, and every icon cut out.** The skull replaces the old logo
  everywhere it appeared: the tab, the tray, the taskbar, the title bar, the
  navigation rail, the login page, the installed app on a phone's home screen
  and the notifications the app raises. All of them are generated from one file
  — `public/icons/logo.png` — so replacing that file and running
  `node tools/make-icons.mjs` is still the whole job.

  They no longer carry a background. The icons used to be drawn onto the
  source's own field colour, on the reasoning that a launcher composites an
  icon onto whatever it likes and a transparent one would pick up a white
  sheet. That is the wrong way round for a mark which is a cut-out shape rather
  than a picture in a box: the field showed up as a pale rectangle behind the
  skull on every dark surface it landed on.

  Two smaller things had to follow. The generator found the mark by looking for
  pixels that differed from a corner — which finds nothing useful in an image
  that is transparent at the corner and black in the middle — so it now goes by
  alpha when the source arrives cut out, and skips the flood-fill that would
  otherwise have eaten its way into the skull's own outline. And the Windows
  icon's 1-bit mask, a relic that predates the alpha channel and is still
  consulted in places, is built from the alpha instead of left at zero; without
  that the tray would have drawn a solid rectangle at exactly the size where
  the icon is smallest.

## 1.4.0

### Fixed

- **HDR films stuttered the whole way through, and now they do not.** The
  cause was not the player: tone mapping ran on the CPU, converting every frame
  to 32-bit float per channel, and on a 4K HDR file that encodes at 1.05x
  realtime — slower than watching it. The encoder could never get ahead, so the
  buffer emptied every few seconds for the length of the film, and the bigger
  the file the worse it got.

  Where the machine can do it, those frames are now decoded into Vulkan memory
  and scaled and tone mapped by libplacebo without ever leaving the GPU. Same
  file, same sixty seconds, measured through the real player: 28 seconds of
  video played before, 64 seconds after; two segments produced, against twelve;
  a buffer that sat empty for twenty seconds at a time, against one that holds
  thirty to forty seconds ahead.

  It is probed at startup, not assumed — a build can list the filter and still
  fail on the driver, and several of these pipelines report success while
  writing no video at all, so the probe insists on real output. Anything short
  of that keeps the CPU chain, which is slow but works everywhere. SDR files
  never touch any of it.
- **The first play of a session no longer waits for the machine to be
  measured.** Which encoder and which tone mapper this machine can use are both
  established by running ffmpeg, and both were established on first use — in
  front of a black player. They are asked for at startup now.

## 1.3.1

### Fixed

- **The first play of a session took a second longer than it needed to.** Every
  stream URL asks this browser what it can decode, and on Windows the first
  question about HEVC makes Chromium bring up the platform decoder registry —
  about 900ms of blocked main thread, spent at the exact moment somebody
  pressed play. What a browser build can decode cannot change without a reload,
  so it is asked once now, while the library is on screen rather than while a
  player is black. Click to first frame on a file that plays as it is: 1513ms
  before, 844ms after. A second open in the same session: 260ms, now 225ms.
- **The navigation marker measured the page on every render.** Reading
  `offsetTop` forces the browser to lay the whole page out before it can
  answer, and it was asked immediately after the page had been replaced, which
  is the worst possible moment. The marker only moves when the page changes, so
  that is now the only time it is measured.

### Notes

Playing is not where the time goes. During steady playback the page is 97.4%
idle, with no long tasks, no dropped frames and no re-rendering — the cost is
all in getting started.

Files that have to be transcoded still take around four seconds to first frame,
and that is ffmpeg starting up and encoding rather than anything in the player.
Two candidate fixes were measured and rejected rather than shipped: having
ffmpeg report exactly when it finishes each segment, so a segment need not wait
for the next one to begin (4585ms against a 4567ms baseline — no change), and
halving the segment length (4983ms — worse, because more segments means more
round trips before playback can start).

## 1.3.0

### Added

- **A status light in the title bar**, beside the version the app is running.
  Green is the current version with its server answering — the state nobody
  needs to think about, so it says so quietly. Flashing yellow is a newer
  release waiting, with an **Update** button that downloads it, shows the
  progress, and then offers **Restart & install**. Steady red is a server that
  has stopped answering, with a **Reconnect** button.

  The red one is the reason this exists. A backend that has gone away otherwise
  looks like the app being slow: every panel fails on its own, none of them says
  why, and nothing tells you the one thing worth knowing. Reconnect asks the
  cheap question first — a server that is answering again needs nothing started
  — and only replaces one that is genuinely gone.
- **The installer asks what you came for.** Running it on a machine that already
  has MediaWatcher used to reinstall without comment, which is the wrong answer
  to all three reasons anyone runs an installer twice. It now says which version
  it found and offers to update, repair, or uninstall. An update the app
  performs itself skips the page — it was already agreed to — and so does a
  silent run.

## 1.2.1

### Fixed

- Two servers over one library are no longer possible. 1.2.0 made the desktop
  app open beside a server it did not start, which left the obvious way to run
  two of these on purpose — give one a different `PORT` — as the one way to end
  up with both writing to the same folder. They would each scan it, each sweep
  the caches, each reconcile the same download queue, and each delete the
  other's in-flight video segments as orphans left by a dead process; the
  symptom is somebody else's playback stopping mid-episode. A server now claims
  its data folder while it runs, and a second one over the same folder exits
  saying where the first is answering. The claim is advisory: one left behind
  by a crash names a port that answers nothing, and never stops a server
  starting.
- The desktop app finds a running server that took a different port than the
  one configured here, rather than starting a second one beside it.

## 1.2.0

The desktop app and a server started any other way can now be open at once, and
the app stops offering a notification switch it could never honour.

### Added

- **The app shares the machine.** Opening it while the launcher, `npm start` or
  a terminal is already serving this library joins that server instead of
  starting a second one, and closing the window leaves it running. If the port
  belongs to something else entirely, the app takes the next free one rather
  than refusing to open. Two servers over one data folder is the case worth
  preventing — each would scan, sweep and reconcile downloads over the other's
  work, and each would delete the other's in-flight video segments as orphans.
  Which server is which is settled by a value only something that can already
  read `config/admin-key` can compute, so joining is limited to a process on
  this machine with this library.
- **Desktop notifications for downloads.** A finished or failed download raises
  a Windows notification while MediaWatcher is running, including with the
  window closed to the tray; clicking it brings the window back. **Settings →
  Notifications** switches it off.

### Fixed

- The close prompt no longer times out while it is on screen. The shell hides
  the window by itself if the prompt cannot be drawn — a crashed renderer, or a
  page mid-navigation — and that fallback was on a timer rather than an answer,
  so reopening the window from the tray while the question was up saw it vanish
  again four seconds later. The prompt now says when it has appeared, and the
  fallback stops running.
- The notification switch in the desktop app could only ever fail. Electron has
  no push service, so subscribing there ended in "push service not available"
  after asking for permission. The app raises its own notifications now, and
  the settings page says plainly that being told while MediaWatcher is *not*
  running is the browser's job.
- The Devices panel showed "nothing is remembered" to everyone. The list is
  gated on the local admin key rather than on being signed in — deliberately,
  so a device that is merely logged in cannot enumerate or revoke the others —
  and the refusal was being read as an empty list. It now says where the list
  lives instead of claiming there is nothing in it.

## 1.1.0

The first published build of the Windows desktop app, and the first release the
app can find on its own.

### Added

- **Updates from GitHub.** The app checks for a newer release when it opens and
  every six hours after that, and **Check for updates** in the tray and
  application menus opens a window showing your version against the latest one.
  A release is downloaded when you ask for it and installed when you ask for
  that: installing closes the app, so neither happens on its own while you are
  watching something. Installing stops the server cleanly first, and your data
  folder is left exactly as it was.
- **Closing the window asks what it should do.** Shutting the window stops
  nothing — downloads, conversions and anyone watching from another device all
  carry on — which is the right behaviour and an invisible one. The first close
  now asks whether to keep running in the tray or to quit, in a panel drawn
  inside the app rather than a Windows message box, and remembers the answer
  only if you tick the box. **Settings → Desktop app → Closing the window**
  changes it afterwards, including back to asking every time.

### Fixed

- **Typing in search no longer rebuilds the page.** Each keystroke used to
  write the query into application state, which re-rendered the whole page:
  the results grid was thrown away and rebuilt, every poster reloaded, and the
  scroll position snapped back to the top while you were still typing. The
  half-typed query no longer lives in state, so the page holds still and the
  search runs on what is in the box.
- **An AllDebrid key it no longer likes will not log you out.** The account
  panel on the settings page passed AllDebrid's rejection straight through as a
  401, and the app treats a 401 as a revoked session — so opening Settings with
  an expired key bounced you to the login screen, and signing back in did it
  again. Rejections from a third party now read as what they are.
- **Opening the updates window checks.** It used to open on the last answer it
  had and wait to be asked a second time, which from a source checkout hid the
  one thing worth knowing: there is no installed copy here to replace.

### Notes

- The installer is unsigned, so Windows may show a SmartScreen prompt on first
  run. Choose **More info → Run anyway**.
- Updating replaces the application and keeps your library, database, watch
  history and settings where they are. Uninstalling leaves them in place too.
