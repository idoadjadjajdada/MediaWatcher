/**
 * /api/media/* — library reads, rescans, and forced TMDB refreshes.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as scanner from '../services/scanner.js';
import * as tmdb from '../services/tmdb.js';

const log = createLogger('api:media');
const router = express.Router();

/** Forward async errors to the express error handler. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * GET /api/media/library
 * Served from the in-memory snapshot. The very first call has nothing to serve,
 * so it waits for a scan rather than returning a misleading empty library.
 */
router.get('/library', wrap(async (_req, res) => {
  let library = scanner.getLibrary();

  if (library.last_scan_at === null) {
    log.info('no scan yet, running one before serving the library');
    library = await scanner.scanLibrary();
  }

  res.json({ ...library, scanning: scanner.isScanning() });
}));

/**
 * POST /api/media/rescan
 * Backgrounds the scan and returns 202. Pass ?wait=1 to block and get the
 * finished library back with a 200 instead.
 */
router.post('/rescan', wrap(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';

  if (req.query.wait === '1' || req.query.wait === 'true') {
    const library = await scanner.scanLibrary({ force });
    return res.json({ ...library, scanning: false });
  }

  const alreadyRunning = scanner.isScanning();
  scanner.scanLibrary({ force }).catch((error) => log.error(`rescan failed: ${error.message}`));

  res.status(202).json({
    status: alreadyRunning ? 'already scanning' : 'started',
    scanning: true,
    last_scan_at: scanner.getLibrary().last_scan_at
  });
}));

/**
 * GET /api/media/refresh/:tmdb_id
 * Drops the cached TMDB payload, refetches it, then rebuilds the library in the
 * background so the new metadata shows up without a manual rescan.
 *
 * Type comes from ?type=movie|show; when omitted it is inferred from the
 * library, then attempted as a movie and finally as a show.
 */
async function refreshHandler(req, res) {
  const tmdbId = Number(req.params.tmdb_id);
  if (!Number.isFinite(tmdbId)) {
    return res.status(400).json({ error: 'tmdb_id must be a number' });
  }

  const library = scanner.getLibrary();
  const requested = req.query.type === 'show' || req.query.type === 'movie' ? req.query.type : null;
  const known = library.movies.some((movie) => movie.tmdb_id === tmdbId) ? 'movie'
    : library.shows.some((show) => show.tmdb_id === tmdbId) ? 'show'
      : null;

  const candidates = requested ? [requested] : known ? [known] : ['movie', 'show'];
  let details = null;
  let resolvedType = null;
  let lastError = null;

  for (const type of candidates) {
    try {
      tmdb.invalidate(tmdbId, type);
      details = await tmdb.getDetails(tmdbId, type, { force: true });
      resolvedType = type;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!details) {
    const status = lastError?.status === 404 ? 404 : lastError?.status || 502;
    return res.status(status).json({ error: lastError?.message || `TMDB has no item ${tmdbId}` });
  }

  scanner.scanLibrary().catch((error) => log.error(`post-refresh rescan failed: ${error.message}`));

  res.json({
    tmdb_id: tmdbId,
    type: resolvedType,
    title: resolvedType === 'movie' ? details.title : details.name,
    refreshed: true,
    rescanning: true
  });
}

router.get('/refresh/:tmdb_id', wrap(refreshHandler));
// Spec section 5 names this path, section 7 names the shorter one; both work.
router.get('/refresh-tmdb/:tmdb_id', wrap(refreshHandler));

export default router;
