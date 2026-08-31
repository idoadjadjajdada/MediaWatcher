/**
 * Per-episode watch indicators on the show detail page.
 *
 * Run: node tests/watch-state.test.mjs
 */
import { watchState, progressByPath } from '../public/js/state.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nprogressByPath');
const index = progressByPath([
  { file_path: '/a.mkv', position: 300, duration: 1200, completed: 0 },
  { file_path: '/b.mkv', position: 1180, duration: 1200, completed: 1 }
]);
check('indexes by file path', index['/a.mkv'].position === 300);
check('keeps the completed flag', index['/b.mkv'].completed === 1);
check('an empty list gives an empty index', Object.keys(progressByPath([])).length === 0);
check('null gives an empty index', Object.keys(progressByPath(null)).length === 0);

console.log('\nwatchState');
const part = watchState({ position: 300, duration: 1200, completed: 0 });
check('a part-watched episode is started', part.started === true);
check('it is not marked watched', part.watched === false);
check('percent is position over duration', Math.abs(part.percent - 25) < 1e-9);
check('it reports the time left', part.remaining === 900);

const done = watchState({ position: 1180, duration: 1200, completed: 1 });
check('a completed episode is watched', done.watched === true);
check('a completed episode shows a full bar', done.percent === 100);

// A row can pass the 95% rule without the flag having been written yet.
const nearEnd = watchState({ position: 1150, duration: 1200, completed: 0 });
check('past 95% counts as watched even without the flag', nearEnd.watched === true);
check('94% is not watched yet',
  watchState({ position: 1128, duration: 1200, completed: 0 }).watched === false);

// Barely-started rows would put a sliver on every episode you merely opened.
const glance = watchState({ position: 3, duration: 1200, completed: 0 });
check('a few seconds in does not count as started', glance.started === false);
check('a glance has no percent', glance.percent === 0);

check('no row means never started', watchState(null).started === false);
check('no row is not watched', watchState(null).watched === false);
check('no row has no percent', watchState(null).percent === 0);
check('a zero duration does not divide by zero',
  watchState({ position: 30, duration: 0, completed: 0 }).percent === 0);
check('a zero duration still counts as started',
  watchState({ position: 30, duration: 0, completed: 0 }).started === true);
check('percent never exceeds 100',
  watchState({ position: 9999, duration: 1200, completed: 0 }).percent === 100);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
