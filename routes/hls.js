/**
 * GET  /api/hls/playlist.m3u8?path=&q=&hevc=&ac3=&audio=&audioOffset=
 * GET  /api/hls/:session/:segment.ts
 * POST /api/hls/:session/touch
 *
 * The playlist URL is the session handle: requesting it creates or reuses a
 * session, so a reload lands on the same encoder rather than starting a second
 * one against the same file.
 *
 * This exists because a pipe cannot answer byte ranges. iOS probes a source
 * with Range: bytes=0-1 and requires a 206; the pipe answers 200 and iOS gives
 * up. Segments are ordinary files, so that problem disappears — and transcoded
 * playback becomes seekable as a side effect.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as manager from '../services/hls/manager.js';
import { buildPlaylist } from '../services/hls/playlist.js';
import { resolveQuality } from '../services/quality.js';
import { classifyOrigin } from '../services/network.js';
import { COOKIE_NAME, parseCookies, hashToken } from '../services/auth.js';

/**
 * Who is asking, for the purposes of not sharing an encoder with them.
 *
 * A remembered device has a stable id; an unremembered session is identified by
 * its own token; the launcher and anything else holding the admin key share one
 * bucket, which is fine because none of them play video.
 */
function viewerId(req) {
  if (req.device?.id) return `device:${req.device.id}`;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  return token ? `session:${hashToken(token).slice(0, 16)}` : 'admin';
}

const log = createLogger('api:hls');
const router = express.Router();

router.get('/playlist.m3u8', async (req, res, next) => {
  try {
    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const filePath = path.resolve(requested);
    if (!isInsideLibrary(filePath)) {
      log.warn(`refused hls outside library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'file not found' });
    }

    const caps = {
      hevc: req.query.hevc === '1',
      ac3: req.query.ac3 === '1'
    };
    const audioIndex = Math.max(0, Number(req.query.audio) || 0);
    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
    const quality = resolveQuality(req.query.q, classifyOrigin(req.ip));

    const info = await transcoder.probe(filePath);
    // Without a duration there is no playlist to write — every segment
    // boundary is derived from it.
    if (!info?.duration) {
      return res.status(422).json({ error: 'cannot determine the duration of this file' });
    }

    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    const session = await manager.openSession({
      viewer: viewerId(req),
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      quality: quality.level,
      audioIndex,
      audioOffset,
      caps,
      duration: info.duration,
      tonemap: Boolean(decision.tonemapped),
      sourceHeight: info.video?.height ?? null,
      // A tone-mapped stream carries its own height ceiling when no cap is set.
      maxHeight: decision.targetHeight ?? (decision.tonemapped ? decision.tonemapHeight : null),
      maxrate: decision.maxrate
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    // The session behind this playlist is reaped when idle, so a cached copy
    // would hand back an id that no longer exists.
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildPlaylist(session.id, session.duration));
  } catch (error) {
    next(error);
  }
});

router.get('/:session/:segment.ts', async (req, res, next) => {
  try {
    const index = Number.parseInt(req.params.segment, 10);
    if (!Number.isFinite(index)) {
      return res.status(400).json({ error: 'bad segment number' });
    }

    /*
     * hls.js abandons in-flight segment requests on every seek. Without
     * telling the manager, the orphaned handler keeps waiting - and can move
     * the encoder to a segment nobody wants any more.
     */
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const file = await manager.requestSegment(req.params.session, index, controller.signal);
    if (!file) return res.status(404).json({ error: 'segment unavailable' });

    res.setHeader('Content-Type', 'video/mp2t');
    // Segments are pruned behind the play position, so caching one would
    // outlive the file it points at.
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(file, (error) => (error ? next(error) : undefined));
  } catch (error) {
    next(error);
  }
});

router.post('/:session/touch', (req, res) => {
  manager.touch(req.params.session);
  res.json({ ok: true });
});

export default router;
