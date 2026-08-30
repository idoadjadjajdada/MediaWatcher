/**
 * IMDB resolution for search.
 *
 * These are integration tests: they hit TMDB for real, because the whole point
 * is how TMDB responds to a title searched under the wrong media type. A stub
 * would encode the assumption under test.
 *
 * Run: npm test
 */
import { resolveImdbId, queryVariants } from '../services/torrentSearch.js';

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

await check('prefers a movie over a show for a film title with punctuation', async () => {
  const result = await resolveImdbId({ query: 'spider-man', type: 'movie' });
  equal(result.type, 'movie', 'spider-man is a film, not a series');
});

// The top TMDB movie hit for this is an unreleased film with no IMDB id. The
// resolver must walk to the next movie rather than jumping to television.
await check('walks past a candidate with no IMDB id instead of switching type', async () => {
  const result = await resolveImdbId({ query: 'spiderman', type: 'movie' });
  equal(result.type, 'movie', 'should stay a movie');
  equal(typeof result.imdbId === 'string' && result.imdbId.startsWith('tt'), true,
    'and should still find an IMDB id');
});

console.log('\nqueryVariants');

const variantsOf = (input) => queryVariants(input);

// These are synchronous, but check() takes a function, so each is wrapped.
await check('keeps the query as typed first', async () => {
  equal(variantsOf('Rick and Morty')[0], 'Rick and Morty', 'the typed query is tried first');
});

await check('strips punctuation into a variant', async () => {
  equal(variantsOf('spider-man').includes('spider man'), true, 'hyphen becomes a space');
});

await check('splits run-together words', async () => {
  equal(variantsOf('rickandmorty').includes('rick and morty'), true, 'embedded "and" is split out');
});

await check('splits a leading joiner', async () => {
  equal(variantsOf('thematrix').includes('the matrix'), true, 'leading "the" is split out');
});

await check('drops a trailing word', async () => {
  equal(variantsOf('rick and mortey').includes('rick and'), true, 'the bad trailing word is dropped');
});

await check('never degrades to a single short token', async () => {
  equal(variantsOf('rick and mortey').every((v) => v.length >= 4), true, 'no variant shorter than four characters');
});

await check('de-duplicates', async () => {
  const variants = variantsOf('Inception');
  equal(new Set(variants.map((v) => v.toLowerCase())).size, variants.length, 'no repeated variants');
});

await check('an empty query yields nothing', async () => {
  equal(variantsOf('').length, 0, 'nothing to try');
});

await check('a one-character query yields nothing', async () => {
  equal(variantsOf('a').length, 0, 'too short to be a title');
});

await check('does not mangle a query that already has spaces', async () => {
  equal(variantsOf('rick and morty').includes('rick  and  morty'), false, 'no double spacing');
});

await check('separates lossy variants from meaning-preserving ones', async () => {
  const safe = queryVariants('Rick and Morty', { includeLossy: false });
  const all = queryVariants('Rick and Morty');
  equal(safe.includes('Rick and'), false, 'truncation is not a safe variant');
  equal(all.includes('Rick and'), true, 'but it is still available as a last resort');
});

await check('resolves a run-together title', async () => {
  const result = await resolveImdbId({ query: 'rickandmorty', type: 'show' });
  equal(result.imdbId, 'tt2861424', 'rickandmorty should reach Rick and Morty');
});

await check('resolves a title with a wrong trailing word', async () => {
  const result = await resolveImdbId({ query: 'rick and mortey', type: 'show' });
  equal(result.imdbId, 'tt2861424', 'trailing-word removal should reach it');
});

// Spacing is not a meaningful difference between titles. Without this, TMDB's
// results for "thematrix" rank a stray file name above The Matrix, because the
// file name starts with the query while "the matrix" does not equal it.
await check('ignores spacing when scoring a title match', async () => {
  const result = await resolveImdbId({ query: 'thematrix', type: 'movie' });
  equal(result.imdbId, 'tt0133093', 'thematrix should reach The Matrix (1999)');
});

// Documents the known limitation rather than pretending it is fixed: a
// misspelling inside a word has no valid variant, and autocomplete is what
// covers that case.
await check('a misspelling inside a word still finds nothing', async () => {
  const result = await resolveImdbId({ query: 'inceptoin', type: 'movie' });
  equal(result.imdbId, null, 'no variant of inceptoin is a real title');
});

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
