/**
 * /api/discover — browsable titles that are not in the library yet.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as discover from '../services/discover.js';
import * as tmdb from '../services/tmdb.js';

const log = createLogger('api:discover');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

router.get('/catalog', wrap(async (req, res) => {
  const type = req.query.type || 'movie';
  const query = String(req.query.q || '').trim().slice(0, 200);
  const page = Number(req.query.page || 1);
  const year = req.query.year ? Number(req.query.year) : '';
  const rating = Number(req.query.rating || 0);
  const genre = req.query.genre ? Number(req.query.genre) : '';
  const sort = req.query.sort || 'popular';
  if (!['movie', 'show'].includes(type) || !Number.isInteger(page) || page < 1 || page > 500
    || (req.query.year && (!Number.isInteger(year) || year < 1870 || year > 2200))
    || !Number.isFinite(rating) || rating < 0 || rating > 10
    || (req.query.genre && (!Number.isInteger(genre) || genre <= 0))
    || !['popular', 'rating', 'newest'].includes(sort)) return res.status(400).json({ error: 'Invalid catalog filters' });
  try {
    const genres = await tmdb.getGenres(type);
    const byName = genres.find((entry) => entry.name.toLowerCase() === query.toLowerCase());
    const selectedGenre = genre || byName?.id || '';
    if (selectedGenre && !genres.some((entry) => entry.id === selectedGenre)) {
      return res.status(400).json({ error: 'This genre is not available for the selected type' });
    }
    const titleQuery = byName ? '' : query;
    const data = await tmdb.catalogPage({ query: titleQuery, type, genre: selectedGenre, year, rating, sort, page });
    // TMDB title search doesn't accept genre/rating filters; filter that page
    // locally and retain pagination so later matches stay reachable.
    const results = (data.results || []).filter((entry) => !entry.adult
      && (!selectedGenre || (entry.genre_ids || []).includes(selectedGenre))
      && (!rating || Number(entry.vote_average) >= rating))
      .map((entry) => ({ ...tmdb.toSuggestion({ ...entry, media_type: type === 'show' ? 'tv' : 'movie' }),
        rating: Number(entry.vote_average || 0).toFixed(1), overview: entry.overview || '' }));
    res.json({ results: results.filter((entry) => entry.tmdb_id), genres, genre: selectedGenre,
      query: titleQuery, page, totalPages: Math.min(500, data.total_pages || 0) });
  } catch (error) {
    log.warn(`catalog unavailable: ${error.message}`);
    res.status(502).json({ error: 'Could not load titles. Check the TMDB connection and try again.' });
  }
}));

router.get('/show/:tmdb_id/season/:season', wrap(async (req, res) => {
  const id = Number(req.params.tmdb_id);
  const season = Number(req.params.season);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(season) || season < 0 || season > 999) {
    return res.status(400).json({ error: 'Invalid show or season' });
  }
  try { res.json(await tmdb.getSeasonDetails(id, season)); }
  catch (error) { res.status(error.status === 404 ? 404 : 502).json({ error: 'Could not load this season. Please try again.' }); }
}));

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
