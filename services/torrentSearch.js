/**
 * Multi-source search aggregator.
 *
 * Sources are registered in the SOURCES array below. Adding an indexer means
 * writing one `search()` function and appending one entry — the merge, the
 * dedupe by infoHash, the ranking and the whole download path downstream are
 * source-agnostic. A source only has to produce an infoHash or a magnet.
 *
 * Every source runs in parallel under its own timeout. One dead source never
 * fails a search; a SearchError is thrown only when every enabled source fails.
 */
import axios from 'axios';
import config, { createLogger } from '../config/index.js';
import { rankResults } from './qualityRanker.js';
import * as alldebrid from './alldebrid.js';
import { getImdbId, rankMovies, rankShows } from './tmdb.js';

const log = createLogger('search');

export class SearchError extends Error {
  constructor(message, status = 502, details) {
    super(message);
    this.name = 'SearchError';
    this.status = status;
    this.details = details || null;
  }
}

/* --------------------------------------------------------------------------
 * Magnet helpers
 * ----------------------------------------------------------------------- */

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];

const HASH_PATTERN = /\b([a-f0-9]{40}|[a-z2-7]{32})\b/i;

/** Pull a 40-hex (or base32) infohash out of a magnet URI or raw string. */
export function extractInfoHash(value) {
  if (!value) return null;
  const fromMagnet = /xt=urn:btih:([a-z0-9]+)/i.exec(value);
  const hash = fromMagnet ? fromMagnet[1] : (HASH_PATTERN.exec(value)?.[1] || null);
  return hash ? hash.toLowerCase() : null;
}

/** Build a magnet from an infohash, carrying any tracker hints the source gave us. */
export function buildMagnet(infoHash, title, extraTrackers = []) {
  if (!infoHash) return null;
  const trackers = [...new Set([...extraTrackers, ...TRACKERS])];
  const params = trackers.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title || infoHash)}${params}`;
}

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

function parseSize(text) {
  const match = /([\d.]+)\s*(TB|GB|MB|KB|B)/i.exec(String(text || ''));
  if (!match) return 0;
  return Math.round(Number(match[1]) * (SIZE_UNITS[match[2].toLowerCase()] || 1));
}

/* --------------------------------------------------------------------------
 * Source: AllDebrid cached torrents
 * ----------------------------------------------------------------------- */

async function searchAllDebrid({ query }) {
  const torrents = await alldebrid.searchCached(query);
  return torrents.map((entry) => ({
    title: entry.name,
    infoHash: entry.hash ? entry.hash.toLowerCase() : null,
    magnet: entry.hash ? buildMagnet(entry.hash.toLowerCase(), entry.name) : null,
    size_bytes: entry.size,
    seeders: entry.seeders,
    source: 'alldebrid'
  }));
}

/* --------------------------------------------------------------------------
 * Source: Torrentio
 *
 * Which trackers Torrentio queries is set by TORRENTIO_CONFIG — the option
 * segment from torrentio.strem.fun/configure. No code change needed to add one.
 * ----------------------------------------------------------------------- */

async function searchTorrentio({ type, imdbId, season, episode, signal }) {
  if (!imdbId) {
    throw new SearchError('Torrentio needs an IMDB id and TMDB did not provide one', 404);
  }

  const kind = type === 'show' || type === 'series' || type === 'episode' ? 'series' : 'movie';
  const streamId = kind === 'series' && season != null && episode != null
    ? `${imdbId}:${season}:${episode}`
    : imdbId;

  const segment = config.torrentio.configSegment ? `/${config.torrentio.configSegment}` : '';
  const url = `${config.torrentio.baseUrl}${segment}/stream/${kind}/${encodeURIComponent(streamId)}.json`;

  const response = await axios.get(url, { timeout: config.torrentio.timeoutMs, signal });
  const streams = response.data?.streams || [];

  return streams.map((stream) => {
    // title is multi-line: "Release.Name\n👤 1234 💾 2.1 GB ⚙️ provider"
    const lines = String(stream.title || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const releaseTitle = stream.behaviorHints?.filename || lines[0] || stream.name || '';
    const meta = lines.slice(1).join(' ');

    const seeders = Number(/👤\s*(\d+)/.exec(meta)?.[1] || /(\d+)\s*seed/i.exec(meta)?.[1] || 0);
    const sizeBytes = parseSize(/💾\s*([\d.]+\s*[KMGT]?B)/i.exec(meta)?.[1] || meta);
    const provider = /⚙️\s*([^\s]+)/.exec(meta)?.[1] || null;

    const infoHash = stream.infoHash ? String(stream.infoHash).toLowerCase() : extractInfoHash(stream.url);
    const trackerHints = (stream.sources || [])
      .filter((entry) => typeof entry === 'string' && entry.startsWith('tracker:'))
      .map((entry) => entry.slice('tracker:'.length));

    return {
      title: releaseTitle,
      infoHash,
      magnet: buildMagnet(infoHash, releaseTitle, trackerHints),
      size_bytes: sizeBytes,
      seeders,
      source: 'torrentio',
      indexer: provider
    };
  }).filter((entry) => entry.infoHash);
}

/* --------------------------------------------------------------------------
 * Source: Jackett
 *
 * Jackett owns the site definitions, the logins and the Cloudflare handling;
 * MediaWatcher just reads its JSON results endpoint. Add a tracker in Jackett's
 * dashboard and it shows up here with no changes on this side.
 * ----------------------------------------------------------------------- */

const JACKETT_CATEGORIES = { movie: 2000, show: 5000 };

async function searchJackett({ query, type, season, episode, signal }) {
  const base = `${config.jackett.url}/api/v2.0/indexers/${encodeURIComponent(config.jackett.indexers)}/results`;

  // Jackett has no IMDB lookup for most trackers, so episodes go out as "Show S01E05".
  const term = type === 'show' && season != null && episode != null
    ? `${query} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : query;

  const params = new URLSearchParams({ apikey: config.jackett.apiKey, Query: term });
  params.append('Category[]', String(JACKETT_CATEGORIES[type] || JACKETT_CATEGORIES.movie));

  const response = await axios.get(`${base}?${params.toString()}`, {
    timeout: config.jackett.timeoutMs,
    signal
  });

  const rows = response.data?.Results || [];
  return rows.map((row) => {
    const infoHash = (row.InfoHash && String(row.InfoHash).toLowerCase())
      || extractInfoHash(row.MagnetUri)
      || extractInfoHash(row.Guid)
      || extractInfoHash(row.Link);

    const title = row.Title || '';
    return {
      title,
      infoHash,
      magnet: row.MagnetUri || buildMagnet(infoHash, title),
      size_bytes: Number(row.Size) || 0,
      seeders: Number(row.Seeders) || 0,
      source: 'jackett',
      indexer: row.Tracker || null
    };
    // Rows with neither a magnet nor a hash are .torrent-file-only results;
    // AllDebrid takes magnets, so they are dropped rather than half-supported.
  }).filter((entry) => entry.infoHash || (entry.magnet && entry.magnet.startsWith('magnet:')));
}

/* --------------------------------------------------------------------------
 * Registry
 *
 * To add a source: write an async search({ query, type, imdbId, season,
 * episode, signal }) that returns unified results, then add a line here.
 * ----------------------------------------------------------------------- */

const SOURCES = [
  {
    id: 'alldebrid',
    label: 'AllDebrid cache',
    enabled: () => Boolean(config.alldebrid.apiKey),
    search: searchAllDebrid
  },
  {
    id: 'torrentio',
    label: 'Torrentio',
    enabled: () => true,
    search: searchTorrentio
  },
  {
    id: 'jackett',
    label: 'Jackett',
    enabled: () => Boolean(config.jackett.url && config.jackett.apiKey),
    search: searchJackett
  }
];

/** Which sources would run right now — surfaced by /api/search for the UI. */
export function listSources() {
  return SOURCES.map(({ id, label }) => ({ id, label, enabled: SOURCES.find((s) => s.id === id).enabled() }));
}

function withTimeout(promiseFactory, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return Promise.resolve(promiseFactory(controller.signal))
    .catch((error) => {
      if (controller.signal.aborted) throw new SearchError(`${label} timed out after ${ms}ms`, 504);
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

/* --------------------------------------------------------------------------
 * Merge
 * ----------------------------------------------------------------------- */

function mergeResults(batches) {
  const byHash = new Map();

  for (const result of batches.flat()) {
    if (!result.title) continue;
    const key = result.infoHash || `title:${result.title.toLowerCase()}`;
    const existing = byHash.get(key);

    if (!existing) {
      byHash.set(key, { ...result, sources: [result.source], indexers: result.indexer ? [result.indexer] : [] });
      continue;
    }

    // Same release from several sources: keep the richest view of it.
    existing.seeders = Math.max(existing.seeders || 0, result.seeders || 0);
    existing.size_bytes = existing.size_bytes || result.size_bytes;
    existing.magnet = existing.magnet || result.magnet;
    if (String(result.title).length > String(existing.title).length) existing.title = result.title;
    if (!existing.sources.includes(result.source)) existing.sources.push(result.source);
    if (result.indexer && !existing.indexers.includes(result.indexer)) existing.indexers.push(result.indexer);
  }

  return Array.from(byHash.values()).map((entry) => ({
    ...entry,
    // A hit in the AllDebrid cache means instant download, so it wins the badge.
    source: entry.sources.includes('alldebrid') ? 'alldebrid' : entry.sources[0],
    cached: entry.sources.includes('alldebrid')
  }));
}

/* --------------------------------------------------------------------------
 * Public entry point
 * ----------------------------------------------------------------------- */

/**
 * Query every enabled source in parallel and return ranked, deduped results.
 *
 * @param {object} options
 * @param {string} options.query    Title to search for
 * @param {'movie'|'show'} options.type
 * @param {number} [options.tmdbId] Used to resolve an IMDB id for Torrentio
 * @param {string} [options.imdbId] Skips the TMDB lookup when already known
 * @param {number} [options.season]
 * @param {number} [options.episode]
 */
/**
 * Resolve a title to the IMDB id Torrentio is keyed on.
 *
 * The requested media type is a hint, not a verdict. TMDB will happily match a
 * *different* work of the requested type — searching "Rick and Morty" as a
 * movie finds an unrelated film with no IMDB id at all, which leaves Torrentio
 * nothing to query and fails the only always-on source. Since the type
 * selector defaults to "movie", that is what a user gets by typing a show name
 * and pressing Search.
 *
 * So: try the requested type, and fall back to the other one when it yields no
 * IMDB id. An explicitly supplied tmdb_id or imdb_id is authoritative and is
 * never second-guessed.
 *
 * @returns {Promise<{ tmdbId: number|null, imdbId: string|null, type: 'movie'|'show' }>}
 */
export async function resolveImdbId({ query, type = 'movie', tmdbId, imdbId } = {}) {
  const wanted = type === 'show' ? 'show' : 'movie';

  if (imdbId) return { tmdbId: tmdbId ?? null, imdbId, type: wanted };

  try {
    if (tmdbId) {
      return { tmdbId, imdbId: await getImdbId(tmdbId, wanted), type: wanted };
    }
    if (!query) return { tmdbId: null, imdbId: null, type: wanted };

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

    const primary = await attempt(wanted);
    if (primary) return primary;

    const other = wanted === 'show' ? 'movie' : 'show';
    const fallback = await attempt(other);
    if (fallback) {
      log.info(`"${query}" did not resolve as a ${wanted}; using the ${other} match instead`);
      return fallback;
    }
  } catch (error) {
    log.warn(`could not resolve an IMDB id for "${query || tmdbId}": ${error.message}`);
  }

  return { tmdbId: null, imdbId: null, type: wanted };
}

export async function search({ query, type = 'movie', tmdbId, imdbId, season, episode, limit } = {}) {
  if (!query && !tmdbId && !imdbId) {
    throw new SearchError('search requires a query or a tmdb_id', 400);
  }

  const resolved = await resolveImdbId({ query, type, tmdbId, imdbId });
  const resolvedImdb = resolved.imdbId;
  const resolvedTmdb = resolved.tmdbId;

  const active = SOURCES.filter((source) => source.enabled());
  if (active.length === 0) throw new SearchError('No search sources are enabled', 503);

  // Search the type we actually resolved, not the one that was asked for: a
  // show found via the fallback has to reach Torrentio's series endpoint.
  const context = { query, type: resolved.type, tmdbId, imdbId: resolvedImdb, season, episode };

  const settled = await Promise.all(active.map(async (source) => {
    const started = Date.now();
    try {
      const results = await withTimeout(
        (signal) => source.search({ ...context, signal }),
        config.search.sourceTimeoutMs,
        source.label
      );
      log.debug(`${source.id}: ${results.length} results in ${Date.now() - started}ms`);
      return { id: source.id, label: source.label, ok: true, count: results.length, ms: Date.now() - started, results };
    } catch (error) {
      log.warn(`${source.id} failed: ${error.message}`);
      return { id: source.id, label: source.label, ok: false, count: 0, ms: Date.now() - started, error: error.message, results: [] };
    }
  }));

  if (settled.every((entry) => !entry.ok)) {
    throw new SearchError('All search sources failed', 502, settled.map(({ id, error }) => ({ id, error })));
  }

  const merged = mergeResults(settled.map((entry) => entry.results));
  const ranked = rankResults(merged).slice(0, limit || config.search.maxResults);

  return {
    query,
    type,
    // What the title actually resolved as, which can differ from `type` when
    // the fallback kicked in. The UI uses this to correct its own selector.
    resolved_type: resolved.type,
    tmdb_id: resolvedTmdb,
    imdb_id: resolvedImdb,
    total: ranked.length,
    results: ranked,
    sources: settled.map(({ results: _ignored, ...meta }) => meta)
  };
}

export default { search, listSources, buildMagnet, extractInfoHash, SearchError };
