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
