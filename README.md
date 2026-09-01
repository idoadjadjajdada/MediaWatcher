# MediaWatcher

A self-hosted library for your movies and TV shows: it scans your files, enriches
them with metadata from TMDB, finds new releases through a debrid service and
public indexers, and plays everything back in the browser with resume, subtitles
and next-episode autoplay.

No build step, no framework, no bundler. Node on the back, vanilla ES modules on
the front.

---

## Requirements

| | |
|---|---|
| **Node.js** | 20 LTS or newer (developed and tested on 24) |
| **ffmpeg** | Strongly recommended — see [Playback](#playback) |
| **TMDB API key** | Free, from <https://www.themoviedb.org/settings/api> |
| **AllDebrid API key** | Paid account, from <https://alldebrid.com/apikeys> |

`ffmpeg` is optional in the sense that the app runs without it, but most `.mkv`
releases will not play in a browser unless it is installed.

---

## Quick start

**Double-click `MediaWatcher.bat`.** That opens the launcher — a desktop control
panel for starting and stopping the server, with pre-flight checks, live library
stats and a colour-coded server log.

First time out, run `start.bat` instead: it installs dependencies, creates `.env`
from `.env.example`, and then opens the same launcher.

From a terminal instead:

```bash
npm install
cp .env.example .env      # then open .env and paste your two API keys
npm start                 # server only, logs in the terminal
```

Either way the app itself is at <http://localhost:3000>.

### The launcher

`MediaWatcher.bat` opens a WPF window that:

- starts, stops and restarts the server, showing pid and uptime
- runs pre-flight checks — Node version, `.env`, both API keys, ffmpeg, library
  folder, dependencies, port availability — and offers a one-click fix for each
  failure it can repair itself (`npm install`, creating `.env`, installing ffmpeg
  via winget)
- shows live library counts and any active downloads, read from the server's own API
- streams the server log, colour-coded by level, with follow and clear
- triggers a rescan, opens the app, or opens your library folder
- lets you pick a log level for the next start

It is a single PowerShell script driving a XAML window — no installs beyond what
Windows already ships. All HTTP runs off the UI thread, so a hung server never
freezes the window. Like the app, everything it talks to is on `127.0.0.1`.

The previous WinForms launcher is kept as `MediaWatcher.winforms.ps1` if you need
a fallback.

The first launch creates `library/movies`, `library/shows`, `temp/` and
`db/mediawatcher.db`, then scans whatever is already in the library.

### Installing ffmpeg

```powershell
winget install Gyan.FFmpeg        # Windows
brew install ffmpeg               # macOS
sudo apt install ffmpeg           # Debian/Ubuntu
```

If it is not on your `PATH`, set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env` to
the absolute paths. The server logs which state it is in at boot:

```
INFO  [app] ffmpeg found — incompatible files will be remuxed on the fly
```

---

## Organising your library

The scanner reads filenames first and folder structure second. Any of these work:

```
library/
├── movies/
│   ├── Blade Runner 2049 (2017)/
│   │   ├── Blade Runner 2049 (2017).mkv
│   │   └── Blade Runner 2049 (2017).en.srt
│   ├── Inception.2010.1080p.BluRay.x264-SPARKS.mkv
│   └── Arrival (2016)/
│       └── movie.mkv                      ← folder name is enough
└── shows/
    └── Severance/
        └── Season 01/
            ├── Severance.S01E01.1080p.WEB-DL.mkv
            ├── Severance.S01E02.mkv
            └── Severance.S01E02.srt
```

Filename patterns, tried in order:

| Pattern | Example |
|---|---|
| `SxxExx` (multi-episode too) | `Show.S01E05.mkv`, `Show.S01E05.E06.mkv` |
| `1x05` | `Show.1x05.mkv` |
| `Season X Episode Y` | `Show.Season 1 Episode 5.mkv` |
| Year in brackets | `Movie.(2023).mkv` |
| Bare year | `Movie.2023.1080p.mkv` |
| Folder inference | `shows/Name/Season 01/…`, `movies/Name (2023)/…` |

Anything that matches none of these is listed under `unknown` in
`GET /api/media/library` rather than being silently dropped.

**Subtitles** are matched to a video by filename stem, with or without a
language suffix: `Movie.srt` and `Movie.en.srt` both attach to `Movie.mkv`.
Subtitles embedded inside an MKV are found automatically too.

**Duplicates collapse.** The same show in two different folders becomes one
library entry, because entries are deduped by TMDB id rather than by path.

Files dropped into the library are picked up automatically within a few seconds —
the Rescan button is only there for when you want to force it.

---

## Playback

Quality is never reduced unless your browser genuinely cannot decode the file.
Each file is probed once and served the cheapest possible way:

| Mode | When | What happens to the video |
|---|---|---|
| **direct** | Browser can play the file as-is (MP4 with H.264/AAC) | Raw bytes, byte-for-byte, with range requests. ffmpeg is not involved. |
| **remux** | Codecs are fine, container is not (H.264/AAC in MKV) | Container swap only. **Video and audio are copied bit-for-bit.** |
| **remux-audio** | Video is fine, audio is not (DTS, TrueHD) | **Video copied bit-for-bit**, only the audio re-encoded to AAC. |
| **transcode** | The video codec itself is undecodable | Video re-encoded. The only lossy path. |

The player tells the server what it can decode (HEVC, AC3), so on a machine with
HEVC hardware decoding a 4K HEVC file is *copied*, not re-encoded. The badge in
the top-right of the player shows which mode is in use.

Seeking works differently in the two shapes, and the player handles both: in
direct mode it is a normal byte-range seek; in ffmpeg modes the stream restarts
at a timestamp, so seek accuracy is bounded by the source's keyframe interval.

### Known limits

- **No hardware-accelerated transcoding.** A full HEVC → H.264 transcode is
  CPU-bound. It works, but on a weak machine it will not keep up with 4K.
- **Bitmap subtitles (PGS/VobSub) cannot be shown.** They are images, and turning
  them into WebVTT would need OCR. Text-based tracks (SRT, ASS, embedded SubRip)
  are fine.
- **ASS styling is not rendered.** ASS tracks are served as plain text; the
  `<track>` element has no ASS renderer.

---

## Remote access

MediaWatcher still binds to `127.0.0.1` and is never exposed to the internet or
even to your LAN. Remote devices reach it over a Tailscale tunnel, and
everything behind the tunnel is behind a password.

### One-time setup

1. Install [Tailscale](https://tailscale.com/download/windows) on this machine
   and sign in.
2. In the [admin console](https://login.tailscale.com/admin/dns), enable
   **MagicDNS** *and* **HTTPS Certificates**. Both are required — without them
   there is no valid certificate, and iOS Safari gates several video and
   secure-context behaviours behind one.
3. Publish the server:

   ```
   tailscale serve --bg 3000
   ```

   This prints a hostname like `desktop-9dikq29.taila824ee.ts.net`. It says
   "Available within your tailnet" — this is the private serve, not Funnel, so
   nothing is reachable from the public internet.
4. Put that hostname (bare — no `https://`, no trailing slash) into `.env`:

   ```
   TAILNET_HOST=desktop-9dikq29.taila824ee.ts.net
   ```

   Restart the server so CORS accepts the new origin.
5. Install Tailscale on each device, signed into the same account, and open
   `https://<your-host>.ts.net`.

`tailscale serve` configuration does not always survive a Tailscale upgrade. If
remote access stops working, re-run step 3 before looking anywhere else.

### The password gate

`AUTH_PASSWORD` in `.env` is required and must be at least 8 characters — the
server refuses to start without it, because booting an unauthenticated server
behind a tunnel is the worst failure available here.

Every device enters it once. Ticking **Remember this device** stores a row in
the `devices` table keyed by the SHA-256 of a random 256-bit token, which is
kept in an `HttpOnly` cookie. Only the hash is stored, so a leaked database file
yields no working credential. Leaving it unticked gives a session that dies with
the browser and is never recorded.

A device is identified by that minted token, never by a browser fingerprint. A
fingerprint merely *describes* a device, and a description can be forged by
anyone who knows the shape of an authorised one. It also could not work here:
playback is driven by `<video src="/api/stream?...">`, which issues its own
range requests with no JavaScript in the loop to attach a header or compute
anything — a cookie is the only credential that rides along.

**Loopback is deliberately not trusted.** `tailscale serve` proxies from
`127.0.0.1`, so every remote request arrives looking local; a "trust loopback"
shortcut would disable authentication for exactly the traffic the gate exists to
stop. `tests/auth-loopback.test.mjs` guards this.

### Managing devices

The launcher's **Devices** tab lists every remembered device — name, browser,
LAN or Tailscale, last IP, last seen — and revokes any of them. Revocation takes
effect on that device's very next request.

The tab authenticates with `config/admin-key`, a 32-byte key the server writes
on first boot. It is machine-local, gitignored, and must never be committed. A
signed-in phone holds a device cookie but not this key, so it cannot enumerate
or revoke anything.

### Playback delivery

Three ways a file reaches a player, in order of preference:

| Path | When | Seeking |
|------|------|---------|
| `direct` | the browser can decode the file as it sits on disk | byte ranges |
| `cached-*` | a converted MP4 already exists in `cache/mp4` | byte ranges |
| HLS | anything else — a container swap, an audio re-encode, HDR tone mapping, or a quality cap | by segment |

HLS replaced a raw ffmpeg pipe, for two reasons.

**iOS could not play the pipe at all.** Safari on iOS opens a source through
AVFoundation, which probes it with `Range: bytes=0-1` and requires a `206`. A
pipe has no byte offsets, so it answered `200` with `Accept-Ranges: none` and
iOS abandoned the source with `MEDIA_ERR_SRC_NOT_SUPPORTED`. Segments are
ordinary files, so the problem disappears.

**The pipe could not seek.** Seeking meant restarting ffmpeg at `?t=`, roughly
630ms per seek and impossible to scrub. HLS seeks by segment.

MediaWatcher writes the playlist itself from the probed duration, so the whole
timeline exists before a single segment does and the scrub bar is accurate
immediately. ffmpeg only writes segments, numbered by us — which is what lets
the encoder be killed and restarted at any point when you seek.

Sessions live in `cache/hls/`, are keyed on everything that changes the output
(file, quality, audio track, offset, client capabilities), and are reaped once
idle. Nothing is kept between sessions: segments are quality-specific and cheap
to remake.

Safari and iOS play HLS natively. Everything else uses `hls.js`, served from
`public/js/vendor/` and loaded only when a stream actually needs it.

A session belongs to one viewer, not just to one file: two devices playing the
same episode at the same quality get their own encoder, because a seek by
either restarts the encoder and discards the segments the other is playing.

One encoder run produces `HLS_ENCODE_AHEAD_SECONDS` of video (five minutes by
default) and then stops; the next run starts wherever the viewer has actually
reached. Without that bound ffmpeg encodes to the end of the file whether or not
anyone watches that far.

Closing the player ends its session immediately. While it is open the player
sends a keepalive, so a long pause is not reaped out from under it.

**Seeking transcoded content costs an encode.** Every seek restarts ffmpeg at
that point, so the first segment after a jump takes a few seconds — and on 4K
HDR, where the seek also pays for a tone map, measurably longer. Files that play
`direct` or from the MP4 cache seek instantly, because those are real files.

### Chapters

Nearly every file here carries chapter marks — a sampled thirty gave
twenty-nine — so they appear as ticks on the scrub bar, as a list to jump from,
and on `,` and `.` to step between them. Previous restarts the current chapter
before leaving it, the way a CD player does.

Titles are not shown when they are not worth showing: every file sampled named
its chapters "Chapter 1", "Chapter 2", so the list falls back to the number and
gives you the timestamp instead.

### Sleep timer

In the playback menu: stop after 15, 30 or 60 minutes, or at the end of the
current episode. It pauses rather than closing, so you can see where you got to,
and an end-of-episode timer beats the auto-advance rather than racing it.

The timer survives an episode change — setting "stop in 30 minutes" and then
letting the next episode start is exactly when cancelling it would be wrong.

### Playback stats

`i`, or Diagnostics in the playback menu, overlays what is actually happening
to the stream: which delivery path it took, whether a cap applied, the source
and output resolutions, buffer ahead, dropped frames, and the HLS session id.

It exists because working out those exact numbers from the outside is slow.
When something looks wrong — a stall, a soft picture, a stream that will not
start — this answers "what is it actually doing" in one glance, and the session
id is what to grep the server log for.

### Remote quality

Playback over the tunnel is capped, because the constraint is the *client's*
connection — hotel wifi, cellular, or Tailscale's DERP relay fallback when a
direct peer-to-peer connection cannot be established. The host's uplink is not
the bottleneck.

| Level | Height | Max bitrate |
|-------|--------|-------------|
| Original | source | uncapped |
| High | 1080p | 12M |
| Medium | 720p | 5M |
| Low | 480p | 1.5M |

`Auto` — the default, and selectable per device in the player's speed menu —
means Original on the LAN and High over the tunnel. It never picks Original
remotely even though the host could serve it: a 4K remux runs 60-100 Mbps, past
most client links, and shipping tens of gigabytes over a possibly-metered
connection is not something to do unasked. Original remains available by
explicit request.

A cap overrules `direct` and `cached-*` alike — both hand over full-quality
bytes, so neither can shrink a 4K source. Height *and* container bitrate are
both grounds for capping, since a 720p file at 40 Mbps is under the height
limit and still far too fat.

Tunable in `.env`: `REMOTE_DEFAULT_QUALITY`,
`QUALITY_{HIGH,MEDIUM,LOW}_{HEIGHT,MAXRATE}`, and the session behaviour via
`HLS_IDLE_TIMEOUT_MS`, `HLS_KEEP_BEHIND` and `HLS_SEGMENT_TIMEOUT_MS`.

---

## Search and downloads

Searching queries every configured source in parallel and merges the results,
deduplicating by infohash. One dead source never fails a search — you only get an
error if *every* source fails.

| Source | Needs | Notes |
|---|---|---|
| **AllDebrid cache** | your API key | Instant downloads when a torrent is already cached |
| **Torrentio** | nothing | Public Stremio addon; which trackers it queries is configurable |
| **Jackett** | a local Jackett install | Optional. Gives you any tracker Jackett supports |

### Adding more indexers

**Torrentio** — pick your trackers at <https://torrentio.strem.fun/configure>,
then copy the options segment out of the generated URL into `.env`:

```ini
TORRENTIO_CONFIG=providers=yts,eztv,1337x,thepiratebay,torrentgalaxy|sort=qualitysize
```

**Jackett** — run Jackett, add whatever trackers you want in its dashboard, then:

```ini
JACKETT_URL=http://127.0.0.1:9117
JACKETT_API_KEY=your-jackett-key
JACKETT_INDEXERS=all
```

Leave `JACKETT_URL` empty and the source is skipped entirely.

**Anything else** — add one `search()` function and one line to the `SOURCES`
array in `services/torrentSearch.js`. A source only has to return
`{ title, infoHash, magnet, size_bytes, seeders, source }`; ranking, badges,
deduplication and the whole download path are source-agnostic.

### Result ranking

Results are scored on resolution, source (BluRay > WEB-DL > WEBRip > HDTV > CAM),
codec, and seeders, with penalties for AI-upscaled releases and for "REMUX"
labels on suspiciously small files. Sorted best-first. The **Hide low-quality
upscaled** toggle filters penalised releases out entirely.

### Downloading

Choosing a result uploads the magnet to AllDebrid, waits for it to be ready,
unlocks a direct link, streams it to `temp/`, then moves it into the right
library folder:

```
library/movies/{Title} ({year})/{Title} ({year}).mkv
library/shows/{Title}/Season {NN}/{Title} - S{NN}E{NN} - {Episode}.mkv
```

The file only appears in the library once the byte count matches, so a
half-downloaded file is never scanned or played. Retrying a failed job is the
same Download call again.

---

## Architecture

```
                      browser (vanilla ES modules, no build)
   app.js ── router + one delegated click handler
     ├── views.js ..... pages, cards, modal, toasts
     ├── search.js .... search UI + filters
     ├── player.js .... <video>, resume, subtitles, next-episode
     ├── state.js ..... observable store  (subscribe / setState)
     └── api.js ....... fetch wrappers
                                │  HTTP (localhost only)
 ───────────────────────────────┼────────────────────────────────────
                                ▼
   server.js ── express, helmet CSP, cors, static
     │
     ├── routes/media ......... library, rescan, refresh
     ├── routes/torrents ...... search, download, jobs
     ├── routes/progress ...... watch positions
     ├── routes/stream ........ range requests + ffmpeg modes
     └── routes/subs .......... sidecar + embedded subtitles
                │
                ▼
   services/
     scanner ......... walk → parse filenames → enrich → dedupe by tmdb_id
     tmdb ............ TMDB client, 30-day cache, concurrency-8 pool
     torrentSearch ... source registry, merge, dedupe by infohash
     qualityRanker ... scoring + badges
     alldebrid ....... v4 client
     downloader ...... magnet → debrid → temp → library, queue of 2
     organizer ....... path building, sanitising, library path guard
     transcoder ...... ffprobe + direct/remux/transcode decisions
     watcher ......... chokidar → debounced rescan
                │
                ▼
   db/  better-sqlite3 (WAL)
     metadata_cache · progress · download_jobs
```

**Caching.** TMDB detail payloads live in SQLite for 30 days; search responses
are held in memory for 10 minutes. The library object itself is kept in memory
and rebuilt on rescan. Scans are single-flight — concurrent callers share one run.

**Performance.** Files are grouped by unique title *before* any TMDB call, so a
1000-episode library costs a handful of lookups, not a thousand. A full rescan of
1000 files takes about 100 ms once metadata is cached.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/media/library` | Full library: `{ movies, shows, unknown, last_scan_at }` |
| `POST` | `/api/media/rescan` | Background rescan (202). `?wait=1` blocks, `?force=1` bypasses the TMDB cache |
| `GET` | `/api/media/refresh/:tmdb_id` | Force a TMDB refetch for one item |
| `GET` | `/api/search?q=&type=` | Ranked results from every source |
| `GET` | `/api/torrents/sources` | Which sources are configured |
| `POST` | `/api/torrents/download` | Queue a download |
| `GET` | `/api/torrents/jobs` | All jobs, newest first, with live progress |
| `DELETE` | `/api/torrents/jobs/:id` | Cancel and remove |
| `GET` | `/api/progress` | Continue Watching. `?file_path=` returns one row |
| `POST` | `/api/progress` | Save a position (auto-completes past 95%) |
| `GET` | `/api/stream?path=` | Video, with range support or ffmpeg piping |
| `GET` | `/api/stream/info?path=` | Playback mode, duration, tracks, and why |
| `GET` | `/api/subs?path=` | Subtitles as WebVTT. `?list=1` enumerates tracks |

---

## Configuration

Everything lives in `.env`. Only the first three are required.

| Variable | Default | Purpose |
|---|---|---|
| `TMDB_API_KEY` | — | **Required.** Metadata |
| `ALLDEBRID_API_KEY` | — | **Required.** Downloads |
| `AUTH_PASSWORD` | — | **Required, 8+ chars.** The password every device enters once |
| `LIBRARY_PATH` | `./library` | Where your media lives |
| `TEMP_PATH` | `./temp` | In-progress downloads |
| `PORT` | `3000` | HTTP port |
| `TMDB_LANGUAGE` | `en-US` | Metadata language |
| `LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` |
| `SCAN_INTERVAL_MS` | `5000` | Minimum gap between watcher-triggered rescans |
| `TORRENTIO_CONFIG` | empty | Torrentio options segment |
| `JACKETT_URL` / `JACKETT_API_KEY` | empty | Enables the Jackett source |
| `SEARCH_SOURCE_TIMEOUT_MS` | `20000` | Per-source ceiling |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Override if not on `PATH` |
| `FFMPEG_ENABLED` | `1` | Set `0` to force raw byte streaming only |
| `TRANSCODE_*` | see `.env.example` | Re-encode quality settings |
| `HLS_ENCODE_AHEAD_SECONDS` | `300` | Video one encoder run produces before stopping |
| `HLS_KEEP_BEHIND` | `100` | Segments kept behind the play position |
| `HLS_IDLE_TIMEOUT_MS` | `60000` | Idle time before a session is reaped |
| `TAILNET_HOST` | empty | Tailnet hostname, so CORS accepts that origin |
| `REMOTE_DEFAULT_QUALITY` | `high` | What `Auto` means over the tunnel |
| `QUALITY_*_HEIGHT` / `QUALITY_*_MAXRATE` | see `.env.example` | The remote quality ladder |

---

## Troubleshooting

**"MediaWatcher cannot start: required configuration is missing"**
You have no `.env`, or a key is blank. `cp .env.example .env` and fill both in.

**A file plays as audio only, or not at all**
Your browser cannot decode it and ffmpeg is missing. Check the boot log for
`ffmpeg NOT found`. Install it, or check `GET /api/stream/info?path=…` which
reports the chosen mode and the reason for it.

**Playback stutters on a 4K file**
Look at the mode badge. If it says *Transcode*, the CPU is re-encoding in real
time. Either use a browser/machine with HEVC hardware decoding, or keep an
H.264 copy of that title.

**Nothing appears after adding files**
Check the filename against the pattern table above. Unparseable files are listed
in the `unknown` array of `GET /api/media/library` with a reason. Also confirm
files are under `library/movies` or `library/shows`.

**A show appears twice**
Two folders matched different TMDB entries. Open one and use *Find More*, or hit
`GET /api/media/refresh/:tmdb_id` to force a metadata refetch.

**Search returns nothing**
`GET /api/torrents/sources` shows what is enabled. With only AllDebrid and
Torrentio configured, obscure titles may genuinely have no results — add Jackett
for more coverage.

**Downloads sit at 50%**
That is the boundary between AllDebrid fetching the torrent and the local
transfer. An uncached torrent has to download on AllDebrid's side first; the bar
moves again once the direct link is unlocked.

**`better-sqlite3` fails to install**
It needs a prebuilt binary for your Node version. If none exists you will need
build tools (`npm install --global windows-build-tools` on Windows, `build-essential`
on Linux). Switching to an LTS Node release usually avoids this entirely.

**Resetting**
Deleting `db/mediawatcher.db` is safe — you lose the metadata cache, watch
progress and download history, not your media. It is rebuilt on next start.

---

## Notes

- The server binds to `127.0.0.1` only. It holds API keys and serves local files,
  so exposing it to a network needs a deliberate reverse proxy with auth in front.
- `.env` is gitignored; `.env.example` is not. Keep real keys out of the example.
- Press `Ctrl+C` to stop the server cleanly. On Windows, a kill from Task Manager
  cannot run the shutdown handler — that is safe, since SQLite runs in WAL mode
  and recovers on next open.
- Keyboard shortcuts in the player: `Space`/`K` play-pause, `←`/`→` ±10s,
  `↑`/`↓` volume, `M` mute, `F` fullscreen, `N` next episode, `Esc` exit
  fullscreen or close. Press `/` anywhere to jump to the search box.
