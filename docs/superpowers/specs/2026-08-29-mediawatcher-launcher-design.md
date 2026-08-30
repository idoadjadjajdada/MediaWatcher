# MediaWatcher Launcher — Design

**Date:** 2026-08-29
**Status:** Approved, ready for implementation planning

---

## Problem

MediaWatcher has no working entry point. `start.bat` ends with `node launcher.js`, and
`launcher.js` does not exist; neither does the `npm run launcher` script the README
documents, nor the port-3999 web control panel it describes. The launcher that *does*
exist — `MediaWatcher.ps1`, a 505-line WinForms window — has no `.bat` to launch it,
despite its own header claiming otherwise.

The WinForms launcher also cannot deliver the intended feel. WinForms has no
compositor: animation means repainting on a timer, with no easing and no GPU
acceleration. The current file shows the strain — a single 250ms timer drains the log
*and* recomputes status, and every pre-flight refresh calls `$checkPanel.Controls.Clear()`
and rebuilds seven labels from scratch.

## Goals

- One reliable double-click entry point.
- A dark, sleek window that reads as a designed application, not a themed dialog.
- Smooth, GPU-composited animation.
- Live insight into the server: process state, library contents, active downloads.
- Pre-flight checks that fix problems rather than only reporting them.

## Non-goals

- Replacing the web UI. The launcher controls and observes the server; it does not
  browse the library.
- Cross-platform support. This is a Windows desktop launcher.
- Packaging or code signing.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| UI toolkit | **WPF via XAML, loaded from PowerShell** | Ships with .NET Framework on every Windows 10/11 machine, so the zero-install property is kept. Unlike WinForms it has a compositor: `Storyboard` animations on `Opacity` and `RenderTransform` are GPU-composited with real easing. |
| Layout | **Hybrid, tabbed** | Status strip across the top, slim control rail on the left, right pane tabbed between Log / Pre-flight / Downloads. Everything reachable in one click, nothing competing for space. |
| Window frame | **`System.Windows.Shell.WindowChrome`** | Restyles the titlebar while keeping the real window underneath: hardware acceleration, native resize, Aero Snap, and Windows 11's automatic rounded corners all survive. Rejected `AllowsTransparency="True"`, which on .NET Framework 4.x forces the window into software rendering and would undercut the animation goal. |
| Added features | **Live status panel + one-click pre-flight fixes** | Both are cheap given the API the server already exposes. Rejected: unknown-files inspector, auto-start on launch. |
| Motion set | **Entrance, status pill, gated log lines, progress + buttons** | Rejected: tab slide/crossfade, counter roll-up. |

---

## File layout

```
mediawatcher/
├── MediaWatcher.bat              new — double-click entry point
├── MediaWatcher.winforms.ps1     existing MediaWatcher.ps1, renamed, kept as fallback
├── start.bat                     rewritten to hand off to MediaWatcher.bat
├── README.md                     launcher section rewritten
└── launcher/
    ├── MediaWatcher.ps1          entry: loads XAML, wires events, owns the dispatcher tick
    ├── MainWindow.xaml           all markup, styles, storyboards
    └── lib/
        ├── Config.ps1
        ├── Preflight.ps1
        ├── ServerProcess.ps1
        └── ApiClient.ps1
```

The project is **not** a git repository, so there is no undo. The existing WinForms
launcher is renamed rather than overwritten; if the WPF version misbehaves, a working
launcher still exists.

`MediaWatcher.bat` contains a single line:

```bat
powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "%~dp0launcher\MediaWatcher.ps1"
```

`launcher/MediaWatcher.ps1` resolves the project root as the **parent** of its own
directory, not its own directory.

---

## Module interfaces

Each module dot-sources into the entry script and owns one concern.

### `lib/Config.ps1`

```
Read-EnvFile($path)          -> hashtable of key/value, inline comments stripped
Resolve-MwPath($raw, $root)  -> absolute path (passes through rooted paths)
Get-MwConfig($root)          -> @{ Root; EnvPath; EnvValues; Port; LibraryPath;
                                   TempPath; FfmpegPath; FfprobePath; LogLevel }
```

Defaults when `.env` is absent or a key is blank: port `3000`, library `./library`,
temp `./temp`, ffmpeg `ffmpeg`, ffprobe `ffprobe`, log level `info`.

### `lib/Preflight.ps1`

```
Get-PreflightChecks($config)        -> array of check objects
Invoke-PreflightFix($check, $queue) -> $true if the fix started
```

A check object is:

```
@{ Id; Label; Ok; Severity; Detail; FixLabel; Fix }
```

`Severity` is `fail` or `warn`. `Fix` is a scriptblock or `$null`. Long-running fixes
delegate to `Start-StreamedCommand` and return immediately.

| Id | Label | Test | Severity | Fix |
|---|---|---|---|---|
| `node` | Node.js | `Get-Command node`, then `node --version` | fail | none — detail links to nodejs.org |
| `env` | `.env` file | `Test-Path .env` | fail | copy `.env.example` to `.env` |
| `keys` | API keys | `TMDB_API_KEY` and `ALLDEBRID_API_KEY` non-empty | fail | `Start-Process .env` (opens in default editor) |
| `ffmpeg` | ffmpeg | `Get-Command $config.FfmpegPath` | warn | `winget install Gyan.FFmpeg`, streamed |
| `library` | Library folder | `Test-Path $config.LibraryPath` | warn | create the directory |
| `deps` | Dependencies | `Test-Path node_modules` | fail | `npm install`, streamed |
| `port` | Port free | no non-MediaWatcher listener on `$config.Port` | warn | none — detail names the owning pid |

`ffmpeg` is `warn` rather than `fail` because the server runs without it; only playback
of incompatible files suffers. `port` is `warn` because a listener may be a
MediaWatcher instance the launcher itself started.

### `lib/ServerProcess.ps1`

```
Start-MwServer($config, $logLevel, $queue)              -> System.Diagnostics.Process
Stop-MwServer($proc)                                    -> void
Start-StreamedCommand($file, $args, $workdir, $queue, $tag) -> Process
```

Ported from the existing WinForms implementation, which is sound: `ProcessStartInfo`
with redirected stdout/stderr, `Register-ObjectEvent` handlers enqueueing into a
`[System.Collections.Queue]::Synchronized` queue, and `taskkill /PID <id> /T /F` to
stop — Node on Windows cannot receive SIGTERM, and SQLite's WAL mode recovers on next
open, so a hard kill is safe.

`Stop-MwServer` must unregister its event subscriptions. `Start-StreamedCommand`
generalises the same plumbing so `npm install` and `winget` stream into the same log.

Queue message shape:

```
@{ Kind = 'stdout' | 'stderr' | 'notice'; Text; Tag; Timestamp }
```

### `lib/ApiClient.ps1`

```
Start-ApiPoller($config, $resultQueue) -> handle
Stop-ApiPoller($handle)                -> void
Request-LibraryRefresh($handle)        -> void   # forces a library poll on next cycle
Request-Rescan($handle)                -> void   # POST /api/media/rescan, then refresh
```

Runs a background runspace. **No HTTP call is ever made on the UI thread**, including
the rescan POST. This fixes a live defect in the current launcher, where
`$btnRescan.Add_Click` calls `Invoke-WebRequest -TimeoutSec 10` on the UI thread and
freezes the window for up to ten seconds against a hung server.

`Request-Rescan` enqueues work onto the poller runspace rather than blocking: it POSTs
to `/api/media/rescan` (which returns 202 immediately), then polls
`/api/media/library` every 2s until `scanning` goes false, emitting a `library` result
each time so the status tiles update as the scan lands.

Result message shape:

```
@{ Kind = 'health' | 'library' | 'jobs' | 'error'; Data; Timestamp }
```

Cadence and timeouts:

| Endpoint | Interval | Timeout | Condition |
|---|---|---|---|
| `/api/health` | 2s | 3s | always, while the process is alive |
| `/api/media/library` | 15s | 10s | always, plus on demand after a rescan |
| `/api/torrents/jobs` | 2s | 5s | only when the Downloads tab is visible or a job is active |

`/api/media/library` is polled slowly on purpose: it returns the entire library payload,
and against a cold server the first call blocks on a full scan. The conditional job
polling mirrors `public/js/app.js:syncJobPolling`.

---

## Threading model

Three producers, one consumer, one rule: **nothing touches the UI except the dispatcher
tick and direct user input.**

| Producer | Mechanism | Destination |
|---|---|---|
| Server stdout/stderr | `Register-ObjectEvent` | output queue |
| Fix commands | `Start-StreamedCommand` | output queue |
| API polling | background runspace | result queue |

A single `DispatcherTimer` at **200ms** drains both queues and updates the UI. It also
detects process exit, recomputes uptime, and toggles button enabled-states.

---

## UI structure

Window: default 1040×700, minimum 880×580, centred on screen.

```
┌──────────────────────────────────────────────────────────────┐
│ ▶  MediaWatcher                          ● Running  pid  ⏻ ─ ✕│  WindowChrome titlebar
├──────────────────────────────────────────────────────────────┤
│  [ 91 FILES ] [ 1 SHOWS ] [ 0 MOVIES ] [ 2 DOWNLOADING ]      │  status strip
├───────────────┬──────────────────────────────────────────────┤
│ Start server  │  Log │ Pre-flight ● │ Downloads 2            │  tabs
│ Restart  Stop │ ┌──────────────────────────────────────────┐ │
│ Open MediaW.  │ │                                          │ │
│ Rescan library│ │           active tab content             │ │
│ Library folder│ │                                          │ │
│ Log level ▾   │ └──────────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────────┘
```

Tabs switch instantly; the gradient underline jumps to the new tab. The Pre-flight tab
shows a red dot when any check fails; Downloads shows a count when jobs are active.

Control rail behaviour:

| Control | Action |
|---|---|
| Start / Restart / Stop | `Start-MwServer` / stop-then-start / `Stop-MwServer`. Disabled states follow process liveness. |
| Open MediaWatcher | `Start-Process "http://localhost:<port>"` — enabled only while running |
| Rescan library | `Request-Rescan` — enabled only while running |
| Library folder | `Start-Process $config.LibraryPath` — always enabled |
| Log level | Sets `LOG_LEVEL` in the child process environment. **Applies to the next start**, not the running server, since the level is read once at boot by `config/index.js`. The label states this. |

**Palette** — taken from the existing launcher, which already matches the web app:

| Token | Hex |
|---|---|
| Background | `#0a0a0a` |
| Panel | `#161616` |
| Hover | `#1f1f1f` |
| Log background | `#0d0d0d` |
| Border | `#2a2a2a` |
| Text | `#e5e5e5` |
| Dim | `#888888` |
| Accent | `#a855f7` |
| Accent 2 | `#ec4899` |
| Success | `#10b981` |
| Warning | `#f59e0b` |
| Danger | `#ef4444` |
| Info | `#93c5fd` |

Fonts: Segoe UI for the interface, Consolas for the log.

### Log pane

`ItemsControl` over an `ObservableCollection`, with `VirtualizingStackPanel` — not a
`RichTextBox`, which degrades badly at volume. Buffer capped at **500 lines**, trimmed
from the front. Line colour is bound to level: `ERROR` danger, `WARN` warning, `DEBUG`
dim, `INFO` info, anything else text. Follow-tail and Clear controls sit above the pane.

---

## Motion

All storyboards animate `Opacity` and `RenderTransform` only, so they stay GPU-composited.

| Motion | Spec |
|---|---|
| **Entrance** | Panels fade `0→1` and rise 14px. 260ms, `QuinticEase` `EaseOut`, 130ms stagger between siblings. Fires on window open and on tab switch. |
| **Status pill** | `ColorAnimation` over 400ms across background, border and foreground: grey (stopped) → amber (starting) → green (running). Once running, the dot gets a 1.6s repeating outward pulse. |
| **Log lines** | Fade `0→1` with a 10px slide from the left, 450ms, `QuinticEase` `EaseOut`. **Gated:** the drain loop counts lines per tick; ≤1 line per 200ms tick (≈5/sec) animates, a burst appends instantly. |
| **Progress + buttons** | Bars `DoubleAnimation` to each new value over 400ms rather than jumping, with a 1.5s looping sheen sweeping across the fill. Buttons lift on hover and dip to 96% scale over 90ms on press. |

**Known wrinkle:** virtualization recycles containers, so a scrolled-away log line can
replay its entrance animation. Each line model carries a `HasAnimated` flag, set after
first play and checked by the container's `Loaded` handler.

---

## Error handling

| Situation | Behaviour |
|---|---|
| Server exits on its own | Status pill drops to grey; exit code written to the log as a `notice` |
| Port already taken | Pre-flight `port` check reports the owning pid before start; the server's own `EADDRINUSE` message surfaces in the log regardless |
| API poll fails while process alive | Status tiles render `—`, not stale numbers. Repeated failures logged once, not per attempt |
| Fix command fails | Output streams to the Log tab, check stays red, button re-enables |
| `.env` missing or unreadable | Reported by pre-flight; the launcher still opens and stays usable |
| XAML fails to parse | Message box naming the failing line, then exit — a half-built window is worse than none |
| Window closed while server runs | `Stop-MwServer` in the closing handler, so the server is never orphaned |

---

## Testing

The four `lib/*.ps1` modules are pure logic and get Pester tests:

- `Config.ps1` — `.env` parsing (inline comments, blank values, missing file), path
  resolution for rooted and relative inputs
- `Preflight.ps1` — check evaluation against mocked `Get-Command` / `Test-Path`, correct
  severity, fix presence
- `ServerProcess.ps1` — queue message shape from a short-lived real process
- `ApiClient.ps1` — response shaping and error paths against canned JSON

The window itself is verified manually. There is no honest way to unit-test WPF
interaction from PowerShell without tooling that costs more than it returns here.

**Dependency note:** these need Pester 5 (`Install-Module Pester -Scope CurrentUser`).
Windows ships Pester 3.4, which will not run them. If adding that dependency is
unwanted, the fallback is a plain `tests/run-tests.ps1` assertion script with no module
requirement.

---

## Migration and cleanup

1. Rename `MediaWatcher.ps1` → `MediaWatcher.winforms.ps1`.
2. Add `MediaWatcher.bat`.
3. Rewrite `start.bat` to hand off to `MediaWatcher.bat`, keeping its existing Node
   check and first-run `npm install` / `.env` creation.
4. Rewrite the README's **Quick start** and **The launcher** sections: remove
   `npm run launcher`, the port-3999 control panel, and `launcher.js`; document
   `MediaWatcher.bat` and the real feature set.
5. Add `.superpowers/` to `.gitignore` (brainstorming artifacts).

`package.json` needs no change — the launcher is not a Node program, so no `launcher`
script should be added.
