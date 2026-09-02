/**
 * GET /api/library/missing  — episodes TMDB knows about that are not on disk
 * GET /api/library/storage  — what the library is actually made of, by size
 *
 * Both answer questions the library endpoint cannot, because the library is
 * built from files: it can only describe what is there.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as scanner from '../services/scanner.js';
import * as tmdb from '../services/tmdb.js';
import { compareSeason, isRealSeason, summariseShow } from '../services/missing.js';
import * as warmup from '../services/warmup.js';

const log = createLogger('api:library');
const router = express.Router();

/**
 * Compare one show against TMDB, season by season.
 *
 * Only seasons the library already holds something from are checked. A show
 * you have one season of is not missing the other four; it is a show you have
 * one season of, and reporting it otherwise turns the feature into noise.
 */
async function missingForShow(show) {
  const seasons = [];

  for (const season of show.seasons || []) {
    if (!isRealSeason(season.number)) continue;

    let details;
    try {
      details = await tmdb.getSeasonDetails(show.tmdb_id, season.number);
    } catch (error) {
      // A season TMDB will not answer for is skipped rather than reported as
      // wholly missing, which is what an empty episode list would look like.
      log.debug(`no TMDB detail for ${show.title} S${season.number}: ${error.message}`);
      continue;
    }

    const comparison = compareSeason(details.episodes, season.episodes);
    seasons.push({ season: season.number, ...comparison });
  }

  return {
    tmdb_id: show.tmdb_id,
    title: show.title,
    poster: show.poster || null,
    ...summariseShow(seasons)
  };
}

router.get('/missing', async (req, res, next) => {
  try {
    const library = scanner.getLibrary();
    const wanted = req.query.show ? Number.parseInt(req.query.show, 10) : null;

    const shows = (library.shows || [])
      .filter((show) => show.tmdb_id && (wanted === null || show.tmdb_id === wanted));

    if (wanted !== null && shows.length === 0) {
      return res.status(404).json({ error: `no show with tmdb id ${wanted} in the library` });
    }

    // Sequential across shows: each one costs several TMDB season lookups, and
    // those are cached, so the second call is cheap and the first should not
    // fan out into a burst that gets rate-limited.
    const results = [];
    for (const show of shows) results.push(await missingForShow(show));

    return res.json({
      shows: results.sort((a, b) => b.missingCount - a.missingCount || a.title.localeCompare(b.title)),
      totalMissing: results.reduce((sum, show) => sum + show.missingCount, 0),
      showsWithGaps: results.filter((show) => !show.complete).length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/library/storage — where the space went.
 *
 * Titles rather than folders. The organiser decides the folder layout, so a
 * per-directory breakdown answers a question about the organiser; a per-title
 * one answers the question you actually have, which is what to delete.
 */
router.get('/storage', (_req, res, next) => {
  try {
    const library = scanner.getLibrary();
    const titles = [];

    let movieBytes = 0;
    for (const movie of library.movies || []) {
      const bytes = (movie.files || []).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      movieBytes += bytes;
      titles.push({
        type: 'movie',
        tmdb_id: movie.tmdb_id || null,
        title: movie.title,
        year: movie.year || null,
        bytes,
        files: (movie.files || []).length
      });
    }

    let showBytes = 0;
    for (const show of library.shows || []) {
      let bytes = 0;
      let files = 0;
      let episodes = 0;
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          const own = (episode.files || []).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
          if ((episode.files || []).length > 0) episodes += 1;
          files += (episode.files || []).length;
          bytes += own;
        }
      }
      showBytes += bytes;
      titles.push({
        type: 'show',
        tmdb_id: show.tmdb_id || null,
        title: show.title,
        year: show.year || null,
        bytes,
        files,
        episodes,
        seasons: (show.seasons || []).length,
        // What one episode costs is the number that tells you whether a show
        // is worth keeping at this quality; the total only tells you it is big.
        bytesPerEpisode: episodes > 0 ? Math.round(bytes / episodes) : 0
      });
    }

    titles.sort((a, b) => b.bytes - a.bytes);

    return res.json({
      totalBytes: movieBytes + showBytes,
      movieBytes,
      showBytes,
      titles
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/library/warm — convert and thumbnail everything, ahead of time.
 *
 * Warming happens automatically for anything downloaded from now on, but a
 * library that already exists has never been through it, and that is exactly
 * the library where every first play pays for a tone map and an encode before
 * the first frame. This is the catch-up.
 *
 * It answers immediately with what was queued. The work itself runs on
 * background ffmpeg slots, one file at a time, and yields to anyone watching —
 * so this is safe to start and walk away from.
 */
router.post('/warm', (req, res, next) => {
  try {
    const library = scanner.getLibrary();
    const wanted = req.body?.show ? Number.parseInt(req.body.show, 10) : null;

    const paths = [];
    for (const movie of library.movies || []) {
      if (wanted !== null && movie.tmdb_id !== wanted) continue;
      for (const file of movie.files || []) if (file.file_path) paths.push(file.file_path);
    }
    for (const show of library.shows || []) {
      if (wanted !== null && show.tmdb_id !== wanted) continue;
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          for (const file of episode.files || []) if (file.file_path) paths.push(file.file_path);
        }
      }
    }

    const queued = warmup.enqueueAll(paths);
    log.info(`warm requested: ${queued} of ${paths.length} file(s) queued`);
    // Fewer queued than found is the normal case on a second run: anything
    // already converted, or already waiting, is not queued again.
    return res.json({ found: paths.length, queued, ...warmup.getStats() });
  } catch (error) {
    next(error);
  }
});

/** GET /api/library/warm — how far the catch-up has got. */
router.get('/warm', (_req, res) => {
  res.json(warmup.getStats());
});

export default router;
