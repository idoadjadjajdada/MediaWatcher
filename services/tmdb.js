/**
 * TMDB v3 client with read-through caching.
 *
 * Cache keys: `metadata_cache.tmdb_id` is a bare INTEGER primary key, but TMDB
 * numbers movies and shows in separate namespaces — movie 1399 and show 1399
 * both exist. Shows are therefore stored under the negated id so the two can
 * never evict each other. `cacheKey()` is the only place that knows this.
 *
 * Detail payloads live in SQLite (30-day TTL). Search responses are volatile
 * and not keyed by a tmdb_id, so they use a short-lived in-memory cache.
 */
import axios from 'axios';
import config, { createLogger } from '../config/index.js';
import { getMetadataRow, readMetadata, writeMetadata, deleteMetadata } from '../db/index.js';

const log = createLogger('tmdb');

export class TmdbError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'TmdbError';
    this.status = status ?? 502;
    this.code = code ?? null;
  }
}

const http = axios.create({
  baseURL: config.tmdb.baseUrl,
  timeout: config.tmdb.timeoutMs,
  params: { api_key: config.tmdb.apiKey, language: config.tmdb.language }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET with retry on 429 / 5xx / network errors. */
async function request(path, params = {}, attempt = 1) {
  try {
    const response = await http.get(path, { params });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const retryable = status === undefined || status === 429 || status >= 500;

    if (retryable && attempt < 3) {
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 300 * 2 ** (attempt - 1);
      log.debug(`retrying ${path} in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return request(path, params, attempt + 1);
    }

    const body = error.response?.data;
    const message = body?.status_message || error.message || 'TMDB request failed';
    throw new TmdbError(`TMDB ${path}: ${message}`, status, body?.status_code);
  }
}

/* --------------------------------------------------------------------------
 * Cache plumbing
 * ----------------------------------------------------------------------- */

const cacheKey = (tmdbId, type) => (type === 'show' ? -Number(tmdbId) : Number(tmdbId));

function readCached(tmdbId, type) {
  const key = cacheKey(tmdbId, type);
  const row = getMetadataRow(key);
  if (!row || row.type !== type) return undefined;
  return readMetadata(key);
}

function writeCached(tmdbId, type, data) {
  writeMetadata(cacheKey(tmdbId, type), type, data);
  return data;
}

/** Drop a cached item so the next read refetches. Used by /api/media/refresh. */
export function invalidate(tmdbId, type) {
  return deleteMetadata(cacheKey(tmdbId, type));
}

// Search results churn (new releases, popularity) and are not tmdb_id-keyed,
// so they stay in memory for 10 minutes rather than going to SQLite.
const SEARCH_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map();

function memo(key, producer) {
  const hit = searchCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = producer().catch((error) => {
    searchCache.delete(key);
    throw error;
  });
  searchCache.set(key, { value, expires: Date.now() + SEARCH_TTL_MS });
  return value;
}

/* --------------------------------------------------------------------------
 * Concurrency pool
 * ----------------------------------------------------------------------- */

/**
 * Map `items` through `worker` with at most `limit` in flight. Rejections are
 * captured per item so one bad lookup cannot abort a whole library scan.
 * Returns [{ status, value | reason }] in input order.
 */
export async function mapWithConcurrency(items, worker, limit = config.tmdb.concurrency) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let cursor = 0;

  const runner = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runner));
  return results;
}

/* --------------------------------------------------------------------------
 * Search + best-match selection
 * ----------------------------------------------------------------------- */

const normalize = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export function searchMovies(query, year) {
  const params = { query, include_adult: false };
  if (year) params.primary_release_year = year;
  return memo(`movie:${normalize(query)}:${year || ''}`, async () => {
    const data = await request('/search/movie', params);
    return data.results || [];
  });
}

export function searchShows(query, year) {
  const params = { query, include_adult: false };
  if (year) params.first_air_date_year = year;
  return memo(`show:${normalize(query)}:${year || ''}`, async () => {
    const data = await request('/search/tv', params);
    return data.results || [];
  });
}

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

/**
 * Score a search hit against the parsed filename. Exact title match dominates,
 * year agreement breaks near-ties, popularity settles the rest — this is what
 * keeps "Inception" off "Inception: The Cobol Job".
 */
function matchScore(candidate, wantedTitle, wantedYear) {
  const title = normalize(candidate.title || candidate.name);
  const original = normalize(candidate.original_title || candidate.original_name);
  const wanted = normalize(wantedTitle);

  let score = 0;
  if (title === wanted || original === wanted) score += 10;
  else if (title.startsWith(wanted) || wanted.startsWith(title)) score += 6;
  else if (title.includes(wanted) || wanted.includes(title)) score += 3;

  const released = candidate.release_date || candidate.first_air_date || '';
  const candidateYear = Number(released.slice(0, 4)) || null;
  if (wantedYear && candidateYear) {
    const drift = Math.abs(candidateYear - wantedYear);
    if (drift === 0) score += 5;
    else if (drift === 1) score += 2;
    else score -= drift;
  }

  // Popularity is a tiebreak, never a decider.
  score += Math.min(2, Math.log10((candidate.vote_count || 0) + 1));
  score += Math.min(1, (candidate.popularity || 0) / 100);
  if (!released) score -= 1;

  return score;
}

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

/* --------------------------------------------------------------------------
 * Details
 * ----------------------------------------------------------------------- */

export async function getMovie(tmdbId, { force = false } = {}) {
  if (!force) {
    const cached = readCached(tmdbId, 'movie');
    if (cached) return cached;
  }
  const data = await request(`/movie/${tmdbId}`, { append_to_response: 'credits,external_ids' });
  return writeCached(tmdbId, 'movie', data);
}

export async function getShow(tmdbId, { force = false } = {}) {
  if (!force) {
    const cached = readCached(tmdbId, 'show');
    if (cached) return cached;
  }
  const data = await request(`/tv/${tmdbId}`, { append_to_response: 'credits,external_ids' });
  return writeCached(tmdbId, 'show', data);
}

/**
 * Season details (episode titles, stills, air dates).
 *
 * Seasons have their own TMDB ids but the cache table only accepts
 * 'movie' | 'show', so seasons ride along inside the parent show's blob under
 * `_mw_seasons`. Their freshness is the show's freshness, which is correct:
 * refetching a show should refetch its episode list too.
 */
export async function getSeasonDetails(showTmdbId, seasonNumber, { force = false } = {}) {
  const show = await getShow(showTmdbId, { force });
  const key = String(seasonNumber);

  if (!force && show._mw_seasons && show._mw_seasons[key]) return show._mw_seasons[key];

  const season = await request(`/tv/${showTmdbId}/season/${seasonNumber}`);
  show._mw_seasons = { ...(show._mw_seasons || {}), [key]: season };
  writeCached(showTmdbId, 'show', show);
  return season;
}

/** Full detail record for either type. */
export function getDetails(tmdbId, type, options) {
  return type === 'show' ? getShow(tmdbId, options) : getMovie(tmdbId, options);
}

/**
 * IMDB id (tt…) for a TMDB id — Torrentio and most indexers key on it.
 * Returns null when TMDB has no external id on file.
 */
export async function getImdbId(tmdbId, type) {
  const details = await getDetails(tmdbId, type);
  const imdb = details?.external_ids?.imdb_id || details?.imdb_id || null;
  return imdb || null;
}

/* --------------------------------------------------------------------------
 * Images
 * ----------------------------------------------------------------------- */

export function imageUrl(filePath, size) {
  if (!filePath) return null;
  return `${config.tmdb.imageBaseUrl}/${size}${filePath}`;
}

export const posterUrl = (p) => imageUrl(p, config.tmdb.posterSize);
export const backdropUrl = (p) => imageUrl(p, config.tmdb.backdropSize);
export const profileUrl = (p) => imageUrl(p, config.tmdb.profileSize);

/** Clear the in-memory search cache (used by forced rescans). */
export function clearSearchCache() {
  searchCache.clear();
}

export default {
  searchMovies,
  searchShows,
  searchMulti,
  toSuggestion,
  suggest,
  findBestMovie,
  findBestShow,
  rankMovies,
  rankShows,
  getMovie,
  getShow,
  getDetails,
  getSeasonDetails,
  getImdbId,
  invalidate,
  mapWithConcurrency,
  imageUrl,
  posterUrl,
  backdropUrl,
  profileUrl,
  clearSearchCache,
  TmdbError
};
