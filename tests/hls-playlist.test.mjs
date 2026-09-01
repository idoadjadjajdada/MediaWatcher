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
