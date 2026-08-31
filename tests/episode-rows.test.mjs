/**
 * Episode sidebar rows.
 *
 * Run: node tests/episode-rows.test.mjs
 */
import { episodeRows, seasonNumbers } from '../public/js/state.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const show = {
  title: 'Rick and Morty',
  seasons: [
    { number: 2, episodes: [
      { episode_number: 2, title: 'Mortynight Run', files: [{ file_path: '/lib/s2e2.mkv' }] },
      { episode_number: 1, title: 'A Rickle in Time', files: [{ file_path: '/lib/s2e1.mkv' }] },
      { episode_number: 3, title: 'Auto Erotic', files: [] }
    ] },
    { number: 1, episodes: [
      { episode_number: 1, title: 'Pilot', files: [{ file_path: '/lib/s1e1.mkv' }] }
    ] },
    { number: 3, episodes: [] }
  ]
};

console.log('\nseasonNumbers');
check('sorts ascending', JSON.stringify(seasonNumbers(show)) === '[1,2,3]');
check('a show with no seasons gives an empty list', seasonNumbers({}).length === 0);
check('a null show gives an empty list', seasonNumbers(null).length === 0);

console.log('\nepisodeRows');
const s2 = episodeRows(show, 2, 2, 2);
check('returns every episode of the season', s2.length === 3);
check('sorts by episode number', s2.map((r) => r.episode_number).join(',') === '1,2,3');
check('carries the season number', s2.every((r) => r.season === 2));
check('carries the title', s2[0].title === 'A Rickle in Time');
check('carries the file path', s2[0].filePath === '/lib/s2e1.mkv');

check('an episode with a file is playable', s2[0].playable === true);
check('an episode with no file is not playable', s2[2].playable === false);
check('an episode with no file has a null path', s2[2].filePath === null);

check('marks the current episode', s2[1].current === true);
check('does not mark the others', s2[0].current === false && s2[2].current === false);

// The current episode is S02E02, so nothing in season 1 may be marked -
// matching on episode number alone would light up S01E01 against S02E01.
const s1 = episodeRows(show, 1, 2, 1);
check('does not mark a same-numbered episode in another season', s1[0].current === false);

check('an empty season gives an empty list', episodeRows(show, 3, 2, 2).length === 0);
check('an unknown season gives an empty list', episodeRows(show, 99, 2, 2).length === 0);
check('a null show gives an empty list', episodeRows(null, 1, 1, 1).length === 0);
check('every row carries the full shape', s2.every((row) =>
  typeof row.season === 'number' &&
  typeof row.episode_number === 'number' &&
  typeof row.title === 'string' &&
  (row.filePath === null || typeof row.filePath === 'string') &&
  typeof row.playable === 'boolean' &&
  typeof row.current === 'boolean'));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
