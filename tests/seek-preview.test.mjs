/**
 * Seek bar preview arithmetic.
 *
 * Run: node tests/seek-preview.test.mjs
 */
import { previewFraction, frameIndex, cardLeft } from '../public/js/preview.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\npreviewFraction');
check('midpoint is 0.5', previewFraction(200, 400) === 0.5);
check('left edge is 0', previewFraction(0, 400) === 0);
check('right edge is 1', previewFraction(400, 400) === 1);
check('clamps a negative position', previewFraction(-30, 400) === 0);
check('clamps past the right edge', previewFraction(900, 400) === 1);
check('zero width gives 0 rather than NaN', previewFraction(10, 0) === 0);
check('negative width gives 0', previewFraction(10, -5) === 0);
check('NaN position gives 0', previewFraction(NaN, 400) === 0);
check('NaN width gives 0', previewFraction(10, NaN) === 0);

console.log('\nframeIndex');
check('start of file is frame 0', frameIndex(0, 10) === 0);
check('floors within an interval', frameIndex(9.9, 10) === 0);
check('crosses to the next frame', frameIndex(10, 10) === 1);
check('handles a long position', frameIndex(1325, 10) === 132);
check('respects a wider interval', frameIndex(1325, 24) === 55);
check('never returns a negative index', frameIndex(-50, 10) === 0);
check('a zero interval gives 0 rather than Infinity', frameIndex(100, 0) === 0);
check('NaN time gives 0', frameIndex(NaN, 10) === 0);

console.log('\ncardLeft');
// A 160px card on a 1000px track: centred on the cursor, but never overhanging.
check('centres in the middle of the track', cardLeft(0.5, 1000, 160) === 420);
check('clamps at the left edge', cardLeft(0, 1000, 160) === 0);
check('clamps at the right edge', cardLeft(1, 1000, 160) === 840);
check('clamps just inside the left edge', cardLeft(0.02, 1000, 160) === 0);
check('a card wider than the track pins to 0', cardLeft(0.5, 100, 160) === 0);
check('zero track width gives 0', cardLeft(0.5, 0, 160) === 0);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
