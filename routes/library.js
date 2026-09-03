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
import * as changes from '../services/changes.js';
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
/**
 * GET /api/library/changes — what this device has not seen yet.
 *
 * Per device, because "since you last looked" is a fact about a person at a
 * screen: the television catching up after a fortnight and the phone used an
 * hour ago have different answers, and one shared marker would give them both
 * the phone's.
 */
router.get('/changes', (req, res) => {
  res.json(changes.changesFor(req.device?.id || null, scanner.getLibrary()));
});

/**
 * POST /api/library/changes/seen — caught up.
 *
 * Separate from reading them, and deliberately so: the snapshot moves when the
 * list has actually been shown, not when something fetched it in the
 * background. Marking on read would mean a poll that ran while the tab was
 * closed silently consumed the answer.
 */
router.post('/changes/seen', (req, res) => {
  res.json({ at: changes.markSeen(req.device?.id || null, scanner.getLibrary()) });
});

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
    /*
     * Fewer queued than found has two quite different causes and the answer
     * separates them: something already converted or already waiting, and
     * something a rule deliberately passed over. Only one of those is worth
     * doing anything about.
     */
    return res.json({
      found: paths.length,
      queued,
      excluded: paths.length - queued,
      ...warmup.getStats()
    });
  } catch (error) {
    next(error);
  }
});

/** GET /api/library/warm — how far the catch-up has got. */
/**
 * GET /api/library/warm/policy — what gets converted ahead of time.
 *
 * Answers the rules and a dry run against the current library together,
 * because the rules on their own are not an answer to the question anyone
 * actually has, which is "what will this do to my library".
 */
router.get('/warm/policy', (_req, res) => {
  const policy = warmup.getPolicy();
  const library = scanner.getLibrary();

  const preview = { included: 0, excluded: 0, bytes: 0, reasons: {}, titles: [] };

  const consider = (file) => {
    if (!file?.file_path) return;
    const verdict = warmup.assess(file.file_path);
    if (verdict.warm) {
      preview.included += 1;
      preview.bytes += Number(file.size) || 0;
      return;
    }
    preview.excluded += 1;
    preview.reasons[verdict.reason] = (preview.reasons[verdict.reason] || 0) + 1;
  };

  for (const movie of library.movies || []) {
    for (const file of movie.files || []) consider(file);
  }
  for (const show of library.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        for (const file of episode.files || []) consider(file);
      }
    }
  }

  /*
   * Named titles come back with their names attached. A page listing
   * "movie:603" and "show:1396" is a page that cannot be used to undo a rule
   * set six months ago.
   */
  for (const [key, choice] of Object.entries(policy.titles)) {
    const [kind, id] = key.split(':');
    const pool = kind === 'show' ? library.shows : library.movies;
    const found = (pool || []).find((entry) => String(entry.tmdb_id) === id);
    preview.titles.push({ key, kind, tmdbId: Number(id), choice, title: found?.title || null });
  }
  preview.titles.sort((a, b) => String(a.title || a.key).localeCompare(String(b.title || b.key)));

  res.json({ policy, preview });
});

/** PUT /api/library/warm/policy — change the rules. */
router.put('/warm/policy', (req, res) => {
  res.json({ policy: warmup.setPolicy(req.body?.policy) });
});

/**
 * PUT /api/library/warm/policy/title — one title's own rule.
 *
 * Separate from the whole policy so the button on a title's page cannot
 * accidentally write back a stale copy of every other rule alongside it.
 */
router.put('/warm/policy/title', (req, res) => {
  const { type, tmdb_id: tmdbId, choice } = req.body || {};
  if (!tmdbId) return res.status(400).json({ error: 'tmdb_id is required' });
  if (!['auto', 'always', 'never'].includes(String(choice))) {
    return res.status(400).json({ error: 'choice must be auto, always or never' });
  }

  const policy = warmup.setTitleRule(type === 'show' ? 'show' : 'movie', tmdbId, choice);
  return res.json({ choice, titles: policy.titles });
});

router.get('/warm', (_req, res) => {
  res.json(warmup.getStats());
});

export default router;
