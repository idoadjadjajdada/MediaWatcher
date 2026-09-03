/**
 * The playback speed ladder.
 *
 * A slider over a list of stops rather than a continuous range, and 1.00x is
 * the reason. It is by far the most-used value and the only one that has to be
 * exactly right; on a continuous slider it is a pixel you have to find, and
 * landing at 1.03x sounds subtly wrong in a way that is hard to place.
 *
 * The stops are unevenly spaced on purpose — fine near 1x where a tenth is
 * audible, coarse at the ends where it is not — so the arithmetic that maps a
 * rate to a position has to work in ratios rather than differences. That is
 * what most of this checks.
 *
 * Run: node tests/speed.test.mjs
 */
import { SPEEDS, NORMAL_SPEED_INDEX, speedIndexFor, speedAtIndex, formatSpeed } from '../public/js/player.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nthe ladder');

check('starts at a quarter speed', SPEEDS[0] === 0.25);
check('ends at five times', SPEEDS[SPEEDS.length - 1] === 5);
check('is sorted', SPEEDS.every((speed, i) => i === 0 || speed > SPEEDS[i - 1]));
check('every stop is positive', SPEEDS.every((speed) => speed > 0));
// The value that has to be exactly reachable, because it is the one everything
// else is a deviation from.
check('includes exactly 1', SPEEDS.includes(1));
check('and knows where it is', SPEEDS[NORMAL_SPEED_INDEX] === 1);

/*
 * Fine in the middle, coarse at the ends. Checked as a property rather than
 * stop by stop: the useful range is where people adjust carefully, and a
 * ladder that is uniform there has thrown away the point of being a ladder.
 */
{
  const nearOne = SPEEDS.filter((speed) => speed >= 0.75 && speed <= 1.5);
  check('has plenty of stops around normal speed', nearOne.length >= 10);
  const above = SPEEDS.filter((speed) => speed > 2);
  check('and few above 2x', above.length <= 10);
}

console.log('\nfrom a rate to a position');

check('1x maps to its own stop', speedAtIndex(speedIndexFor(1)) === 1);
check('an exact stop maps to itself', speedAtIndex(speedIndexFor(1.25)) === 1.25);
check('and another', speedAtIndex(speedIndexFor(0.5)) === 0.5);
check('the slowest', speedAtIndex(speedIndexFor(0.25)) === 0.25);
check('the fastest', speedAtIndex(speedIndexFor(5)) === 5);

/*
 * Nearest in ratio, not in difference. 0.5x is as far from 1x as 2x is, and
 * measuring arithmetically would make 2x look closer — which is how a slider
 * ends up jumping the wrong way as you drag through the middle.
 */
check('a rate between two stops takes the nearer one', speedAtIndex(speedIndexFor(1.26)) === 1.25);
check('rounding is by ratio, not by difference',
  speedAtIndex(speedIndexFor(Math.sqrt(0.5 * 1))) === 0.7);

console.log('\nout of range');

check('slower than the ladder clamps to the slowest', speedAtIndex(speedIndexFor(0.05)) === 0.25);
check('faster clamps to the fastest', speedAtIndex(speedIndexFor(50)) === 5);
// Every one of these has reached playbackRate at some point in this codebase's
// life, and none of them may produce NaN on the element.
check('zero falls back to normal speed', speedAtIndex(speedIndexFor(0)) === 1);
check('a negative rate falls back to normal', speedAtIndex(speedIndexFor(-2)) === 1);
check('nonsense falls back to normal', speedAtIndex(speedIndexFor('fast')) === 1);
check('undefined falls back to normal', speedAtIndex(speedIndexFor(undefined)) === 1);
check('a string that is a number still works', speedAtIndex(speedIndexFor('1.5')) === 1.5);

console.log('\npositions');

check('index zero is the slowest', speedAtIndex(0) === SPEEDS[0]);
check('the last index is the fastest', speedAtIndex(SPEEDS.length - 1) === 5);
check('past the end clamps', speedAtIndex(999) === 5);
check('before the start clamps', speedAtIndex(-4) === 0.25);
check('a fractional position rounds', speedAtIndex(NORMAL_SPEED_INDEX + 0.4) === 1);
// A slider hands back strings.
check('a string position works', speedAtIndex(String(NORMAL_SPEED_INDEX)) === 1);

console.log('\nhow it reads');

check('a whole number has no decimals', formatSpeed(1) === '1×');
check('and neither does five', formatSpeed(5) === '5×');
// Trailing zeros look like precision that is not there.
check('one decimal stays one', formatSpeed(1.5) === '1.5×');
check('two decimals stay two', formatSpeed(1.05) === '1.05×');
check('a quarter reads as a quarter', formatSpeed(0.25) === '0.25×');
check('every stop formats without a trailing zero',
  SPEEDS.every((speed) => !/\.\d*0×$/.test(formatSpeed(speed))));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
