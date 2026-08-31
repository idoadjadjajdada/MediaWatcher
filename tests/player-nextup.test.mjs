/**
 * When should the "up next" card appear?
 *
 * The old rule was a fraction of the running time (85%), which on a 22-minute
 * episode fires with 3m19s still to play — losing the ending and, for shows
 * like Rick and Morty, the post-credits scene as well. The rule has to be a
 * distance from the end, not a proportion of the whole.
 *
 * Run: npm test
 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ canPlayType: () => '' }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};

const { shouldOfferNext, secondsRemaining, shouldCountDown,
        NEXT_UP_LEAD_SECONDS, COUNTDOWN_WINDOW_SECONDS } =
  await import('../public/js/player.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

// Measured from the actual library: Rick and Morty episodes run ~22 minutes.
const EPISODE = 1321;      // 22m01s, S01E01
const FEATURE = 10800;     // a 3 hour film

console.log('\nshouldOfferNext');

check('does not fire at the old 85% point of an episode',
  shouldOfferNext(EPISODE, EPISODE * 0.85) === false);

check('does not fire with 3 minutes left',
  shouldOfferNext(EPISODE, EPISODE - 180) === false);

check('fires with 30 seconds left',
  shouldOfferNext(EPISODE, EPISODE - 30) === true);

check('fires exactly at the lead boundary',
  shouldOfferNext(EPISODE, EPISODE - NEXT_UP_LEAD_SECONDS) === true);

check('does not fire one second before the boundary',
  shouldOfferNext(EPISODE, EPISODE - NEXT_UP_LEAD_SECONDS - 1) === false);

check('still fires past the end',
  shouldOfferNext(EPISODE, EPISODE + 5) === true);

// The whole point of switching units: a percentage scales with the file, a
// distance from the end does not.
check('does not fire 27 minutes into the end of a 3 hour film',
  shouldOfferNext(FEATURE, FEATURE * 0.85) === false);

check('fires near the end of a 3 hour film',
  shouldOfferNext(FEATURE, FEATURE - 20) === true);

check('unknown duration never fires', shouldOfferNext(0, 100) === false);
check('NaN duration never fires', shouldOfferNext(NaN, 100) === false);
check('Infinite duration never fires', shouldOfferNext(Infinity, 100) === false);
check('negative position never fires', shouldOfferNext(EPISODE, -1) === false);

console.log('\nsecondsRemaining');
check('counts down in whole seconds', secondsRemaining(EPISODE, EPISODE - 30) === 30);
check('rounds a partial second up', secondsRemaining(EPISODE, EPISODE - 29.2) === 30);
check('floors at zero past the end', secondsRemaining(EPISODE, EPISODE + 10) === 0);
check('zero for an unknown duration', secondsRemaining(0, 5) === 0);

console.log('\nshouldCountDown');
check('no number a minute out', shouldCountDown(EPISODE, EPISODE - 60) === false);
check('no number at 11 seconds', shouldCountDown(EPISODE, EPISODE - 11) === false);
check('number at exactly 10 seconds', shouldCountDown(EPISODE, EPISODE - 10) === true);
check('number at 3 seconds', shouldCountDown(EPISODE, EPISODE - 3) === true);
check('number past the end', shouldCountDown(EPISODE, EPISODE + 5) === true);
check('no number for an unknown duration', shouldCountDown(0, 10) === false);
check('window is 10 seconds', COUNTDOWN_WINDOW_SECONDS === 10);
check('lead is a full minute', NEXT_UP_LEAD_SECONDS === 60);
check('the card is up well before the number starts',
  shouldOfferNext(EPISODE, EPISODE - 30) === true && shouldCountDown(EPISODE, EPISODE - 30) === false);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
