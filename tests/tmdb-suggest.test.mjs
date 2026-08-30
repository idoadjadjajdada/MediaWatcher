/**
 * Suggestion shaping. Integration test against live TMDB, matching the
 * approach in tests/search-resolution.test.mjs.
 *
 * Run: npm test
 */
import { toSuggestion, suggest } from '../services/tmdb.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ntoSuggestion');

const movieRaw = {
  id: 27205, media_type: 'movie', title: 'Inception',
  release_date: '2010-07-15', poster_path: '/x.jpg', popularity: 42.5
};
const movie = toSuggestion(movieRaw);
check('maps a movie id', movie.tmdb_id === 27205);
check('maps a movie type', movie.type === 'movie');
check('maps title from `title`', movie.title === 'Inception');
check('maps year from release_date', movie.year === 2010);
check('builds a poster url', typeof movie.poster === 'string' && movie.poster.includes('/x.jpg'));

const showRaw = {
  id: 60625, media_type: 'tv', name: 'Rick and Morty',
  first_air_date: '2013-12-02', poster_path: null, popularity: 99
};
const show = toSuggestion(showRaw);
check('maps tv to show', show.type === 'show');
check('maps title from `name`', show.title === 'Rick and Morty');
check('maps year from first_air_date', show.year === 2013);
check('null poster stays null', show.poster === null);

check('drops an entry with no title',
  toSuggestion({ id: 1, media_type: 'movie', release_date: '2020-01-01' }) === null);
check('drops a person', toSuggestion({ id: 1, media_type: 'person', name: 'Someone' }) === null);
check('handles a missing date', toSuggestion({ id: 2, media_type: 'movie', title: 'X' }).year === null);

console.log('\nsuggest');

const short = await suggest('i');
check('a one-character query returns nothing', Array.isArray(short) && short.length === 0);
check('an empty query returns nothing', (await suggest('')).length === 0);

const hits = await suggest('inception');
check('finds results for a real title', hits.length > 0);
check('respects the limit', (await suggest('the', 3)).length <= 3);
check('every entry carries the full shape', hits.every((entry) =>
  typeof entry.tmdb_id === 'number' &&
  (entry.type === 'movie' || entry.type === 'show') &&
  typeof entry.title === 'string' && entry.title.length > 0));
check('contains no people', hits.every((entry) => entry.type === 'movie' || entry.type === 'show'));
check('sorted by popularity, descending', hits.every((entry, index) =>
  index === 0 || hits[index - 1].popularity >= entry.popularity));

const rm = await suggest('rick and morty');
check('finds Rick and Morty as a show',
  rm.some((entry) => entry.tmdb_id === 60625 && entry.type === 'show'));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
