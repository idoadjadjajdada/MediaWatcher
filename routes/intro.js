/**
 * GET  /api/intro?path=      — the intro marker for this episode, if one exists
 * POST /api/intro/skip       — record a skip that might teach us one
 * DELETE /api/intro?path=    — forget what was learned for this season
 *
 * The player reports every forward jump that looks like someone skipping a
 * title sequence. Two that agree become a marker, and from then on the episode
 * offers a Skip Intro button.
 */
import express from 'express';
import path from 'node:path';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import { introKey, isCandidateSkip, agreeOnIntro } from '../services/intro.js';
import { recordSkip, skipsFor, markerFor, saveMarker, forgetIntro } from '../db/intro.js';
import { detectIntroForSeason } from '../services/introDetect.js';
import * as scanner from '../services/scanner.js';

const log = createLogger('api:intro');
const router = express.Router();

/**
 * The player knows which show and season a file belongs to; the server does
 * not without walking the library. Rather than duplicate that lookup, the
 * player sends the identifiers it already has.
 */
function keyFrom(query) {
  const showId = Number(query.show);
  const season = Number(query.season);
  if (!Number.isFinite(showId) || !Number.isFinite(season)) return null;
  return introKey({ type: 'episode', item: { tmdb_id: showId }, season });
}

/** Refuse anything outside the library, exactly as the stream routes do. */
function allowedPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const resolved = path.resolve(raw);
  return isInsideLibrary(resolved) ? resolved : null;
}

/**
 * Seasons already being analysed.
 *
 * Detection costs two ffmpeg decodes per pair, and the player asks for the
 * marker every time an episode opens - so without this, starting three
 * episodes in a row would launch three identical analyses.
 */
const detecting = new Set();

/** Episode files for a show and season, in episode order. */
function seasonFiles(showId, seasonNumber) {
  const library = scanner.getLibrary();
  const show = (library.shows || []).find((s) => s.tmdb_id === showId);
  const season = (show?.seasons || []).find((s) => s.number === seasonNumber);
  if (!season) return [];

  return (season.episodes || [])
    .slice()
    .sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
    .map((episode) => episode.files?.[0]?.file_path)
    .filter(Boolean);
}

/**
 * Work out where the intro is without waiting to be shown.
 *
 * Runs in the background and answers nothing: the episode being opened now
 * plays without it, and the marker is there the next time. Waiting would add
 * two decodes to the time before playback starts.
 */
function detectInBackground(key, showId, seasonNumber) {
  if (detecting.has(key)) return;

  const files = seasonFiles(showId, seasonNumber);
  if (files.length < 2) {
    /*
     * Usually means the library has not finished its first scan yet, which
     * looked identical to a broken detector until this said so. A later
     * request will try again, so there is nothing to recover from.
     */
    log.debug(`not enough episodes to compare for ${key} yet (${files.length})`);
    return;
  }

  detecting.add(key);
  detectIntroForSeason(files)
    .then((marker) => {
      if (!marker) {
        log.info(`no shared intro found for ${key}`);
        return;
      }
      // Never over a learned marker: someone actually skipping is better
      // evidence than two episodes sounding alike.
      if (markerFor(key)?.source === 'learned') return;
      saveMarker(key, { ...marker, source: 'detected', observations: 1 });
      log.info(`detected intro for ${key}: ${marker.start.toFixed(0)}s-${marker.end.toFixed(0)}s`);
    })
    .catch((error) => log.warn(`intro detection failed for ${key}: ${error.message}`))
    .finally(() => detecting.delete(key));
}

router.get('/', (req, res) => {
  const key = keyFrom(req.query);
  if (!key) return res.json({ marker: null });

  const marker = markerFor(key);
  if (!marker) detectInBackground(key, Number(req.query.show), Number(req.query.season));

  return res.json({ marker });
});

router.post('/skip', (req, res) => {
  const { show, season, path: rawPath, from, to, duration } = req.body || {};

  const key = keyFrom({ show, season });
  if (!key) return res.status(400).json({ error: 'show and season are required' });

  const filePath = allowedPath(rawPath);
  if (!filePath) return res.status(403).json({ error: 'path is outside the library' });

  /*
   * Judged server-side rather than trusting the player: this is what decides
   * whether a jump is remembered at all, and the rule wants to live next to
   * the one that later reads it.
   */
  if (!isCandidateSkip({ from: Number(from), to: Number(to), duration: Number(duration) })) {
    return res.json({ recorded: false, marker: markerFor(key) });
  }

  recordSkip({ key, filePath, from: Number(from), to: Number(to) });

  // Recomputed from every observation rather than nudged, so one odd skip
  // cannot drag an established marker along with it.
  const agreed = agreeOnIntro(skipsFor(key));
  if (agreed) {
    saveMarker(key, { ...agreed, source: 'learned' });
    log.info(`learned intro for ${key}: ${agreed.start.toFixed(0)}s-${agreed.end.toFixed(0)}s `
      + `from ${agreed.observations} episodes`);
  }

  return res.json({ recorded: true, marker: markerFor(key) });
});

router.delete('/', (req, res) => {
  const key = keyFrom(req.query);
  if (!key) return res.status(400).json({ error: 'show and season are required' });
  forgetIntro(key);
  log.info(`forgot intro for ${key}`);
  return res.json({ ok: true });
});

export default router;
