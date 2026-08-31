# Player Controls and Seek Preview — Design

**Date:** 2026-08-30
**Status:** Approved, ready for implementation planning

---

## Context

The UI overhaul left the player with a single gear button opening one panel that stacks
three unrelated groups — subtitles, audio delay and playback speed. Adding a fourth
setting to that stack would make it worse, and three of the four are things you reach
for mid-scene, when a menu you have to read is the wrong shape.

This design splits those settings into four buttons, adds picture controls, gives shows
an episode sidebar, and rebuilds the seek bar so it previews where a scrub will land.

## Goals

- Every setting reachable in one press, with its current value visible without opening
  anything.
- Brightness and contrast adjustable during playback, without restarting the stream.
- Jumping to another episode of the same show without leaving the player.
- Scrubbing that shows the frame you are about to land on, and how far you are skipping.

## Non-goals

- Chapter markers. The library has no chapter metadata and none is being added.
- Per-file picture settings. Brightness tracks the room, not the file.
- Adaptive bitrate, auth, network exposure. Separate sub-projects, unchanged by this.
- Restyling anything outside the player. The tokens, colours, control-bar geometry, hero
  and rails set by the UI overhaul are fixed and must not move.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Settings layout | Four buttons in the right cluster, one popover each | Matches every mainstream player; transport stays centred |
| Speed button face | Current rate as text (`1x`) | A stray 1.5x is the setting people forget; showing it costs nothing |
| Picture controls | Brightness **and** contrast, 20-150% | User asked for both; one Reset covers the pair |
| Picture scope | Global, in `localStorage` | It tracks ambient light, not the file |
| Picture mechanism | CSS filter on the video element only | Instant, mode-independent, leaves chrome legible |
| Sidebar contents | Current season, with season tabs | Lets you go back to a missed episode, not only forward |
| Sidebar trigger | Right-edge chevron, episodes only | Movies have nothing to list |
| Preview contents | Thumbnail frame plus timestamp | User's choice over timestamp-only |
| Frame generation | Parallel input-seek grabs, individual JPEGs | Input seeking jumps rather than decodes; frames appear progressively |
| Frame cache key | `sha1(path + size + mtime)` | A replaced file invalidates itself with no explicit purge |

---

## 1. Four setting buttons

The gear and its `menu-panel` are replaced by four buttons in `player__buttons-right`:

```
[vol]---   [|<][<10][>][10>][>|]   [CC][sync][1x][sun][full]
```

| Button | Popover | Content |
|---|---|---|
| `CC` | Subtitles | Track list. Moved from the gear panel, content unchanged. |
| `sync` | Audio delay | Value, Reset, nudge grid. Moved, content unchanged. |
| `1x` | Speed | 0.75 / 1 / 1.25 / 1.5 / 2. Moved, content unchanged. |
| `sun` | Picture | Brightness slider, contrast slider, Reset. New. |

Opening any popover closes the other three. Each closes on Escape, on a click outside,
and when the player goes idle. Four icons are added to the `ICONS` map in `views.js`:
`cc`, `sync`, `speed`, `brightness`.

The three moved popovers keep their existing `data-action` names, so the action dispatch
in `player.js` does not change for them.

## 2. Picture controls

Two sliders, both 20-150%, both defaulting to 100%, and one Reset that returns both.

Applied as a CSS filter on `.player__video` alone:

```css
filter: brightness(var(--brightness, 1)) contrast(var(--contrast, 1));
```

Setting it on the video element rather than the player root is load-bearing: on the
root, the control bar and subtitles would dim along with the picture, which is the
opposite of what dimming is for.

This never touches ffmpeg, so it is instant and behaves identically in direct, remux and
transcode modes — unlike audio delay, which lives in the ffmpeg command and has to
restart the stream.

Values persist globally under a single `localStorage` key and are reapplied on every
`open()`. A `localStorage` read that throws (private browsing) falls back to 100/100
rather than failing the open.

## 3. Episode sidebar

A left-pointing chevron, pinned to the right edge and vertically centred, rendered only
when `located.type === 'episode'`. It carries the `is-idle` fade the rest of the chrome
uses.

The panel docks to the right edge and slides in on a transform. It contains:

- The show title and a close button.
- Season tabs, one per season, with the current season selected on open.
- The selected season's episodes: episode tag, title, and a marker on the one playing.

Episodes with no file in the library are listed but dimmed and unclickable, so a gap in
the library shows as a gap rather than silently renumbering the list.

Picking a playable episode calls the existing `open(file.file_path)`. The panel closes on
pick, on the close button, on Escape, and on a click outside.

No new API: `ctx.located.item.seasons` already holds the whole show, because `locateFile`
returns the show as `item`.

**Touch interaction:** the double-tap-to-seek listener is bound to the `video` element
(`player.js:663`), not to an overlay, so the arrow and panel sit above it and swallow
their own taps. No coordination needed.

## 4. Seek bar preview

A native `<input type="range">` cannot carry a second thumb, so the ball and the band are
a sibling layer positioned over the track, driven by two custom properties:

- `--fill` — where playback is. Already exists and is already maintained.
- `--preview` — where the cursor is. New.

Both are unitless percentage numbers, not lengths: the seek handler already writes
`--fill` as `(fraction * 100).toFixed(2)`, and `--preview` follows the same convention so
the two can be compared directly when painting the band.

Three elements:

- **Translucent ball** at `--preview`, semi-transparent, distinct from the solid knob
  that stays at `--fill`, so both are visible at once.
- **Card** floating above the ball on a stalk, holding the frame and the timestamp. It
  clamps at both ends of the track so it cannot run off the edge of the screen.
- **Band** between `--fill` and `--preview`, darkened, showing the stretch about to be
  skipped. It renders in either direction: scrubbing backward shades the stretch about to
  be replayed.

`previewFraction(x, width)` converts a pointer position to a fraction, clamped to
`[0, 1]`. The preview layer is `pointer-events: none` so it never intercepts a drag.

On touch there is no hover, so the same preview follows the finger during a drag and
clears on release.

## 5. Thumbnail service

### Endpoints

```
GET /api/thumbs/meta?path=...   -> { interval, count, ready, total }
GET /api/thumbs?path=...&i=N    -> image/jpeg
```

Both validate `path` with `isInsideLibrary`, the same check the stream route already
applies to every incoming path.

### Generation

Frames are grabbed by input-seeking, four concurrently:

```
ffmpeg -ss <T> -i <file> -frames:v 1 -vf scale=160:-1 -q:v 5 <out>.jpg
```

Seeking before `-i` makes ffmpeg jump to the nearest keyframe rather than decoding
forward from the start — the same fast path the transcoder already relies on for seeking.
A full end-to-end decode of a 22-minute episode would cost over a minute; a few hundred
input-seek grabs cost seconds.

Interval is one frame every 10 seconds, capped at 300 frames per file:

```
frameInterval(duration) = max(10, ceil(duration / 300))
```

A 22-minute episode therefore gets 10s spacing and ~132 frames; a two-hour film stretches
to 24s rather than generating 720 files.

Duration comes from the existing ffprobe call in `transcoder.js`.

### Cache

Frames land in `cache/thumbs/<key>/<index>.jpg`, where the key is
`sha1(path + size + mtime)`. Including size and mtime means a replaced or re-downloaded
file gets a new key and regenerates, with no explicit invalidation step anywhere.

`cache/` is added to `.gitignore`.

Responses carry `Cache-Control: public, max-age=31536000, immutable` — safe because the
key already encodes file identity.

### Degradation

All three failures are silent, and none of them affect the ball or the band:

| Condition | Server | Client |
|---|---|---|
| Still generating | `meta` reports `ready: false` and the count so far | Timestamp only; frames appear as they land |
| ffmpeg missing or disabled | 503 | Timestamp only, permanently, no retry |
| Individual frame missing | 404 | Timestamp only for that position |

This mirrors the transcoder's existing posture: ffmpeg absent degrades the feature, it
does not fail the request.

Generation for a file is started once per process and deduplicated by key, so hovering
during generation cannot spawn a second run.

---

## Architecture

```
public/js/player.js       -- popover state, picture filter, sidebar, preview wiring
public/js/picture.js      -- clampPicture, pictureFilter, localStorage read/write
public/js/preview.js      -- previewFraction, frameIndex, card positioning
public/js/views.js        -- markup for four buttons, sidebar, preview layer; new icons
public/css/player.css     -- popovers, sidebar, ball, band, card

routes/thumbs.js          -- the two endpoints, path validation
services/thumbnails.js    -- frameInterval, cacheKey, generation queue, frame lookup
```

Splitting `picture.js` and `preview.js` out of `player.js` keeps their arithmetic
testable without a DOM, and keeps `player.js` from growing past the size where it stops
fitting in one read. It is 798 lines today; these features would add roughly 300 to it
otherwise.

## Data flow

**Picture:** slider input -> `clampPicture` -> set CSS custom properties on the video
element -> write to `localStorage`. No network, no state store, no re-render.

**Sidebar:** `ctx.located.item.seasons` -> `episodeRows(show, season, currentSeason,
currentEpisode)` -> markup. Picking a row calls `open(file.file_path)`, the same entry
point the next-episode button already uses.

**Preview:** `pointermove` on the seek bar -> `previewFraction(x, width)` -> set
`--preview` and position the card -> `frameIndex(time, interval)` -> fetch that frame,
memoised in a client-side `Map` so re-hovering the same index costs nothing.

## Error handling

- `localStorage` unavailable -> picture defaults to 100/100, everything else works.
- Show has one season -> tabs render but are inert rather than hidden, so the header does
  not change shape between shows.
- Episode has no file -> row is dimmed and unclickable.
- Thumbnail fetch fails for any reason -> card falls back to the timestamp. The ball and
  the band never depend on it.
- ffmpeg missing -> 503 once, client stops asking for that session.

## Testing

**DOM-free unit tests** over the extracted pure functions:

- `clampPicture(value)` — clamps to 20-150, rejects `NaN`, keeps 100 as the identity.
- `pictureFilter({ brightness, contrast })` — produces the exact filter string.
- `episodeRows(show, season, currentSeason, currentEpisode)` — marks the current row,
  dims file-less episodes, orders by episode number, handles a season with no episodes.
- `previewFraction(x, width)` — clamps below 0 and above 1, handles zero width.
- `frameInterval(duration)` — 10s under the cap, stretches above it, never returns fewer
  than 10, handles a zero or unknown duration.
- `frameIndex(time, interval)` — floors correctly, never returns a negative index.
- `cacheKey(path, size, mtime)` — stable for identical inputs, differs when any input
  changes.

**Browser-driven checks** appended to the existing `tests/ui-check.mjs` harness:

- Four setting buttons present in the right cluster.
- Opening one popover closes the others.
- Brightness slider changes the video element's computed filter.
- The arrow is absent on a movie and present on an episode.
- The sidebar opens, shows the current season, and marks the playing episode.
- Hovering the seek bar sets `--preview` and positions the ball at the right offset.
- The band renders between fill and preview in both scrub directions.

The browser checks are not optional. Three separate UI bugs in this codebase have passed
render-shape assertions and only failed when a browser actually drove the page: a
re-entrant `innerHTML` crash that killed typing after one character, a flex card
collapsing to zero width, and a modal throwing on `item.seasons.map` for a title with no
seasons.

## Sequencing

Sections 1-4 are client-only and land together. Section 5 is a new server subsystem and
lands after, so the seek bar works with timestamps before thumbnails layer on top. If
input-seek grabbing turns out slower than expected on this library, everything else is
already shipped and the preview still works.
