/**
 * /api/progress — watch position tracking.
 *
 * The completed=1 rule (position > 95% of duration) lives in db/index.js so the
 * player, this route and anything added later cannot disagree about it.
 */
import express from 'express';
import {
  upsertProgress, getProgress, listContinueWatching, listAllProgress, deleteProgress
} from '../db/index.js';

const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * POST /api/progress
 * Upsert. The player calls this every 5 seconds, so it stays cheap and tolerant:
 * only file_path and position are required.
 */
router.post('/', wrap(async (req, res) => {
  const body = req.body || {};

  if (!body.file_path || typeof body.file_path !== 'string') {
    return res.status(400).json({ error: 'file_path is required' });
  }
  const position = Number(body.position);
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: 'position must be a non-negative number' });
  }

  const row = upsertProgress({
    file_path: body.file_path,
    position,
    duration: Number(body.duration) || 0,
    tmdb_id: body.tmdb_id,
    type: body.type,
    parent_tmdb_id: body.parent_tmdb_id,
    season_number: body.season_number,
    episode_number: body.episode_number,
    title: body.title,
    completed: body.completed,
    audio_offset: body.audio_offset
  });

  res.json(row);
}));

/**
 * GET /api/progress            → Continue Watching list
 * GET /api/progress?file_path= → one row, or null when the file is unwatched
 *
 * The single-file form answers with 200 and a null body rather than 404: "never
 * watched" is a normal answer for the player, not an error worth a toast.
 */
router.get('/', wrap(async (req, res) => {
  if (req.query.file_path) {
    return res.json(getProgress(String(req.query.file_path)) || null);
  }

  // ?all=1 returns every row, completed ones included. Continue Watching wants
  // one unfinished entry per show; the show detail page wants the opposite -
  // every episode, so it can mark which ones you have already seen.
  if (req.query.all === '1' || req.query.all === 'true') {
    return res.json(listAllProgress());
  }

  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json(listContinueWatching(limit));
}));

/** DELETE /api/progress?file_path= — drop an item from Continue Watching. */
router.delete('/', wrap(async (req, res) => {
  if (!req.query.file_path) {
    return res.status(400).json({ error: 'file_path is required' });
  }
  res.json({ removed: deleteProgress(String(req.query.file_path)) });
}));

export default router;
