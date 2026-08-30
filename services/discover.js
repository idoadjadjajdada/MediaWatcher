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
 * Reading it off the payload would produce rails of blank titles.
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
