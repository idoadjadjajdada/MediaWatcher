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
import { buildSegmentArgs } from '../services/transcoder.js';
import { SEGMENT_SECONDS } from '../services/hls/playlist.js';

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
check('the highest segment is still being written', completedThrough([0, 1, 2], 0, false) === 1);
check('an empty directory has produced nothing', completedThrough([], 0, false) === -1);
check('one segment alone is incomplete', completedThrough([0], 0, false) === -1);
// Once the process exits, the last one is finished.
check('exiting completes the highest', completedThrough([0, 1, 2], 0, true) === 2);
check('an exited empty run completes nothing', completedThrough([], 0, true) === -1);
check('gaps do not confuse it', completedThrough([10, 11, 12], 0, false) === 11);

/*
 * Segments left by an earlier start point are real content but say nothing
 * about where the current encoder has reached. Counting them made a session
 * that restarted at 150 read its leftover segment 2 as "produced through 1",
 * decide the encoder would never arrive, and restart in a tight loop.
 */
check('leftovers from an earlier start point are ignored',
  completedThrough([0, 1, 2], 150, false) === 149);
check('a fresh run reports one below its start',
  completedThrough([], 150, false) === 149);
check('the first segment of a run is still being written',
  completedThrough([150], 150, false) === 149);
check('a run counts only its own segments',
  completedThrough([0, 1, 2, 150, 151, 152], 150, false) === 151);
check('an exited run counts its highest own segment',
  completedThrough([0, 1, 2, 150, 151], 150, true) === 151);

console.log('\npruning');
check('segments well behind are pruned',
  JSON.stringify(segmentsToPrune([0, 1, 2, 3, 4, 5], 5, 2)) === JSON.stringify([0, 1, 2]));
check('nothing is pruned early on',
  segmentsToPrune([0, 1], 1, 2).length === 0);
check('the current segment is never pruned',
  !segmentsToPrune([0, 1, 2, 3], 3, 0).includes(3));
check('an empty set prunes nothing', segmentsToPrune([], 5, 2).length === 0);

console.log('\nsegment encoder arguments');
const args = buildSegmentArgs('C:/lib/movie.mkv', {
  startSegment: 0,
  outputPattern: 'C:/cache/hls/abc/%d.ts',
  audioIndex: 0
});
const joined = args.join(' ');

check('outputs the segment muxer', joined.includes('-f segment'));
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

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
