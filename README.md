# MediaWatcher

<img src="public/icons/icon-192.png" alt="" width="96" align="right">

A self-hosted library for your movies and TV shows: it scans your files, enriches
them with metadata from TMDB, finds new releases through a debrid service and
public indexers, and plays everything back in the browser with resume, subtitles
and next-episode autoplay.

Node on the back, vanilla ES modules on the front. The web server needs no
frontend build step; the Windows desktop edition packages the same UI in Electron.

## Contents

- [Windows desktop application](#windows-desktop-application)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Organising your library](#organising-your-library)
- [Playback](#playback)
- [Conversion and encoding](#conversion-and-encoding)
- [Search and downloads](#search-and-downloads)
- [Remote access](#remote-access)
- [Running it from somewhere else](#running-it-from-somewhere-else)
- [Architecture](#architecture)
- [API](#api)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Notes](#notes)

---

## Windows desktop application

Build a Windows installer with `npm install` followed by `npm run dist`.
The result is `dist/MediaWatcher-Setup-1.0.2-x64.exe`, with Node.js, SQLite,
FFmpeg and FFprobe included. Installed users do not need Node, npm, a terminal,
or the old PowerShell launcher.

On first launch, choose **Use existing library** and select your existing
MediaWatcher project folder. Stop the server in the old launcher first.
This reuses your `.env`, database, watch history and media in place. For a new
installation, expand **Set up a new library** and enter your API keys and password.

The website's visuals and player are served directly from the existing `public/`
files. Closing the window keeps downloads and remote access running in the tray;
right-click the tray icon and choose **Quit MediaWatcher** to stop everything.
Use **Open in browser** for Chromecast and browser web push integrations.

The app checks GitHub for a newer release when it opens and every six hours
after that. **Check for updates** in the tray and application menus opens a
window showing your version, the latest release, and a download that only
installs when you restart. Releases come from the repository in
`desktop/release.json`; the window can point at a different one.

Run `npm run desktop` for desktop development, or `npm run desktop:pack` for an
unpacked executable. Build prerequisites, data locations, tests and distribution
notes are in [docs/desktop.md](docs/desktop.md).

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

### What else the launcher does

Beyond starting and stopping the server:

- **Restart if it crashes**, backing off each time and giving up after five
  failures in a row, so the error that caused them stays readable.
- **Throughput** while downloads run, derived from progress rather than from
  the socket — the launcher polls an API for a percentage and never sees bytes.
- **Notifications** when a download finishes or fails, whichever tab is open.
- **System tab**: Tailscale status with a start/stop toggle and a QR code to
  point a phone at, cache sizes with sweep and clear, and installing the server
  as a Windows service. Installing needs administrator rights.

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

The viewer is also who may act on it. Keepalives, segment requests and the
closing `DELETE` all check that the caller is the one who opened the session,
and someone else's id answers exactly as an invented one does. Ids are not
secret — the player shows its own in the diagnostics panel — so without that a
signed-in phone could cut off the television.

One encoder run produces `HLS_ENCODE_AHEAD_SECONDS` of video (five minutes by
default) and then stops; the next run starts wherever the viewer has actually
reached. Without that bound ffmpeg encodes to the end of the file whether or not
anyone watches that far.

Closing the player ends its session immediately. While it is open the player
sends a keepalive, so a long pause is not reaped out from under it.

### Playback speed

A slider from 0.25x to 5x, in the speed menu, over a ladder of stops rather
than a continuous range. The reason is 1.00x: it is the most-used value and the
only one that has to be exactly right, and on a continuous slider it is a pixel
you have to find. Every stop is a value someone would actually pick, so
dragging cannot leave you at 1.03x wondering why the audio sounds slightly off.
**Normal** puts it back.

The spacing is uneven on purpose — fine near 1x where a tenth is audible,
coarse at the ends where it is not. A linear slider over that range would spend
four fifths of its travel above 2x, which is the part nobody adjusts carefully.

**Pitch follows speed**, the O|I switch below it, decides what the audio does.
Off — the default, and what every browser does on its own — voices keep their
pitch at any rate. On, it behaves like a tape: slower is deeper, faster is
higher. Worth having as a choice because pitch correction is not free: it
stretches and overlaps windows of audio, which smears transients and gives
music a watery quality.

Browsers clamp very high rates and some mute audio above 2x, so the top of the
slider is worth more to skimming than to listening.

### Resuming

A saved position is offered, not taken: opening something you were part way
through shows where you got to, with Resume and Start over. Playback waits for
the answer rather than dropping you into the middle of a scene.

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

### Skip Intro

A **Skip intro** button appears when the app knows where a season's title
sequence is. It finds out two ways, and neither needs anything from the files:
every one of them titles its chapters "Chapter 1".

**By watching you.** Every forward jump near the start of an episode is
recorded. Two that agree, on different episodes, become a marker. One skip
teaches nothing and skips that disagree teach nothing, because offering to jump
into the middle of a scene is worse than never offering.

**By comparing episodes.** The first time an episode of an unknown season is
opened, two of its episodes are compared in the background. The titles are the
same audio every week and almost nothing else is, so the longest stretch they
share is the intro. Measured against chapter marks it never sees, this finds
season one's titles at 1-30s and season two's at 149-179s — the latter after a
cold open.

**By being told.** Both of those are guesses, and a guess thirty seconds out puts
the button in the middle of a line of dialogue. The control bar has an intro
editor for saying exactly where the titles are. It scrubs a *window* — a minute
or two of the episode across the full width of the panel, not the whole forty —
because that is the difference between an intro four pixels wide on the seek bar
and one that can be dragged a second at a time. A handle sits on each end; moving
one seeks the video to it, so the frame under the timestamp is the frame being
judged. The nudge buttons move an edge by a tenth of a second, which the seek bar
cannot express at all, and the − and + beside the heading zoom the strip between
30 seconds and 10 minutes. Generated thumbnails run along it where they exist.

The three sources rank: set by hand beats learned beats detected, so no
background analysis ever overwrites a correction.

**Seasons are guessed at; episodes are edited.** What is learned is a season —
the same titles every week is the pattern being looked for, and one episode
cannot establish it. What the editor saves is a single episode, because a run
that opens cold one week and not the next puts its titles in a different place
each time, and applying one person's correction to twenty-one other episodes
would replace a guess that is sometimes wrong with an assertion that is
confidently wrong. An episode that has been edited uses its own timings; every
other episode of the season falls back to what the season learned.

`PUT /api/intro` sets one episode's timings. `DELETE /api/intro` naming an
episode gives those up and falls back to the season's; without an episode it
forgets the season's timings and the skips behind them.

### Subtitles

The player lists whatever a file already has: `.srt`, `.vtt` and `.ass` sidecars
beside it first, then the text tracks inside the container. Image-based
subtitles (PGS, VobSub) are not listed at all — they are pictures, and a browser
cannot draw them without OCR or burning them into the video.

**ASS and SSA** are parsed and drawn into an overlay rather than converted to
WebVTT, because converting throws away the positioning: signs and translation
notes end up stacked at the bottom in the dialogue font. Styles, per-event
margins, alignment, `\pos`, and the usual inline tags are honoured. Karaoke,
animated transforms, vector drawings and clipping are ignored — a half-drawn
transform looks broken, where the line without it just looks plain.

**Appearance** lives in the subtitles menu: size, background opacity, height off
the bottom edge, and a colour. Global rather than per-file, like brightness —
how big subtitles need to be is a property of the screen you are sitting in
front of. Height cannot go through CSS (`::cue` has no say over where a cue
sits), so it is applied to each cue directly.

**Downloading** needs an OpenSubtitles account. Set all three of
`OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME` and `OPENSUBTITLES_PASSWORD`:
the key alone can search, but the download endpoint also wants a token that only
a login can mint, so with a key and no account the feature stays hidden. Once
configured, the player menu fetches one for what is playing, and each season in
a show's detail page gets a **Subtitles** button that fetches one per episode.

Matching prefers a subtitle cut for the same release over a more popular one for
a different rip — a subtitle for the wrong rip is out of sync from the first
line. Machine and AI translations are pushed down rather than filtered out.
Downloads land as `<video name>.<lang>.srt` next to the file, which is the same
shape the sidecar discovery above already looks for, so nothing else changes.
Episodes that already have a subtitle are skipped, so re-running a season costs
none of the account's daily allowance.

**Your audio and subtitle choice is remembered per show.** Pick the track once
and the rest of the season opens that way, including a deliberate "off". What is
stored is the language and where the track came from, never a stream index:
numbering belongs to the file, so one release muxing the commentary second and
the next muxing it fifth would otherwise start episode two on the commentary.

### Are these subtitles in time?

A subtitle cut for a different release is out from the first line, and the way
anyone finds out is by watching two minutes of dialogue arrive at the wrong
moment. **Check against the audio**, in the subtitles menu, asks the file: a
cue begins when someone begins speaking, so cue starts and sound starts should
coincide, and if one set has to be slid eight seconds to meet the other then
the track is eight seconds out.

It compares onsets rather than loudness, and that is the whole difficulty. A
loudness threshold marks 58-74% of a film's opening ten minutes as loud —
music, effects, room tone and dialogue together — so every candidate offset
scores well, the peak is flat, and the answer lands wherever the noise is. The
first version of this reported every file in the library as out of sync with
its own embedded track. Onsets are rare where loudness is common.

The thresholds come from measurement: five films checked against their own
tracks, which must read as in sync, and again with every cue moved eight
seconds, which must read as out. One of the five — a quiet film with sparse
dialogue over a lot of ambient sound — cannot be told apart either way, and
reports "cannot tell" rather than guessing. A warning that cries wolf on a
correct track spends the credibility that makes the true ones worth reading.

### Known limits

- **Hardware encoding is used for tone mapping only.** `transcoder.js` finds
  NVENC, QSV or AMF and uses it when tone mapping, where the CPU is already
  busy with the colour conversion; an ordinary HEVC → H.264 transcode still
  runs on libx264. **Settings → Performance → This machine** measures both, so
  the gap is a number rather than a guess — 1.48x against 2.14x on the machine
  this was written on.
- **Bitmap subtitles (PGS/VobSub) cannot be shown.** They are images, and turning
  them into WebVTT would need OCR. Text-based tracks (SRT, ASS, embedded SubRip)
  are fine.
- **Bitmap subtitles still cannot be shown** — see above. ASS *is* rendered now,
  in an overlay rather than through `<track>`, but karaoke, animated transforms
  and vector drawings are dropped rather than approximated.

---

## Conversion and encoding

Everything below is ffmpeg work: converting a release the browser cannot play,
deciding when to do it, and where. None of it is needed for a file that already
plays directly — see [Playback delivery](#playback-delivery) for which is which.

### Ahead-of-time conversion

Playing an MKV that no browser can decode means tone-mapping and encoding it
first, which is what makes the opening seconds slow. Anything downloaded from
now on is converted and thumbnailed automatically when it lands — on background
ffmpeg slots, one file at a time, always yielding to whatever is playing.

A library that already exists never went through that, so **Settings →
Performance → Convert library ahead of time** is the catch-up. It is safe to
start and walk away from.

#### Choosing what gets converted

Converting everything is right for a library of 1080p web rips and wrong for
almost anything else: a 4K remux converted for a phone that will never play it
is an hour of encoding and twenty gigabytes spent on a file nobody asked for.
**Settings → Performance → What gets converted** sets the rules.

| Rule | For |
|---|---|
| Films / Shows | Turning off a whole kind |
| Size limit | Leaving remuxes alone and converting them on first play instead |
| Never convert paths containing | A folder of extras, a release group, a drive |
| A title's own rule | The exception, in either direction |

A rule about one title beats every general rule, both ways round — "always" is
usually said *because* the size limit would have skipped it. It is set on the
title's own page, under **Convert ahead of time**, where the thought actually
occurs.

The panel shows a dry run against the current library rather than only the
rules, because the rules on their own do not answer the question anyone has:
how many files, how many gigabytes, and how many were passed over and why.

**HDR is passed through** to displays that can show it. Tone mapping is right
for an ordinary screen — a browser renders a PQ stream as if the curve were
plain gamma, so it looks washed out and too bright — but on an HDR display it
throws away the range the file was made for and charges a full re-encode. The
client reports its display range; anything that cannot say is treated as SDR.
Passthrough also needs the client to decode the codec, since HDR is almost
always HEVC and a re-encode cannot preserve it.

**Quality steps down** when the connection cannot keep up, and back up when it
settles. Not a multi-rendition ladder: every stream here is encoded on demand,
so three renditions would mean three encoders per viewer. Picking a level by
hand turns it off.

### Pooled segments

A session owns an encoder; it does not own the bytes that encoder produced.
Two devices watching the same episode at the same quality, one device seeking
back into a stretch it already played, or the same file opened again tomorrow
all want segment 214 to be the same four megabytes — and each used to pay for a
full re-encode, because segments lived in a per-session directory that was
deleted with the session.

Sessions are still keyed on the viewer, because a *running* encoder cannot be
shared: a seek by either party moves it out from under the other. Finished
segments are pooled under the same identity with the viewer removed, as a hard
link where the filesystem allows one — so a pooled segment usually costs no
extra disk at all. The pool is wiped at boot with the rest of `cache/hls` and
trimmed to `HLS_SHARED_CACHE_MAX_GB`, least recently used first.

### How much a run encodes

One encoder run used to produce five minutes of video whatever was happening,
so opening a title to see what it was cost five minutes of encoding for the
thirty seconds actually watched.

The first run is now two minutes, and every run that ends by spending its
budget rather than by a seek doubles the next, up to `HLS_ENCODE_AHEAD_SECONDS`.
Someone watching straight through reaches the ceiling within a couple of runs;
someone browsing never does. A seek resets it, because a seek is the one thing
that proves the last run's remaining output was encoded for nobody.

### Encoders

**Settings → Encoders** lists every ffmpeg process the server is running: what
it is for, which file, how far it has reached, and its realtime factor. Below
1× an encoder is producing video more slowly than it is being watched, which is
a stall in the making rather than one that has happened yet. Each row has a
Stop, which is safe by construction — every process on that list is restartable,
an HLS encoder by the next segment request and a conversion by the next play.

The numbers come from ffmpeg's own `-progress` stream rather than from parsing
the status line it writes for a terminal.

### Encoding on another machine

The slow path here is always the CPU: a 4K HDR film tone-mapped to H.264 takes
about ninety minutes of the same processor that is meant to be serving
playback. A second PC can take the job instead.

On the machine doing the work:

```ini
ENCODE_WORKER=1
ENCODE_SECRET=the-same-value-in-both-files
```

On the machine that owns the library:

```ini
ENCODE_WORKERS=http://box2:3000
ENCODE_SELF_URL=http://box1:3000
ENCODE_SECRET=the-same-value-in-both-files
```

The worker pulls the source over HTTP, converts it, and holds the result until
this end collects it. It pulls rather than both machines sharing a disk because
the shared-storage version needs a NAS, matching paths at both ends and
credentials, none of which this app has anywhere else — and the transfer is not
the expensive part.

There is nobody to sign in, so the two ends prove themselves to each other with
the shared secret, and the source link is signed over one path: a worker given
a link to one film cannot read another with it. Every failure — worker asleep,
busy, unreachable, on a different version — falls back to converting locally,
silently.

`ENCODE_SELF_URL` is configured rather than worked out because behind a tunnel
a server's own idea of its address is usually wrong.

### Disk the app manages

| Directory | Holds | Trimmed by |
|---|---|---|
| `cache/mp4` | a browser-native copy of anything played on a non-direct path, roughly source-sized | `MP4_CACHE_MAX_GB`, then `MP4_CACHE_TTL_DAYS` |
| `cache/hls/_shared` | segments pooled across sessions | `HLS_SHARED_CACHE_MAX_GB`, least recently used first |
| `cache/thumbs` | seek-preview frames, a few hundred KB per file | `THUMB_CACHE_MAX_GB` / `THUMB_CACHE_TTL_DAYS` |
| `cache/hls` | live segments, bounded per session and reaped when idle | itself |
| `temp/` | in-progress downloads, moved into the library when complete | itself |

Interrupted conversions are swept up too. A conversion writes to a `.part`
file and renames it only on success, so nothing truncated ever appears at the
name playback trusts — but the tidy-up runs in ffmpeg's close handler, which a
kill from Task Manager or a power cut never reaches. Those files were never
removed, and worse, each one made its cache entry look busy and so exempt from
eviction. This install had 13.6 GB of them.

Both budgeted caches are swept on boot and every `CACHE_SWEEP_INTERVAL_MS`:
whatever is past its TTL goes first, then the least recently played until the
directory is under budget. A conversion in progress and anything played in the
last few minutes are never candidates.

Downloads and conversions also check before they start. A transfer that would
leave less than `DOWNLOAD_MIN_FREE_GB` free is refused with that as its error,
and a conversion that would not fit is skipped and retried on a later play —
which is a great deal easier to act on than the ffmpeg write error a full disk
used to produce somewhere else entirely.

**Seeking transcoded content costs an encode.** Every seek restarts ffmpeg at
that point, so the first segment after a jump takes a few seconds — and on 4K
HDR, where the seek also pays for a tone map, measurably longer. Files that play
`direct` or from the MP4 cache seek instantly, because those are real files.

---

## Search and downloads

Home keeps Recently Added and recommendations; the full collection stays on the
Movies and Shows library pages. Search browses title posters with movie/series,
genre, year and rating filters. Enter a title, or a genre name such as `Drama`.
Open a poster for its full cover page, synopsis, cast and download status.
Catalog entries do not become library entries until their files are downloaded.

For a series, select a season and choose **Download entire season** to find season
packs, or **Download** beside an individual episode. Select a release in the
download options below; existing quality filters and the **Files** picker remain
available. Season packs depend on your configured sources; if none are found,
use individual episodes. Specials are supported; unaired episodes are labeled
Upcoming. A pack only saves numbered episodes from the selected season.

Title searches use TMDB relevance ordering. Genre/year/rating browsing supports
Popular, Top rated and Newest ordering. TMDB title search applies genre and
rating filters to each result page, so a filtered page can be empty while later
pages still have matches.

Finding download options queries every configured source in parallel and merges the results,
deduplicating by infohash. One dead source never fails a search — you only get an
error if *every* source fails.

| Source | Needs | Notes |
|---|---|---|
| **AllDebrid cache** | your API key | Instant downloads when a torrent is already cached |
| **Torrentio** | nothing | Public Stremio addon; which trackers it queries is configurable |
| **Jackett** | a local Jackett install | Optional. Gives you any tracker Jackett supports |

### Search sources, and the AllDebrid account

**Settings → Sources** keeps a rolling hundred searches per source: the median
and p95 to set `SEARCH_SOURCE_TIMEOUT_MS` from, timeouts separated from errors,
and the quiet failure counted — a source that answers fast, never errors, and
returns nothing every time.

The AllDebrid account is on the same page. An expired subscription otherwise
surfaces as downloads failing one at a time with an auth error, which is a slow
way to learn something the account says outright.

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

### Season packs

The common real-world release for a show is one torrent holding a whole season.
A job used to be one file with one destination, so taking every file wrote the
season over one name — `Show - S01E05.mkv`, ` (2).mkv`, ` (3).mkv` — and the
selector refused packs outright rather than do that.

Each file carries its own numbering in its name, which is what the library
scanner already reads. A pack is its own kind of request now: every file is
parsed on its own and filed where it belongs. A file that will not say which
episode it is gets skipped rather than guessed at, because a wrong episode
number is silent and a missing file is visible in the season list. The same
goes for a second copy of an episode and for a season-two file inside a
season-one pack.

### Looking inside a torrent

A filename and a size do not say whether a torrent holds one episode, nine, or
a film with three samples and a readme beside it. **Files**, on any search
result, lists what is actually in there with each file's episode read off its
name, and a tick per file.

An explicit choice ends the argument: it is honoured against every file the
torrent holds, including the ones the rules would have dropped, because the
picker showed those too and ticking one means it was meant.

Inspection uploads the magnet, because there is no endpoint that takes a hash
and answers with a file list. If AllDebrid does not already hold the torrent
then the list does not exist yet — it waits twelve seconds, says so, and
deletes the magnet again rather than quietly starting a transfer nobody asked
for.

### Cached, or fetching?

"Stuck at 50%" is the boundary between AllDebrid fetching the torrent and the
local transfer. A job sitting there is not stuck: it is waiting on a torrent
AllDebrid did not already hold, which can take twenty minutes. The first status
poll answers that and the Downloads page says which is happening.

There is no badge on search results, and there cannot be one: it would need an
instant-availability lookup by hash, and AllDebrid has removed it —
`/magnet/instant` answers `Endpoint doesn't exist` on both v4 and v4.1.

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

### Downloads queue

Jobs run in an order you control. Reorder with the arrows, pause one without
cancelling it, retry one that failed. Pausing an active transfer aborts it and
discards the partial file — AllDebrid issues a fresh link each time, so there
is no resume-from-offset and a resumed download restarts — but the job keeps
its place in the queue.

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
yields no working credential. Leaving it unticked gives a session that is never
recorded: the cookie dies with the browser, and the server-side entry behind it
expires after `AUTH_SESSION_TTL_HOURS` of no requests. The window measures idle
time, so it never interrupts a viewing — but a token does stop being one long
before the next restart, which is what it used to wait for.

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

### Adding a device without typing the password

The gate is right and it is miserable on a television: twelve characters
entered with a D-pad and an on-screen keyboard, usually while someone waits.

**Settings → Devices → Add a device** mints an enrolment code and draws it as a
QR. The device that scans it is signed in — the login page reads the code out
of the URL, strips it from the address bar before doing anything else, and
signs itself in without anyone pressing a key.

Good once and for five minutes, so the photograph someone takes of the screen
is worth nothing afterwards. Codes live in memory, so a restart during
enrolment costs one re-scan and there is nothing on disk to leak. Every way of
failing answers identically: a caller who can tell "expired" from "never
existed" learns whether a code ever existed.

Minting one needs the password, because a code is a way into the server and
handing one out should be at least as hard as signing in.

### On a phone's home screen

Open the site and use **Add to Home Screen**. It opens without browser chrome
from then on, which is the point and also the catch: with no address bar and no
toolbar, the page owns the whole screen — including the strip under the clock
and the island, and the strip the home indicator sits on. iOS reports those four
distances as safe-area insets, and every bar in the app is held off them: the
top bar grows by the top inset rather than sharing a strip with the clock, the
tab bar pads out past the home indicator, and in landscape — where the island
moves to the side of the screen, beside the back button — the player's controls
come in from both edges. The video itself still bleeds to every edge, because
that is what a video should do.

A browser tab reports all four as zero, so none of this shows up until the app
is actually installed. `npm run ui-standalone` writes the insets itself and
measures where everything lands, in both orientations.

### On a phone

The lock screen and Control Centre show the poster, the episode title and
working transport controls, including next and previous episode for a show.

**AirPlay** appears as a button in the control bar once Safari reports a
receiver on the network. It works because everything needing ffmpeg is HLS —
AirPlay will not accept an arbitrary progressive stream.

### Notifications

The launcher raises a toast on the machine the server runs on, which is the one
place you are not when a download finishes. **Settings → Notifications**
subscribes this device instead.

The push carries no payload. Encrypting one means the whole of RFC 8291 — ECDH
against the subscription key, HKDF, AES-128-GCM, record padding — which is a
library's worth of cryptography to get subtly wrong, and it would mean the
title of whatever you just downloaded passing through Google or Mozilla on its
way here. Instead the push is an empty knock and the service worker asks this
server what it was about. Less code, and the push service carries a knock at
the door rather than the message.

Three things have to be true and they fail differently, so the page reports
them separately: the browser supports Push, permission was granted, and this
device is subscribed. On iPhone and iPad it works only once MediaWatcher has
been added to the home screen — Safari allows notifications from an installed
app and not from a tab. There is a test button, because there are four places
this can break and the alternative is finding out on the night it matters.

`PUSH_CONTACT` is the address put in the signed token for the push service's
own logs. It defaults to an `.invalid` address deliberately: nothing here needs
a real one, and sending a personal address to Google on every push is not a
reasonable default.

### Chromecast

Casting is not the same shape as AirPlay, and the difference decides what it
takes to support. AirPlay hands the stream over from a device that is already
signed in. A Chromecast is *told a URL* and fetches it itself, from a device
that holds no cookie, cannot be given one, and cannot join a tailnet.

So two things have to be true, and both are deliberately off by default:

```ini
BIND_HOST=0.0.0.0     # the server listens where a Chromecast can reach it
CAST_ENABLED=1
```

`CAST_ENABLED` alone, with the server still on loopback, leaves casting off
rather than producing a button that cannot work. The boot log says so whenever
the server is listening wider than loopback, because that is a real change to
what is exposed: the gate is still in front of everything, but everything on
the network can now reach the gate.

Permission to fetch is a signed link — an HMAC over the one path the receiver
may read and an expiry, signed with the machine-local admin key. It names a
single path, so a link for one film admits a request for that film and nothing
else; it expires after six hours; and only something already signed in can mint
one. The endpoints it may ever name are a fixed list: the stream, HLS segments,
and subtitles.

The Cast sender SDK is the only third-party script in the app, and it is
allowed into the CSP only when casting is switched on — an install that does
not cast keeps a policy with no external script origin in it at all.

---

## Running it from somewhere else

Reading the log meant the launcher window, changing a setting meant a text
editor, and restarting meant going home. Over the tunnel none of those are
available, which is exactly when they are wanted. All three are in **Settings →
Server**.

**The log** is a ring of the last few thousand lines, with a level filter and a
follow that polls only while the page is open. Anything that looks like a key
is redacted on the way into the buffer: the console is on the machine that owns
the keys, this is reachable from a phone.

**The settings file** can be edited in place. Comments, ordering and unrelated
keys survive a write; secrets are masked, and a value that comes back still
masked leaves the stored one alone. Validation happens before anything is
written, so a rejected change leaves the file exactly as it was, and the write
is a temporary file and a rename with the previous contents kept at `.env.bak`.
Nothing takes effect until the server restarts — every value is read once at
boot and then frozen, and the page says so rather than appearing to apply
something it has not.

**Restarting** exits with a code the launcher understands, so a requested
restart comes straight back instead of being backed off and counted against the
crash-loop budget. It refuses when nothing is supervising the process, because
a server that cannot come back is not a restart.

Saving settings and restarting both ask for the password again. A signed-in
device is a cookie on a phone that might be sitting unlocked on a table.

### What this machine can do

**Settings → Performance → This machine** encodes a few seconds of the largest
file in the library on each path and times it. Above 1× the encoder produces
video faster than it is watched; below it, playback stalls and no amount of
buffering helps.

Those numbers used to live only in code comments, measured once on one machine.
On the machine this was written on:

| Path | Realtime |
|---|---|
| H.264, software, 1080p | 1.48x |
| H.264, NVENC, 1080p | 2.14x |
| HDR tone map to 1080p | 1.31x |
| HDR tone map at 2160p | 0.42x |

The last row is the 1080p tone-mapping cap earning itself.

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
| `GET` | `/api/subs/sync?path=` | Whether that track is in time with the audio |
| `POST` | `/api/torrents/inspect` | What is inside a torrent, without downloading it |
| `GET` | `/api/torrents/source-stats` | How each search source has behaved lately |
| `GET` | `/api/torrents/account` | The AllDebrid account behind every download |
| `GET` | `/api/library/changes` | What this device has not seen yet |
| `GET`/`PUT` | `/api/library/warm/policy` | What gets converted ahead of time, and a dry run |
| `PUT` | `/api/library/warm/policy/title` | One title's own rule: auto, always or never |
| `GET` | `/api/diagnostics/encoders` | Every ffmpeg process running now |
| `DELETE` | `/api/diagnostics/encoders/:id` | Stop one |
| `GET` | `/api/admin/log` | Recent log lines, redacted |
| `GET`/`PUT` | `/api/admin/env` | Read and change settings |
| `POST` | `/api/admin/restart` | Stop and come back. Needs the password |
| `POST` | `/api/admin/benchmark` | Measure this machine |
| `POST` | `/api/auth/enrol` | A code that signs another device in |
| `POST` | `/api/notifications/subscribe` | Register a device for push |
| `GET` | `/api/cast/media?path=` | A signed link a Chromecast can fetch |
| `POST` | `/api/encode/jobs` | Worker mode: take a conversion |

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
| `FFMPEG_MAX_PROCESSES` | `4` | Ceiling on ffmpeg processes app-wide; playback never queues, background work does |
| `MP4_CACHE_MAX_GB` / `MP4_CACHE_TTL_DAYS` | `50` / `30` | When converted copies are evicted |
| `THUMB_CACHE_MAX_GB` / `THUMB_CACHE_TTL_DAYS` | `2` / `60` | When preview frames are evicted |
| `CACHE_SWEEP_INTERVAL_MS` | `1800000` | How often the caches are measured and trimmed |
| `DOWNLOAD_MIN_FREE_GB` | `5` | Free space a download must leave behind |
| `DOWNLOAD_STALL_TIMEOUT_MS` | `120000` | Silence before a transfer is treated as dead |
| `AUTH_SESSION_TTL_HOURS` | `12` | Idle life of a login without "remember this device" |
| `TAILNET_HOST` | empty | Tailnet hostname, so CORS accepts that origin |
| `REMOTE_DEFAULT_QUALITY` | `high` | What `Auto` means over the tunnel |
| `QUALITY_*_HEIGHT` / `QUALITY_*_MAXRATE` | see `.env.example` | The remote quality ladder |
| `HLS_ENCODE_AHEAD_MIN_SECONDS` | `120` | What the first encoder run produces, before it doubles |
| `HLS_SHARED_CACHE_MAX_GB` | `4` | Budget for segments pooled across sessions |
| `HLS_CACHE_DIR` | `cache/hls` | Where sessions and the pool live |
| `BIND_HOST` | `127.0.0.1` | Listen wider. Needed for casting, and only for casting |
| `CAST_ENABLED` | `0` | Offer Chromecast. Ignored while the server is loopback-only |
| `CAST_HOST` | empty | Override the address handed to a Chromecast |
| `PUSH_CONTACT` | an `.invalid` address | Contact in the VAPID token. Not your email |
| `ENCODE_WORKER` | `0` | Accept conversions from another MediaWatcher |
| `ENCODE_WORKERS` | empty | Servers this one may hand conversions to |
| `ENCODE_SELF_URL` | empty | How a worker reaches this machine to pull the source |
| `ENCODE_SECRET` | empty | The same value in both `.env` files |

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
moves again once the direct link is unlocked. The job now says which of the two
is happening, so this is visible rather than something to work out from a
percentage that is not moving.

**`better-sqlite3` fails to install**
It needs a prebuilt binary for your Node version. If none exists you will need
build tools (`npm install --global windows-build-tools` on Windows, `build-essential`
on Linux). Switching to an LTS Node release usually avoids this entirely.

**Resetting**
Deleting `db/mediawatcher.db` is safe — you lose the metadata cache, watch
progress and download history, not your media. It is rebuilt on next start.

---

## Notes

- The server binds to `127.0.0.1` unless `BIND_HOST` says otherwise, and remote
  access is a Tailscale tunnel rather than an open port. The one thing that
  needs it listening wider is Chromecast, which fetches media itself from a
  device that cannot join a tailnet — and even then the password gate is still
  in front of everything, so what changes is who can reach the gate.
- `.env` is gitignored; `.env.example` is not. Keep real keys out of the example.
- Press `Ctrl+C` to stop the server cleanly. On Windows, a kill from Task Manager
  cannot run the shutdown handler — that is safe, since SQLite runs in WAL mode
  and recovers on next open.
- Keyboard shortcuts in the player: `Space`/`K` play-pause, `←`/`→` ±10s,
  `↑`/`↓` volume, `M` mute, `F` fullscreen, `N` next episode, `Esc` exit
  fullscreen or close. Press `/` anywhere to jump to the search box.
