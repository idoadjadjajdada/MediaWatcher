/**
 * Finding the gaps in a season.
 *
 * The failure mode worth designing against is not a missed gap — it is a false
 * one. An episode that has not aired yet is not something you failed to
 * download, and counting it turns every currently-running show into a warning
 * that can never be cleared, which trains you to ignore the feature entirely.
 *
 * So the tests below lean on the boundary: an episode airing today has aired,
 * one airing tomorrow has not, and an episode with no date at all — TMDB
 * carries announced-but-unscheduled ones — is unaired rather than missing.
 *
 * Run: node tests/missing.test.mjs
 */
import { hasAired, compareSeason, isRealSeason, summariseShow } from '../services/missing.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

// A fixed "now" so the suite does not change behaviour depending on when it runs.
const NOW = Date.parse('2026-06-15T14:30:00');
const day = (offset) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const ep = (n, airDate, name = `Episode ${n}`) => ({ episode_number: n, name, air_date: airDate });
const held = (...numbers) => numbers.map((n) => ({ episode_number: n, files: [{ file_path: `x${n}.mkv` }] }));

console.log('\nhasAired');
check('yesterday has aired', hasAired(day(-1), NOW) === true);
// The boundary: an episode airing today is out, not pending.
check('today has aired', hasAired(day(0), NOW) === true);
check('tomorrow has not', hasAired(day(1), NOW) === false);
check('next year has not', hasAired('2030-01-01', NOW) === false);
check('long ago has aired', hasAired('1999-03-31', NOW) === true);
// Announced but unscheduled. Calling these missing is a permanent false alarm.
check('no date at all counts as unaired', hasAired(null, NOW) === false);
check('an empty date counts as unaired', hasAired('', NOW) === false);
check('a malformed date counts as unaired', hasAired('soon', NOW) === false);

console.log('\ncompareSeason — a complete season');
const complete = compareSeason(
  [ep(1, day(-30)), ep(2, day(-23)), ep(3, day(-16))],
  held(1, 2, 3),
  { now: NOW }
);
check('nothing is missing', complete.missing.length === 0);
check('it reports complete', complete.complete === true);
check('the held count is right', complete.held === 3);
check('the total is right', complete.total === 3);

console.log('\ncompareSeason — a gap');
const gap = compareSeason(
  [ep(1, day(-30)), ep(2, day(-23), 'The Missing One'), ep(3, day(-16))],
  held(1, 3),
  { now: NOW }
);
check('the gap is found', gap.missing.length === 1);
check('and identified by number', gap.missing[0].episode_number === 2);
check('with its title, so it can be searched for', gap.missing[0].title === 'The Missing One');
check('it does not report complete', gap.complete === false);
check('the held count excludes the gap', gap.held === 2);

console.log('\ncompareSeason — a show still airing');
const airing = compareSeason(
  [ep(1, day(-14)), ep(2, day(-7)), ep(3, day(0)), ep(4, day(7)), ep(5, day(14))],
  held(1, 2, 3),
  { now: NOW }
);
// The whole point: two future episodes must not read as two failures.
check('future episodes are not missing', airing.missing.length === 0);
check('they are reported separately as unaired', airing.unaired.length === 2);
check('a season that is up to date reads as complete', airing.complete === true);
check('today\'s episode counted as held, not unaired',
  !airing.unaired.some((e) => e.episode_number === 3));

const airingWithGap = compareSeason(
  [ep(1, day(-14)), ep(2, day(-7)), ep(3, day(7))],
  held(1),
  { now: NOW }
);
check('a real gap is still found alongside unaired ones',
  airingWithGap.missing.length === 1 && airingWithGap.missing[0].episode_number === 2);
check('and the future episode stays unaired', airingWithGap.unaired.length === 1);

console.log('\ncompareSeason — edge cases');
check('an empty file list is a gap, not a hold',
  compareSeason([ep(1, day(-5))], [{ episode_number: 1, files: [] }], { now: NOW }).missing.length === 1);
check('an episode with files but no TMDB entry is simply not reported',
  compareSeason([], held(1, 2), { now: NOW }).missing.length === 0);
check('no TMDB episodes at all is not a season of gaps',
  compareSeason(null, held(1), { now: NOW }).missing.length === 0);
check('no library season at all reports every aired episode',
  compareSeason([ep(1, day(-5)), ep(2, day(-2))], null, { now: NOW }).missing.length === 2);
check('a non-numeric episode number is ignored rather than crashing',
  compareSeason([{ episode_number: 'special', name: 'x' }], held(1), { now: NOW }).missing.length === 0);
check('missing episodes come back in order',
  compareSeason([ep(5, day(-5)), ep(2, day(-9)), ep(9, day(-1))], [], { now: NOW })
    .missing.map((e) => e.episode_number).join(',') === '2,5,9');

console.log('\nisRealSeason');
// Season 0 is specials and featurettes; counting them makes everything look
// incomplete forever.
check('season 0 is excluded', isRealSeason(0) === false);
check('season 1 is included', isRealSeason(1) === true);
check('season 12 is included', isRealSeason(12) === true);
check('a missing number is excluded', isRealSeason(null) === false);
check('nonsense is excluded', isRealSeason('specials') === false);

console.log('\nsummariseShow');
const summary = summariseShow([
  { season: 1, missing: [{ episode_number: 2 }], unaired: [] },
  { season: 2, missing: [], unaired: [{ episode_number: 9 }] },
  { season: 3, missing: [{ episode_number: 1 }, { episode_number: 4 }], unaired: [] }
]);
check('missing episodes are totalled', summary.missingCount === 3);
check('unaired are counted separately', summary.unairedCount === 1);
check('seasons with gaps are counted, not episodes', summary.seasonsWithGaps === 2);
check('a show with any gap is not complete', summary.complete === false);
check('a show with only unaired episodes is complete',
  summariseShow([{ season: 1, missing: [], unaired: [{ episode_number: 3 }] }]).complete === true);
check('a show with no seasons is complete', summariseShow([]).complete === true);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
