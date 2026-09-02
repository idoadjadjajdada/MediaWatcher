# Code review — 2026-09-02

Full pass over the backend (auth, streaming, HLS, downloads, scanner, db), the
frontend render/player code, and config. Findings are ordered by severity; file
and line references are as of this date.

> **Status:** every finding below is fixed. Line references therefore point at
> the code as it was, not as it is. New settings are in `.env.example`; new
> suites are `downloads`, `cache-limits`, `scanner-titles` and `hls-ownership`.

---

## High — real logic/operational holes

### 1. A non-matching episode torrent downloads everything in it

`selectFiles` (services/downloader.js:80-95): for `type: 'episode'`, if no
filename in the torrent matches `SxxExx` or `1x05`, the `match` is undefined
and execution falls through to `return pool` — every video in the torrent. Each
file then goes through the same `targetPath({type:'episode', season, episode})`
in the loop (services/downloader.js:210-220), so a season pack lands as
`Show - S01E05 - Episode.mkv`, `… (2).mkv`, `… (3).mkv`, and so on. Wrong disk
usage, wrong bandwidth, wrong library.

### 2. A server restart mid-episode-download mangles the destination

The `download_jobs` schema has no `season`/`episode`/`year`/`episodeTitle`
columns, and `reconcileOnBoot` re-queues with only
`{type, title, tmdb_id, magnet, source}` (services/downloader.js:349-353). The
re-run has no episode numbers, so `episodeTag(undefined, undefined)` produces
`S00E00` and `seasonFolder` produces `Season 00` (services/organizer.js:44,
63-65) — files land in `Season 00` — and it also triggers finding 1's
fallthrough, since the season/episode match can no longer hit.

### 3. No stall detection on the transfer phase

`streamToFile` uses `timeout: 0` (services/downloader.js:118) with no
inactivity watchdog. A stalled AllDebrid link hangs the job forever while
holding one of the 2 concurrency slots; nothing but manual cancel frees it.

### 4. No disk-space management anywhere, and the MP4 cache never evicts

Temp writes, library moves, `cache/hls` (bounded per-session, fine),
`cache/thumbs` (rebuilt keys, grows with library), and above all `cache/mp4`
(services/mp4cache.js) — every non-direct play converts a full copy at full
quality with no TTL or LRU. A large library converts to tens or hundreds of GB
with no cleanup path. Disk fills and the failure mode is confusing ffmpeg
write errors.

---

## Medium

### 5. No global cap on concurrent ffmpeg processes

HLS encoders (one per viewer/file/quality), mp4cache conversions (one per
file/variant), thumbnail generation (four per file, services/thumbnails.js:26),
and intro detection (two decodes per pair) can all run at once. Several
simultaneous viewers plus background conversions on modest hardware will
thrash. Individual pools exist; a shared budget does not.

### 6. Temp-file name collisions between concurrent jobs

`tempPath` is `sanitizeName(file.filename)` only (services/downloader.js:192)
— no job id. Two concurrent jobs (the ceiling is exactly 2) whose torrents
contain same-named files write to the same path simultaneously: corrupted file,
possibly passing the size check.

### 7. Any authenticated device can kill or keep alive any other viewer's HLS session

`POST /api/hls/:session/touch` and `DELETE /api/hls/:session`
(routes/hls.js:109-121) check only that the session exists — not that the
caller owns it. Session ids are even displayed in the player's diagnostics
panel. A signed-in phone can cut off another viewer. Consistent with a
household threat model, but the route comment does not acknowledge it.

### 8. Error handler leaks internals; CORS rejection returns 500

The final handler sends `error.message` to clients for every status
(server.js:182), and a disallowed `Origin` surfaces as a 500 via the cors
callback error (server.js:94). Filesystem/TMDB errors can expose absolute
paths. Also cosmetic: an unauthenticated cross-origin request gets the 500
rather than a 403.

### 9. Progress rows are never pruned for deleted files

Continue Watching (db/index.js:100-115) returns rows whose files may be gone;
clicking them fails in the player. `DELETE /api/progress` exists but nothing
sweeps on rescan.

### 10. Retrying a completed job re-downloads the whole file

`startDownload` only short-circuits for `downloading`/`queued`
(services/downloader.js:283-286); a second call with the same magnet upserts a
completed row back to `queued` and transfers everything again. The UI only
offers Retry on errors, but the API allows it — and the manual "Add torrent"
flow can hit it.

### 11. Two small auth leaks

`failures` map entries are never deleted (services/auth.js:108-127) and the
in-memory `sessions` Set never expires server-side — an unremembered login
survives until process restart, contradicting the README's "dies with the
browser" claim (the cookie does; the server entry doesn't). Both are slow
leaks, not exploits.

---

## Low

- **Junk-token stripping eats real titles** (services/scanner.js:49-75):
  `JUNK_TOKENS` includes `web`, `ts`, `complete`, `multi` — "The Web" becomes
  "The", sending TMDB the wrong query. Only end-of-title tokens, so it's rare,
  but a bad match silently produces wrong metadata.
- **Same-named shows merge into one lookup group** (services/scanner.js:265 —
  shows don't use year in the key), so two distinct shows with identical names
  resolve to one TMDB entry.
- **`watcher.ignored` prefix comparison** (services/watcher.js:104) compares
  chokidar's path form against `config.tempPath` — separator/normalization
  mismatch if temp is configured inside the library.
- **X-Forwarded-For spoofable from loopback** (server.js:49,
  services/network.js): a local request claiming `100.x.x.x` gets classified
  as tailscale — self-harm (wrong quality cap), but worth knowing.
- **Failed thumbnail generation restarts on every hover**
  (services/thumbnails.js:126-131): `count < total` stays true forever when
  frames fail, so each hover re-kicks the full remaining job.
- **Playlist duration drift**: the playlist is computed from probe duration; if
  the real encode ends short, near-tail segments 404 after the 30s wait —
  player stalls at the very end.
- **`.env.bak-before-fix` sits in the repo root** — gitignored (`.env.*`), but
  it's a live copy of the keys in a second location; worth deleting once
  whatever it was backing up is settled.

---

## Solid — things commonly wrong that aren't here

- The path guard (services/organizer.js:147-177) is genuinely good — resolve,
  nearest-existing-ancestor realpath, symlink-aware, correct on Windows.
- Constant-time password and admin-key compares, hashed device tokens, per-IP
  backoff, no loopback trust.
- Every client path is `spawn()`ed (no shell injection); SQL is fully
  parameterized; `?q=` uses `hasOwnProperty.call` so `__proto__` can't sneak
  into the quality ladder.
- The quality cap is enforced in exactly one place (`decide()`) and overrules
  direct and cached paths alike.
- `parseRange` handles suffix/open/multi ranges correctly.
- The HLS session design — per-viewer keying, bounded encode-ahead, serialized
  restarts, abort-on-disconnect, prune-behind — is careful.
- The frontend keeps `esc()` discipline on every third-party string checked.
- The test suite (22 files) covers the load-bearing pure logic.
- CSRF is adequately covered by SameSite=Lax plus the CORS origin gate on
  non-GETs.

---

The four High items are all in the downloader, and three of them chain
together — fixing the schema (finding 2) and the `selectFiles` fallthrough
(finding 1) would close the worst failure mode.

---

## What each fix was

1. `selectFiles` returns nothing when the requested episode is not in the
   torrent, instead of falling through to every video in it. The job fails
   saying which episode it could not find. A torrent holding exactly one video
   is the exception: there is nothing to confuse it with, and plenty of
   single-episode releases name the file something no pattern can read.
2. `download_jobs` gained `year`, `season`, `episode` and `episode_title`
   (added by `ALTER TABLE` on boot for existing databases), and
   `reconcileOnBoot` rebuilds the request from them through `requestFromJob`.
3. `streamToFile` runs an inactivity watchdog — `DOWNLOAD_STALL_TIMEOUT_MS`,
   two minutes by default. Still no overall timeout: a download may take hours,
   but silence is not progress.
4. `services/cacheSweeper.js` trims `cache/mp4` and `cache/thumbs` on boot and
   on an interval, by TTL first and then least-recently-played until each is
   under budget. Cache hits stamp their directory so "recently played" means
   something. Downloads and conversions check free space before they start.
5. `services/ffmpegPool.js` is one budget for every ffmpeg process
   (`FFMPEG_MAX_PROCESSES`). Playback takes a slot without queueing; MP4
   conversions, thumbnails and intro detection wait for what is left. MP4
   conversions additionally run one at a time.
6. Temp files are named `<job id>-<filename>`.
7. HLS sessions record the viewer that opened them; touch, delete and segment
   requests all check it, and someone else's id answers as an invented one does.
8. The error handler passes through 4xx messages only — a 5xx says "Internal
   server error" and the detail goes to the log. A refused origin is a 403.
9. `pruneMissingProgress` runs at the end of every scan. A row is dropped only
   when its directory exists and the file does not, so an unplugged drive
   costs nothing.
10. `startDownload` returns a completed job as-is when its file is still there.
11. Unremembered sessions expire after `AUTH_SESSION_TTL_HOURS` of idleness
    (sliding, so it never interrupts a viewing) and failure records are
    forgotten an hour after they stop blocking.

Low: junk-token stripping now needs an unambiguous release tag in the trailing
run before it will drop ambiguous words, so "The Web" survives; shows are keyed
by year like movies; the watcher compares paths with `path.relative` rather than
`startsWith`; `trust proxy` is off unless `TAILNET_HOST` is set; a thumbnail job
that gave up is not restarted until it makes progress or an hour passes; and the
playlist-drift stall is covered at both ends — see below.

## Found while verifying

Three things the review did not list, all turned up by writing tests for the
fixes above rather than by reading:

**The tail of a file is worse than a stall.** ffmpeg answers an input seek past
the end of an MKV by rewinding to the start and encoding the whole file, so a
playlist that overruns the real content served the *opening of the film as its
final segment* — not a 404. Verified against a real encoder: any seek past the
end, even by one second, replays. The manager now refuses to restart past the
point a run demonstrated the source reaches, but only when that run had the
budget to finish the playlist and did not; a bounded run in the middle of a long
film says nothing about where the file ends, and reading it as the end would
refuse the rest of the episode. `tests/hls-tail.test.mjs` pins both halves.

**A failed download crashed its own event bus.** `events.emit('error', …)` with
no listener attached throws `ERR_UNHANDLED_ERROR` — nothing in the app
subscribes to `downloader.events` — so every failed job threw out of its own
catch block and surfaced as an unhandled rejection, with the useful message
already logged a line earlier. A no-op listener is registered at module scope.

**Refusing a nameless single-file torrent.** Finding 1's first fix was too
broad, and would have failed any single-episode release whose file name carries
no `SxxExx`. See the exception in 1 above.

`.env.bak-before-fix` is deleted. It held an older `ALLDEBRID_API_KEY` and a
different `TORRENTIO_CONFIG`; both were confirmed unwanted before it went.
