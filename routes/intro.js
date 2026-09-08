/**
 * GET    /api/intro?show=&season=&episode=  — the marker to use for this episode
 * POST   /api/intro/skip                    — record a skip that might teach us one
 * PUT    /api/intro                         — set one episode's timings by hand
 * DELETE /api/intro?show=&season=&episode=  — forget an episode's, or the season's
 *
 * The player reports every forward jump that looks like someone skipping a
 * title sequence. Two that agree become a marker, and from then on the episode
 * offers a Skip Intro button.
 *
 * Markers live at two scopes and the narrower one wins. What is *learned* is a
 * season: the same titles every week is the pattern being looked for, and one
 * episode cannot establish it. What is *edited* is a single episode, because a
 * run that opens cold one week and not the next puts its titles in a different
 * place each time, and someone who has looked at the frames is describing the
 * episode in front of them.
 */
import express from 'express';
import path from 'node:path';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import {
  introKey, episodeIntroKey, isCandidateSkip, agreeOnIntro,
  canReplaceMarker, normaliseManualMarker
} from '../services/intro.js';
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

/** The key for one episode's own timings, when the player named an episode. */
function episodeKeyFrom(query) {
  const showId = Number(query.show);
  const season = Number(query.season);
  const episode = Number(query.episode);
  if (![showId, season, episode].every(Number.isFinite)) return null;
  return episodeIntroKey({ type: 'episode', item: { tmdb_id: showId }, season, episode });
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
      // Never over better evidence. Someone actually skipping, and above that
      // someone placing the marker themselves, both outrank two episodes
      // sounding alike.
      if (!canReplaceMarker(markerFor(key)?.source, 'detected')) return;
      saveMarker(key, { ...marker, source: 'detected', observations: 1 });
      log.info(`detected intro for ${key}: ${marker.start.toFixed(0)}s-${marker.end.toFixed(0)}s`);
    })
    .catch((error) => log.warn(`intro detection failed for ${key}: ${error.message}`))
    .finally(() => detecting.delete(key));
}

router.get('/', (req, res) => {
  const key = keyFrom(req.query);
  if (!key) return res.json({ marker: null });

  /*
   * An episode's own timings win outright, and stop the season being analysed
   * on its behalf: the question detection would answer has already been
   * answered here, better.
   */
  const episodeKey = episodeKeyFrom(req.query);
  const own = episodeKey ? markerFor(episodeKey) : null;
  if (own) return res.json({ marker: { ...own, scope: 'episode' } });

  const marker = markerFor(key);
  if (!marker) detectInBackground(key, Number(req.query.show), Number(req.query.season));

  return res.json({ marker: marker ? { ...marker, scope: 'season' } : null });
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

  /*
   * Recomputed from every observation rather than nudged, so one odd skip
   * cannot drag an established marker along with it - and never written over a
   * marker that was placed by hand. Skipping a title sequence that is already
   * marked is ordinary watching, not a correction, and a hand-placed marker
   * that quietly reverted to a learned one would be a bug with no symptom
   * anyone could describe.
   */
  const agreed = agreeOnIntro(skipsFor(key));
  if (agreed && canReplaceMarker(markerFor(key)?.source, 'learned')) {
    saveMarker(key, { ...agreed, source: 'learned' });
    log.info(`learned intro for ${key}: ${agreed.start.toFixed(0)}s-${agreed.end.toFixed(0)}s `
      + `from ${agreed.observations} episodes`);
  }

  return res.json({ recorded: true, marker: markerFor(key) });
});

/**
 * Set one episode's timings by hand.
 *
 * Written against the episode, never the season. The two automatic routes both
 * generalise - they have to, because a guess is only worth making where a
 * pattern repeats - but a correction generalises to nothing: it is one person
 * looking at one episode, and applying it to twenty-one others would replace a
 * guess that is sometimes wrong with an assertion that is confidently wrong.
 *
 * Deliberately unconditional otherwise: this is the one route allowed to
 * overwrite whatever sits at its key, because it is the only one where anyone
 * has actually seen the frames.
 */
router.put('/', (req, res) => {
  const { show, season, episode, start, end } = req.body || {};

  const key = episodeKeyFrom({ show, season, episode });
  if (!key) return res.status(400).json({ error: 'show, season and episode are required' });

  const checked = normaliseManualMarker({ start, end });
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  saveMarker(key, { start: checked.start, end: checked.end, source: 'manual', observations: 0 });
  log.info(`intro set by hand for ${key}: ${checked.start.toFixed(1)}s-${checked.end.toFixed(1)}s`);

  return res.json({ marker: { ...markerFor(key), scope: 'episode' } });
});

/**
 * Forget an episode's own timings, or the whole season's.
 *
 * Which one depends on what exists: an episode that has been edited gives that
 * up first and falls back to the season, and only then does asking again clear
 * the season itself. Two meanings for one button, but they are the two the
 * viewer wants in the order they want them - undo my edit, then forget the
 * thing that was wrong in the first place.
 */
router.delete('/', (req, res) => {
  const key = keyFrom(req.query);
  if (!key) return res.status(400).json({ error: 'show and season are required' });

  const episodeKey = episodeKeyFrom(req.query);
  if (episodeKey && markerFor(episodeKey)) {
    forgetIntro(episodeKey);
    log.info(`forgot the hand-set intro for ${episodeKey}`);
    const fallback = markerFor(key);
    return res.json({ ok: true, scope: 'episode', marker: fallback ? { ...fallback, scope: 'season' } : null });
  }

  forgetIntro(key);
  log.info(`forgot intro for ${key}`);
  return res.json({ ok: true, scope: 'season', marker: null });
});

export default router;
