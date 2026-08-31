/**
 * Thumbnail service — interval arithmetic and cache keys.
 *
 * The pure parts only. Generation needs ffmpeg and a real file, and is covered
 * by driving the player in tests/ui-player.mjs.
 *
 * Run: node tests/thumbnails.test.mjs
 */
import {
  frameInterval, frameCount, cacheKey, FRAME_SECONDS, MAX_FRAMES
} from '../services/thumbnails.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nframeInterval');
check('a 22-minute episode gets the base interval', frameInterval(22 * 60) === FRAME_SECONDS);
check('a short clip gets the base interval', frameInterval(45) === FRAME_SECONDS);
check('exactly at the cap stays at the base interval',
  frameInterval(FRAME_SECONDS * MAX_FRAMES) === FRAME_SECONDS);
check('one second past the cap stretches',
  frameInterval(FRAME_SECONDS * MAX_FRAMES + 1) === FRAME_SECONDS + 1);
check('a two-hour film stretches to 24s', frameInterval(2 * 60 * 60) === 24);
check('never returns below the base interval', frameInterval(1) === FRAME_SECONDS);
check('zero duration gives the base interval', frameInterval(0) === FRAME_SECONDS);
check('null duration gives the base interval', frameInterval(null) === FRAME_SECONDS);
check('NaN duration gives the base interval', frameInterval(NaN) === FRAME_SECONDS);
check('a negative duration gives the base interval', frameInterval(-30) === FRAME_SECONDS);

console.log('\nframeCount');
check('a 22-minute episode at 10s gives 132', frameCount(22 * 60, 10) === 132);
check('rounds a partial final interval up', frameCount(95, 10) === 10);
check('never exceeds the cap',
  frameCount(2 * 60 * 60, frameInterval(2 * 60 * 60)) <= MAX_FRAMES);
check('a very long film still respects the cap',
  frameCount(5 * 60 * 60, frameInterval(5 * 60 * 60)) <= MAX_FRAMES);
check('zero duration gives zero frames', frameCount(0, 10) === 0);
check('null duration gives zero frames', frameCount(null, 10) === 0);
check('a zero interval gives zero rather than Infinity', frameCount(600, 0) === 0);

console.log('\ncacheKey');
const a = cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000);
check('is a 40-character sha1 hex string', /^[0-9a-f]{40}$/.test(a));
check('is stable for identical inputs',
  a === cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000));
check('changes when the path changes',
  a !== cacheKey('/lib/show/s1e2.mkv', 1234567, 1700000000000));
check('changes when the size changes',
  a !== cacheKey('/lib/show/s1e1.mkv', 999, 1700000000000));
check('changes when the mtime changes',
  a !== cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000009999));
check('ignores sub-millisecond mtime drift',
  a === cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000.7));
// Without a separator, ("ab", 1) and ("a", "b1") would collide.
check('separates its fields', cacheKey('ab', 1, 0) !== cacheKey('a', 'b1', 0));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
