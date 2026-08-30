/**
 * /api/discover — browsable titles that are not in the library yet.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as discover from '../services/discover.js';

const log = createLogger('api:discover');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * GET /api/discover
 * Every rail. `?force=1` rebuilds rather than reading the cache.
 * Never fails the page: an empty rail list is a valid answer, because the
 * library above the rails is still perfectly usable.
 */
router.get('/', wrap(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';

  try {
    const rails = await discover.getRails({ force });
    res.json({ rails, generated_at: Date.now() });
  } catch (error) {
    log.warn(`could not build rails: ${error.message}`);
    res.json({ rails: [], generated_at: Date.now() });
  }
}));

/** GET /api/discover/:type/:tmdb_id — full record for the detail modal. */
router.get('/:type/:tmdb_id', wrap(async (req, res) => {
  const type = req.params.type === 'show' ? 'show' : req.params.type === 'movie' ? 'movie' : null;
  if (!type) return res.status(400).json({ error: 'type must be movie or show' });

  const tmdbId = Number(req.params.tmdb_id);
  if (!Number.isFinite(tmdbId)) return res.status(400).json({ error: 'tmdb_id must be a number' });

  try {
    const details = await discover.getDetails(tmdbId, type);
    res.json(details);
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    res.status(status).json({ error: error.message });
  }
}));

export default router;
