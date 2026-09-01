# HLS Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver transcoded playback as HLS so it works on iOS and becomes seekable everywhere, without losing the remote quality cap.

**Architecture:** MediaWatcher writes the playlist itself from the duration `probe()` already returns, so a complete VOD playlist exists before any segment does. ffmpeg only writes MPEG-TS segments, numbered by us, which is what allows the encoder to be killed and restarted at any segment when the viewer seeks. Sessions are keyed on everything that changes the output, live under `cache/hls/`, and are reaped when idle.

**Tech Stack:** Node 20+, Express 4, ffmpeg 9.0 (`-f segment`, `h264_nvenc` available), vanilla ES modules, hls.js vendored for non-Safari browsers.

## Global Constraints

- **No new npm dependencies.** hls.js is vendored as a static file under `public/js/vendor/`, not installed.
- Segment length is 6 seconds, defined once as `SEGMENT_SECONDS` and never duplicated as a literal.
- Segments are MPEG-TS, H.264 + AAC.
- Every ffmpeg invocation includes `-map_chapters -1`, `-sn`, `-dn`.
- Keyframes must align to segment boundaries: `-force_key_frames expr:gte(t,n_forced*SEGMENT_SECONDS)`.
- Node tests are plain scripts using the existing hand-rolled `check(name, condition)` helper and `process.exit(failures > 0 ? 1 : 0)`. Added to the `npm test` chain.
- `transcoder.decide()` is not modified. It remains the single place deciding whether ffmpeg is needed and under what cap.
- `streamViaFfmpeg` and the player's `?t=` seek-restart logic are **not** removed in this plan.
- Comments explain *why*, matching surrounding density and voice.

---

## File Structure

**Created:**
- `services/hls/playlist.js` — pure playlist maths and M3U8 text. No I/O.
- `services/hls/session.js` — session keys, the restart decision, prune selection. Pure.
- `services/hls/manager.js` — stateful: spawns ffmpeg, tracks segments, reaps. The only file here that touches the filesystem or processes.
- `routes/hls.js` — the three endpoints.
- `public/js/vendor/hls.min.js` — vendored library.
- `public/js/hls-player.js` — attach/detach logic, native vs hls.js.
- `tests/hls-playlist.test.mjs`, `tests/hls-session.test.mjs`

Split three ways because the pure parts carry all the logic worth testing and the stateful part is the only thing needing a running ffmpeg. A single `services/hls.js` would make the interesting logic reachable only through a spawned process.

**Modified:**
- `config/index.js` — `hls` config block.
- `server.js` — mount the router, kill sessions on shutdown.
- `routes/stream.js` — `/info` gains the `hls` field; remove the `[diag]` logging.
- `public/js/player.js` — choose HLS when the decision needs ffmpeg.
- `public/js/api.js` — `hlsPlaylistUrl` helper.
- `package.json`, `.gitignore`, `README.md`

---

### Task 1: Playlist generation

**Files:**
- Create: `services/hls/playlist.js`, `tests/hls-playlist.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `SEGMENT_SECONDS` (6), `segmentCount(duration) -> number`, `segmentDuration(index, duration) -> number`, `buildPlaylist(sessionId, duration) -> string`.

- [ ] **Step 1: Write the failing test**

Create `tests/hls-playlist.test.mjs`:

```js
/**
 * HLS playlist generation.
 *
 * The playlist is written from the probed duration before a single segment
 * exists, which is what gives the player an accurate scrub bar immediately and
 * lets the encoder restart anywhere. Getting the arithmetic wrong shows up as
 * a scrub bar that lies or a stream that ends early.
 *
 * Run: node tests/hls-playlist.test.mjs
 */
import {
  SEGMENT_SECONDS, segmentCount, segmentDuration, buildPlaylist
} from '../services/hls/playlist.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nsegment count');
check('six seconds is one segment', segmentCount(6) === 1);
check('a partial segment still counts', segmentCount(7) === 2);
check('an exact multiple does not add an empty one', segmentCount(60) === 10);
check('a long film', segmentCount(7200) === 1200);
check('a fractional duration rounds up', segmentCount(1342.5) === 224);
check('zero duration yields nothing', segmentCount(0) === 0);
check('a negative duration yields nothing', segmentCount(-5) === 0);
check('a non-finite duration yields nothing', segmentCount(Infinity) === 0);
check('null yields nothing', segmentCount(null) === 0);

console.log('\nsegment duration');
check('a middle segment is full length', segmentDuration(0, 1342) === SEGMENT_SECONDS);
check('the last segment carries the remainder',
  Math.abs(segmentDuration(223, 1342) - 4) < 0.001);
// 1342 = 223*6 + 4, so index 223 is the 224th and final segment.
check('an exact multiple ends with a full segment',
  segmentDuration(9, 60) === SEGMENT_SECONDS);
check('a segment past the end is zero', segmentDuration(500, 60) === 0);

console.log('\nplaylist text');
const playlist = buildPlaylist('abc123', 1342);
const lines = playlist.split('\n');
check('starts with the M3U tag', lines[0] === '#EXTM3U');
check('declares VOD', playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
check('target duration matches the segment length',
  playlist.includes(`#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`));
check('starts at media sequence zero', playlist.includes('#EXT-X-MEDIA-SEQUENCE:0'));
check('ends the list', playlist.trim().endsWith('#EXT-X-ENDLIST'));

const extinfs = lines.filter((l) => l.startsWith('#EXTINF'));
check('one EXTINF per segment', extinfs.length === 224);
check('segment URLs carry the session', playlist.includes('/api/hls/abc123/0.ts'));
check('the last segment is numbered from zero', playlist.includes('/api/hls/abc123/223.ts'));
check('there is no segment 224', !playlist.includes('/api/hls/abc123/224.ts'));
check('the final EXTINF is the short one', extinfs[extinfs.length - 1].startsWith('#EXTINF:4.'));

// The durations must sum to the real runtime or the scrub bar lies.
const summed = extinfs
  .map((l) => Number(/#EXTINF:([\d.]+)/.exec(l)[1]))
  .reduce((a, b) => a + b, 0);
check('EXTINF values sum to the duration', Math.abs(summed - 1342) < 0.01);

check('a zero-duration file yields an empty but valid playlist',
  buildPlaylist('x', 0).includes('#EXT-X-ENDLIST'));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/hls-playlist.test.mjs`
Expected: FAIL — `Cannot find module '.../services/hls/playlist.js'`

- [ ] **Step 3: Implement**

Create `services/hls/playlist.js`:

```js
/**
 * The playlist, computed rather than observed.
 *
 * Pure arithmetic on the duration ffprobe already gave us, so the whole
 * playlist exists before the encoder has produced anything. That is what makes
 * the scrub bar accurate from the first frame and what lets the encoder be
 * restarted at any segment without the player noticing - the timeline is ours,
 * not ffmpeg's.
 */

/**
 * Six seconds is the usual HLS compromise: short enough that a seek only wastes
 * a few seconds of encoding, long enough that a two-hour film does not need
 * thousands of playlist entries.
 */
export const SEGMENT_SECONDS = 6;

const usable = (duration) => (Number.isFinite(duration) && duration > 0 ? duration : 0);

/** How many segments a file of this duration is cut into. */
export function segmentCount(duration) {
  const seconds = usable(duration);
  if (seconds === 0) return 0;
  return Math.ceil(seconds / SEGMENT_SECONDS);
}

/**
 * The length of one segment. Every segment is SEGMENT_SECONDS except the last,
 * which carries whatever is left - if it claimed a full length the playlist
 * would overrun the file and the scrub bar would be wrong at the end.
 */
export function segmentDuration(index, duration) {
  const seconds = usable(duration);
  const count = segmentCount(seconds);
  if (index < 0 || index >= count) return 0;

  const remaining = seconds - (index * SEGMENT_SECONDS);
  return remaining >= SEGMENT_SECONDS ? SEGMENT_SECONDS : remaining;
}

/** The complete VOD playlist for a session. */
export function buildPlaylist(sessionId, duration) {
  const count = segmentCount(duration);

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];

  for (let index = 0; index < count; index += 1) {
    lines.push(`#EXTINF:${segmentDuration(index, duration).toFixed(6)},`);
    lines.push(`/api/hls/${sessionId}/${index}.ts`);
  }

  lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

export default { SEGMENT_SECONDS, segmentCount, segmentDuration, buildPlaylist };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/hls-playlist.test.mjs`
Expected: PASS, `23/23 passed`

- [ ] **Step 5: Add to the chain and commit**

Append ` && node tests/hls-playlist.test.mjs` to the `test` script.

```bash
git add services/hls/playlist.js tests/hls-playlist.test.mjs package.json
git commit -m "feat(hls): playlist generated from the probed duration"
```

---

### Task 2: Session keys and the restart decision

**Files:**
- Create: `services/hls/session.js`, `tests/hls-session.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SEGMENT_SECONDS` from Task 1.
- Produces: `sessionKey(spec) -> string` (32 hex chars), `nextAction({ requested, startSegment, producedThrough, lookahead }) -> 'serve'|'wait'|'restart'`, `completedThrough(indices, exited) -> number`, `segmentsToPrune(indices, current, keepBehind) -> number[]`, `LOOKAHEAD`.

- [ ] **Step 1: Write the failing test**

Create `tests/hls-session.test.mjs`:

```js
/**
 * Session identity and the seek-restart decision.
 *
 * These are the two things that make HLS seekable here: a key that reuses a
 * running encoder when nothing about the output changed, and a rule for when a
 * requested segment is worth waiting for versus worth restarting the encoder.
 *
 * Run: node tests/hls-session.test.mjs
 */
import {
  sessionKey, nextAction, completedThrough, segmentsToPrune, LOOKAHEAD
} from '../services/hls/session.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const spec = (over = {}) => ({
  filePath: 'C:/lib/movie.mkv',
  mtimeMs: 1700000000000,
  size: 2201685207,
  quality: 'high',
  audioIndex: 0,
  audioOffset: 0,
  caps: { hevc: true, ac3: true },
  ...over
});

console.log('\nsession key');
check('is 32 hex characters', /^[0-9a-f]{32}$/.test(sessionKey(spec())));
check('is stable for identical input', sessionKey(spec()) === sessionKey(spec()));

// Anything that changes the bytes must change the key, or a second viewer at a
// different quality would silently receive the first one's segments.
check('quality changes it', sessionKey(spec()) !== sessionKey(spec({ quality: 'low' })));
check('audio track changes it', sessionKey(spec()) !== sessionKey(spec({ audioIndex: 1 })));
check('audio offset changes it', sessionKey(spec()) !== sessionKey(spec({ audioOffset: 0.5 })));
check('file path changes it', sessionKey(spec()) !== sessionKey(spec({ filePath: 'C:/lib/other.mkv' })));
check('hevc capability changes it',
  sessionKey(spec()) !== sessionKey(spec({ caps: { hevc: false, ac3: true } })));
check('ac3 capability changes it',
  sessionKey(spec()) !== sessionKey(spec({ caps: { hevc: true, ac3: false } })));
// An edited file must not serve stale segments.
check('mtime changes it', sessionKey(spec()) !== sessionKey(spec({ mtimeMs: 1 })));
check('size changes it', sessionKey(spec()) !== sessionKey(spec({ size: 1 })));

console.log('\nnext action');
const action = (over) => nextAction({
  requested: 0, startSegment: 0, producedThrough: -1, lookahead: LOOKAHEAD, ...over
});

check('an already-produced segment is served',
  action({ requested: 3, producedThrough: 5 }) === 'serve');
check('the segment being written is not yet servable',
  action({ requested: 5, producedThrough: 4 }) === 'wait');
check('a segment just ahead is worth waiting for',
  action({ requested: 6, producedThrough: 4 }) === 'wait');
check('a segment at the edge of reach still waits',
  action({ requested: 4 + LOOKAHEAD, producedThrough: 4 }) === 'wait');
check('a segment beyond reach restarts the encoder',
  action({ requested: 5 + LOOKAHEAD, producedThrough: 4 }) === 'restart');
// Seeking backwards past the start point: the encoder will never reach it.
check('a segment before the start point restarts',
  action({ requested: 2, startSegment: 10, producedThrough: 14 }) === 'restart');
check('the start segment itself is not a restart when produced',
  action({ requested: 10, startSegment: 10, producedThrough: 12 }) === 'serve');
check('a fresh session waits for its first segment',
  action({ requested: 0, startSegment: 0, producedThrough: -1 }) === 'wait');

console.log('\ncompleted through');
// ffmpeg is still writing the highest-numbered segment, so it is not complete
// until the next one appears.
check('the highest segment is still being written', completedThrough([0, 1, 2], false) === 1);
check('an empty directory has produced nothing', completedThrough([], false) === -1);
check('one segment alone is incomplete', completedThrough([0], false) === -1);
// Once the process exits, the last one is finished.
check('exiting completes the highest', completedThrough([0, 1, 2], true) === 2);
check('an exited empty run completes nothing', completedThrough([], true) === -1);
check('gaps do not confuse it', completedThrough([10, 11, 12], false) === 11);

console.log('\npruning');
check('segments well behind are pruned',
  JSON.stringify(segmentsToPrune([0, 1, 2, 3, 4, 5], 5, 2)) === JSON.stringify([0, 1, 2]));
check('nothing is pruned early on',
  segmentsToPrune([0, 1], 1, 2).length === 0);
check('the current segment is never pruned',
  !segmentsToPrune([0, 1, 2, 3], 3, 0).includes(3));
check('an empty set prunes nothing', segmentsToPrune([], 5, 2).length === 0);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/hls-session.test.mjs`
Expected: FAIL — `Cannot find module '.../services/hls/session.js'`

- [ ] **Step 3: Implement**

Create `services/hls/session.js`:

```js
/**
 * Session identity and the seek-restart rule.
 *
 * Pure on purpose: this is the logic that decides whether a viewer waits or the
 * encoder is torn down and moved, and it is the part most likely to be wrong,
 * so it must be testable without spawning anything.
 */
import { createHash } from 'node:crypto';

/**
 * How far ahead of the encoder a request is still worth waiting for.
 *
 * Restarting costs a process teardown plus a fresh seek and decode, so for a
 * segment the encoder will reach in a few seconds anyway, waiting is faster.
 * Four segments is 24 seconds of material - beyond that, restarting at the
 * requested point wins.
 */
export const LOOKAHEAD = 4;

/**
 * Everything that changes the produced bytes goes into the key, so an identical
 * request reuses a running encoder and a different one never inherits its
 * segments. mtime and size are included so an edited file cannot serve stale
 * segments from the previous version.
 */
export function sessionKey(spec) {
  const parts = [
    spec.filePath,
    spec.mtimeMs,
    spec.size,
    spec.quality,
    spec.audioIndex,
    spec.audioOffset,
    spec.caps?.hevc ? 'hevc' : '-',
    spec.caps?.ac3 ? 'ac3' : '-'
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * What to do about a request for segment `requested`.
 *
 *   serve    it exists and is complete
 *   wait     the encoder is heading there and will arrive shortly
 *   restart  the encoder will never reach it, or not soon enough
 */
export function nextAction({ requested, startSegment, producedThrough, lookahead = LOOKAHEAD }) {
  if (requested <= producedThrough) return 'serve';

  // Behind where this encoder began: it only moves forward, so waiting is
  // waiting forever. This is the ordinary backwards-seek case.
  if (requested < startSegment) return 'restart';

  if (requested <= producedThrough + lookahead) return 'wait';
  return 'restart';
}

/**
 * The highest segment index that is finished.
 *
 * ffmpeg is still writing the highest-numbered file, so it does not count until
 * the next one appears. Once the process has exited, nothing more is coming and
 * the highest is complete.
 */
export function completedThrough(indices, exited) {
  if (!indices || indices.length === 0) return -1;
  const highest = Math.max(...indices);
  return exited ? highest : highest - 1;
}

/**
 * Segments far enough behind the play position to delete.
 *
 * A two-hour film at 6s segments is 1200 files; keeping all of them would put
 * the whole runtime on disk for a stream that is never reused.
 */
export function segmentsToPrune(indices, current, keepBehind) {
  if (!indices || indices.length === 0) return [];
  const cutoff = current - keepBehind;
  return indices.filter((index) => index < cutoff).sort((a, b) => a - b);
}

export default { LOOKAHEAD, sessionKey, nextAction, completedThrough, segmentsToPrune };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/hls-session.test.mjs`
Expected: PASS, `28/28 passed`

- [ ] **Step 5: Add to the chain and commit**

Append ` && node tests/hls-session.test.mjs` to the `test` script.

```bash
git add services/hls/session.js tests/hls-session.test.mjs package.json
git commit -m "feat(hls): session keys and the seek-restart rule"
```

---

### Task 3: Segment encoder arguments

**Files:**
- Modify: `services/transcoder.js`, `tests/hls-session.test.mjs`

**Interfaces:**
- Consumes: `SEGMENT_SECONDS` (Task 1), existing `tonemapChain`, `config.ffmpeg`.
- Produces: `buildSegmentArgs(filePath, { startSegment, outputPattern, audioIndex, audioOffset, tonemap, height, maxHeight, maxrate, encoder }) -> string[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/hls-session.test.mjs` before the summary:

```js
import { buildSegmentArgs } from '../services/transcoder.js';
import { SEGMENT_SECONDS } from '../services/hls/playlist.js';

console.log('\nsegment encoder arguments');
const args = buildSegmentArgs('C:/lib/movie.mkv', {
  startSegment: 0,
  outputPattern: 'C:/cache/hls/abc/%d.ts',
  audioIndex: 0
});
const joined = args.join(' ');

check('outputs the segment muxer', args.includes('-f') && joined.includes('-f segment'));
check('uses mpegts segments', joined.includes('-segment_format mpegts'));
check('segments are the configured length',
  joined.includes(`-segment_time ${SEGMENT_SECONDS}`));
check('writes to the given pattern', args[args.length - 1] === 'C:/cache/hls/abc/%d.ts');
check('numbers from the start segment', joined.includes('-segment_start_number 0'));
// Without forced keyframes a segment can begin mid-GOP, which is undecodable
// on its own and makes every seek land in the wrong place.
check('forces keyframes on the boundary',
  joined.includes(`-force_key_frames expr:gte(t,n_forced*${SEGMENT_SECONDS})`));
check('drops subtitles and data', args.includes('-sn') && args.includes('-dn'));
// ffmpeg otherwise turns MKV chapters into a text track the source never had.
check('drops chapters', joined.includes('-map_chapters -1'));
check('audio is always re-encoded to aac for TS', joined.includes('-c:a aac'));

console.log('\nseeking into the file');
const mid = buildSegmentArgs('C:/lib/movie.mkv', {
  startSegment: 100, outputPattern: 'C:/cache/hls/abc/%d.ts', audioIndex: 0
});
const midJoined = mid.join(' ');
const startSeconds = 100 * SEGMENT_SECONDS;
check('seeks to the segment start', midJoined.includes(`-ss ${startSeconds}`));
check('numbers segments from the seek point',
  midJoined.includes('-segment_start_number 100'));
// -ss resets output timestamps to zero; without this the restarted segments
// claim to begin at 0 and the player treats the seek as a jump to the start.
check('shifts timestamps back onto the real timeline',
  midJoined.includes(`-output_ts_offset ${startSeconds}`));

console.log('\ncaps carry over to segments');
const capped = buildSegmentArgs('C:/lib/movie.mkv', {
  startSegment: 0, outputPattern: 'p/%d.ts', audioIndex: 0, maxHeight: 720, maxrate: '5M'
});
check('scales to the cap', capped.join(' ').includes('scale=-2:720'));
check('applies the bitrate ceiling', capped.includes('5M'));

const hdr = buildSegmentArgs('C:/lib/movie.mkv', {
  startSegment: 0, outputPattern: 'p/%d.ts', audioIndex: 0,
  tonemap: true, height: 2160, maxHeight: 720
});
const chain = hdr[hdr.indexOf('-vf') + 1];
check('tone mapping composes with the cap', chain.includes('scale=-2:720'));
check('only one resize step', (chain.match(/(^|,)scale=/g) || []).length === 1);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/hls-session.test.mjs`
Expected: FAIL — `buildSegmentArgs is not a function`

- [ ] **Step 3: Implement**

Add to `services/transcoder.js`, after `buildArgs`:

```js
/**
 * ffmpeg arguments for HLS segment output.
 *
 * Separate from buildArgs rather than a flag on it: the two differ in output
 * muxer, timestamp handling and keyframe placement, and folding both into one
 * function would mean every caller reasoning about which half applies.
 *
 * The video encoding settings are deliberately shared in spirit with buildArgs
 * - same encoder choice, same cap handling - because a stream should not look
 * different depending on how it happens to be delivered.
 */
export function buildSegmentArgs(filePath, {
  startSegment = 0, outputPattern, audioIndex = 0, audioOffset = 0,
  tonemap = false, height = null, maxHeight = null, maxrate = null, encoder = null
}) {
  const startSeconds = startSegment * SEGMENT_SECONDS;
  const args = ['-hide_banner', '-loglevel', 'error'];
  const offset = clampAudioOffset(audioOffset);

  if (tonemap && encoder === 'h264_nvenc') args.push('-hwaccel', 'cuda');

  const seek = () => { if (startSeconds > 0) args.push('-ss', String(startSeconds)); };

  seek();
  args.push('-i', filePath);

  if (offset !== 0) {
    args.push('-itsoffset', String(offset));
    seek();
    args.push('-i', filePath);
    args.push('-map', '0:v:0', '-map', `1:a:${audioIndex}?`);
  } else {
    args.push('-map', '0:v:0', '-map', `0:a:${audioIndex}?`);
  }

  // Chapters would otherwise become a text track that is not in the source.
  args.push('-sn', '-dn', '-map_chapters', '-1');

  if (tonemap) {
    args.push('-vf', tonemapChain(height, maxHeight ?? TONEMAP_MAX_HEIGHT));
  } else if (maxHeight) {
    args.push('-vf', `scale=-2:${maxHeight}`);
  }

  const rate = maxrate || config.ffmpeg.videoMaxrate;

  if (encoder) {
    args.push('-c:v', encoder);
    if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf));
    else args.push('-global_quality', String(config.ffmpeg.videoCrf));
    args.push('-maxrate', rate, '-bufsize', '24M');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', config.ffmpeg.videoPreset,
      '-crf', String(config.ffmpeg.videoCrf),
      '-maxrate', rate,
      '-bufsize', '24M'
    );
  }

  if (!tonemap) args.push('-pix_fmt', 'yuv420p');

  /*
   * A segment that does not begin on a keyframe cannot be decoded on its own,
   * so the player would either stall or land somewhere other than where it
   * asked for. This is the single most important argument here.
   */
  args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);

  // MPEG-TS carries no AAC-in-MP4 niceties; audio is always re-encoded.
  args.push('-c:a', 'aac', '-ac', String(config.ffmpeg.audioChannels), '-b:a', config.ffmpeg.audioBitrate);

  /*
   * -ss rewinds the output clock to zero. Left alone, segments produced after a
   * seek would claim to start at 0 and the player would treat the seek as a
   * jump back to the beginning. This puts them back on the file's own timeline.
   */
  if (startSeconds > 0) args.push('-output_ts_offset', String(startSeconds));

  args.push(
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-segment_format', 'mpegts',
    '-segment_start_number', String(startSegment),
    // Lets a boundary land on the keyframe just before the exact time rather
    // than pushing it into the next segment.
    '-segment_time_delta', '0.05',
    outputPattern
  );

  return args;
}
```

Add the import at the top of `services/transcoder.js`:

```js
import { SEGMENT_SECONDS } from './hls/playlist.js';
```

And add `buildSegmentArgs` to the default export.

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/hls-session.test.mjs`
Expected: PASS

- [ ] **Step 5: Verify the arguments actually work**

This is the risk the spec flagged. Produce real segments and check timestamps line up, using any library file:

```bash
node -e "import('./services/transcoder.js').then(async m=>{const a=m.buildSegmentArgs(process.argv[1],{startSegment:100,outputPattern:'/tmp/seg/%d.ts',audioIndex:0,maxHeight:720});console.log(a.join(' '));process.exit(0)})" "<abs-path-to-a-library-file>"
```

Create `/tmp/seg`, run the printed ffmpeg command with a `-t 30` added, then:

```bash
ffprobe -v error -show_entries format=start_time,duration -of default=noprint_wrappers=1 /tmp/seg/100.ts
```

Expected: `start_time` near 600 (100 × 6), **not** near 0. If it reads 0, `-output_ts_offset` is not doing its job and seeking will jump to the beginning — fix before continuing.

Also confirm the boundary is a keyframe:

```bash
ffprobe -v error -select_streams v:0 -show_entries frame=key_frame -read_intervals "%+#1" -of csv=p=0 /tmp/seg/100.ts
```

Expected: `1`

- [ ] **Step 6: Commit**

```bash
git add services/transcoder.js tests/hls-session.test.mjs
git commit -m "feat(hls): ffmpeg arguments for keyframe-aligned segments"
```

---

### Task 4: Session manager

**Files:**
- Create: `services/hls/manager.js`
- Modify: `config/index.js`, `.gitignore`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `openSession(spec) -> { id, duration, dir }`, `requestSegment(id, index) -> Promise<string|null>` (path or null), `touch(id)`, `getSession(id)`, `shutdownAll()`, `startSweeper()`, `stopSweeper()`.

- [ ] **Step 1: Add config**

In `config/index.js`, inside the config object after `mp4Cache`:

```js
  hls: {
    dir: path.join(ROOT_DIR, 'cache', 'hls'),
    // How long a session survives without a keepalive before it is reaped.
    idleTimeoutMs: int('HLS_IDLE_TIMEOUT_MS', 60000),
    sweepIntervalMs: int('HLS_SWEEP_INTERVAL_MS', 30000),
    // Segments kept behind the play position, so a long film does not put its
    // whole runtime on disk.
    keepBehind: int('HLS_KEEP_BEHIND', 6),
    // How long a request will wait for the encoder to reach a segment.
    segmentTimeoutMs: int('HLS_SEGMENT_TIMEOUT_MS', 30000)
  },
```

Add to `.gitignore` under the cache entry: `cache/hls/` is already covered by the existing `cache/` rule — verify with `git check-ignore -v cache/hls` and add only if it is not.

- [ ] **Step 2: Implement the manager**

Create `services/hls/manager.js`:

```js
/**
 * HLS sessions: one ffmpeg process producing segments forward from a point.
 *
 * The only file in services/hls that touches the filesystem or spawns anything.
 * All the decisions it acts on - which segment to serve, when to restart, what
 * to delete - live in session.js so they can be tested without an encoder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config, { createLogger } from '../../config/index.js';
import { SEGMENT_SECONDS, segmentCount } from './playlist.js';
import { sessionKey, nextAction, completedThrough, segmentsToPrune } from './session.js';
import { buildSegmentArgs, hardwareEncoder } from '../transcoder.js';

const log = createLogger('hls');

/** Live sessions by id. */
const sessions = new Map();

const segmentPath = (session, index) => path.join(session.dir, `${index}.ts`);

/** Segment indices currently on disk. */
function segmentIndices(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => Number.parseInt(name, 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

function killEncoder(session) {
  if (!session.proc) return;
  const proc = session.proc;
  session.proc = null;
  session.exited = true;
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Start (or restart) the encoder at a segment boundary. */
async function startEncoder(session, startSegment) {
  killEncoder(session);

  session.startSegment = startSegment;
  session.exited = false;

  const encoder = await hardwareEncoder();
  const args = buildSegmentArgs(session.filePath, {
    startSegment,
    outputPattern: path.join(session.dir, '%d.ts'),
    audioIndex: session.audioIndex,
    audioOffset: session.audioOffset,
    tonemap: session.tonemap,
    height: session.sourceHeight,
    maxHeight: session.maxHeight,
    maxrate: session.maxrate,
    encoder
  });

  log.info(`session ${session.id}: encoding from segment ${startSegment}`);
  const proc = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
  session.proc = proc;

  proc.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) log.debug(`session ${session.id}: ${text}`);
  });
  proc.on('error', (error) => {
    log.error(`session ${session.id}: ${error.message}`);
    session.exited = true;
  });
  proc.on('close', () => {
    // Only mark exited if this is still the current process; a restart will
    // have replaced it and that close belongs to the old one.
    if (session.proc === proc) {
      session.proc = null;
      session.exited = true;
    }
  });
}

/**
 * Create a session, or hand back the running one for an identical request.
 * `spec` carries everything sessionKey hashes plus what the encoder needs.
 */
export async function openSession(spec) {
  const id = sessionKey(spec);
  const existing = sessions.get(id);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const dir = path.join(config.hls.dir, id);
  fs.mkdirSync(dir, { recursive: true });

  const session = {
    id,
    dir,
    filePath: spec.filePath,
    duration: spec.duration,
    count: segmentCount(spec.duration),
    audioIndex: spec.audioIndex,
    audioOffset: spec.audioOffset,
    tonemap: spec.tonemap,
    sourceHeight: spec.sourceHeight,
    maxHeight: spec.maxHeight,
    maxrate: spec.maxrate,
    proc: null,
    startSegment: 0,
    exited: false,
    lastAccess: Date.now()
  };

  sessions.set(id, session);
  return session;
}

export const getSession = (id) => sessions.get(id) || null;

export function touch(id) {
  const session = sessions.get(id);
  if (session) session.lastAccess = Date.now();
}

/**
 * The path to a finished segment, waiting for or restarting the encoder as
 * needed. Resolves null if it never arrives.
 */
export async function requestSegment(id, index) {
  const session = sessions.get(id);
  if (!session) return null;
  if (index < 0 || index >= session.count) return null;

  session.lastAccess = Date.now();

  const deadline = Date.now() + config.hls.segmentTimeoutMs;

  for (;;) {
    const indices = segmentIndices(session.dir);
    const through = completedThrough(indices, session.exited);
    const action = session.proc || session.exited
      ? nextAction({ requested: index, startSegment: session.startSegment, producedThrough: through })
      : 'restart';

    if (action === 'serve') {
      prune(session, index);
      return segmentPath(session, index);
    }

    if (action === 'restart') {
      await startEncoder(session, index);
    } else if (Date.now() > deadline) {
      log.warn(`session ${id}: segment ${index} timed out`);
      return null;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Delete segments far enough behind the play position. */
function prune(session, current) {
  const stale = segmentsToPrune(segmentIndices(session.dir), current, config.hls.keepBehind);
  for (const index of stale) {
    // Never delete something the encoder is still writing.
    if (index >= session.startSegment && session.proc) continue;
    try { fs.unlinkSync(segmentPath(session, index)); } catch { /* already gone */ }
  }
}

function destroy(session) {
  killEncoder(session);
  sessions.delete(session.id);
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  log.info(`session ${session.id}: reaped`);
}

let sweeper = null;

export function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - config.hls.idleTimeoutMs;
    for (const session of Array.from(sessions.values())) {
      if (session.lastAccess < cutoff) destroy(session);
    }
  }, config.hls.sweepIntervalMs);
  sweeper.unref();
}

export function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

/** Kill every session. Called on shutdown so no ffmpeg outlives the server. */
export function shutdownAll() {
  stopSweeper();
  for (const session of Array.from(sessions.values())) destroy(session);
}

/**
 * Anything left in cache/hls from a previous run is orphaned - the sessions
 * that owned those directories died with the process.
 */
export function clearOrphans() {
  try {
    fs.rmSync(config.hls.dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  fs.mkdirSync(config.hls.dir, { recursive: true });
}

export default {
  openSession, getSession, requestSegment, touch,
  startSweeper, stopSweeper, shutdownAll, clearOrphans
};
```

- [ ] **Step 3: Commit**

```bash
git add services/hls/manager.js config/index.js
git commit -m "feat(hls): session manager with seek-restart and reaping"
```

---

### Task 5: Endpoints

**Files:**
- Create: `routes/hls.js`
- Modify: `server.js`, `routes/stream.js`

**Interfaces:**
- Consumes: Task 4.
- Produces: `GET /api/hls/playlist.m3u8`, `GET /api/hls/:session/:segment.ts`, `POST /api/hls/:session/touch`; `hls` field on `/api/stream/info`.

- [ ] **Step 1: Implement the router**

Create `routes/hls.js`:

```js
/**
 * GET  /api/hls/playlist.m3u8?path=&q=&hevc=&ac3=&audio=&audioOffset=
 * GET  /api/hls/:session/:segment.ts
 * POST /api/hls/:session/touch
 *
 * The playlist URL is the session handle: requesting it creates or reuses a
 * session, so a reload lands on the same encoder rather than starting a second.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as manager from '../services/hls/manager.js';
import { buildPlaylist } from '../services/hls/playlist.js';
import { resolveQuality } from '../services/quality.js';
import { classifyOrigin } from '../services/network.js';

const log = createLogger('api:hls');
const router = express.Router();

router.get('/playlist.m3u8', async (req, res, next) => {
  try {
    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const filePath = path.resolve(requested);
    if (!isInsideLibrary(filePath)) {
      return res.status(403).json({ error: 'path is outside the library' });
    }

    let stats;
    try { stats = fs.statSync(filePath); } catch {
      return res.status(404).json({ error: 'file not found' });
    }

    const caps = {
      hevc: req.query.hevc === '1',
      ac3: req.query.ac3 === '1'
    };
    const audioIndex = Math.max(0, Number(req.query.audio) || 0);
    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
    const quality = resolveQuality(req.query.q, classifyOrigin(req.ip));

    const info = await transcoder.probe(filePath);
    if (!info?.duration) {
      return res.status(422).json({ error: 'cannot determine duration for this file' });
    }
    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    const session = await manager.openSession({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      quality: quality.level,
      audioIndex,
      audioOffset,
      caps,
      duration: info.duration,
      tonemap: Boolean(decision.tonemapped),
      sourceHeight: info.video?.height ?? null,
      maxHeight: decision.targetHeight ?? (decision.tonemapped ? decision.tonemapHeight : null),
      maxrate: decision.maxrate
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    // The playlist is derived from the duration, not from what exists yet, so
    // caching it would hand back a stale session id after a reap.
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildPlaylist(session.id, session.duration));
  } catch (error) {
    next(error);
  }
});

router.get('/:session/:segment.ts', async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.segment, 10);
    if (!Number.isFinite(index)) return res.status(400).json({ error: 'bad segment' });

    const file = await manager.requestSegment(req.params.session, index);
    if (!file) return res.status(404).json({ error: 'segment unavailable' });

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(file, (error) => (error ? next(error) : undefined));
  } catch (error) {
    next(error);
  }
});

router.post('/:session/touch', (req, res) => {
  manager.touch(req.params.session);
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Mount it and manage lifecycle**

In `server.js`, add the imports:

```js
import hlsRouter from './routes/hls.js';
import * as hls from './services/hls/manager.js';
```

Mount alongside the other API routes:

```js
app.use('/api/hls', hlsRouter);
```

In the `app.listen` callback, beside `watcher.start()`:

```js
  // Directories from a previous run are orphaned: the encoders that owned them
  // died with that process.
  hls.clearOrphans();
  hls.startSweeper();
```

In `shutdown()`, beside `watcher.stop()`:

```js
  hls.shutdownAll();
```

- [ ] **Step 3: Tell the player about it**

In `routes/stream.js`, remove the `logClientRequest` function and both of its call sites — it was diagnostic and its job is done.

Then add to the `/info` JSON payload:

```js
      // Present when playback needs ffmpeg. A direct or cached file is a real
      // file with byte ranges and needs nothing here.
      hls: (decision.mode === 'direct' || decision.mode.startsWith('cached-'))
        ? null
        : `/api/hls/playlist.m3u8?${new URLSearchParams({
          path: resolved.filePath,
          q: req.query.q || 'auto',
          hevc: caps.hevc ? '1' : '',
          ac3: caps.ac3 ? '1' : '',
          audio: String(req.query.audio || 0),
          audioOffset: String(audioOffset || 0)
        })}`,
```

And because HLS seeks natively, override seekability for that path:

```js
      seekable: decision.mode === 'direct'
        || decision.mode.startsWith('cached-')
        // HLS seeks by segment, which is the whole point of it.
        || true,
```

Replace that with a plain `seekable: true` and a comment, since every delivery path is now seekable:

```js
      // Every path is seekable now: files by byte range, HLS by segment.
      seekable: true,
```

- [ ] **Step 4: Verify the endpoints**

Start the server, log in, then:

```bash
curl -s -G "http://127.0.0.1:3000/api/hls/playlist.m3u8" \
  --data-urlencode "path=<abs-path>" --data-urlencode "q=low" \
  --data-urlencode "hevc=1" --data-urlencode "ac3=1" -b /tmp/d.txt | head -8
```

Expected: an `#EXTM3U` playlist with `/api/hls/<32 hex>/0.ts` lines.

Then fetch segment 0 and a far-future segment:

```bash
SESSION=<from the playlist>
curl -s -o /tmp/s0.ts -w "seg0 %{http_code} %{size_download}\n" "http://127.0.0.1:3000/api/hls/$SESSION/0.ts" -b /tmp/d.txt
curl -s -o /tmp/s150.ts -w "seg150 %{http_code} %{size_download}\n" "http://127.0.0.1:3000/api/hls/$SESSION/150.ts" -b /tmp/d.txt
ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 /tmp/s0.ts
ffprobe -v error -show_entries format=start_time -of csv=p=0 /tmp/s150.ts
```

Expected: both `200` with non-zero size; segment 0 is `h264` at the capped height; segment 150's `start_time` is near 900 (150 × 6), proving the restart landed on the right part of the file.

- [ ] **Step 5: Commit**

```bash
git add routes/hls.js server.js routes/stream.js
git commit -m "feat(hls): playlist, segment and keepalive endpoints"
```

---

### Task 6: Client playback

**Files:**
- Create: `public/js/vendor/hls.min.js`, `public/js/hls-player.js`
- Modify: `public/js/api.js`, `public/js/player.js`

**Interfaces:**
- Consumes: the `hls` field from Task 5.
- Produces: `attachHls(video, url) -> Promise<detach>`; `api.hlsSupported()`.

- [ ] **Step 1: Vendor hls.js**

```bash
mkdir -p public/js/vendor
curl -sL https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js -o public/js/vendor/hls.min.js
ls -la public/js/vendor/hls.min.js
```

Expected: roughly 300–400 KB. If the download fails, stop and report — do not hand-write a replacement.

Confirm it is the real library:

```bash
head -c 200 public/js/vendor/hls.min.js
```

Expected: a minified bundle mentioning `Hls`.

- [ ] **Step 2: Implement the attach helper**

Create `public/js/hls-player.js`:

```js
/**
 * HLS attachment.
 *
 * Safari and iOS play HLS natively through AVFoundation and must be given the
 * playlist directly - handing those a Media Source instead is slower and, on
 * iOS, unsupported. Everything else goes through hls.js.
 *
 * The library is fetched only when a stream actually needs it, so direct and
 * cached playback never pays for it.
 */
let hlsModulePromise = null;

function loadHlsLibrary() {
  if (hlsModulePromise) return hlsModulePromise;
  hlsModulePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/hls.min.js';
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error('could not load the HLS player'));
    document.head.appendChild(script);
  });
  return hlsModulePromise;
}

/** Does this browser play HLS without help? */
export const nativeHls = (video) =>
  Boolean(video.canPlayType('application/vnd.apple.mpegurl'));

/**
 * Point a <video> at an HLS playlist.
 * Resolves a detach function that must be called before reusing the element.
 */
export async function attachHls(video, url) {
  if (nativeHls(video)) {
    video.src = url;
    return () => { video.removeAttribute('src'); };
  }

  const Hls = await loadHlsLibrary();
  if (!Hls?.isSupported()) {
    throw new Error('This browser cannot play the converted stream.');
  }

  const instance = new Hls({
    // The playlist is complete from the start and segments are produced on
    // demand, so the default live-edge behaviour does not apply.
    lowLatencyMode: false,
    // A segment can take a moment when the encoder has just restarted after a
    // seek; the default gives up too early and surfaces as a stall.
    fragLoadingMaxRetry: 6,
    fragLoadingRetryDelay: 1000
  });

  instance.loadSource(url);
  instance.attachMedia(video);

  return () => {
    try { instance.destroy(); } catch { /* already gone */ }
  };
}

export default { attachHls, nativeHls };
```

- [ ] **Step 3: Add the API helper**

In `public/js/api.js`, beside the other playback URL helpers:

```js
/** Keepalive so the server does not reap a session that is still playing. */
export const touchHlsSession = (sessionId) =>
  post(`/api/hls/${sessionId}/touch`, {});
```

Add `touchHlsSession` to the default export.

- [ ] **Step 4: Use it in the player**

In `public/js/player.js`, add the import:

```js
import { attachHls } from './hls-player.js';
```

In `load()`, branch before the existing logic:

```js
function load(startAt = 0, { autoplay = true } = {}) {
  // HLS covers everything that needs ffmpeg. It seeks by segment, so none of
  // the ?t= restart machinery below applies to it.
  if (ctx.info?.hls) {
    ctx.offset = 0;
    attachHls(ctx.video, ctx.info.hls)
      .then((detach) => {
        ctx.detachHls = detach;
        if (startAt > 0) {
          ctx.video.addEventListener('loadedmetadata', () => {
            ctx.video.currentTime = startAt;
          }, { once: true });
        }
        if (autoplay) ctx.video.play().catch(() => {});
      })
      .catch((error) => {
        toast('error', 'Cannot play this file', error.message);
      });
    return;
  }

  // ... existing direct / pipe handling unchanged ...
```

In `close()` and wherever the source is torn down, call the detach first:

```js
  if (ctx.detachHls) {
    ctx.detachHls();
    ctx.detachHls = null;
  }
```

Add the session keepalive beside the existing `ctx.saveTimer` interval:

```js
  /*
   * The server reaps idle sessions to stop abandoned encoders piling up, so a
   * paused film has to keep saying it is still there.
   */
  ctx.hlsTimer = setInterval(() => {
    const match = /\/api\/hls\/([0-9a-f]{32})\//.exec(ctx.video.currentSrc || '');
    if (match) api.touchHlsSession(match[1]).catch(() => {});
  }, 20000);
```

Clear it alongside `ctx.saveTimer` on close.

- [ ] **Step 5: Verify in Chromium and WebKit**

Using the existing Playwright harness pattern, load a `.mkv` in the player and assert `readyState >= 2`, then seek to 10 minutes and assert `currentTime` lands within 10 seconds of the target.

Expected: passes in both engines. WebKit here is not iOS, but it does exercise the hls.js path and the segment endpoints.

- [ ] **Step 6: Commit**

```bash
git add public/js/vendor/hls.min.js public/js/hls-player.js public/js/api.js public/js/player.js
git commit -m "feat(player): play transcoded streams over HLS"
```

---

### Task 7: Device verification and documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Verify on the iPhone**

Over the tunnel, play a `.mkv` that previously failed. Expected: it plays, and seeking works.

Check the server log for the session:

```bash
grep "session " /tmp/mw-prod.log | tail -5
```

Expected: one session opened, restarts only when you actually seek.

- [ ] **Step 2: Confirm sessions are reaped**

Close the player, wait past the idle timeout, then:

```bash
ls cache/hls/ 2>/dev/null | wc -l
```

Expected: `0`. Also confirm no ffmpeg processes linger:

```bash
tasklist | grep -ci ffmpeg
```

Expected: `0` when nothing is playing.

- [ ] **Step 3: Confirm the cap still holds**

Over the tunnel with quality on Auto, fetch a segment and probe its height.
Expected: 1080 or below, not 2160.

- [ ] **Step 4: Document**

Update the README's Remote access section: transcoded playback is delivered as
HLS, it is seekable, iOS is supported, and the `HLS_*` tunables exist.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: HLS playback"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Playlist written from probed duration | 1 |
| 6s segments, TS, keyframe-aligned | 1, 3 |
| `-map_chapters -1` | 3 |
| Session keys on everything affecting output | 2 |
| Serve / wait / restart rule | 2 |
| Completeness from directory contents | 2 |
| Timestamp continuity across restart | 3 (step 5 verifies empirically) |
| Session manager, encoder lifecycle | 4 |
| Keepalive, sweeper, shutdown, orphans | 4, 5 |
| Pruning behind the play position | 2, 4 |
| Three endpoints | 5 |
| `hls` field on `/info` | 5 |
| Quality cap as encoder settings | 3, 5 |
| Native HLS vs hls.js | 6 |
| Lazy library load | 6 |
| Pipe retained | Not removed anywhere — correct |
| Tests named in the spec | 1, 2, 3 |
| Device verification | 7 |

**Naming consistency:** `SEGMENT_SECONDS` is defined once in `playlist.js` and imported by `transcoder.js` and `manager.js`. `sessionKey`/`nextAction`/`completedThrough`/`segmentsToPrune` are produced in Task 2 and consumed under those names in Task 4. `buildSegmentArgs` takes `outputPattern`/`startSegment` in both Task 3 and Task 4.

**Known ordering note:** Task 3 imports `services/hls/playlist.js` from Task 1, and Task 4 imports both. Executing in order is required.

**Diagnostic removal:** the `[diag]` logging added while investigating the iOS failure is removed in Task 5 Step 3.
