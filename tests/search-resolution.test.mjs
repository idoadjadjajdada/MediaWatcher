/**
 * IMDB resolution for search.
 *
 * These are integration tests: they hit TMDB for real, because the whole point
 * is how TMDB responds to a title searched under the wrong media type. A stub
 * would encode the assumption under test.
 *
 * Run: npm test
 */
import { resolveImdbId } from '../services/torrentSearch.js';

let total = 0;
let failures = 0;

async function check(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`  [pass] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${error.message}`);
  }
}

function equal(actual, expected, because) {
  if (actual !== expected) {
    throw new Error(`${because}\n         expected: <${expected}>\n         actual:   <${actual}>`);
  }
}

console.log('\nresolveImdbId');

await check('resolves a movie searched as a movie', async () => {
  const result = await resolveImdbId({ query: 'Inception', type: 'movie' });
  equal(result.imdbId, 'tt1375666', 'Inception should resolve to its own IMDB id');
  equal(result.type, 'movie', 'and stay a movie');
});

await check('resolves a show searched as a show', async () => {
  const result = await resolveImdbId({ query: 'Rick and Morty', type: 'show' });
  equal(result.imdbId, 'tt2861424', 'Rick and Morty should resolve as a show');
  equal(result.type, 'show', 'and stay a show');
});

// The type selector defaults to "movie", so this is what a user gets by typing
// a show name and pressing Search. TMDB matches an unrelated film with no IMDB
// id, which leaves Torrentio with nothing to query.
await check('falls back to the other type when the chosen one has no IMDB id', async () => {
  const result = await resolveImdbId({ query: 'Rick and Morty', type: 'movie' });
  equal(result.imdbId, 'tt2861424', 'should fall back to the show match');
  equal(result.type, 'show', 'and report that it resolved as a show');
});

await check('honours an explicit tmdb id without re-searching', async () => {
  const result = await resolveImdbId({ tmdbId: 1396, type: 'show' });
  equal(result.imdbId, 'tt0903747', 'tmdb 1396 is Breaking Bad');
  equal(result.type, 'show', 'and the caller-supplied type wins');
});

await check('passes an explicit imdb id straight through', async () => {
  const result = await resolveImdbId({ imdbId: 'tt0111161', query: 'anything', type: 'movie' });
  equal(result.imdbId, 'tt0111161', 'an explicit IMDB id is used as-is');
});

await check('returns nulls rather than throwing for an unmatchable title', async () => {
  const result = await resolveImdbId({ query: 'zzqqxx not a real title at all', type: 'movie' });
  equal(result.imdbId, null, 'no IMDB id for a title TMDB cannot match');
  equal(result.tmdbId, null, 'and no TMDB id either');
});

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
