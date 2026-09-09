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
 *   /api/subs?path=…&embedded=0&raw=1   that stream as ASS rather than WebVTT
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config, { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as subtitleSync from '../services/subtitleSync.js';
import * as scanner from '../services/scanner.js';
import * as opensubtitles from '../services/opensubtitles.js';
import { fetchForFile, fetchForFiles } from '../services/subtitleFetch.js';
import { upstreamStatus } from '../middleware/errorHandler.js';

const log = createLogger('api:subs');
const router = express.Router();

// A <track> element renders WebVTT only, so SRT is converted to it. ASS is
// served as-is instead: the player parses and draws it itself, because
// flattening it to WebVTT discards the positioning and styling that is the
// whole reason a release shipped ASS.
const PREFERRED_ORDER = ['.vtt', '.srt', '.ass'];
// Image-based subtitle formats cannot become VTT at all.
const BITMAP_CODECS = new Set(['dvd_subtitle', 'hdmv_pgs_subtitle', 'dvb_subtitle', 'xsub']);
// Text formats that carry styling and positioning a <track> element cannot express.
const STYLED_CODECS = new Set(['ass', 'ssa']);

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

/**
 * Cue timings out of WebVTT or SRT, in seconds.
 *
 * Only the timings — the text is irrelevant to everything that uses this, and
 * skipping it means the parser has no opinion about markup, positioning cues,
 * or the many ways a subtitle file can be malformed in its content while being
 * perfectly readable in its timing.
 */
export function parseCueTimings(text) {
  const cues = [];
  /*
   * Hours are optional. WebVTT allows MM:SS.mmm and ffmpeg writes exactly that
   * for anything under an hour, so a pattern that insists on H:MM:SS silently
   * matches nothing for the first hour of every file — which reads as "this
   * track has no cues" rather than as a parser that cannot see them.
   */
  const stamp = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`;
  const pattern = new RegExp(String.raw`${stamp}\s*-->\s*${stamp}`, 'g');

  for (const match of String(text || '').matchAll(pattern)) {
    const at = (h, m, sec, ms) =>
      (Number(h || 0) * 3600) + (Number(m) * 60) + Number(sec) + (Number(String(ms).padEnd(3, '0')) / 1000);
    const start = at(match[1], match[2], match[3], match[4]);
    const end = at(match[5], match[6], match[7], match[8]);
    // A cue that ends before it starts is a broken line, not a negative cue.
    if (end >= start) cues.push({ start, end });
  }

  return cues;
}

/** Did the caller ask for ASS rather than the WebVTT a <track> would want? */
const assRequested = (req) => req.query.raw === '1' || req.query.raw === 'true';

/**
 * GET /api/subs/sync?path=&lang=&embedded=
 *
 * Whether the track that would be chosen for this file is actually in time
 * with it. A subtitle cut for a different release is out from the first line,
 * and the way anyone finds out today is by watching two minutes of dialogue
 * arrive at the wrong moment.
 *
 * Costs an audio decode of the first ten minutes, so it is asked for, never
 * automatic on opening a file.
 */
router.get('/sync', async (req, res, next) => {
  try {
    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const videoPath = path.resolve(requested);
    if (!isInsideLibrary(videoPath)) {
      log.warn(`refused subtitle sync check outside library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    const text = await subtitleTextFor(videoPath, req);
    if (!text) return res.status(404).json({ error: 'no subtitles found for this file' });

    const cues = parseCueTimings(text);
    const audioIndex = Number.isInteger(Number(req.query.audio)) ? Number(req.query.audio) : 0;
    return res.json(await subtitleSync.check(videoPath, cues, { audioIndex }));
  } catch (error) {
    return next(error);
  }
});

/**
 * The text of whichever track the sync check should look at.
 *
 * Deliberately the same choice the player would make, so the answer is about
 * the track someone is actually going to watch with rather than about whatever
 * happened to be first in the container.
 */
async function subtitleTextFor(videoPath, req) {
  const external = findSubtitles(videoPath);
  const wanted = req.query.lang ? String(req.query.lang).toLowerCase() : null;

  if (req.query.embedded === undefined) {
    const choice = wanted ? external.find((entry) => entry.lang === wanted) : external[0];
    if (choice) {
      const text = readText(choice.file);
      // ASS carries its timings in the same shape once the format markers are
      // ignored, and parseCueTimings only reads timings.
      return choice.ext === '.srt' ? srtToVtt(text) : text;
    }
  }

  const info = await transcoder.probe(videoPath);
  const embedded = (info?.subtitles || []).filter((track) => !BITMAP_CODECS.has(track.codec));
  if (embedded.length === 0) return null;

  const index = req.query.embedded !== undefined
    ? Number(req.query.embedded)
    : (wanted ? embedded.find((track) => track.language === wanted) : null)?.index
      ?? (embedded.find((track) => track.default) || embedded[0]).index;

  const { stream } = transcoder.extractSubtitle(videoPath, index, 'webvtt');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
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
          styled: entry.ext === '.ass',
          path: entry.file
        })),
        ...embedded.map((track) => ({
          source: 'embedded',
          index: track.index,
          lang: track.language,
          codec: track.codec,
          forced: track.forced,
          // The client renders these itself; converting them to WebVTT would
          // drop exactly the styling and positioning that makes them ASS.
          styled: STYLED_CODECS.has(track.codec),
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
      return pipeEmbedded(res, videoPath, index, assRequested(req) ? 'ass' : 'webvtt');
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
        // Sent as ASS, not flattened: public/js/ass.js parses it and draws the
        // cues into an overlay, which is the only way to keep the positioning.
        res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
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

/** Stream one embedded track out of the container, as WebVTT or as ASS. */
function pipeEmbedded(res, videoPath, index, format = 'webvtt') {
  const ass = format === 'ass';
  res.setHeader('Content-Type', ass ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Subtitle-Source', 'embedded');

  const { stream, kill } = transcoder.extractSubtitle(videoPath, index, format);

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
      return res.status(upstreamStatus(error)).json({ error: error.message });
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
