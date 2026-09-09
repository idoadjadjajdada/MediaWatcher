# Changelog

What changed in each release, newest first. Every version here has a GitHub
release carrying these notes and the Windows installer built from that commit —
`node tools/release.mjs` will not publish one without both.

Versions follow [semantic versioning](https://semver.org): the minor number
moves for new behaviour, the patch number for fixes alone.

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
