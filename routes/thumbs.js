/**
 * GET /api/thumbs/meta?path=   — interval and how many frames exist yet
 * GET /api/thumbs?path=&i=N    — one generated frame
 *
 * Every path arrives from the client and is checked against the library root
 * before anything is opened, exactly as the stream route does.
 *
 * Nothing here is required for playback: the client falls back to a timestamp
 * whenever a frame is unavailable, so 404 and 503 are ordinary answers rather
 * than failures worth logging loudly.
 */
import fs from 'node:fs';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as thumbnails from '../services/thumbnails.js';

const log = createLogger('api:thumbs');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Resolve and validate the ?path= parameter. Returns null once it has replied. */
function resolvePath(req, res) {
  const filePath = req.query.path;
  if (!filePath) {
    res.status(400).json({ error: 'path is required' });
    return null;
  }
  if (!isInsideLibrary(filePath)) {
    log.warn(`rejected a path outside the library: ${filePath}`);
    res.status(403).json({ error: 'path is outside the library' });
    return null;
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'file not found' });
    return null;
  }
  return filePath;
}

router.get('/meta', wrap(async (req, res) => {
  const filePath = resolvePath(req, res);
  if (!filePath) return;

  const meta = await thumbnails.getMeta(filePath);
  if (!meta.available) return res.status(503).json({ error: 'ffmpeg unavailable' });

  res.json({ interval: meta.interval, count: meta.count, total: meta.total, ready: meta.ready });
}));

router.get('/', wrap(async (req, res) => {
  const filePath = resolvePath(req, res);
  if (!filePath) return;

  const index = Number(req.query.i);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'i must be a non-negative integer' });
  }

  const frame = await thumbnails.framePath(filePath, index);
  if (!frame) return res.status(404).json({ error: 'frame not generated yet' });

  // The cache key already encodes path, size and mtime, so a given URL can
  // never point at a different frame.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/jpeg');
  fs.createReadStream(frame).pipe(res);
}));

export default router;
