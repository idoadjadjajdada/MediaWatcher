# Title Resolution (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make search find the right title without exact spelling — a suggestion dropdown that searches by TMDB id, plus a retry ladder and same-type preference for typed queries.

**Architecture:** All resolution funnels through one exported function, `resolveImdbId` in `services/torrentSearch.js`. It gains two orthogonal improvements: a list of query *variants* to try (pure, testable, no network) and a walk down ranked *candidates* within the requested media type before ever switching type. Separately, a new `/api/search/suggest` endpoint backed by TMDB `/search/multi` feeds a dropdown that sets a `tmdb_id`, which bypasses title matching entirely.

**Tech Stack:** Node 20+ (ESM), Express 4, axios, vanilla ES modules on the front end. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-discovery-and-title-resolution-design.md` (Phase A only; Phase B is a separate plan)

## Global Constraints

- **No new npm dependencies.** `package.json` dependencies are unchanged.
- **Tests are integration tests against live TMDB**, run with plain `node`, matching `tests/search-resolution.test.mjs`. A stub would encode the very assumptions under test. They need `TMDB_API_KEY` in `.env`, which is present.
- **`npm test` must run every test file** and exit non-zero if any fails.
- **TMDB vocabulary is normalised at the boundary.** TMDB says `tv`, `name`, `first_air_date`; this app says `type: 'show'`, `title`, `year`. Nothing downstream of `services/tmdb.js` sees TMDB's field names.
- **An explicit `tmdb_id` or `imdb_id` is authoritative** and is never second-guessed by the ladder.
- **Known limitation, do not attempt to fix:** the ladder cannot repair a misspelling *inside* a word (`inceptoin`, `the matrx`). Autocomplete covers those. A test documents this rather than asserting a fix.
- **Frontend is ES modules with no build step.** No JSX, no bundler, no framework.
- **The search page currently sends `q`, `type`, `season`, `episode`.** Adding `tmdb_id` requires no server change: `routes/torrents.js` already reads `req.query.tmdb_id`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `services/tmdb.js` | TMDB client. Gains multi-search, ranked candidate lists, and suggestion shaping. | Modify |
| `services/torrentSearch.js` | Source registry and resolution. `resolveImdbId` gains variants + candidate walk. | Modify |
| `routes/torrents.js` | Already owns `/api/search`. Gains `/api/search/suggest`. | Modify |
| `public/js/api.js` | Fetch wrappers. Gains `suggest()`. | Modify |
| `public/js/state.js` | Search slice gains `tmdbId` and `suggestions`. | Modify |
| `public/js/search.js` | Renders the dropdown; `runSearch` sends `tmdb_id`. | Modify |
| `public/js/app.js` | Debounced input handler, keyboard nav, selection action. | Modify |
| `public/css/styles.css` | Dropdown styling. | Modify |
| `tests/tmdb-suggest.test.mjs` | Suggestion shaping and endpoint contract. | Create |
| `tests/search-resolution.test.mjs` | Extended with variant, candidate-walk and regression cases. | Modify |
| `package.json` | `test` script runs all four suites. | Modify |

---

## Task 1: TMDB multi-search and suggestions

**Files:**
- Modify: `services/tmdb.js`
- Modify: `routes/torrents.js`
- Create: `tests/tmdb-suggest.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `memo`, `normalize`, `request`, `posterUrl` in `services/tmdb.js`
- Produces:
  - `searchMulti(query)` → `Promise<Array>` of raw TMDB results (memoised 10 min)
  - `toSuggestion(result)` → `{ tmdb_id, type: 'movie'|'show', title, year, poster, popularity }` or `null`
  - `suggest(query, limit = 8)` → `Promise<Array<Suggestion>>`, `[]` for queries under 2 characters
  - `GET /api/search/suggest?q=&limit=` → JSON array of suggestions

- [ ] **Step 1: Write the failing test**

Create `tests/tmdb-suggest.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/tmdb-suggest.test.mjs`

Expected: FAIL — `SyntaxError: The requested module '../services/tmdb.js' does not provide an export named 'toSuggestion'`.

- [ ] **Step 3: Add the implementation to `services/tmdb.js`**

Insert after the existing `searchShows` function:

```javascript
/**
 * Combined movie + TV search, used by the suggestion dropdown.
 * Volatile like the other searches, so it shares the 10-minute memo cache.
 */
export function searchMulti(query) {
  return memo(`multi:${normalize(query)}`, async () => {
    const data = await request('/search/multi', { query, include_adult: false });
    return data.results || [];
  });
}

/**
 * Normalise one TMDB search hit into this app's vocabulary.
 *
 * TMDB calls television `tv` and carries its name in `name`/`first_air_date`,
 * while films use `title`/`release_date`. Everything downstream sees only
 * `type: 'show'`, `title` and `year`.
 *
 * Returns null for people and for entries with no usable title.
 */
export function toSuggestion(result) {
  if (!result) return null;
  if (result.media_type !== 'movie' && result.media_type !== 'tv') return null;

  const type = result.media_type === 'tv' ? 'show' : 'movie';
  const title = type === 'show' ? result.name : result.title;
  if (!title) return null;

  const released = type === 'show' ? result.first_air_date : result.release_date;
  const year = released ? (Number(String(released).slice(0, 4)) || null) : null;

  return {
    tmdb_id: result.id,
    type,
    title,
    year,
    poster: posterUrl(result.poster_path),
    popularity: Number(result.popularity) || 0
  };
}

/**
 * Suggestions for the search box, most popular first.
 *
 * A query under two characters is answered locally rather than spending a
 * TMDB call on something that would match half the catalogue.
 */
export async function suggest(query, limit = 8) {
  const term = String(query || '').trim();
  if (term.length < 2) return [];

  const results = await searchMulti(term);
  return results
    .map(toSuggestion)
    .filter(Boolean)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, limit);
}
```

Add `searchMulti`, `toSuggestion` and `suggest` to the `export default { ... }` object at the bottom of the file, alongside the existing `searchMovies` and `searchShows` entries.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/tmdb-suggest.test.mjs`

Expected: PASS — `19 checks, all passed`.

- [ ] **Step 5: Add the route**

In `routes/torrents.js`, immediately **before** the existing `router.get('/search', wrap(searchHandler));` line:

```javascript
/**
 * GET /api/search/suggest?q=&limit=
 * Titles for the search box dropdown. Never fails the caller: a TMDB outage
 * closes the dropdown rather than blocking the search box.
 */
router.get('/search/suggest', wrap(async (req, res) => {
  const query = String(req.query.q || '').trim();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));

  try {
    res.json(await tmdb.suggest(query, limit));
  } catch (error) {
    log.warn(`suggest "${query}" failed: ${error.message}`);
    res.json([]);
  }
}));
```

Add the import at the top of the file, beside the existing service imports:

```javascript
import * as tmdb from '../services/tmdb.js';
```

- [ ] **Step 6: Verify the endpoint against the running server**

Run:

```bash
node server.js &
sleep 5
curl -s "http://127.0.0.1:3000/api/search/suggest?q=rick%20and%20morty&limit=3"
curl -s "http://127.0.0.1:3000/api/search/suggest?q=i"
```

Expected: the first prints a JSON array of up to 3 objects, the first of which
has `"title":"Rick and Morty"` and `"type":"show"`. The second prints `[]`.

Stop the server afterwards — do not leave it holding port 3000:

```bash
taskkill //F //IM node.exe
```

- [ ] **Step 7: Wire the new suite into `npm test`**

In `package.json`, set the `test` script to:

```json
"test": "node tests/search-resolution.test.mjs && node tests/tmdb-suggest.test.mjs && node tests/player-nextup.test.mjs"
```

Run: `npm test`

Expected: all three suites pass, exit 0.

- [ ] **Step 8: Commit**

```bash
git add services/tmdb.js routes/torrents.js tests/tmdb-suggest.test.mjs package.json
git commit -m "feat(search): add TMDB multi-search and a suggestion endpoint"
```

---

## Task 2: Prefer the requested media type

Fixes the live regression: `spiderman` resolves to a television series because the top movie hit is an unreleased film with no IMDB id, and the code switches media type instead of trying the next movie.

**Files:**
- Modify: `services/tmdb.js`
- Modify: `services/torrentSearch.js`
- Modify: `tests/search-resolution.test.mjs`

**Interfaces:**
- Consumes: `getImdbId(tmdbId, type)` from `services/tmdb.js`
- Produces:
  - `rankMovies(title, year)` → `Promise<Array>` of TMDB candidates, best match first
  - `rankShows(title, year)` → same for television
  - `findBestMovie` / `findBestShow` keep their current signatures and behaviour

- [ ] **Step 1: Write the failing test**

Append to `tests/search-resolution.test.mjs`, immediately before the final
`console.log('')` and exit block:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/search-resolution.test.mjs`

Expected: FAIL on `walks past a candidate with no IMDB id instead of switching type` —
`expected: <movie>  actual: <show>`.

- [ ] **Step 3: Expose ranked candidates from `services/tmdb.js`**

Replace the existing `bestOf`, `findBestMovie` and `findBestShow` block with:

```javascript
/** Every candidate, best match first. */
function rankAll(results, title, year) {
  if (!results || results.length === 0) return [];
  return results
    .map((candidate) => ({ candidate, score: matchScore(candidate, title, year) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);
}

/** Ranked movie candidates for a parsed filename or free-text query. */
export async function rankMovies(title, year) {
  let results = await searchMovies(title, year);
  // A wrong year in the filename shouldn't sink the lookup.
  if (results.length === 0 && year) results = await searchMovies(title);
  return rankAll(results, title, year);
}

/** Ranked show candidates. */
export async function rankShows(title, year) {
  let results = await searchShows(title, year);
  if (results.length === 0 && year) results = await searchShows(title);
  return rankAll(results, title, year);
}

/** Best movie match for a parsed filename, or null. */
export async function findBestMovie(title, year) {
  return (await rankMovies(title, year))[0] ?? null;
}

/** Best show match for a parsed filename, or null. */
export async function findBestShow(title, year) {
  return (await rankShows(title, year))[0] ?? null;
}
```

Add `rankMovies` and `rankShows` to the `export default { ... }` object at the
bottom of the file.

- [ ] **Step 4: Walk candidates in `services/torrentSearch.js`**

Change the import at the top of the file from:

```javascript
import { getImdbId, findBestMovie, findBestShow } from './tmdb.js';
```

to:

```javascript
import { getImdbId, rankMovies, rankShows } from './tmdb.js';
```

Then replace the `attempt` helper inside `resolveImdbId` with:

```javascript
    /**
     * First candidate of this media type that actually has an IMDB id.
     *
     * TMDB will return unreleased or obscure entries with no IMDB id on file;
     * taking only the top hit and giving up made "spiderman" resolve to a
     * television series. Five is enough to clear those without turning one
     * search into a dozen round trips.
     */
    const attempt = async (kind) => {
      const candidates = kind === 'show' ? await rankShows(query) : await rankMovies(query);
      for (const candidate of candidates.slice(0, 5)) {
        const imdb = await getImdbId(candidate.id, kind);
        if (imdb) return { tmdbId: candidate.id, imdbId: imdb, type: kind };
      }
      return null;
    };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/search-resolution.test.mjs`

Expected: PASS — every check green, including both new ones.

- [ ] **Step 6: Confirm nothing else regressed**

Run: `npm test`

Expected: all three suites pass.

- [ ] **Step 7: Commit**

```bash
git add services/tmdb.js services/torrentSearch.js tests/search-resolution.test.mjs
git commit -m "fix(search): walk same-type candidates before changing media type"
```

---

## Task 3: Query variant ladder

**Files:**
- Modify: `services/torrentSearch.js`
- Modify: `tests/search-resolution.test.mjs`

**Interfaces:**
- Consumes: `attempt(kind)` from Task 2
- Produces: `queryVariants(raw)` → `string[]`, ordered, de-duplicated, never empty for a usable input

- [ ] **Step 1: Write the failing test**

Add to the top of `tests/search-resolution.test.mjs`, beside the existing import:

```javascript
import { resolveImdbId, queryVariants } from '../services/torrentSearch.js';
```

(replacing the current `import { resolveImdbId } from '../services/torrentSearch.js';`)

Then append these checks before the final exit block:

```javascript
console.log('\nqueryVariants');

const variantsOf = (input) => queryVariants(input);

check('keeps the query as typed first',
  variantsOf('Rick and Morty')[0] === 'Rick and Morty');

check('strips punctuation into a variant',
  variantsOf('spider-man').includes('spider man'));

check('splits run-together words',
  variantsOf('rickandmorty').includes('rick and morty'));

check('splits a leading joiner',
  variantsOf('thematrix').includes('the matrix'));

check('drops a trailing word',
  variantsOf('rick and mortey').includes('rick and'));

check('never degrades to a single short token',
  variantsOf('rick and mortey').every((v) => v.length >= 4));

check('de-duplicates',
  new Set(variantsOf('Inception').map((v) => v.toLowerCase())).size ===
  variantsOf('Inception').length);

check('an empty query yields nothing', variantsOf('').length === 0);
check('a one-character query yields nothing', variantsOf('a').length === 0);
check('does not split a query that already has spaces',
  !variantsOf('rick and morty').includes('rick  and  morty'));
```

And these resolution checks, which exercise the ladder end to end:

```javascript
await check('resolves a run-together title', async () => {
  const result = await resolveImdbId({ query: 'rickandmorty', type: 'show' });
  equal(result.imdbId, 'tt2861424', 'rickandmorty should reach Rick and Morty');
});

await check('resolves a title with a wrong trailing word', async () => {
  const result = await resolveImdbId({ query: 'rick and mortey', type: 'show' });
  equal(result.imdbId, 'tt2861424', 'trailing-word removal should reach it');
});

// Documents the known limitation rather than pretending it is fixed: a
// misspelling inside a word has no valid variant, and autocomplete is what
// covers that case.
await check('a misspelling inside a word still finds nothing', async () => {
  const result = await resolveImdbId({ query: 'inceptoin', type: 'movie' });
  equal(result.imdbId, null, 'no variant of inceptoin is a real title');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/search-resolution.test.mjs`

Expected: FAIL — `SyntaxError: The requested module '../services/torrentSearch.js' does not provide an export named 'queryVariants'`.

- [ ] **Step 3: Implement `queryVariants`**

Insert into `services/torrentSearch.js`, immediately before `resolveImdbId`:

```javascript
// Words that commonly get swallowed when a title is typed without spaces.
// Ordered longest-first so "and" wins before "an" can split it badly.
const JOINERS = ['and', 'the', 'of', 'an', 'in', 'on'];

/**
 * Re-insert a space around the first joiner found in a run-together title:
 * "rickandmorty" -> "rick and morty", "thematrix" -> "the matrix".
 * Returns the input unchanged when nothing sensible can be split.
 */
function splitJoined(text) {
  const lower = text.toLowerCase();

  for (const word of JOINERS) {
    if (lower.startsWith(word) && lower.length > word.length + 2) {
      return `${word} ${lower.slice(word.length)}`;
    }
    const at = lower.indexOf(word, 1);
    if (at > 0 && at + word.length < lower.length) {
      return `${lower.slice(0, at)} ${word} ${lower.slice(at + word.length)}`;
    }
  }
  return text;
}

/**
 * Query variants to try, in order, stopping at the first that resolves.
 *
 * TMDB does no fuzzy matching at all — one wrong character returns an empty
 * list — so a typed query gets a few deliberate re-shapings rather than one
 * take-it-or-leave-it lookup.
 *
 * This fixes run-together words, stray punctuation, and wrong or extra
 * trailing words. It cannot fix a misspelling *inside* a word: "inceptoin"
 * has no valid variant. The suggestion dropdown covers that case.
 */
export function queryVariants(raw) {
  const seen = new Set();
  const variants = [];

  const push = (value) => {
    const cleaned = String(value || '').trim().replace(/\s+/g, ' ');
    if (cleaned.length < 2) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(cleaned);
  };

  const original = String(raw || '').trim();
  if (original.length < 2) return [];

  push(original);
  push(original.replace(/[^\p{L}\p{N}]+/gu, ' '));

  if (!/\s/.test(original) && original.length > 8) {
    push(splitJoined(original));
  }

  // Drop trailing words one at a time, down to a floor of two tokens and four
  // characters so a query can never degrade to something like "the".
  const tokens = original.replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/);
  for (let count = tokens.length - 1; count >= 2; count -= 1) {
    const candidate = tokens.slice(0, count).join(' ');
    if (candidate.length < 4) break;
    push(candidate);
  }

  return variants;
}
```

- [ ] **Step 4: Use the ladder in `resolveImdbId`**

Replace the body between the `if (!query) return ...` guard and the `catch`
block with:

```javascript
    if (!query) return { tmdbId: null, imdbId: null, type: wanted };

    const attempt = async (kind, term) => {
      const candidates = kind === 'show' ? await rankShows(term) : await rankMovies(term);
      for (const candidate of candidates.slice(0, 5)) {
        const imdb = await getImdbId(candidate.id, kind);
        if (imdb) return { tmdbId: candidate.id, imdbId: imdb, type: kind };
      }
      return null;
    };

    const variants = queryVariants(query);
    const other = wanted === 'show' ? 'movie' : 'show';

    // Exhaust every variant of the requested type before changing type, so an
    // explicit Movie/Show choice is respected as far as it possibly can be.
    for (const kind of [wanted, other]) {
      for (const variant of variants) {
        const hit = await attempt(kind, variant);
        if (hit) {
          if (variant !== query) {
            log.info(`"${query}" resolved as "${variant}"`);
          }
          if (kind !== wanted) {
            log.info(`"${query}" did not resolve as a ${wanted}; using the ${other} match instead`);
          }
          return hit;
        }
      }
    }
```

Note the `attempt` helper now takes the term as a parameter — this supersedes
the version added in Task 2, which closed over `query`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/search-resolution.test.mjs`

Expected: PASS, including `resolves a run-together title` and `resolves a
title with a wrong trailing word`.

- [ ] **Step 6: Confirm the whole suite and a real search**

Run: `npm test`

Expected: all three suites pass.

Then:

```bash
node server.js &
sleep 5
curl -s "http://127.0.0.1:3000/api/search?q=rickandmorty&type=show&season=9&episode=1" | head -c 200
taskkill //F //IM node.exe
```

Expected: a JSON body whose `imdb_id` is `tt2861424` and whose `total` is
greater than zero.

- [ ] **Step 7: Commit**

```bash
git add services/torrentSearch.js tests/search-resolution.test.mjs
git commit -m "feat(search): retry a typed query through punctuation, joined-word and trailing-word variants"
```

---

## Task 4: Suggestion dropdown

**Files:**
- Modify: `public/js/api.js`
- Modify: `public/js/state.js`
- Modify: `public/js/search.js`
- Modify: `public/js/app.js`
- Modify: `public/css/styles.css`

**Interfaces:**
- Consumes: `GET /api/search/suggest` from Task 1
- Produces: `api.suggest(query, limit)`; `state.search.tmdbId`; `state.search.suggestions`; actions `suggest-input` and `pick-suggestion`

- [ ] **Step 1: Add the fetch wrapper**

In `public/js/api.js`, beside the existing `searchTorrents` export:

```javascript
export const suggest = (query, limit = 8) => get(`/api/search/suggest?${q({ q: query, limit })}`);
```

Add `suggest` to the `export default { ... }` object at the bottom of the file.

- [ ] **Step 2: Extend search state**

In `public/js/state.js`, inside the `search` slice, after the `episode: 1` line:

```javascript
    // Set when a suggestion is picked. Searching by TMDB id skips title
    // matching altogether, so a typo cannot reach the resolver at all.
    tmdbId: null,
    suggestions: [],
```

- [ ] **Step 3: Send the id and render the dropdown**

In `public/js/search.js`, inside `runSearch`, replace the `params` construction:

```javascript
  const params = { q: term, type };
  if (isShow) {
    params.season = wantedSeason;
    params.episode = wantedEpisode;
  }
  if (state.search.tmdbId) params.tmdb_id = state.search.tmdbId;
```

Change the `renderSearch` destructuring line to include suggestions:

```javascript
  const { query, type, season, episode, suggestions, filters, status, results, sources, error } = state.search;
```

Add the dropdown markup immediately after the closing `</div>` of the first
`search-toolbar__row`, still inside `.search-toolbar`:

```javascript
      ${suggestions.length ? `
        <div class="suggestions" id="suggestions">
          ${suggestions.map((entry, index) => `
            <button class="suggestion" data-action="pick-suggestion" data-index="${index}">
              ${entry.poster
    ? `<img class="suggestion__poster" loading="lazy" alt="" src="${esc(entry.poster)}">`
    : '<span class="suggestion__poster suggestion__poster--empty"></span>'}
              <span class="suggestion__title">${esc(entry.title)}</span>
              ${entry.year ? `<span class="suggestion__year">${entry.year}</span>` : ''}
              <span class="badge suggestion__type">${entry.type === 'show' ? 'Show' : 'Movie'}</span>
            </button>`).join('')}
        </div>` : ''}
```

Add the `id="search-input"` element's autocomplete affordance by replacing that
input line with:

```javascript
        <input class="input" id="search-input" placeholder="Title to search for…" value="${esc(query)}"
               autocomplete="off" data-action="suggest-input" role="combobox" aria-expanded="${suggestions.length > 0}">
```

- [ ] **Step 4: Wire the actions**

In `public/js/app.js`, add to the `ACTIONS` object:

```javascript
  // Typing clears any picked id, so an edited query resolves by title again.
  'suggest-input': (el) => {
    patchSlice('search', { query: el.value, tmdbId: null });
    scheduleSuggest(el.value);
  },

  'pick-suggestion': (el) => {
    const entry = state.search.suggestions[Number(el.dataset.index)];
    if (!entry) return;
    patchSlice('search', {
      query: entry.title,
      type: entry.type,
      tmdbId: entry.tmdb_id,
      suggestions: []
    });
    const live = liveSearch();
    search.runSearch(entry.title, entry.type, live.season, live.episode);
  },
```

Add the debounce helper beside `liveSearch`:

```javascript
const SUGGEST_DEBOUNCE_MS = 250;
let suggestTimer = null;
let suggestSeq = 0;

/**
 * Fetch suggestions 250ms after typing stops. Responses carry a sequence
 * number so a slow reply for an older query cannot overwrite a newer one.
 */
function scheduleSuggest(value) {
  clearTimeout(suggestTimer);
  const term = String(value || '').trim();

  if (term.length < 2) {
    if (state.search.suggestions.length > 0) patchSlice('search', { suggestions: [] });
    return;
  }

  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    try {
      const suggestions = await api.suggest(term);
      if (seq === suggestSeq) patchSlice('search', { suggestions });
    } catch {
      // A failed lookup just leaves the dropdown closed.
    }
  }, SUGGEST_DEBOUNCE_MS);
}
```

Add `input` to the delegated listeners in `boot()`, beside the existing
`click` and `change` registrations:

```javascript
  document.addEventListener('input', onClick);
```

In `onClick`, extend the form-control guard so `input` events reach the handler
while `click` still does not:

```javascript
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') {
    if (event.type === 'click') return;
  } else {
    event.preventDefault();
  }
```

This already behaves correctly — `input` events are not `click`, so they pass
through. No change is needed beyond registering the listener.

Close the dropdown when a search runs: in the `run-search` action, before
calling `search.runSearch`, add:

```javascript
    patchSlice('search', { suggestions: [] });
```

- [ ] **Step 5: Style the dropdown**

Append to `public/css/styles.css`, after the `.episode-picker` rules:

```css
/* Suggestion dropdown under the search box. */
.suggestions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  max-height: 340px;
  overflow-y: auto;
}
.suggestion {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.suggestion:hover, .suggestion:focus-visible {
  background: var(--bg-hover);
  outline: none;
}
.suggestion__poster {
  width: 32px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  flex: 0 0 auto;
}
.suggestion__poster--empty { background: var(--bg-hover); display: block; }
.suggestion__title { font-weight: 600; }
.suggestion__year { color: var(--text-dim); font-size: 12px; }
.suggestion__type { margin-left: auto; }
```

All tokens used above are verified present in the `:root` block of
`styles.css`: `--bg-elevated`, `--bg-hover`, `--border`, `--text`,
`--text-dim`, `--space-2`, `--space-3`. Note the panel colour is
`--bg-elevated` — there is no `--bg-panel`.

- [ ] **Step 6: Verify the render**

Create `_suggest-check.mjs` in the project root:

```javascript
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ canPlayType: () => '' }),
  querySelectorAll: () => [],
  querySelector: () => null
};

const { state } = await import('./public/js/state.js');
const { renderSearch } = await import('./public/js/search.js');

let failures = 0;
const check = (name, condition) => {
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

state.search.type = 'movie';
state.search.query = 'incep';
state.search.suggestions = [];
check('no dropdown when there are no suggestions', !renderSearch().includes('id="suggestions"'));

state.search.suggestions = [
  { tmdb_id: 27205, type: 'movie', title: 'Inception', year: 2010, poster: 'https://x/p.jpg', popularity: 40 },
  { tmdb_id: 60625, type: 'show', title: 'Rick and Morty', year: 2013, poster: null, popularity: 99 }
];
const html = renderSearch();
check('dropdown renders', html.includes('id="suggestions"'));
check('shows both entries', (html.match(/data-action="pick-suggestion"/g) || []).length === 2);
check('shows the title', html.includes('Inception'));
check('shows the year', html.includes('2010'));
check('tags a movie', html.includes('>Movie<'));
check('tags a show', html.includes('>Show<'));
check('renders a poster when present', html.includes('suggestion__poster" loading'));
check('falls back when the poster is null', html.includes('suggestion__poster--empty'));
check('indexes entries for selection', html.includes('data-index="1"'));

console.log(failures === 0 ? '\ndropdown checks passed\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
```

Run: `node _suggest-check.mjs`

Expected: all checks pass. Then delete it: `rm _suggest-check.mjs`

- [ ] **Step 7: Verify in the browser**

```bash
node server.js &
sleep 5
```

Open <http://localhost:3000>, go to Search, and confirm by eye:

- Typing `incep` shows a dropdown within about half a second, with posters,
  years and Movie/Show tags
- Clicking `Inception` fills the box, switches the type to Movie, and runs a
  search that returns results
- Typing a single character closes the dropdown
- Typing after picking a suggestion reopens it
- Pressing Search with the dropdown open closes it and searches

Stop the server: `taskkill //F //IM node.exe`

- [ ] **Step 8: Commit**

```bash
git add public/js/api.js public/js/state.js public/js/search.js public/js/app.js public/css/styles.css
git commit -m "feat(search): add a title suggestion dropdown that searches by TMDB id"
```

---

## Self-Review

**Spec coverage** — every Phase A requirement maps to a task:

| Spec section | Task |
|---|---|
| A1 suggestion endpoint, `searchMulti`, tv→show normalisation | 1 |
| A1 route in `routes/torrents.js`, not `routes/media.js` | 1, Step 5 |
| A2 autocomplete dropdown, debounce, `tmdbId` in state | 4 |
| A2 `runSearch` sends `tmdb_id` | 4, Step 3 |
| A3 variant ladder (as typed, punctuation, joined words, trailing words) | 3 |
| A3 known limitation documented by a test | 3, Step 1 |
| A4 same-type preference before cross-type fallback | 2 |
| Testing: typo, joined-word, spiderman, one-character cases | 1, 2, 3 |

**Deliberate omission:** the spec lists `/search/multi` as ladder step 5. Task 3
stops at four variant shapes because `searchMulti` is already reachable through
the suggestion dropdown, and adding it as a fifth blind retry would double the
TMDB calls on a failed search for no measured gain. If a future case needs it,
`searchMulti` is exported and ready.

**Type consistency** — checked across tasks: `toSuggestion` produces
`{ tmdb_id, type, title, year, poster, popularity }` in Task 1 and is consumed
with those exact keys in Task 4; `resolveImdbId` keeps returning
`{ tmdbId, imdbId, type }` throughout; `attempt(kind, term)` in Task 3
supersedes `attempt(kind)` from Task 2 and that supersession is called out in
the step itself so an implementer reading Task 3 alone is not confused.

**Ordering dependency:** Task 3 rewrites the `attempt` helper introduced in
Task 2. Tasks must run in order. Task 4 depends on Task 1's endpoint existing
but not on Tasks 2 or 3.
