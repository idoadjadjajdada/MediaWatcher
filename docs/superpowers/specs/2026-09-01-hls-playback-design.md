# HLS playback for transcoded streams

Date: 2026-09-01

## Problem

Anything MediaWatcher cannot serve as a file on disk is streamed from an ffmpeg
pipe as fragmented MP4. A pipe has no byte offsets, so `/api/stream` answers
`200` with `Accept-Ranges: none`.

iOS refuses that. Safari on iOS drives `<video>` through AVFoundation, which
opens a source by probing it with `Range: bytes=0-1` and requires a `206 Partial
Content` reply. Given a `200`, it abandons the source with
`MEDIA_ERR_SRC_NOT_SUPPORTED` (media error 4) without decoding a frame.

Confirmed from the device, not inferred:

```
[diag] stream from iPhone (tailscale) range=bytes=0-1 hevc=1 ac3=1 q=auto
```

against a response of `200 OK` / `Accept-Ranges: none`, with the player
reporting error 4.

This is not fixable within the pipe: a live pipe cannot answer byte ranges,
because the bytes do not exist until they are encoded and their offsets are
never known in advance.

Two consequences, one pre-existing and one introduced by the remote-access work:

- **Pre-existing:** any file needing ffmpeg (62 of 97 library files are `.mkv`)
  is unplayable on iOS unless an MP4 cache variant happens to exist.
- **Introduced:** capped playback deliberately bypasses the MP4 cache, because
  those variants are full quality. Over the tunnel every stream is capped, so
  remote iOS playback fails even for files that have a perfectly good cached
  copy sitting on disk.

A secondary problem the same change fixes: pipe playback has never been
seekable. Seeking restarts ffmpeg at `?t=`, which costs roughly 630ms per seek
and cannot scrub.

## Goals

- Transcoded playback works on iOS and iPadOS.
- Transcoded playback becomes seekable on every client.
- The quality cap survives — remote playback stays capped.
- One playback path for transcoded content, not two.

## Non-goals

- Replacing the direct and cached-MP4 paths. Those serve real files with byte
  ranges, already work everywhere, and are the fastest thing available.
- Adaptive bitrate. The quality level is chosen explicitly or by connection
  origin; mid-stream ladder switching is not wanted.
- Caching HLS output between sessions. Segments are quality-specific and cheap
  to regenerate, and `cache/` already holds 62 GB.
- Subtitles inside the HLS playlist. The existing `/api/subs` `<track>` path is
  unchanged.

## Approach

**We generate the playlist; ffmpeg only produces segments.**

The duration is already known from `probe()`, so a complete VOD playlist can be
written before a single segment exists. The player gets an accurate scrub bar
immediately, and — because segment numbering is ours rather than ffmpeg's — the
encoder can be stopped and restarted at any segment without the client noticing.

This is what makes seeking work. ffmpeg's own HLS playlist output is unused.

### Segments

MPEG-TS, H.264 + AAC, 6 seconds. TS rather than fMP4/CMAF: both play on modern
iOS, but TS is the safer common denominator across iOS and hls.js.

Segment boundaries **must** be keyframe-aligned, or a segment is not
independently decodable and a seek lands in the wrong place. Forced with
`-force_key_frames expr:gte(t,n_forced*6)`.

`-map_chapters -1` is set on every session. ffmpeg otherwise converts MKV
chapters into a `text`/SubtitleHandler data track that is not in the source;
harmless in practice but pointless in a stream that carries no chapters.

### Session lifecycle

A session is one ffmpeg process producing segments forward from a start point,
plus the directory those segments land in.

Sessions are keyed deterministically on everything that changes the output:
file path, mtime, size, quality level, audio track index, audio offset, and the
client capabilities that steer `decide()`. The same request therefore reuses a
running session instead of starting a second encoder for it.

When segment *n* is requested:

- **Present and complete** — serve it.
- **Ahead of the encoder but within reach** — wait for it, up to a timeout. The
  encoder is already heading there and restarting would be slower.
- **Behind the start point, or too far ahead** — kill the encoder and restart at
  `n * 6` seconds with `-start_number n`.

A segment file is complete once the *next* segment appears; ffmpeg is still
writing the highest-numbered one. The last segment of the file is complete when
the process exits.

### Reaping

An abandoned session otherwise leaves an ffmpeg process and a directory behind.

- The player sends a keepalive while playing.
- A sweeper kills sessions idle beyond a timeout and deletes their directories.
- Sessions are killed and cleaned on server shutdown, alongside the existing
  `watcher.stop()` handling.
- Segments far behind the current position are pruned as playback advances, so
  a long film does not accumulate its whole runtime on disk.

## Endpoints

All under `/api/hls`, behind `requireAuth` like everything else.

| Route | Purpose |
|---|---|
| `GET /api/hls/playlist.m3u8?path=&q=&hevc=&ac3=&audio=&audioOffset=` | Create or reuse a session; return the predicted playlist |
| `GET /api/hls/:session/:n.ts` | One segment, produced on demand |
| `POST /api/hls/:session/touch` | Keepalive |

The playlist URL *is* the session handle — there is no separate create call, and
a reload of the same stream lands on the same session.

## Playlist shape

For a 1,342-second file at 6-second segments:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000000,
/api/hls/<session>/0.ts
... 223 more ...
#EXTINF:4.000000,
/api/hls/<session>/223.ts
#EXT-X-ENDLIST
```

Segment count is `ceil(duration / 6)`; the final `EXTINF` carries the remainder
so the total matches the real duration rather than overrunning it.

## Integration

`transcoder.decide()` is unchanged — it remains the single place that decides
whether ffmpeg is needed and under what cap. What changes is delivery: when the
decision is anything other than `direct` or `cached-*`, the stream is delivered
as HLS instead of a pipe.

`/api/stream/info` gains an `hls` field carrying the playlist URL when the file
needs one. The player reads that rather than constructing it, so the quality
cap, audio track and offset are resolved server-side exactly as they are today.

The quality cap becomes ordinary encoder settings for the session
(`-vf scale=-2:H`, `-maxrate`), not a special case. Capped playback therefore
gains seeking rather than losing it, which reverses the tradeoff the remote
quality design had to accept.

`decision.seekable` becomes true for HLS. The player's `ctx.offset` machinery —
which exists solely because a pipe cannot seek — stays at zero on this path.

## Client

`hls.js` is vendored into `public/js/vendor/`, self-hosted. No npm dependency,
and the existing `script-src 'self'` CSP is unchanged.

Selection order in the player:

1. Native HLS (`canPlayType('application/vnd.apple.mpegurl')`) — Safari, iOS,
   iPadOS. Assign the playlist URL to `video.src` and let the platform do it.
2. `hls.js` via MSE — Chrome, Edge, Firefox.
3. Neither — surface the error rather than failing silently.

The library is loaded lazily, only when a stream actually needs it, so ordinary
direct playback pays nothing for it.

## Retiring the pipe

`streamViaFfmpeg` stays until HLS is confirmed working on real devices, then
comes out along with the `?t=` seek-restart logic in the player. Keeping both
indefinitely would mean two playback paths and two sets of seek semantics.

Removal is deliberately **not** part of this work — it happens once the
replacement has proven itself, not on the same commit that introduces it.

## Testing

Node tests under `tests/`, matching the existing `*.test.mjs` convention and
added to the `npm test` chain:

- `hls-playlist.test.mjs` — segment count from duration, `EXTINF` values, the
  short final segment, `ENDLIST` presence, target duration, and that a duration
  that divides exactly does not emit a trailing zero-length segment.
- `hls-session.test.mjs` — session key determinism (same inputs reuse, changed
  quality or audio track does not), the restart decision as a pure function
  (`present`, `within reach`, `behind start`, `too far ahead`), segment
  completeness from directory contents, and prune selection.

Integration checks against a running server, since the encoder is the thing
being tested:

- A playlist is returned before any segment exists, and its segment count
  matches the probe duration.
- Segment 0 arrives and is a valid TS file with the expected codecs.
- A far-future segment triggers a restart and still arrives.
- Segment boundaries are keyframe-aligned.
- A capped session produces segments at the capped height.

Browser check via the existing Playwright harness: hls.js attaches, playback
reaches `readyState >= 2`, and a seek lands within tolerance.

Real-device check on the iPhone, which is the failure this exists to fix and
cannot be reproduced locally — desktop WebKit does not use AVFoundation and
plays the pipe happily.

## Risks

**Timestamp continuity across a restart.** Restarting ffmpeg at a seek point
with `-ss` resets output timestamps to zero, which would break playback
continuity. Segments must carry timestamps on the original timeline
(`-output_ts_offset`), and this needs verifying empirically rather than
assuming — it is the most likely thing to be subtly wrong.

**Encoder throughput.** Playback needs segments faster than realtime. NVENC is
available (`h264_nvenc`) and already used for tone mapping; HLS sessions should
request it on the same reasoning.

**Disk.** Sessions add to a `cache/` already at 62 GB. Mitigated by pruning
behind the play position and deleting sessions on close.
