/**
 * GET /api/offline/info?path=  — can this be saved yet, and how big is it?
 * GET /api/offline/file?path=  — the whole thing as one file, for saving
 *
 * Saving something for offline needs a single file. Normal playback does not:
 * an MKV that no browser can decode is delivered as HLS, which is dozens of
 * segments assembled on the fly and useless to put in a cache.
 *
 * So this leans on the MP4 cache that already exists for playback. If a
 * browser-native copy has been built, it is served whole with range support.
 * If not, asking starts the conversion and answers "not yet" - the same
 * mechanism playback already uses, rather than a second conversion pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as transcoder from '../services/transcoder.js';
import * as mp4cache from '../services/mp4cache.js';
import * as warmup from '../services/warmup.js';

const log = createLogger('api:offline');
const router = express.Router();

/** Resolve and refuse anything outside the library, as every media route does. */
function resolveInLibrary(req, res) {
  const requested = req.query.path;
  if (!requested || typeof requested !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return null;
  }
  const resolved = path.resolve(requested);
  if (!isInsideLibrary(resolved)) {
    log.warn(`refused offline access outside library: ${requested}`);
    res.status(403).json({ error: 'path is outside the library' });
    return null;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'file does not exist' });
    return null;
  }
  return resolved;
}

/**
 * What can be saved for this file right now.
 *
 * `browserNative` files are served straight from disk - no conversion, no
 * cache entry, nothing to wait for. Everything else needs the MP4 cache, and
 * `ready: false` means a conversion was started and the caller should ask
 * again rather than that saving is impossible.
 */
router.get('/info', async (req, res, next) => {
  try {
    const filePath = resolveInLibrary(req, res);
    if (!filePath) return undefined;

    const info = await transcoder.probe(filePath);
    const decision = transcoder.decide(info, {
      hevc: req.query.hevc === '1',
      ac3: req.query.ac3 === '1'
    });

    if (decision.mode === 'direct') {
      const { size } = fs.statSync(filePath);
      return res.json({ ready: true, source: 'original', bytes: size, variant: null });
    }

    const variant = mp4cache.pickVariant(info, {
      hevc: req.query.hevc === '1',
      ac3: req.query.ac3 === '1'
    });
    const cached = mp4cache.readyVariant(filePath, variant);

    if (cached) {
      return res.json({ ready: true, source: 'cache', bytes: fs.statSync(cached).size, variant });
    }

    /*
     * Queued rather than started directly. The warm-up queue is sequential and
     * runs on background ffmpeg slots, so asking to save five episodes at once
     * converts them one at a time behind whatever is playing — where calling
     * ensureVariant five times would start as many as the pool allowed.
     */
    warmup.enqueue(filePath);
    return res.json({
      ready: false,
      source: 'converting',
      variant,
      // An estimate rather than a promise: the caller needs it to decide
      // whether the download is worth starting on a phone.
      estimatedBytes: Math.round((info?.duration || 0) * 1_500_000 / 8) || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The file itself, whole, with range support.
 *
 * A save reads this once from end to end, but range support is not optional:
 * a browser will happily issue a ranged request for a large body, and a server
 * that answers 200 to one produces a corrupt file rather than an error.
 */
router.get('/file', async (req, res, next) => {
  try {
    const filePath = resolveInLibrary(req, res);
    if (!filePath) return undefined;

    const info = await transcoder.probe(filePath);
    const caps = { hevc: req.query.hevc === '1', ac3: req.query.ac3 === '1' };
    const decision = transcoder.decide(info, caps);

    let target = filePath;
    let type = 'video/mp4';

    if (decision.mode !== 'direct') {
      const cached = mp4cache.readyVariant(filePath, mp4cache.pickVariant(info, caps));
      if (!cached) {
        return res.status(409).json({
          error: 'no browser-native copy yet — ask /api/offline/info first'
        });
      }
      target = cached;
    } else if (path.extname(filePath).toLowerCase() === '.webm') {
      type = 'video/webm';
    }

    const { size } = fs.statSync(target);
    const range = req.headers.range;

    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    // Immutable: the cache key already encodes the source, so a body that
    // arrives once never changes underneath the saved copy.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    if (!range) {
      res.setHeader('Content-Length', size);
      return fs.createReadStream(target).pipe(res);
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

    if (!Number.isFinite(start) || start >= size || start > end) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(target, { start, end }).pipe(res);
  } catch (error) {
    next(error);
  }
});

export default router;
