# Discovery Rails and Title Resolution — Design

**Date:** 2026-08-29
**Status:** Approved, ready for implementation planning

---

## Problem

Two complaints, one shared cause: the app can only reach content you can name exactly.

**Search is spelling-sensitive.** Measured against the live TMDB API:

| Query | TMDB hits | Outcome |
|---|---|---|
| `rick and morty` | 2 | resolves `tt2861424` |
| `RICK AND MORTY` | 2 | resolves `tt2861424` |
| `rick & morty` | 2 | resolves `tt2861424` |
| `rick and mortey` | **0** | nothing |
| `rickandmorty` | **0** | nothing |
| `inceptoin` | **0** | nothing |
| `the matrx` | **0** | nothing |

Case is already handled — TMDB is case-insensitive and `normalize()` lowercases
besides. The failure is that TMDB's search does no fuzzy matching at all: one
wrong character returns an empty list, so there is no IMDB id, so Torrentio has
nothing to query, so the search fails.

The same probe exposed a regression in the cross-type fallback added earlier:
`spiderman` resolves to a **TV show** (`tt0185116`), because the top movie hit
was an unreleased film with no IMDB id and the code jumped media type rather
than trying the next movie down.

**There is no way to find something you have not already decided to watch.**
The library shows only what is on disk, so discovering anything new means
knowing its title in advance and typing it correctly.

## Goals

- Find titles without spelling them perfectly.
- Browse things worth watching from the Home page and download them there.
- Never guess on the user's behalf about what to download.

## Non-goals

- A full catalogue browser with genre/year/rating filters.
- Recommendations computed locally; TMDB's own are enough.
- Any change to the playback, scanning or organiser paths.

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where discovery lives | **Home page rails only** | Movies and Shows keep meaning "what I own" — nothing unplayable ever appears there, and the Play button never has to become something else. |
| Which rails | **Popular recently, Because you watch …, Top rated** | Two evergreen feeds plus a personal one that improves as the library grows. |
| "Recent" window | **Released in the last 60 days, by popularity** | TMDB's `/trending` accepts only `day` or `week`; there is no two-month window. `/discover` with a release-date filter delivers the intent — recent releases people are watching — so the rail is labelled **Popular recently**, not "Trending", because it is not TMDB's trending signal. |
| Clicking an unowned card | **Detail modal, then Find torrents** | Reuses the modal that already renders overview, cast and seasons. For shows, episode rows are how the user picks a season and episode before searching. |
| Typo handling | **Autocomplete + loosened retries** | Autocomplete removes typos at the source by searching on a TMDB id; retries catch the type-and-press-Enter path. |

---

## Phase A — Title resolution

Independent of Phase B and built first, because it fixes a live complaint.

### A1. Suggestion endpoint

```
GET /api/search/suggest?q=<text>&limit=<n>
->  [ { tmdb_id, type: 'movie'|'show', title, year, poster, popularity } ]
```

Backed by TMDB `/search/multi`. Filters out `person` results, drops entries
with no title, sorts by popularity, caps at 8 by default. Answers `[]` for a
query shorter than two characters rather than calling TMDB.

TMDB labels television as `tv` and carries its name in `name`/`first_air_date`,
while films use `title`/`release_date`. The endpoint normalises both to this
app's own vocabulary — `type: 'show'`, `title`, `year` — so nothing downstream
has to know TMDB's field names. This mapping already exists informally in
`scanner.baseFields`; the suggest route follows the same convention.

Responses are volatile and not keyed by a tmdb_id, so they use the existing
in-memory `memo()` cache in `services/tmdb.js` with its 10-minute TTL — the
same treatment `searchMovies`/`searchShows` already get.

New in `services/tmdb.js`:

```
searchMulti(query)  ->  raw TMDB results array (memoised)
```

The route lives in `routes/torrents.js`, which is the router already mounted at
`/api` and already owns `/api/search`. It does **not** go in `routes/media.js`,
which is mounted at `/api/media` and could not serve this path.

### A2. Autocomplete dropdown

`public/js/search.js` gains a suggestion list rendered under the search input:
poster thumbnail, title, year, and a Movie/Show tag. Behaviour:

- Fires 250ms after typing stops; a query under two characters clears it.
- Arrow keys move the highlight, Enter accepts the highlighted item, Escape
  closes it, clicking outside closes it.
- Selecting an item sets `state.search.query` to its title, `type` to its type,
  and `tmdbId` to its id, then runs the search.
- Typing again clears `tmdbId`, so an edited query resolves by title as before.

`state.search` gains `tmdbId: null` and `suggestions: []`.

`runSearch` passes `tmdb_id` when set. The server already accepts it
(`routes/torrents.js` reads `req.query.tmdb_id`) and `resolveImdbId` already
treats an explicit id as authoritative, so no server change is needed for this.

### A3. Resolution ladder

`resolveImdbId` in `services/torrentSearch.js` currently makes one attempt per
media type. It gains an ordered ladder of query variants, stopping at the first
that yields an IMDB id:

1. **as typed**
2. **punctuation stripped** — `spider-man` → `spider man`
3. **run-together words split** — a query containing no spaces and longer than
   8 characters has spaces inserted around embedded common words (`and`, `the`,
   `of`, `in`, `on`, `a`, `an`), producing `rickandmorty` → `rick and morty`
   and `thematrix` → `the matrix`. Only variants that differ from the input are
   tried.
4. **trailing words dropped**, one at a time, down to a floor of two tokens and
   four characters — `rick and mortey` → `rick and`, which TMDB matches. The
   floor exists so a query never degrades to `the`.
5. **`/search/multi`** as a last resort, taking the highest-popularity movie or
   show result.

**Known limitation, stated plainly:** this ladder fixes joined words, stray
punctuation, and wrong or extra trailing words. It cannot fix a misspelling
*inside* a word — `inceptoin` and `the matrx` have no valid variant and will
still find nothing. That case is what autocomplete exists for, and the two
features are complementary rather than redundant.

### A4. Same-type preference

Within one media type, if the best match has no IMDB id, try the next
candidates (up to 5) before falling back to the other type. Only when every
same-type candidate is exhausted does the cross-type fallback run. This is what
stops `spiderman` resolving to a television series.

`findBestMovie` / `findBestShow` currently return a single candidate. They gain
sibling functions that return the ranked list:

```
rankMovies(title, year)  ->  candidates ordered best-first
rankShows(title, year)   ->  candidates ordered best-first
```

`bestOf` already computes this ordering; these expose it rather than
discarding all but the top entry.

---

## Phase B — Discovery rails

### B1. Cache table

Rails change slowly and recommendations cost one TMDB call per owned title, so
they are cached in SQLite rather than in memory. Added to `db/schema.sql`,
which runs on every boot with `IF NOT EXISTS` and so migrates itself:

```sql
CREATE TABLE IF NOT EXISTS discover_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`db/index.js` gains `readDiscover(key, ttlMs)` and `writeDiscover(key, data)`,
mirroring the existing `readMetadata` / `writeMetadata` pair including its
treatment of corrupt JSON as a cache miss.

### B2. Discover service

New `services/discover.js`, one clear job: assemble rails.

```
getRails({ force })  ->  [ { id, title, kind, items: [...] } ]
getDetails(tmdbId, type)  ->  full TMDB record (delegates to tmdb.getDetails)
```

A rail item is `{ tmdb_id, type, title, year, poster, backdrop, rating,
overview, owned }`.

| Rail id | Title | Source | TTL |
|---|---|---|---|
| `recent` | Popular recently | `/discover/movie?primary_release_date.gte=<60d>&sort_by=popularity.desc` and `/discover/tv?first_air_date.gte=<60d>&sort_by=popularity.desc`, merged and re-sorted by popularity | 6h |
| `recommended:<tmdbId>` | Because you watch <title> | `/movie/<id>/recommendations` or `/tv/<id>/recommendations` | 24h |
| `top` | Top rated | `/movie/top_rated` and `/tv/top_rated`, merged | 24h |

Each rail is capped at 20 items. Recommendation rails are built for the **3
most recently added** library titles, ordered by the same `added_at` the
"Recently Added" row already uses, so at most three appear.

`owned` is computed by checking each item's `tmdb_id` against the scanner's
current library snapshot — the library is already deduped by `tmdb_id`, so this
is a set membership test.

Rails are fetched through `tmdb.mapWithConcurrency` so one failure cannot abort
the rest; a rail that throws is omitted from the response, and a rail whose
source list is empty (no library, so no recommendations) is not rendered.

### B3. Routes

New `routes/discover.js`, mounted at `/api/discover`:

```
GET /api/discover              -> { rails: [...], generated_at }   ?force=1 bypasses cache
GET /api/discover/:type/:id    -> full TMDB detail record for the modal
```

`:type` is `movie` or `show`; anything else answers 400.

### B4. Home rails

`public/js/views.js` `renderHome` gains the rails below Recently Added, using
the existing `.rail` and card markup. `state.js` gains
`discover: { rails: [], status: 'idle', error: null }`, loaded once on boot
after the library, so Home never blocks on it.

Cards for unowned items carry `data-action="open-discover"` with the tmdb id and
type. Owned items render an **In library** badge and use the existing
`open-detail` action, so they behave exactly like a library card.

### B5. Detail modal for unowned titles

`open-discover` fetches `GET /api/discover/:type/:id` and renders through the
existing `renderDetailModal`, with two differences driven by the absence of
`files`:

- The **Play** button becomes **Find torrents**, which runs a search carrying
  the tmdb id and type.
- For shows, each episode row's `missing` badge becomes a **Find** button that
  searches that specific season and episode.

This is why the detail-modal route was chosen over jumping to results: the
modal already renders seasons and episodes, and that list is the natural place
to choose what to download.

---

## Error handling

| Situation | Behaviour |
|---|---|
| A rail's TMDB call fails | That rail is omitted; the others render. Logged once at warn. |
| Every rail fails | Home renders without the discovery section; no error toast, since the library is still usable. |
| Library is empty | Recommendation rails are skipped; `recent` and `top` still render. |
| Suggest endpoint fails | Dropdown stays closed. Typing and pressing Enter still works through the ladder. |
| Detail fetch fails | Toast with the reason; the modal does not open. |
| Torrent search from the modal finds nothing | Existing "No results" empty state, unchanged. |

---

## Testing

Both suites are integration tests against live TMDB, consistent with the
existing `tests/search-resolution.test.mjs` — a stub would encode the very
assumptions under test.

**`tests/search-resolution.test.mjs`** (extended):

- `rickandmorty` resolves to `tt2861424` via the joined-word variant
- `rick and mortey` resolves via trailing-word removal
- `spider-man` resolves to a **movie**, not a show
- `spiderman` resolves to a **movie**, not a show — the regression guard
- `inceptoin` returns nulls without throwing, documenting the known limitation
- a query of one character returns nulls without calling TMDB

**`tests/discover.test.mjs`** (new):

- every rail item carries the full shape, with `owned` a boolean
- `recent` contains only titles released within the window
- items already in the library are marked `owned`
- a rail whose source throws is omitted rather than failing the whole response
- `readDiscover` returns undefined past its TTL and the payload within it

---

## Build order

Phase A ships first and stands alone: autocomplete, the resolution ladder, and
the same-type fix, with its tests. Phase B follows. Neither depends on the
other, and Phase A addresses the complaint that is live today.
