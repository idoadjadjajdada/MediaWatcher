# Changelog

What changed in each release, newest first. Every version here has a GitHub
release carrying these notes and the Windows installer built from that commit —
`node tools/release.mjs` will not publish one without both.

Versions follow [semantic versioning](https://semver.org): the minor number
moves for new behaviour, the patch number for fixes alone.

## Unreleased

### Fixed

- The close prompt no longer times out while it is on screen. The shell hides
  the window by itself if the prompt cannot be drawn — a crashed renderer, or a
  page mid-navigation — and that fallback was on a timer rather than an answer,
  so reopening the window from the tray while the question was up saw it vanish
  again four seconds later. The prompt now says when it has appeared, and the
  fallback stops running.

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
