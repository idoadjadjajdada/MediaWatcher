/**
 * GET /api/subs?path= — subtitle discovery and delivery.
 *
 * Two sources, one endpoint:
 *   external  .srt/.vtt/.ass sitting next to the video (SRT converted to VTT)
 *   embedded  subtitle streams inside the container, extracted with ffmpeg —
 *             which is where MKV releases usually keep them
 *
 *   /api/subs?path=…              best available track, as text/vtt
 *   /api/subs?path=…&list=1       every track, as JSON, for the player menu
 *   /api/subs?path=…&lang=en      a specific language
 *   /api/subs?path=…&embedded=0   a specific embedded stream index
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config, { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as scanner from '../services/scanner.js';
import * as opensubtitles from '../services/opensubtitles.js';
import { fetchForFile, fetchForFiles } from '../services/subtitleFetch.js';

const log = createLogger('api:subs');
const router = express.Router();

// Browsers render WebVTT only; SRT is converted, ASS is served as plain text
// for download rather than pretended to be a usable track.
const PREFERRED_ORDER = ['.vtt', '.srt', '.ass'];
// Image-based subtitle formats cannot become VTT at all.
const BITMAP_CODECS = new Set(['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub']);

/**
 * Subtitle files beside `videoPath` whose stem matches, with or without a
 * language suffix ("Movie.srt", "Movie.en.srt").
 */
export function findSubtitles(videoPath) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const found = [];
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!config.subtitleExtensions.includes(ext)) continue;

    const base = path.basename(name, ext);
    if (base === stem) {
      found.push({ file: path.join(dir, name), ext, lang: null });
      continue;
    }

    const languageMatch = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([A-Za-z]{2,3})$`).exec(base);
    if (languageMatch) {
      found.push({ file: path.join(dir, name), ext, lang: languageMatch[1].toLowerCase() });
    }
  }

  return found.sort((a, b) => PREFERRED_ORDER.indexOf(a.ext) - PREFERRED_ORDER.indexOf(b.ext));
}

/**
 * Decode a subtitle file. Subtitles are frequently Windows-1252 rather than
 * UTF-8; a replacement character in the UTF-8 attempt means we guessed wrong.
 */
function readText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const utf8 = buffer.toString('utf8');
  return utf8.includes(String.fromCharCode(0xFFFD)) ? buffer.toString('latin1') : utf8;
}

/** SubRip → WebVTT: header, dot decimals, and zero-padded hours. */
export function srtToVtt(input) {
  const body = input
    .replace(new RegExp('^' + String.fromCharCode(0xFEFF)), '')
    .replace(/\r\n|\r/g, '\n')
    .replace(
      /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/g,
      (_match, hours, minutes, seconds, millis) => `${String(hours).padStart(2, '0')}:${minutes}:${seconds}.${millis}`
    )
    .trim();

  return `WEBVTT\n\n${body}\n`;
}

router.get('/', async (req, res, next) => {
  try {
    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const videoPath = path.resolve(requested);
    if (!isInsideLibrary(videoPath)) {
      log.warn(`refused subtitle read outside library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    const external = findSubtitles(videoPath);
    const info = await transcoder.probe(videoPath);
    // Bitmap subtitles would need OCR, so they are not offered as tracks.
    const embedded = (info?.subtitles || []).filter((track) => !BITMAP_CODECS.has(track.codec));

    /* ---- list mode ---- */
    if (req.query.list === '1' || req.query.list === 'true') {
      return res.json([
        ...external.map((entry) => ({
          source: 'external',
          lang: entry.lang,
          ext: entry.ext,
          label: entry.lang ? entry.lang.toUpperCase() : 'External',
          path: entry.file
        })),
        ...embedded.map((track) => ({
          source: 'embedded',
          index: track.index,
          lang: track.language,
          codec: track.codec,
          forced: track.forced,
          label: track.title
            || `${(track.language || 'Embedded').toUpperCase()}${track.forced ? ' (forced)' : ''}`
        }))
      ]);
    }

    /* ---- an explicitly requested embedded track ---- */
    if (req.query.embedded !== undefined) {
      const index = Number(req.query.embedded);
      if (!Number.isInteger(index) || !embedded.some((track) => track.index === index)) {
        return res.status(404).json({ error: `no embedded subtitle stream ${req.query.embedded}` });
      }
      return pipeEmbedded(res, videoPath, index);
    }

    /* ---- pick the best track ---- */
    const wanted = req.query.lang ? String(req.query.lang).toLowerCase() : null;

    const externalChoice = wanted
      ? external.find((entry) => entry.lang === wanted)
      : external[0];

    if (externalChoice) {
      let text;
      try {
        text = readText(externalChoice.file);
      } catch (error) {
        log.error(`cannot read ${externalChoice.file}: ${error.message}`);
        return res.status(500).json({ error: 'subtitle file could not be read' });
      }

      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Subtitle-Source', 'external');

      if (externalChoice.ext === '.ass') {
        // No native ASS renderer exists in the <track> element.
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(text);
      }

      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return res.send(externalChoice.ext === '.srt' ? srtToVtt(text) : text);
    }

    // Nothing beside the file — fall back to what is inside it.
    const embeddedChoice = wanted
      ? embedded.find((track) => track.language === wanted)
      : embedded.find((track) => track.default) || embedded[0];

    if (embeddedChoice) {
      return pipeEmbedded(res, videoPath, embeddedChoice.index);
    }

    return res.status(404).json({ error: 'no subtitles found for this file' });
  } catch (error) {
    next(error);
  }
});

/** Stream one embedded track through ffmpeg's WebVTT muxer. */
function pipeEmbedded(res, videoPath, index) {
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Subtitle-Source', 'embedded');

  const { stream, kill } = transcoder.extractSubtitle(videoPath, index);

  stream.on('error', (error) => {
    log.warn(`embedded subtitle extraction failed: ${error.message}`);
    kill();
    res.destroy();
  });
  res.on('close', kill);

  return stream.pipe(res);
}

/* --------------------------------------------------------------------------
 * Fetching from OpenSubtitles
 *
 * Everything below writes sidecar files that the discovery above then picks
 * up on its own. Nothing here teaches the player a second way to load a
 * subtitle; it only puts more files where the first way already looks.
 * ----------------------------------------------------------------------- */

/**
 * What this deployment can actually do.
 *
 * The player asks once and hides the fetch controls when downloading is off,
 * which is friendlier than offering a button that always answers 503.
 */
router.get('/capabilities', (_req, res) => {
  res.json({
    search: opensubtitles.enabled(),
    download: opensubtitles.downloadable(),
    languages: config.opensubtitles.languages
  });
});

/** Every episode of a season, in order, with the numbers a search needs. */
function seasonEntries(showId, seasonNumber) {
  const library = scanner.getLibrary();
  const show = (library.shows || []).find((s) => s.tmdb_id === showId);
  const season = (show?.seasons || []).find((s) => s.number === seasonNumber);
  if (!season) return [];

  return (season.episodes || [])
    .slice()
    .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    .map((episode) => ({
      path: episode.files?.[0]?.file_path,
      tmdbId: showId,
      season: seasonNumber,
      episode: episode.episode_number
    }))
    .filter((entry) => Boolean(entry.path));
}

/**
 * The quota reported by the most recent result that knew one.
 *
 * Results that never reached the download step carry no quota figure, so the
 * last element is not reliably the last *known* number.
 */
function lastKnownRemaining(results) {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const value = results[i].remaining;
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Parse an integer query or body field, or undefined when absent. */
function intOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * GET /api/subs/search — candidates for a file, ranked, without downloading.
 *
 * Separate from the fetch so a viewer who dislikes the automatic pick can see
 * the alternatives. Ranking happens here rather than in the client because the
 * score depends on the video's file name, which the client would have to be
 * handed anyway.
 */
router.get('/search', async (req, res, next) => {
  try {
    if (!opensubtitles.enabled()) {
      return res.status(503).json({ error: 'OpenSubtitles is not configured' });
    }

    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const videoPath = path.resolve(requested);
    if (!isInsideLibrary(videoPath)) {
      log.warn(`refused subtitle search outside library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    const candidates = await opensubtitles.search({
      tmdbId: intOrUndefined(req.query.tmdbId),
      season: intOrUndefined(req.query.season),
      episode: intOrUndefined(req.query.episode),
      languages: req.query.lang ? String(req.query.lang) : undefined,
      query: req.query.tmdbId ? undefined : path.basename(videoPath, path.extname(videoPath))
    });

    const videoName = path.basename(videoPath);
    return res.json(
      candidates
        .map((candidate) => ({ ...candidate, score: Math.round(opensubtitles.scoreCandidate(candidate, videoName)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 25)
    );
  } catch (error) {
    if (error.name === 'OpenSubtitlesError') {
      return res.status(error.status).json({ error: error.message });
    }
    return next(error);
  }
});

/**
 * POST /api/subs/fetch — download one subtitle and save it beside the video.
 *
 * Answers 200 for every outcome the fetch itself defines, including `none`
 * and `skipped`: "no French subtitles exist for this episode" is a result, not
 * a failure of the request. Only a refused or unconfigured request is an error
 * status.
 */
router.post('/fetch', async (req, res, next) => {
  try {
    const { path: requested, tmdbId, season, episode, lang, force } = req.body || {};
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!opensubtitles.downloadable()) {
      return res.status(503).json({ error: 'OpenSubtitles credentials are not configured' });
    }

    const videoPath = path.resolve(requested);
    if (!isInsideLibrary(videoPath)) {
      log.warn(`refused subtitle fetch outside library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    const result = await fetchForFile(videoPath, {
      tmdbId: intOrUndefined(tmdbId),
      season: intOrUndefined(season),
      episode: intOrUndefined(episode),
      language: lang ? String(lang) : undefined,
      force: force === true || force === 'true'
    });

    return res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/subs/fetch-season — one subtitle per episode of a season.
 *
 * Runs to completion before answering rather than streaming progress. A season
 * is tens of files and the fetch is sequential, so this can take a minute; the
 * caller is expected to show a pending state and read the per-episode
 * breakdown out of the response.
 */
router.post('/fetch-season', async (req, res, next) => {
  try {
    const { tmdbId, season, lang, force } = req.body || {};
    const showId = intOrUndefined(tmdbId);
    const seasonNumber = intOrUndefined(season);

    if (showId === undefined || seasonNumber === undefined) {
      return res.status(400).json({ error: 'tmdbId and season are required' });
    }
    if (!opensubtitles.downloadable()) {
      return res.status(503).json({ error: 'OpenSubtitles credentials are not configured' });
    }

    const entries = seasonEntries(showId, seasonNumber);
    if (entries.length === 0) {
      return res.status(404).json({ error: `no episodes found for show ${showId} season ${seasonNumber}` });
    }

    log.info(`bulk subtitle fetch: show ${showId} season ${seasonNumber}, ${entries.length} episodes`);

    const results = await fetchForFiles(entries, {
      language: lang ? String(lang) : undefined,
      force: force === true || force === 'true'
    });

    const tally = results.reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {});

    return res.json({
      season: seasonNumber,
      requested: entries.length,
      // Fewer results than episodes means the run stopped early, which only
      // happens when the account's download quota ran out mid-season.
      attempted: results.length,
      tally,
      remaining: lastKnownRemaining(results),
      results
    });
  } catch (error) {
    next(error);
  }
});

export default router;
