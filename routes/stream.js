/**
 * GET /api/stream?path=      — video streaming
 * GET /api/stream/info?path= — what playback mode this file needs, and why
 *
 * Two paths out of here:
 *
 *   direct  the browser can decode the file as it sits on disk, so it gets the
 *           raw bytes with full HTTP range support. Byte-for-byte, no ffmpeg,
 *           no quality loss, native seeking.
 *   ffmpeg  the container or a codec is not playable, so ffmpeg remuxes (and
 *           only if unavoidable, re-encodes) into fragmented MP4 on the fly.
 *           A pipe has no byte offsets, so seeking restarts ffmpeg at ?t=.
 *
 * Every path arrives from the client and is checked against the library root
 * before anything is opened.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as mp4cache from '../services/mp4cache.js';
import { resolveQuality } from '../services/quality.js';
import { classifyOrigin } from '../services/network.js';

const log = createLogger('api:stream');
const router = express.Router();

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t'
};

/**
 * Parse a Range header against a known file size.
 * Handles "bytes=0-", "bytes=500-999" and the suffix form "bytes=-500".
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return { invalid: true };

  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return { invalid: true };

  let start;
  let end;

  if (startRaw === '') {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start > end || start >= size || start < 0) return { invalid: true };

  return { start, end: Math.min(end, size - 1) };
}

/** Resolve and authorise a client-supplied path. Returns null after responding. */
function resolveRequestPath(req, res) {
  const requested = req.query.path;
  if (!requested || typeof requested !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return null;
  }

  const filePath = path.resolve(requested);
  if (!isInsideLibrary(filePath)) {
    log.warn(`refused stream outside library: ${requested}`);
    res.status(403).json({ error: 'path is outside the library' });
    return null;
  }

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    res.status(404).json({ error: 'file not found' });
    return null;
  }
  if (!stats.isFile()) {
    res.status(404).json({ error: 'not a file' });
    return null;
  }

  return { filePath, stats };
}

/** Client decoder capabilities, passed by the player as ?hevc=1&ac3=1. */
const capsFrom = (req) => ({
  hevc: req.query.hevc === '1' || req.query.hevc === 'true',
  ac3: req.query.ac3 === '1' || req.query.ac3 === 'true'
});

/** The cap this request plays under, from ?q= and where the request came from. */
const qualityFrom = (req) => resolveQuality(req.query.q, classifyOrigin(req.ip));

/* --------------------------------------------------------------------------
 * GET /api/stream/info
 * ----------------------------------------------------------------------- */

router.get('/info', async (req, res, next) => {
  try {
    const resolved = resolveRequestPath(req, res);
    if (!resolved) return;

    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
    const caps = capsFrom(req);
    const quality = qualityFrom(req);
    const info = await transcoder.probe(resolved.filePath);
    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    /*
     * A cached MP4 overrides the decision entirely: it is a real file on disk,
     * so it seeks natively and needs no ffmpeg. An audio offset still has to go
     * through the pipe, because the offset lives in the ffmpeg command — and so
     * does a capped stream, because the cached variants are full quality and
     * serving one would silently ignore the cap.
     */
    const capped = Boolean(decision.targetHeight || decision.maxrate);
    const variant = mp4cache.pickVariant(info?.video, caps);
    const cached = (audioOffset === 0 && !capped)
      ? mp4cache.readyVariant(resolved.filePath, variant)
      : null;
    if (cached) {
      decision.mode = `cached-${variant}`;
      decision.seekable = true;
      decision.lossless = variant === mp4cache.VARIANT_COPY;
      decision.tonemapped = false;
      decision.reasons = [
        variant === mp4cache.VARIANT_COPY
          ? 'playing a cached MP4 — lossless picture, native seeking'
          : 'playing a cached H.264 MP4 — plays anywhere, native seeking'
      ];
    } else if (audioOffset === 0 && !capped) {
      mp4cache.ensureVariant(resolved.filePath, variant).catch(() => {});
    }

    res.json({
      path: resolved.filePath,
      size: resolved.stats.size,
      ffmpeg_available: await transcoder.isAvailable(),
      mode: decision.mode,
      lossless: decision.lossless,
      // Files seek by byte range and HLS seeks by segment, so the only path
      // that could not seek - the raw ffmpeg pipe - is no longer reachable
      // from the player.
      seekable: true,
      tonemapped: Boolean(decision.tonemapped),
      tonemap_height: decision.tonemapHeight ?? null,
      // What the cap actually did, not merely what was asked for: a request for
      // Low on a file already below it reports original, because nothing was
      // taken away.
      quality: capped ? quality.level : 'original',
      origin: classifyOrigin(req.ip),
      // Present when playback needs ffmpeg. A direct or cached file is a real
      // file with byte ranges and needs nothing here.
      hls: (decision.mode === 'direct' || decision.mode.startsWith('cached-'))
        ? null
        : `/api/hls/playlist.m3u8?${new URLSearchParams({
          path: resolved.filePath,
          q: String(req.query.q || 'auto'),
          hevc: caps.hevc ? '1' : '',
          ac3: caps.ac3 ? '1' : '',
          audio: String(req.query.audio || 0),
          audioOffset: String(audioOffset || 0)
        })}`,
      reasons: decision.reasons,
      duration: decision.duration,
      video: decision.video || null,
      audio_tracks: decision.audioTracks || [],
      embedded_subtitles: info?.subtitles || []
    });
  } catch (error) {
    next(error);
  }
});

/* --------------------------------------------------------------------------
 * Direct byte streaming (with ranges)
 * ----------------------------------------------------------------------- */

function streamBytes(req, res, filePath, size, mode = 'direct') {
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-cache');
  // Named by the caller, so a cached MP4 does not report itself as a raw source
  // file. Both are byte-range serves; only one of them is the original.
  res.setHeader('X-Playback-Mode', mode);

  if (!req.headers.range) {
    res.setHeader('Content-Length', size);
    res.status(200);
    if (req.method === 'HEAD') return res.end();

    const whole = fs.createReadStream(filePath);
    whole.on('error', (error) => {
      log.error(`stream error on ${filePath}: ${error.message}`);
      res.destroy();
    });
    res.on('close', () => whole.destroy());
    return whole.pipe(res);
  }

  const range = parseRange(req.headers.range, size);
  if (range.invalid) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).json({ error: 'range not satisfiable' });
  }

  const { start, end } = range;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  res.status(206);
  if (req.method === 'HEAD') return res.end();

  const partial = fs.createReadStream(filePath, { start, end });
  partial.on('error', (error) => {
    log.error(`range stream error on ${filePath}: ${error.message}`);
    res.destroy();
  });
  // Seeking aborts the previous request; drop the file handle straight away.
  res.on('close', () => partial.destroy());
  return partial.pipe(res);
}

/* --------------------------------------------------------------------------
 * ffmpeg streaming
 * ----------------------------------------------------------------------- */

async function streamViaFfmpeg(req, res, filePath, decision) {
  const startSeconds = Math.max(0, Number(req.query.t) || 0);
  const audioIndex = Math.max(0, Number(req.query.audio) || 0);
  const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);

  // Asked for when tone mapping, where the CPU is already saturated doing the
  // colour conversion — and when capping, which re-encodes every frame for the
  // same reason. A plain transcode is fine on libx264.
  const needsEncoder = decision.tonemapped || Boolean(decision.targetHeight || decision.maxrate);
  const encoder = needsEncoder ? await transcoder.hardwareEncoder() : null;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');
  // A pipe has no byte offsets — the player seeks with ?t= instead.
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('X-Playback-Mode', decision.mode);
  res.setHeader('X-Playback-Lossless', decision.lossless ? '1' : '0');
  res.status(200);

  if (req.method === 'HEAD') return res.end();

  const { stream, kill } = transcoder.openStream(filePath, {
    mode: decision.mode,
    startSeconds,
    audioIndex,
    audioOffset,
    tonemap: Boolean(decision.tonemapped),
    height: decision.video?.height ?? null,
    maxHeight: decision.targetHeight,
    maxrate: decision.maxrate,
    encoder
  });

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    kill();
  };

  stream.on('error', (error) => {
    log.warn(`ffmpeg pipe error on ${path.basename(filePath)}: ${error.message}`);
    cleanup();
    res.destroy();
  });

  // Viewer closed the tab, seeked, or switched files: stop encoding immediately.
  res.on('close', cleanup);
  stream.on('end', () => { finished = true; });

  return stream.pipe(res);
}

/* --------------------------------------------------------------------------
 * GET /api/stream
 * ----------------------------------------------------------------------- */

router.get('/', async (req, res, next) => {
  try {
    const resolved = resolveRequestPath(req, res);
    if (!resolved) return;

    const { filePath, stats } = resolved;

    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);

    const quality = qualityFrom(req);

    // Escape hatch: ?mode=direct serves raw bytes - but it must not become a
    // way around the cap, and an offset needs ffmpeg, so neither can be
    // honoured alongside one.
    const uncapped = !quality.height && !quality.maxrate;
    if (req.query.mode === 'direct' && audioOffset === 0 && uncapped) {
      return streamBytes(req, res, filePath, stats.size);
    }

    const info = await transcoder.probe(filePath);
    const caps = capsFrom(req);
    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    if (decision.mode === 'direct') {
      return streamBytes(req, res, filePath, stats.size);
    }

    // A cached MP4 turns this into a plain byte-range serve: native seeking,
    // no ffmpeg in the path. An audio offset has to keep going through ffmpeg,
    // because the offset lives in the command rather than in the file — and a
    // capped stream must too, since the cached variants are full quality.
    if (audioOffset === 0 && !(decision.targetHeight || decision.maxrate)) {
      const variant = mp4cache.pickVariant(info?.video, caps);
      const cached = mp4cache.readyVariant(filePath, variant);
      if (cached) {
        const cachedStats = fs.statSync(cached);
        return streamBytes(req, res, cached, cachedStats.size, `cached-${variant}`);
      }
      // Not ready. Start it, keep serving from the pipe, and the next play of
      // this file gets the fast path.
      mp4cache.ensureVariant(filePath, variant).catch(() => {});
    }

    log.info(`${decision.mode}: ${path.basename(filePath)} — ${decision.reasons.join('; ')}`);
    return await streamViaFfmpeg(req, res, filePath, decision);
  } catch (error) {
    next(error);
  }
});

export default router;
