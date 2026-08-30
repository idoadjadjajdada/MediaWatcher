/**
 * Discovery rails. Integration test against live TMDB and the real database,
 * matching the approach in tests/search-resolution.test.mjs.
 *
 * Run: npm test
 */
import { readDiscover, writeDiscover } from '../db/index.js';
import { toRailItem, markOwned, getRails } from '../services/discover.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ndiscover_cache');

const key = `test:${Date.now()}`;
check('a missing key reads as undefined', readDiscover(key, 60000) === undefined);

writeDiscover(key, { rails: [1, 2, 3] });
const stored = readDiscover(key, 60000);
check('a written payload reads back', stored && stored.rails.length === 3);

check('an expired entry reads as undefined', readDiscover(key, -1) === undefined);
check('a zero TTL expires immediately', readDiscover(key, 0) === undefined);

writeDiscover(key, { rails: ['replaced'] });
check('writing the same key replaces it', readDiscover(key, 60000).rails[0] === 'replaced');

console.log('\ntoRailItem');

const rawMovie = {
  id: 27205, title: 'Inception', release_date: '2010-07-15',
  poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 8.367,
  overview: 'A thief...', popularity: 42
};
const movie = toRailItem(rawMovie, 'movie');
check('maps the id', movie.tmdb_id === 27205);
check('carries the type it was told', movie.type === 'movie');
check('maps title', movie.title === 'Inception');
check('maps year', movie.year === 2010);
check('rounds the rating', movie.rating === 8.4);
check('builds a poster url', typeof movie.poster === 'string' && movie.poster.includes('/p.jpg'));

// Rail endpoints carry no media_type, so the type must come from the caller.
const rawShow = {
  id: 60625, name: 'Rick and Morty', first_air_date: '2013-12-02',
  poster_path: null, backdrop_path: null, vote_average: 8.7, overview: '', popularity: 99
};
const showItem = toRailItem(rawShow, 'show');
check('maps a show title from `name`', showItem.title === 'Rick and Morty');
check('maps a show year from first_air_date', showItem.year === 2013);
check('null poster stays null', showItem.poster === null);

check('drops an entry with no title', toRailItem({ id: 1, release_date: '2020-01-01' }, 'movie') === null);
check('drops a null result', toRailItem(null, 'movie') === null);

console.log('\nmarkOwned');

const rails = [{ id: 'r', title: 'R', items: [
  { tmdb_id: 60625, type: 'show', title: 'Rick and Morty' },
  { tmdb_id: 27205, type: 'movie', title: 'Inception' }
] }];
const marked = markOwned(rails, new Set([60625]));
check('marks a library title as owned', marked[0].items[0].owned === true);
check('leaves the rest unowned', marked[0].items[1].owned === false);
check('every item gets a boolean', marked[0].items.every((i) => typeof i.owned === 'boolean'));

console.log('\ngetRails');

const built = await getRails({ force: true });
check('returns an array of rails', Array.isArray(built) && built.length > 0);
check('every rail has an id and a title',
  built.every((rail) => typeof rail.id === 'string' && typeof rail.title === 'string'));
check('every rail has items', built.every((rail) => Array.isArray(rail.items) && rail.items.length > 0));
check('no rail exceeds 20 items', built.every((rail) => rail.items.length <= 20));
check('includes the recent rail', built.some((rail) => rail.id === 'recent'));
check('includes the top rated rail', built.some((rail) => rail.id === 'top'));
check('every item carries the full shape', built.every((rail) => rail.items.every((item) =>
  typeof item.tmdb_id === 'number' &&
  (item.type === 'movie' || item.type === 'show') &&
  typeof item.title === 'string' && item.title.length > 0 &&
  typeof item.owned === 'boolean')));

const cached = await getRails({});
check('a second call is served from cache', Array.isArray(cached) && cached.length === built.length);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
