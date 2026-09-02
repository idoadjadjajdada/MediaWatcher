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

router.get('/', (req, res) => {
  const key = keyFrom(req.query);
  if (!key) return res.json({ marker: null });
  return res.json({ marker: markerFor(key) });
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
