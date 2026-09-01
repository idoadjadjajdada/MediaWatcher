/**
 * Sleep timer.
 *
 * The failure that matters is stopping the show while someone is still
 * watching, so the decision is a pure function of the clock and the position
 * and is tested without waiting for real minutes to pass.
 *
 * Run: node tests/sleep.test.mjs
 */
import {
  SLEEP_OPTIONS, remainingMs, shouldSleep, createTimer, timerLabel
} from '../public/js/sleep.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const NOW = 1_700_000_000_000;
const MIN = 60_000;

console.log('\ncreateTimer');
check('off creates nothing', createTimer('off', NOW) === null);
check('an unknown option creates nothing', createTimer('nonsense', NOW) === null);
check('15 minutes ends 15 minutes out',
  createTimer('15', NOW).endsAt === NOW + (15 * MIN));
check('an hour ends an hour out', createTimer('60', NOW).endsAt === NOW + (60 * MIN));
check('a duration timer knows what it is', createTimer('30', NOW).kind === 'duration');
check('end of episode is not a duration', createTimer('episode', NOW).kind === 'episode');
check('end of episode has no clock deadline',
  createTimer('episode', NOW).endsAt === undefined);

console.log('\nshouldSleep - duration');
const fifteen = createTimer('15', NOW);
check('does not fire immediately',
  shouldSleep(fifteen, { now: NOW, position: 10, duration: 1400 }) === false);
check('does not fire a minute before',
  shouldSleep(fifteen, { now: NOW + (14 * MIN), position: 10, duration: 1400 }) === false);
check('fires on time',
  shouldSleep(fifteen, { now: NOW + (15 * MIN), position: 10, duration: 1400 }) === true);
check('fires after its time',
  shouldSleep(fifteen, { now: NOW + (20 * MIN), position: 10, duration: 1400 }) === true);
// The clock decides, not the position: that is the whole point of a duration.
check('fires regardless of where playback is',
  shouldSleep(fifteen, { now: NOW + (15 * MIN), position: 5, duration: 7200 }) === true);

console.log('\nshouldSleep - end of episode');
const episode = createTimer('episode', NOW);
check('does not fire at the start',
  shouldSleep(episode, { now: NOW, position: 0, duration: 1400 }) === false);
check('does not fire in the middle',
  shouldSleep(episode, { now: NOW, position: 700, duration: 1400 }) === false);
check('does not fire a minute out',
  shouldSleep(episode, { now: NOW, position: 1340, duration: 1400 }) === false);
check('fires at the end',
  shouldSleep(episode, { now: NOW, position: 1399.5, duration: 1400 }) === true);
check('fires past the end',
  shouldSleep(episode, { now: NOW, position: 1400, duration: 1400 }) === true);
// A stream whose duration is not known yet must not be treated as finished.
check('an unknown duration never fires',
  shouldSleep(episode, { now: NOW, position: 10, duration: 0 }) === false);
check('a non-finite duration never fires',
  shouldSleep(episode, { now: NOW, position: 10, duration: Infinity }) === false);
check('a non-finite position never fires',
  shouldSleep(episode, { now: NOW, position: NaN, duration: 1400 }) === false);
// Hours of wall clock must not end an episode that is barely started.
check('time passing does not end an episode',
  shouldSleep(episode, { now: NOW + (600 * MIN), position: 30, duration: 1400 }) === false);

console.log('\nno timer');
check('nothing set never fires',
  shouldSleep(null, { now: NOW, position: 1400, duration: 1400 }) === false);
check('nothing set has no remaining time', remainingMs(null, NOW) === null);

console.log('\nremainingMs');
check('counts down', remainingMs(fifteen, NOW + (5 * MIN)) === 10 * MIN);
check('never goes negative', remainingMs(fifteen, NOW + (99 * MIN)) === 0);
check('an episode timer has no countdown', remainingMs(episode, NOW) === null);

console.log('\ntimerLabel');
check('off reads as off', timerLabel(null, NOW) === 'Off');
check('an episode timer names itself', timerLabel(episode, NOW) === 'End of episode');
check('a duration counts down in minutes',
  timerLabel(fifteen, NOW + (5 * MIN)) === '10 min left');
check('one minute is singular',
  timerLabel(fifteen, NOW + (14 * MIN) + 30_000) === '1 min left');
check('an expired timer says now', timerLabel(fifteen, NOW + (15 * MIN)) === 'Now');

console.log('\noptions');
check('there are five', SLEEP_OPTIONS.length === 5);
check('off is first', SLEEP_OPTIONS[0].id === 'off');
check('every option has a label', SLEEP_OPTIONS.every((o) => o.label.length > 0));
check('every id is unique', new Set(SLEEP_OPTIONS.map((o) => o.id)).size === SLEEP_OPTIONS.length);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
