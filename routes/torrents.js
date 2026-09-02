/**
 * /api/search and /api/torrents/* — discovery and downloads.
 *
 * Mounted at /api, so the search endpoint answers on both /api/search (the path
 * in the spec) and /api/torrents/search.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as torrentSearch from '../services/torrentSearch.js';
import * as downloader from '../services/downloader.js';
import * as tmdb from '../services/tmdb.js';
import { listJobs, getJob } from '../db/index.js';

const log = createLogger('api:torrents');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* --------------------------------------------------------------------------
 * Search
 * ----------------------------------------------------------------------- */

/**
 * GET /api/search?q=&type=movie|show[&tmdb_id=&season=&episode=]
 * 200 with ranked results; 502 only when every enabled source failed.
 */
async function searchHandler(req, res) {
  const query = String(req.query.q || req.query.query || '').trim();
  const type = req.query.type === 'show' || req.query.type === 'series' ? 'show' : 'movie';
  const tmdbId = req.query.tmdb_id ? Number(req.query.tmdb_id) : undefined;

  if (!query && !tmdbId) {
    return res.status(400).json({ error: 'q is required' });
  }

  try {
    const outcome = await torrentSearch.search({
      query,
      type,
      tmdbId,
      imdbId: req.query.imdb_id || undefined,
      season: req.query.season != null ? Number(req.query.season) : undefined,
      episode: req.query.episode != null ? Number(req.query.episode) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });
    res.json(outcome);
  } catch (error) {
    const status = error.status || 502;
    log.warn(`search "${query}" failed: ${error.message}`);
    res.status(status).json({ error: error.message, sources: error.details || null });
  }
}

/**
 * GET /api/search/suggest?q=&limit=
 * Titles for the search box dropdown. Never fails the caller: a TMDB outage
 * closes the dropdown rather than blocking the search box.
 */
router.get('/search/suggest', wrap(async (req, res) => {
  const query = String(req.query.q || '').trim();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));

  try {
    res.json(await tmdb.suggest(query, limit));
  } catch (error) {
    log.warn(`suggest "${query}" failed: ${error.message}`);
    res.json([]);
  }
}));

router.get('/search', wrap(searchHandler));
router.get('/torrents/search', wrap(searchHandler));

/** GET /api/torrents/sources — which sources are configured, for the UI. */
router.get('/torrents/sources', (_req, res) => {
  res.json(torrentSearch.listSources());
});

/* --------------------------------------------------------------------------
 * Downloads
 * ----------------------------------------------------------------------- */

/** Attach live in-flight progress, which moves faster than the 5% DB writes. */
function withLiveProgress(job) {
  if (job.status === 'complete' || job.status === 'error') return job;
  const live = downloader.getLiveProgress(job.id);
  return live ? { ...job, progress: live.progress, phase: live.phase } : job;
}

/**
 * POST /api/torrents/download
 * Body: { magnet | infoHash, title, type, tmdb_id, year?, season?, episode?, episodeTitle?, source? }
 *
 * The magnet is uploaded to AllDebrid inline (sub-second) so the returned id is
 * the real torrent id; the transfer itself runs in the background.
 * Retrying a failed job is the same call again with the same magnet.
 */
router.post('/torrents/download', wrap(async (req, res) => {
  const body = req.body || {};

  if (!body.magnet && !body.infoHash) {
    return res.status(400).json({ error: 'magnet or infoHash is required' });
  }
  if (!body.title) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const job = await downloader.startDownload({
      magnet: body.magnet,
      infoHash: body.infoHash,
      title: body.title,
      type: body.type,
      tmdb_id: body.tmdb_id,
      year: body.year,
      season: body.season,
      episode: body.episode,
      episodeTitle: body.episodeTitle,
      source: body.source
    });

    res.status(202).json({ id: job.id, status: job.status, title: job.title });
  } catch (error) {
    const status = error.status || 502;
    log.warn(`download failed for "${body.title}": ${error.message}`);
    res.status(status).json({ error: error.message });
  }
}));

/** GET /api/torrents/jobs — newest first, with live progress on active rows. */
router.get('/torrents/jobs', (_req, res) => {
  // Queue order, not insertion order: with reordering, database order and
  // the order things actually run in are no longer the same list.
  res.json(downloader.listQueue().map(withLiveProgress));
});

/** GET /api/torrents/jobs/:id */
router.get('/torrents/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: `no job ${req.params.id}` });
  res.json(withLiveProgress(job));
});

/** DELETE /api/torrents/jobs/:id — abort the transfer, drop it at AllDebrid, remove the row. */
/**
 * POST /api/torrents/jobs/:id/move — reorder within the queue.
 *
 * A swap touches two rows, so this answers how many it wrote; zero means the
 * move was impossible (already at that end, or the job is not waiting) rather
 * than that it failed.
 */
router.post('/torrents/jobs/:id/move', wrap(async (req, res) => {
  const move = String(req.body?.move || '');
  if (!['up', 'down', 'top', 'bottom'].includes(move)) {
    return res.status(400).json({ error: 'move must be up, down, top or bottom' });
  }
  const result = downloader.moveJob(req.params.id, move);
  return res.json({ ...result, jobs: downloader.listQueue() });
}));

/**
 * POST /api/torrents/jobs/:id/:action — pause, resume or retry.
 *
 * Registered after /move on purpose: "move" matches :action too, and Express
 * takes the first route that matches, so the specific path has to come first.
 *
 * Pausing an active transfer aborts it and discards the partial file:
 * AllDebrid issues a fresh link each time and there is no resume-from-offset,
 * so a paused download restarts from the beginning when resumed. The job keeps
 * its place in the queue, which is the part people actually care about.
 */
router.post('/torrents/jobs/:id/:action', wrap(async (req, res) => {
  const { id, action } = req.params;
  if (!['pause', 'resume', 'retry'].includes(action)) {
    return res.status(400).json({ error: `unknown action "${action}"` });
  }
  const job = await downloader.setJobState(id, action);
  return res.json(job);
}));

router.delete('/torrents/jobs/:id', wrap(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: `no job ${req.params.id}` });

  await downloader.cancelJob(req.params.id);
  res.json({ id: req.params.id, cancelled: true });
}));

export default router;
