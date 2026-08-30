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

export default router;
