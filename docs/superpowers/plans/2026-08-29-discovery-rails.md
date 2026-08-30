# Discovery Rails (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put browsable, undownloaded films and shows on the Home page, so finding something to watch does not require already knowing its name.

**Architecture:** A new `services/discover.js` assembles three rails from TMDB list endpoints, marks anything already in the library as owned, and caches each rail in a new SQLite table because recommendations cost one API call per owned title. `routes/discover.js` serves them. Home renders them with the existing card markup; clicking an unowned card opens the existing detail modal, whose Play button becomes Find torrents and hands off to the Search page built in Phase A.

**Tech Stack:** Node 20+ (ESM), Express 4, axios, better-sqlite3, vanilla ES modules. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-discovery-and-title-resolution-design.md` (Phase B; Phase A is merged)

## Global Constraints

- **No new npm dependencies.**
- **Tests are integration tests against live TMDB**, run with plain `node`, matching `tests/search-resolution.test.mjs` and `tests/tmdb-suggest.test.mjs`.
- **`npm test` must run every test file** and exit non-zero if any fails.
- **TMDB vocabulary is normalised at the boundary**: TMDB says `tv`, `name`, `first_air_date`; this app says `type: 'show'`, `title`, `year`.
- **Rail endpoints do not return `media_type`.** `/discover/movie`, `/movie/top_rated` and `/movie/{id}/recommendations` all return bare results. Unlike `toSuggestion`, the rail mapper must be told the type by its caller. Getting this wrong produces rails of blank titles.
- **A failing rail is omitted, never fatal.** Home must render without the discovery section if every rail fails.
- **Frontend is ES modules with no build step.**
- **`render()` refuses re-entry and restores focus** (added in Phase A). Do not remove either guard.
- **Never leave a server running.** Stop any `node server.js` started for verification.

---

## Deviation from the spec, and why

The spec says the unowned detail modal gives **each episode row a Find button**. This plan does not build that.

Listing episodes needs one `/tv/{id}/season/{n}` call per season — nine for Rick and Morty — on every modal open, and the payload from `/tv/{id}` carries only a `seasons` summary, not episodes. Meanwhile Phase A already put season and episode fields on the Search page, which is one place to pick an episode rather than two.

So the modal hands off: **Find torrents** navigates to Search with the TMDB id, type and title prefilled, and for shows the S/E boxes appear ready to adjust. Same destination, no per-season API calls, one episode picker in the app instead of two.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `db/schema.sql` | Gains `discover_cache`. Runs `IF NOT EXISTS` on boot, so it self-migrates. | Modify |
| `db/index.js` | Gains `readDiscover` / `writeDiscover`, mirroring the metadata pair. | Modify |
| `services/discover.js` | Rail assembly, TMDB shaping, owned marking. One job. | Create |
| `routes/discover.js` | `/api/discover` and `/api/discover/:type/:id`. | Create |
| `server.js` | Mounts the new router. | Modify |
| `public/js/api.js` | `getDiscover()`, `getDiscoverDetail()`. | Modify |
| `public/js/state.js` | `discover` slice. | Modify |
| `public/js/views.js` | Rails on Home; modal handles unowned items. | Modify |
| `public/js/app.js` | Loads rails on boot; `open-discover` and `find-torrents` actions. | Modify |
| `public/css/styles.css` | Owned badge. | Modify |
| `tests/discover.test.mjs` | Shaping, owned marking, rail contract, cache TTL. | Create |
| `package.json` | `test` runs the new suite too. | Modify |

---

## Task 1: Cache table and helpers

**Files:**
- Modify: `db/schema.sql`
- Modify: `db/index.js`
- Create: `tests/discover.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the existing `db` handle and prepared-statement pattern in `db/index.js`
- Produces:
  - `readDiscover(key, ttlMs)` → parsed payload, or `undefined` when absent, expired or corrupt
  - `writeDiscover(key, data)` → the payload it was given

- [ ] **Step 1: Write the failing test**

Create `tests/discover.test.mjs`:

```javascript
/**
 * Discovery rails. Integration test against live TMDB and the real database,
 * matching the approach in tests/search-resolution.test.mjs.
 *
 * Run: npm test
 */
import { readDiscover, writeDiscover } from '../db/index.js';

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

Run: `node tests/discover.test.mjs`

Expected: FAIL — `SyntaxError: The requested module '../db/index.js' does not provide an export named 'readDiscover'`.

- [ ] **Step 3: Add the table**

Append to `db/schema.sql`:

```sql
-- Discovery rails. Cached because recommendations cost one TMDB call per
-- owned title and the lists change slowly. Keyed by rail id, not tmdb_id,
-- which is why this cannot share metadata_cache.
CREATE TABLE IF NOT EXISTS discover_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Add the helpers**

In `db/index.js`, add to the `stmt` object, after the `metaDelete` entry:

```javascript
  discoverGet: db.prepare('SELECT * FROM discover_cache WHERE key = ?'),
  discoverUpsert: db.prepare(`
    INSERT INTO discover_cache (key, data, updated_at)
    VALUES (@key, @data, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `),
```

Then add the functions after `deleteMetadata`:

```javascript
/* --------------------------------------------------------------------------
 * discover_cache
 * ----------------------------------------------------------------------- */

/**
 * Cached rail payload if it is younger than `ttlMs`, otherwise undefined.
 * Corrupt JSON is treated as a cache miss rather than an error, matching
 * readMetadata.
 */
export function readDiscover(key, ttlMs) {
  const row = stmt.discoverGet.get(key);
  if (!row) return undefined;
  if (ttlMs >= 0 && row.updated_at < now() - ttlMs) return undefined;
  if (ttlMs < 0) return undefined;
  try {
    return JSON.parse(row.data);
  } catch {
    log.warn(`corrupt discover_cache row for "${key}", refetching`);
    return undefined;
  }
}

export function writeDiscover(key, data) {
  stmt.discoverUpsert.run({ key, data: JSON.stringify(data), updated_at: now() });
  return data;
}
```

Note the `ttlMs < 0` branch: a negative TTL means "always refetch", which is
how `force` is expressed. `readMetadata` treats negative as "never expire";
the opposite convention here is deliberate and the test pins it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/discover.test.mjs`

Expected: PASS — `5 checks, all passed`.

- [ ] **Step 6: Wire into `npm test`**

In `package.json`, set:

```json
"test": "node tests/search-resolution.test.mjs && node tests/tmdb-suggest.test.mjs && node tests/discover.test.mjs && node tests/player-nextup.test.mjs"
```

Run: `npm test`

Expected: four suites, all pass.

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql db/index.js tests/discover.test.mjs package.json
git commit -m "feat(discover): add a cache table for rail payloads"
```

---

## Task 2: Rail assembly

**Files:**
- Create: `services/discover.js`
- Modify: `services/tmdb.js`
- Modify: `tests/discover.test.mjs`

**Interfaces:**
- Consumes: `readDiscover` / `writeDiscover` (Task 1); `mapWithConcurrency`, `posterUrl`, `backdropUrl`, `getDetails` from `services/tmdb.js`
- Produces:
  - `tmdb.discoverRecent(type)` → raw TMDB results for titles released in the last 60 days
  - `tmdb.topRated(type)` → raw TMDB results
  - `tmdb.recommendations(tmdbId, type)` → raw TMDB results
  - `discover.toRailItem(result, type)` → `{ tmdb_id, type, title, year, poster, backdrop, rating, overview, popularity }` or `null`
  - `discover.markOwned(rails, ownedIds)` → the same rails with `owned: boolean` on every item
  - `discover.getRails({ force })` → `[{ id, title, items }]`

- [ ] **Step 1: Write the failing test**

Append to `tests/discover.test.mjs`, before the final exit block:

```javascript
import { toRailItem, markOwned, getRails } from '../services/discover.js';

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/discover.test.mjs`

Expected: FAIL — `Cannot find module '../services/discover.js'`.

- [ ] **Step 3: Add the TMDB list endpoints**

In `services/tmdb.js`, after the `suggest` function:

```javascript
/* --------------------------------------------------------------------------
 * Discovery lists
 *
 * These return bare results with no `media_type`, so every caller has to know
 * which type it asked for. That is why the rail mapper takes the type as an
 * argument rather than reading it off the payload.
 * ----------------------------------------------------------------------- */

const DISCOVER_WINDOW_DAYS = 60;

/** Popular titles released within the last DISCOVER_WINDOW_DAYS. */
export function discoverRecent(type) {
  const since = new Date(Date.now() - DISCOVER_WINDOW_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const path = type === 'show' ? '/discover/tv' : '/discover/movie';
  const dateField = type === 'show' ? 'first_air_date.gte' : 'primary_release_date.gte';

  return memo(`recent:${type}:${since}`, async () => {
    const data = await request(path, { [dateField]: since, sort_by: 'popularity.desc', include_adult: false });
    return data.results || [];
  });
}

/** The acclaimed back catalogue. */
export function topRated(type) {
  const path = type === 'show' ? '/tv/top_rated' : '/movie/top_rated';
  return memo(`top:${type}`, async () => {
    const data = await request(path);
    return data.results || [];
  });
}

/** TMDB's own "if you liked this" list for one title. */
export function recommendations(tmdbId, type) {
  const path = type === 'show' ? `/tv/${tmdbId}/recommendations` : `/movie/${tmdbId}/recommendations`;
  return memo(`recs:${type}:${tmdbId}`, async () => {
    const data = await request(path);
    return data.results || [];
  });
}
```

Add `discoverRecent`, `topRated` and `recommendations` to the `export default { ... }` object.

- [ ] **Step 4: Write the service**

Create `services/discover.js`:

```javascript
/**
 * Discovery rails for the Home page.
 *
 * One job: turn TMDB's list endpoints into rails of browsable titles, marked
 * with whether they are already in the library.
 *
 * Rails are cached in SQLite rather than memory because the recommendation
 * rails cost one API call per owned title and survive a restart unchanged.
 */
import { createLogger } from '../config/index.js';
import { readDiscover, writeDiscover } from '../db/index.js';
import * as tmdb from './tmdb.js';
import * as scanner from './scanner.js';

const log = createLogger('discover');

const RAIL_LIMIT = 20;
const RECOMMENDATION_SOURCES = 3;

const TTL = {
  recent: 6 * 60 * 60 * 1000,
  top: 24 * 60 * 60 * 1000,
  recommended: 24 * 60 * 60 * 1000
};

/**
 * Shape one TMDB list result.
 *
 * The type is a parameter, not a field: `/discover/movie`, `/movie/top_rated`
 * and `/movie/{id}/recommendations` all return results with no `media_type`.
 */
export function toRailItem(result, type) {
  if (!result) return null;

  const title = type === 'show' ? result.name : result.title;
  if (!title) return null;

  const released = type === 'show' ? result.first_air_date : result.release_date;

  return {
    tmdb_id: result.id,
    type,
    title,
    year: released ? (Number(String(released).slice(0, 4)) || null) : null,
    poster: tmdb.posterUrl(result.poster_path),
    backdrop: tmdb.backdropUrl(result.backdrop_path),
    rating: typeof result.vote_average === 'number' ? Number(result.vote_average.toFixed(1)) : null,
    overview: result.overview || '',
    popularity: Number(result.popularity) || 0
  };
}

/** Flag every item that is already in the library. */
export function markOwned(rails, ownedIds) {
  return rails.map((rail) => ({
    ...rail,
    items: rail.items.map((item) => ({ ...item, owned: ownedIds.has(item.tmdb_id) }))
  }));
}

/** Shape, drop blanks, and cap a raw TMDB list. */
function railItems(results, type) {
  return (results || []).map((result) => toRailItem(result, type)).filter(Boolean);
}

/** Read a rail from cache, or build and store it. */
async function cached(key, ttlMs, build) {
  if (ttlMs >= 0) {
    const hit = readDiscover(key, ttlMs);
    if (hit) return hit;
  }
  const fresh = await build();
  writeDiscover(key, fresh);
  return fresh;
}

/** Popular recently: films and shows released in the last 60 days, merged. */
async function recentRail(ttlMs) {
  const items = await cached('rail:recent', ttlMs, async () => {
    const [movies, shows] = await Promise.all([
      tmdb.discoverRecent('movie'),
      tmdb.discoverRecent('show')
    ]);
    return [...railItems(movies, 'movie'), ...railItems(shows, 'show')]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, RAIL_LIMIT);
  });
  return { id: 'recent', title: 'Popular recently', items };
}

/** Top rated: the acclaimed back catalogue, films and shows merged. */
async function topRail(ttlMs) {
  const items = await cached('rail:top', ttlMs, async () => {
    const [movies, shows] = await Promise.all([
      tmdb.topRated('movie'),
      tmdb.topRated('show')
    ]);
    return [...railItems(movies, 'movie'), ...railItems(shows, 'show')]
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, RAIL_LIMIT);
  });
  return { id: 'top', title: 'Top rated', items };
}

/** One "Because you watch X" rail per recently added library title. */
async function recommendationRails(ttlMs) {
  const library = scanner.getLibrary();
  const sources = [
    ...library.movies.map((movie) => ({ tmdb_id: movie.tmdb_id, title: movie.title, type: 'movie', at: newestFile(movie) })),
    ...library.shows.map((show) => ({ tmdb_id: show.tmdb_id, title: show.title, type: 'show', at: newestFile(show) }))
  ].sort((a, b) => b.at - a.at).slice(0, RECOMMENDATION_SOURCES);

  const built = await tmdb.mapWithConcurrency(sources, async (source) => {
    const items = await cached(`rail:recommended:${source.type}:${source.tmdb_id}`, ttlMs, async () => {
      const results = await tmdb.recommendations(source.tmdb_id, source.type);
      return railItems(results, source.type).slice(0, RAIL_LIMIT);
    });
    return {
      id: `recommended:${source.tmdb_id}`,
      title: `Because you watch ${source.title}`,
      items
    };
  });

  return built
    .filter((outcome) => outcome.status === 'fulfilled')
    .map((outcome) => outcome.value);
}

/** Newest file mtime under a library entry, for ordering by recency. */
function newestFile(item) {
  let newest = 0;
  for (const file of item.files || []) newest = Math.max(newest, file.added_at || 0);
  for (const season of item.seasons || []) {
    for (const episode of season.episodes) {
      for (const file of episode.files || []) newest = Math.max(newest, file.added_at || 0);
    }
  }
  return newest;
}

/**
 * Every rail, with owned titles flagged.
 *
 * A rail that throws is dropped rather than failing the whole response: the
 * Home page is more useful with two rails than with an error.
 */
export async function getRails({ force = false } = {}) {
  const ttl = (base) => (force ? -1 : base);

  const attempts = await Promise.allSettled([
    recentRail(ttl(TTL.recent)),
    recommendationRails(ttl(TTL.recommended)),
    topRail(ttl(TTL.top))
  ]);

  const rails = [];
  for (const attempt of attempts) {
    if (attempt.status === 'rejected') {
      log.warn(`a rail failed and was omitted: ${attempt.reason?.message || attempt.reason}`);
      continue;
    }
    if (Array.isArray(attempt.value)) rails.push(...attempt.value);
    else rails.push(attempt.value);
  }

  const library = scanner.getLibrary();
  const ownedIds = new Set([
    ...library.movies.map((movie) => movie.tmdb_id),
    ...library.shows.map((show) => show.tmdb_id)
  ]);

  return markOwned(rails.filter((rail) => rail.items.length > 0), ownedIds);
}

/** Full TMDB record for the detail modal. */
export function getDetails(tmdbId, type) {
  return tmdb.getDetails(tmdbId, type);
}

export default { getRails, getDetails, toRailItem, markOwned };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/discover.test.mjs`

Expected: PASS — all checks green, including `includes the recent rail` and
`a second call is served from cache`.

- [ ] **Step 6: Commit**

```bash
git add services/discover.js services/tmdb.js tests/discover.test.mjs
git commit -m "feat(discover): assemble Home rails from TMDB with owned marking"
```

---

## Task 3: Routes

**Files:**
- Create: `routes/discover.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: `getRails`, `getDetails` (Task 2)
- Produces:
  - `GET /api/discover` → `{ rails, generated_at }`; `?force=1` bypasses the cache
  - `GET /api/discover/:type/:tmdb_id` → the full TMDB record

- [ ] **Step 1: Write the router**

Create `routes/discover.js`:

```javascript
/**
 * /api/discover — browsable titles that are not in the library yet.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as discover from '../services/discover.js';

const log = createLogger('api:discover');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * GET /api/discover
 * Every rail. `?force=1` rebuilds rather than reading the cache.
 * Never fails the page: an empty rail list is a valid answer.
 */
router.get('/', wrap(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';

  try {
    const rails = await discover.getRails({ force });
    res.json({ rails, generated_at: Date.now() });
  } catch (error) {
    log.warn(`could not build rails: ${error.message}`);
    res.json({ rails: [], generated_at: Date.now() });
  }
}));

/** GET /api/discover/:type/:tmdb_id — full record for the detail modal. */
router.get('/:type/:tmdb_id', wrap(async (req, res) => {
  const type = req.params.type === 'show' ? 'show' : req.params.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ error: 'type must be movie or show' });

  const tmdbId = Number(req.params.tmdb_id);
  if (!Number.isFinite(tmdbId)) return res.status(400).json({ error: 'tmdb_id must be a number' });

  try {
    const details = await discover.getDetails(tmdbId, type);
    res.json(details);
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    res.status(status).json({ error: error.message });
  }
}));

export default router;
```

- [ ] **Step 2: Mount it**

In `server.js`, add the import beside the other routers:

```javascript
import discoverRouter from './routes/discover.js';
```

And mount it beside the others, after the `/api/media` line:

```javascript
app.use('/api/discover', discoverRouter);
```

- [ ] **Step 3: Verify against the running server**

```bash
node server.js &
sleep 6
curl -s "http://127.0.0.1:3000/api/discover" | head -c 400
echo
curl -s -o /dev/null -w "detail movie: %{http_code}\n" "http://127.0.0.1:3000/api/discover/movie/27205"
curl -s -o /dev/null -w "detail show:  %{http_code}\n" "http://127.0.0.1:3000/api/discover/show/60625"
curl -s -o /dev/null -w "bad type:     %{http_code}\n" "http://127.0.0.1:3000/api/discover/person/1"
taskkill //F //IM node.exe
```

Expected: the first prints JSON containing `"rails":[{"id":"recent"`. The two
detail calls print `200`; the bad type prints `400`. Confirm port 3000 is free
afterwards.

- [ ] **Step 4: Commit**

```bash
git add routes/discover.js server.js
git commit -m "feat(discover): serve rails and detail records"
```

---

## Task 4: Rails on Home

**Files:**
- Modify: `public/js/api.js`
- Modify: `public/js/state.js`
- Modify: `public/js/views.js`
- Modify: `public/js/app.js`
- Modify: `public/css/styles.css`

**Interfaces:**
- Consumes: `GET /api/discover` (Task 3)
- Produces: `api.getDiscover()`; `state.discover`; `discoverCard(item)`; action `open-discover`

- [ ] **Step 1: Add the fetch wrappers**

In `public/js/api.js`, beside `getLibrary`:

```javascript
export const getDiscover = (force = false) => get(`/api/discover?${q({ force: force ? 1 : '' })}`);
export const getDiscoverDetail = (type, tmdbId) => get(`/api/discover/${type}/${tmdbId}`);
```

Add both to the `export default { ... }` object.

- [ ] **Step 2: Add the state slice**

In `public/js/state.js`, after the `search` slice:

```javascript
  // Browsable titles that are not in the library. Loaded once after the
  // library so Home never blocks on TMDB.
  discover: { rails: [], status: 'idle', error: null },
```

- [ ] **Step 3: Render the rails**

In `public/js/views.js`, add this card renderer beside `posterCard`:

```javascript
/**
 * A discovery card. Owned titles route to the normal library modal so they
 * behave exactly like a card on the Movies or Shows page.
 */
function discoverCard(item) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  const action = item.owned
    ? `data-action="open-detail" data-type="${esc(item.type)}" data-id="${item.tmdb_id}"`
    : `data-action="open-discover" data-type="${esc(item.type)}" data-id="${item.tmdb_id}"`;

  return `
    <article class="card" ${action} tabindex="0">
      ${poster}
      ${item.owned ? '<span class="card__owned">In library</span>' : ''}
      <div class="card__play"><div class="card__play-button">${playIcon()}</div></div>
      <div class="card__overlay">
        <div class="card__title">${esc(item.title)}</div>
        <div class="card__meta">${item.year || '—'}${item.rating ? ` · ★ ${item.rating}` : ''}</div>
      </div>
    </article>`;
}

/** The discovery section, or nothing at all when no rail loaded. */
function discoverRails() {
  const { rails } = state.discover;
  if (!rails.length) return '';

  return rails.map((rail) => `
    <section class="section">
      <div class="section__header">
        <h2 class="section__title">${esc(rail.title)}</h2>
      </div>
      <div class="rail">${rail.items.map(discoverCard).join('')}</div>
    </section>`).join('');
}
```

Then, in `renderHome`, change the closing of the Recently Added section from:

```javascript
      <div class="grid">${recent.map((entry) => posterCard(entry.item, entry.type)).join('')}</div>
    </section>`;
```

to:

```javascript
      <div class="grid">${recent.map((entry) => posterCard(entry.item, entry.type)).join('')}</div>
    </section>

    ${discoverRails()}`;
```

- [ ] **Step 4: Load the rails on boot**

In `public/js/app.js`, add beside `loadJobs`:

```javascript
/**
 * Rails are decoration: a failure leaves Home exactly as it was, with no
 * toast, because the library above them is still perfectly usable.
 */
async function loadDiscover() {
  patchSlice('discover', { status: 'loading' });
  try {
    const payload = await api.getDiscover();
    patchSlice('discover', { rails: payload.rails || [], status: 'done', error: null });
  } catch (error) {
    patchSlice('discover', { rails: [], status: 'error', error: error.message });
  }
}
```

And call it at the end of `boot()`, after `syncJobPolling()`:

```javascript
  loadDiscover();
```

Note it is deliberately not awaited: Home renders from the library first and
the rails appear when they arrive.

- [ ] **Step 5: Style the owned badge**

Append to `public/css/styles.css`:

```css
/* Poster cards in a rail need an explicit width. `.rail` is a flex row and
   only ever held `.card--backdrop` before, which carries its own `flex: 0 0
   300px`; a plain `.card` has no width rule and would collapse to nothing. */
.rail .card {
  flex: 0 0 168px;
  width: 168px;
}

/* Marks a discovery card that is already in the library. */
.card__owned {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  z-index: 2;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: rgba(10, 10, 10, .82);
  border: 1px solid var(--success);
  color: var(--success);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .02em;
}
```

- [ ] **Step 6: Verify in a browser**

```bash
node server.js &
sleep 6
```

Open <http://localhost:3000> and confirm by eye:

- Below Recently Added there are rails titled **Popular recently**,
  **Because you watch Rick and Morty** and **Top rated**
- Cards show posters, years and ratings, and scroll horizontally
- Rick and Morty itself, if it appears in a rail, carries an **In library**
  badge
- The browser console is clean

Stop the server: `taskkill //F //IM node.exe`

- [ ] **Step 7: Commit**

```bash
git add public/js/api.js public/js/state.js public/js/views.js public/js/app.js public/css/styles.css
git commit -m "feat(discover): show discovery rails on the Home page"
```

---

## Task 5: Detail modal and handoff to Search

**Files:**
- Modify: `public/js/views.js`
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: `api.getDiscoverDetail` (Task 4); `search.runSearch` from Phase A
- Produces: actions `open-discover` and `find-torrents`

- [ ] **Step 1: Teach the modal about unowned items**

In `public/js/views.js`, inside `renderDetailModal`, replace:

```javascript
  const isShow = Boolean(item.seasons);
  const firstFile = isShow ? firstEpisodeFile(item) : (item.files || [])[0];
```

with:

```javascript
  // A discovery item has no files and no library-shaped seasons, so it carries
  // its type explicitly. Library items keep the old inference.
  const isShow = item.media_type ? item.media_type === 'show' : Boolean(item.seasons);
  const firstFile = isShow ? firstEpisodeFile(item) : (item.files || [])[0];
  const unowned = item.owned === false;
```

Then replace the actions block:

```javascript
          <div class="modal__actions">
            ${firstFile
    ? `<button class="btn btn--primary btn--lg" data-action="play" data-path="${esc(firstFile.file_path)}">${playIcon('btn__icon')}Play</button>`
    : ''}
            <button class="btn btn--secondary btn--lg" data-action="find-more" data-type="${isShow ? 'show' : 'movie'}" data-id="${item.tmdb_id}">Find More</button>
          </div>
```

with:

```javascript
          <div class="modal__actions">
            ${firstFile
    ? `<button class="btn btn--primary btn--lg" data-action="play" data-path="${esc(firstFile.file_path)}">${playIcon('btn__icon')}Play</button>`
    : ''}
            <button class="btn ${unowned ? 'btn--primary' : 'btn--secondary'} btn--lg"
                    data-action="find-torrents"
                    data-type="${isShow ? 'show' : 'movie'}"
                    data-id="${item.tmdb_id}"
                    data-title="${esc(item.title)}">${unowned ? 'Find torrents' : 'Find More'}</button>
          </div>
          ${unowned && isShow
    ? '<p class="modal__hint">Shows are indexed one episode at a time — pick a season and episode on the next screen.</p>'
    : ''}
```

- [ ] **Step 2: Add the hint style**

Append to `public/css/styles.css`:

```css
.modal__hint {
  color: var(--text-dim);
  font-size: 12px;
  margin-top: var(--space-3);
}
```

- [ ] **Step 3: Wire the actions**

In `public/js/app.js`, replace the whole `'find-more'` action with:

```javascript
  /**
   * Search for a title by TMDB id.
   *
   * Works for both library items and discovery items: the id is authoritative,
   * so no title matching happens at all. Shows land on the Search page with
   * the season and episode fields ready, which is the one place in the app
   * that picks an episode.
   */
  'find-torrents': (el) => {
    const type = el.dataset.type === 'show' ? 'show' : 'movie';
    const title = el.dataset.title || '';
    const tmdbId = Number(el.dataset.id) || null;

    setState({ currentItem: null });
    patchSlice('search', { type, tmdbId, suggestions: [] });
    navigate('search');
    search.runSearch(title, type, state.search.season, state.search.episode);
  },

  'open-discover': async (el) => {
    const type = el.dataset.type === 'show' ? 'show' : 'movie';
    const tmdbId = Number(el.dataset.id);
    if (!Number.isFinite(tmdbId)) return;

    try {
      const details = await api.getDiscoverDetail(type, tmdbId);
      setState({
        currentItem: {
          tmdb_id: details.id,
          media_type: type,
          owned: false,
          title: type === 'show' ? details.name : details.title,
          year: Number(String(type === 'show' ? details.first_air_date : details.release_date || '').slice(0, 4)) || null,
          poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
          backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
          rating: typeof details.vote_average === 'number' ? Number(details.vote_average.toFixed(1)) : null,
          overview: details.overview || '',
          genres: (details.genres || []).map((genre) => genre.name),
          runtime: details.runtime || (details.episode_run_time || [])[0] || null,
          cast: (details.credits?.cast || []).slice(0, 10).map((person) => ({
            id: person.id,
            name: person.name,
            character: person.character || null,
            profile: person.profile_path ? `https://image.tmdb.org/t/p/w185${person.profile_path}` : null
          }))
        }
      });
    } catch (error) {
      views.toast('error', 'Could not load that title', error.message);
    }
  },
```

Note the image URLs are built here rather than server-side because the detail
endpoint returns raw TMDB records; the sizes match `config.tmdb.posterSize`,
`backdropSize` and `profileSize`.

- [ ] **Step 4: Verify in a browser**

```bash
node server.js &
sleep 6
```

Open <http://localhost:3000> and confirm by eye:

- Clicking an unowned rail card opens the detail modal with poster, overview,
  rating, genres and cast
- The primary button reads **Find torrents**, not Play
- For a show, the hint about seasons appears under the buttons
- Clicking **Find torrents** lands on Search with the title filled in, and for
  a show the S/E boxes are visible; results appear
- Clicking a card badged **In library** opens the normal library modal with a
  working Play button
- The browser console is clean

Stop the server: `taskkill //F //IM node.exe`

- [ ] **Step 5: Run everything**

Run: `npm test`

Expected: four suites, all pass.

- [ ] **Step 6: Commit**

```bash
git add public/js/views.js public/js/app.js public/css/styles.css
git commit -m "feat(discover): open unowned titles in the detail modal and hand off to Search"
```

---

## Self-Review

**Spec coverage** — every Phase B requirement maps to a task:

| Spec section | Task |
|---|---|
| B1 `discover_cache` table, `readDiscover` / `writeDiscover` | 1 |
| B2 `toRailItem`, `getRails`, `getDetails`, owned marking | 2 |
| B2 three rails with their TTLs and 20-item cap | 2 |
| B2 recommendations for the 3 most recently added titles | 2 |
| B2 a failing rail is omitted, not fatal | 2 |
| B3 both routes, 400 on a bad type | 3 |
| B4 rails on Home, `In library` badge, loaded after the library | 4 |
| B5 modal with Find torrents instead of Play | 5 |
| Error handling: empty library, failed rail, failed detail fetch | 2, 3, 5 |

**Known deviation:** per-episode Find buttons are replaced by a handoff to the
Search page, for the reasons given at the top of this plan. The spec's intent —
choose a season and episode before searching — is met in one place rather than
two.

**Type consistency** — checked across tasks: `toRailItem` produces
`{ tmdb_id, type, title, year, poster, backdrop, rating, overview, popularity }`
in Task 2, `markOwned` adds `owned`, and Task 4's `discoverCard` reads exactly
those keys. The modal item built in Task 5 uses `media_type` and `owned`, which
Task 5's `renderDetailModal` change is the only consumer of. `find-torrents`
replaces `find-more` and Task 5 replaces its single call site.

**Ordering dependency:** Tasks 1 → 2 → 3 are strictly sequential. Task 4 needs
Task 3's endpoint. Task 5 needs Task 4's `getDiscoverDetail` wrapper.
