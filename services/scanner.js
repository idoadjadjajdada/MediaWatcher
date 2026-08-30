/**
 * Filesystem scanner: walk the library, parse filenames, enrich via TMDB,
 * and collapse everything into one deduped library object.
 *
 * Performance shape (the 1000-files-in-10s bar):
 *   - the walk is an async generator over opendir(), so no giant array is built
 *   - one readdir per directory serves every file in it, subtitles included
 *   - TMDB lookups are grouped by unique title+year first, so a 200-episode
 *     show costs one search, not two hundred, and the rest come from cache
 *   - remaining network work runs through the concurrency-8 pool in tmdb.js
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import config, { createLogger } from '../config/index.js';
import * as tmdb from './tmdb.js';

const log = createLogger('scanner');

const VIDEO_EXTENSIONS = new Set(config.videoExtensions);
const SUBTITLE_EXTENSIONS = new Set(config.subtitleExtensions);
const IGNORED = new Set(config.ignoredDirectories.map((name) => name.toLowerCase()));

/* --------------------------------------------------------------------------
 * Filename parsing
 * ----------------------------------------------------------------------- */

// Tried in this order; the first hit wins.
const PATTERNS = {
  // Show.Name.S01E05 — with optional extra episodes: S01E05.E06 / S01E05E06
  sxxexx: /^(.*?)[\s._-]*s(\d{1,2})[\s._-]*e(\d{1,3})((?:[\s._-]*e\d{1,3})*)/i,
  // Show.Name.1x05
  altEpisode: /^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})/i,
  // Show.Name.Season 1 Episode 5
  verbose: /^(.*?)[\s._-]*season[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})/i,
  // Movie.Name.(2023) / [2023] / {2023}
  bracketYear: /^(.*?)[\s._-]*[([{](19\d{2}|20\d{2})[)\]}]/,
  // Movie.Name.2023.1080p
  bareYear: /^(.*?)[\s._-](19\d{2}|20\d{2})(?:[\s._-]|$)/
};

const SEASON_FOLDER = /^(?:season|series|s)[\s._-]*(\d{1,2})$/i;
const EXTRA_EPISODES = /e(\d{1,3})/gi;
const GROUP_PREFIX = /^\[[^\]]+\]\s*/;
const TRAILING_YEAR = /[\s._-]*[([{]?(19\d{2}|20\d{2})[)\]}]?$/;

// Release junk that trails a title once the year/episode marker is stripped.
const JUNK_TOKENS = new Set([
  '1080p', '720p', '2160p', '480p', '4k', 'uhd', 'hd', 'sd', 'hdr', 'hdr10', 'dv', 'sdr',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'xvid', 'divx', '10bit', '8bit',
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'webrip', 'web', 'webdl',
  'web-dl', 'hdtv', 'dvdrip', 'dvd', 'hdrip', 'cam', 'ts', 'tc',
  'aac', 'aac5', 'ac3', 'dts', 'dtshd', 'ddp', 'ddp5', 'dd5', 'eac3', 'atmos', 'truehd', 'flac',
  'proper', 'repack', 'internal', 'limited', 'extended', 'uncut', 'unrated', 'remastered',
  'imax', 'multi', 'dual', 'subbed', 'dubbed', 'complete'
]);

/** Turn a raw filename fragment into a human title. */
function cleanTitle(raw) {
  let title = String(raw || '')
    .replace(GROUP_PREFIX, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–\s]+|[-–\s]+$/g, '');

  // Drop trailing release junk ("The Movie 1080p x264" -> "The Movie").
  let tokens = title.split(' ');
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1].toLowerCase().replace(/[[\]()]/g, '');
    if (JUNK_TOKENS.has(last)) tokens.pop();
    else break;
  }
  title = tokens.join(' ').trim();

  return title;
}

/** Pull a year off the end of a title, returning both parts. */
function splitTrailingYear(title) {
  const match = TRAILING_YEAR.exec(title);
  if (!match) return { title, year: null };
  const stripped = title.slice(0, match.index).trim();
  // "2012" as a whole title is a film, not a year.
  if (!stripped) return { title, year: null };
  return { title: stripped, year: Number(match[1]) };
}

/**
 * Parse one video file into a media descriptor.
 *
 * Patterns are attempted in the spec's order, with folder layout as the final
 * fallback. Anything that survives all of them is bucketed as unknown.
 */
export function parseFile(absolutePath, libraryRoot = config.libraryPath) {
  const extension = path.extname(absolutePath);
  const stem = path.basename(absolutePath, extension);
  const relative = path.relative(libraryRoot, absolutePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const topLevel = (segments[0] || '').toLowerCase();

  const parentDir = path.basename(path.dirname(absolutePath));
  const grandparentDir = path.basename(path.dirname(path.dirname(absolutePath)));

  // Which folder names could carry a show title, best first.
  const seasonMatch = SEASON_FOLDER.exec(parentDir);
  const showFolderName = seasonMatch ? grandparentDir : parentDir;

  /* 1. SxxExx (with multi-episode support) */
  let match = PATTERNS.sxxexx.exec(stem);
  if (match) {
    const episodes = [Number(match[3])];
    for (const extra of String(match[4] || '').matchAll(EXTRA_EPISODES)) {
      const number = Number(extra[1]);
      if (!episodes.includes(number)) episodes.push(number);
    }
    const parsed = splitTrailingYear(cleanTitle(match[1]));
    const title = parsed.title || cleanTitle(showFolderName);
    if (title) {
      return { kind: 'episode', title, year: parsed.year, season: Number(match[2]), episodes, pattern: 'SxxExx' };
    }
  }

  /* 2. 1x05 */
  match = PATTERNS.altEpisode.exec(stem);
  if (match) {
    const parsed = splitTrailingYear(cleanTitle(match[1]));
    const title = parsed.title || cleanTitle(showFolderName);
    if (title) {
      return { kind: 'episode', title, year: parsed.year, season: Number(match[2]), episodes: [Number(match[3])], pattern: '1x05' };
    }
  }

  /* 3. Season X Episode Y */
  match = PATTERNS.verbose.exec(stem);
  if (match) {
    const parsed = splitTrailingYear(cleanTitle(match[1]));
    const title = parsed.title || cleanTitle(showFolderName);
    if (title) {
      return { kind: 'episode', title, year: parsed.year, season: Number(match[2]), episodes: [Number(match[3])], pattern: 'Season X Episode Y' };
    }
  }

  // Episode markers beat year markers, so movie patterns only run past here.

  /* 4. Movie.Name.(2023) */
  match = PATTERNS.bracketYear.exec(stem);
  if (match) {
    const title = cleanTitle(match[1]);
    if (title) return { kind: 'movie', title, year: Number(match[2]), pattern: '(year)' };
  }

  /* 5. Movie.Name.2023.1080p */
  match = PATTERNS.bareYear.exec(stem);
  if (match) {
    const title = cleanTitle(match[1]);
    if (title) return { kind: 'movie', title, year: Number(match[2]), pattern: 'bare year' };
  }

  /* 6. Folder inference */
  if (seasonMatch && grandparentDir) {
    const parsed = splitTrailingYear(cleanTitle(grandparentDir));
    if (parsed.title) {
      // Episode number is genuinely unknown here — the file lists under the
      // season with a null episode rather than being thrown away.
      return { kind: 'episode', title: parsed.title, year: parsed.year, season: Number(seasonMatch[1]), episodes: [null], pattern: 'folder' };
    }
  }

  if (topLevel === 'shows' && segments.length >= 2) {
    const parsed = splitTrailingYear(cleanTitle(segments[1]));
    if (parsed.title) {
      return { kind: 'episode', title: parsed.title, year: parsed.year, season: null, episodes: [null], pattern: 'folder' };
    }
  }

  if (topLevel === 'movies' && segments.length >= 2) {
    const folder = segments[segments.length - 2] === segments[0] ? stem : parentDir;
    const bracket = PATTERNS.bracketYear.exec(folder);
    const bare = PATTERNS.bareYear.exec(folder);
    const hit = bracket || bare;
    if (hit) {
      const title = cleanTitle(hit[1]);
      if (title) return { kind: 'movie', title, year: Number(hit[2]), pattern: 'folder' };
    }
    const parsed = splitTrailingYear(cleanTitle(folder));
    if (parsed.title) return { kind: 'movie', title: parsed.title, year: parsed.year, pattern: 'folder' };
  }

  return { kind: 'unknown', reason: 'filename and folder layout did not match any known pattern' };
}

/* --------------------------------------------------------------------------
 * Filesystem walk
 * ----------------------------------------------------------------------- */

/**
 * Yield one record per directory: its video files and a subtitle index.
 *
 * Streaming per directory keeps memory flat and means each directory is read
 * exactly once no matter how many videos it holds.
 */
export async function* walkLibrary(root) {
  const stack = [root];
  const visited = new Set();

  while (stack.length > 0) {
    const dir = stack.pop();

    let realDir;
    try {
      realDir = await fsp.realpath(dir);
    } catch {
      continue;
    }
    if (visited.has(realDir)) continue; // symlink loop guard
    visited.add(realDir);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      log.warn(`cannot read ${dir}: ${error.message}`);
      continue;
    }

    const videos = [];
    const subtitles = new Map(); // stem -> [{ path, ext, lang }]

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) stack.push(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        videos.push({ path: full, name: entry.name });
      } else if (SUBTITLE_EXTENSIONS.has(ext)) {
        const stem = path.basename(entry.name, ext);
        // "movie.en.srt" indexes under both "movie.en" and "movie".
        const languageMatch = /^(.*)\.([a-z]{2,3})$/i.exec(stem);
        const keys = languageMatch ? [stem, languageMatch[1]] : [stem];
        const lang = languageMatch ? languageMatch[2].toLowerCase() : null;

        for (const key of keys) {
          if (!subtitles.has(key)) subtitles.set(key, []);
          subtitles.get(key).push({ path: full, ext, lang });
        }
      }
    }

    if (videos.length > 0) yield { dir, videos, subtitles };
  }
}

/* --------------------------------------------------------------------------
 * TMDB enrichment
 * ----------------------------------------------------------------------- */

const lookupKey = (kind, title, year) =>
  `${kind}|${String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${year || ''}`;

function castOf(details) {
  return (details?.credits?.cast || []).slice(0, 10).map((person) => ({
    id: person.id,
    name: person.name,
    character: person.character || null,
    profile: tmdb.profileUrl(person.profile_path)
  }));
}

function baseFields(details, type) {
  const released = type === 'movie' ? details.release_date : details.first_air_date;
  return {
    tmdb_id: details.id,
    title: type === 'movie' ? details.title : details.name,
    year: released ? Number(String(released).slice(0, 4)) : null,
    poster: tmdb.posterUrl(details.poster_path),
    backdrop: tmdb.backdropUrl(details.backdrop_path),
    rating: typeof details.vote_average === 'number' ? Number(details.vote_average.toFixed(1)) : null,
    overview: details.overview || '',
    genres: (details.genres || []).map((genre) => genre.name),
    cast: castOf(details)
  };
}

/* --------------------------------------------------------------------------
 * Scan
 * ----------------------------------------------------------------------- */

let cachedLibrary = { movies: [], shows: [], unknown: [], last_scan_at: null, scanning: false };
let inFlight = null;

/** Last completed scan result. */
export function getLibrary() {
  return cachedLibrary;
}

export function isScanning() {
  return inFlight !== null;
}

/**
 * Full scan. Concurrent callers share one run rather than stacking scans.
 * `force: true` bypasses the 30-day TMDB cache.
 */
export function scanLibrary(options = {}) {
  if (inFlight) return inFlight;
  inFlight = runScan(options).finally(() => { inFlight = null; });
  return inFlight;
}

async function runScan({ force = false } = {}) {
  const started = Date.now();
  log.info(`scanning ${config.libraryPath}${force ? ' (forced TMDB refetch)' : ''}`);

  const files = [];
  const unknown = [];
  let fileCount = 0;

  // --- 1. Walk + parse -----------------------------------------------------
  for await (const { videos, subtitles } of walkLibrary(config.libraryPath)) {
    // mtime rides along with the size stat so "Recently Added" has an ordering.
    const stats = await Promise.all(videos.map(async (video) => {
      try {
        const stat = await fsp.stat(video.path);
        return { size: stat.size, added_at: Math.round(stat.mtimeMs) };
      } catch {
        return { size: 0, added_at: 0 };
      }
    }));

    videos.forEach((video, index) => {
      fileCount += 1;
      const parsed = parseFile(video.path);
      const stem = path.basename(video.name, path.extname(video.name));

      if (parsed.kind === 'unknown') {
        unknown.push({ file_path: video.path, reason: parsed.reason });
        return;
      }

      files.push({
        file_path: video.path,
        size: stats[index].size,
        added_at: stats[index].added_at,
        subtitles: (subtitles.get(stem) || []).map((sub) => ({ path: sub.path, ext: sub.ext, lang: sub.lang })),
        parsed
      });
    });
  }

  const walkMs = Date.now() - started;

  // --- 2. Resolve unique titles against TMDB -------------------------------
  const groups = new Map();
  for (const file of files) {
    const kind = file.parsed.kind === 'episode' ? 'show' : 'movie';
    const key = lookupKey(kind, file.parsed.title, kind === 'movie' ? file.parsed.year : null);
    if (!groups.has(key)) {
      groups.set(key, { kind, title: file.parsed.title, year: file.parsed.year, files: [] });
    }
    groups.get(key).files.push(file);
  }

  log.debug(`${fileCount} files, ${groups.size} unique titles to resolve`);

  const groupList = Array.from(groups.values());
  const resolutions = await tmdb.mapWithConcurrency(groupList, async (group) => {
    const match = group.kind === 'movie'
      ? await tmdb.findBestMovie(group.title, group.year)
      : await tmdb.findBestShow(group.title, group.year);

    if (!match) return { group, details: null };
    const details = group.kind === 'movie'
      ? await tmdb.getMovie(match.id, { force })
      : await tmdb.getShow(match.id, { force });

    return { group, details };
  });

  // --- 3. Build deduped entries -------------------------------------------
  const movies = new Map();
  const shows = new Map();
  const seasonsNeeded = new Map(); // `${showId}:${season}` -> { showId, season }

  resolutions.forEach((outcome, index) => {
    const group = groupList[index];

    if (outcome.status === 'rejected') {
      const reason = `TMDB lookup failed: ${outcome.reason?.message || outcome.reason}`;
      for (const file of group.files) unknown.push({ file_path: file.file_path, reason });
      return;
    }
    if (!outcome.value.details) {
      for (const file of group.files) {
        unknown.push({ file_path: file.file_path, reason: `no TMDB match for "${group.title}"` });
      }
      return;
    }

    const details = outcome.value.details;

    if (group.kind === 'movie') {
      // Dedupe by tmdb_id: the same film in two folders is one entry.
      if (!movies.has(details.id)) {
        movies.set(details.id, {
          ...baseFields(details, 'movie'),
          runtime: details.runtime || null,
          files: []
        });
      }
      const entry = movies.get(details.id);
      for (const file of group.files) {
        entry.files.push({ file_path: file.file_path, size: file.size, added_at: file.added_at, subtitles: file.subtitles });
      }
      return;
    }

    if (!shows.has(details.id)) {
      shows.set(details.id, {
        ...baseFields(details, 'show'),
        runtime: (details.episode_run_time || [])[0] || null,
        seasons: new Map()
      });
    }
    const show = shows.get(details.id);

    for (const file of group.files) {
      const seasonNumber = file.parsed.season ?? 0;
      if (!show.seasons.has(seasonNumber)) show.seasons.set(seasonNumber, new Map());
      const season = show.seasons.get(seasonNumber);

      if (file.parsed.season != null) {
        seasonsNeeded.set(`${details.id}:${seasonNumber}`, { showId: details.id, season: seasonNumber });
      }

      // A multi-episode file (S01E05E06) is listed under each episode it holds.
      for (const episodeNumber of file.parsed.episodes) {
        const key = episodeNumber ?? `unnumbered:${file.file_path}`;
        if (!season.has(key)) {
          season.set(key, {
            episode_number: episodeNumber,
            title: null,
            overview: '',
            still: null,
            air_date: null,
            files: []
          });
        }
        season.get(key).files.push({ file_path: file.file_path, size: file.size, added_at: file.added_at, subtitles: file.subtitles });
      }
    }
  });

  // --- 4. Episode titles ---------------------------------------------------
  await tmdb.mapWithConcurrency(Array.from(seasonsNeeded.values()), async ({ showId, season }) => {
    const details = await tmdb.getSeasonDetails(showId, season, { force });
    const bucket = shows.get(showId)?.seasons.get(season);
    if (!bucket) return;

    for (const episode of details.episodes || []) {
      const entry = bucket.get(episode.episode_number);
      if (!entry) continue;
      entry.title = episode.name || null;
      entry.overview = episode.overview || '';
      entry.still = tmdb.imageUrl(episode.still_path, config.tmdb.backdropSize);
      entry.air_date = episode.air_date || null;
      entry.runtime = episode.runtime || null;
    }
  });

  // --- 5. Shape the result -------------------------------------------------
  const library = {
    movies: Array.from(movies.values()).sort((a, b) => a.title.localeCompare(b.title)),
    shows: Array.from(shows.values())
      .map((show) => ({
        ...show,
        seasons: Array.from(show.seasons.entries())
          .map(([number, episodes]) => ({
            number,
            episodes: Array.from(episodes.values())
              .sort((a, b) => (a.episode_number ?? 999) - (b.episode_number ?? 999))
          }))
          .sort((a, b) => a.number - b.number)
      }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    unknown: unknown.sort((a, b) => a.file_path.localeCompare(b.file_path)),
    last_scan_at: Date.now(),
    scanning: false
  };

  const totalMs = Date.now() - started;
  log.info(
    `scan complete: ${fileCount} files in ${totalMs}ms (walk ${walkMs}ms) — `
    + `${library.movies.length} movies, ${library.shows.length} shows, ${library.unknown.length} unknown`
  );

  cachedLibrary = library;
  return library;
}

/** Force a single item to be refetched from TMDB on the next scan. */
export function invalidateItem(tmdbId, type) {
  return tmdb.invalidate(tmdbId, type);
}

/** Find the file entry for a path, used by the player for next-episode logic. */
export function findByPath(filePath) {
  const target = path.resolve(filePath);

  for (const movie of cachedLibrary.movies) {
    if (movie.files.some((file) => path.resolve(file.file_path) === target)) {
      return { type: 'movie', item: movie };
    }
  }
  for (const show of cachedLibrary.shows) {
    for (const season of show.seasons) {
      for (const episode of season.episodes) {
        if (episode.files.some((file) => path.resolve(file.file_path) === target)) {
          return { type: 'episode', item: show, season: season.number, episode };
        }
      }
    }
  }
  return null;
}

export default {
  scanLibrary,
  getLibrary,
  isScanning,
  parseFile,
  walkLibrary,
  invalidateItem,
  findByPath
};
