/**
 * GET/PUT/DELETE /api/track-prefs — the audio and subtitle track per title.
 *
 * Storage only. The server never decides which track a file should open with,
 * because that decision needs the file's actual track list, which the player
 * already has in hand; public/js/track-prefs.js does the matching there.
 *
 *   GET    /api/track-prefs?key=show:1234
 *   PUT    /api/track-prefs        { key, audioLang, audioIndex, subtitleOff, ... }
 *   DELETE /api/track-prefs?key=show:1234
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import { getTrackPrefs, saveTrackPrefs, forgetTrackPrefs } from '../db/trackPrefs.js';

const log = createLogger('api:track-prefs');
const router = express.Router();

/*
 * The key is a primary key that arrives from the client, so its shape is
 * checked rather than trusted. Anything else is a bug in the caller, and
 * letting it through would scatter junk rows that nothing ever reads again.
 */
const KEY_PATTERN = /^(show|movie):\d+$/;

const readKey = (value) => (typeof value === 'string' && KEY_PATTERN.test(value) ? value : null);

router.get('/', (req, res) => {
  const key = readKey(req.query.key);
  if (!key) return res.status(400).json({ error: 'a key of the form show:<id> or movie:<id> is required' });
  // No stored preference is a normal answer, not a 404: the player asks on
  // every open and the first one is always going to be empty.
  return res.json({ key, prefs: getTrackPrefs(key) });
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const key = readKey(body.key);
  if (!key) return res.status(400).json({ error: 'a key of the form show:<id> or movie:<id> is required' });

  const prefs = saveTrackPrefs(key, {
    audioLang: typeof body.audioLang === 'string' ? body.audioLang.toLowerCase() : null,
    audioIndex: Number.isInteger(body.audioIndex) ? body.audioIndex : null,
    subtitleOff: body.subtitleOff === true,
    subtitleLang: typeof body.subtitleLang === 'string' ? body.subtitleLang.toLowerCase() : null,
    subtitleSource: body.subtitleSource === 'external' || body.subtitleSource === 'embedded'
      ? body.subtitleSource
      : null
  });

  log.debug(`${key}: audio=${prefs.audioLang ?? prefs.audioIndex ?? 'default'} subs=${prefs.subtitleOff ? 'off' : (prefs.subtitleLang || prefs.subtitleSource || 'default')}`);
  return res.json({ key, prefs });
});

router.delete('/', (req, res) => {
  const key = readKey(req.query.key);
  if (!key) return res.status(400).json({ error: 'a key of the form show:<id> or movie:<id> is required' });
  forgetTrackPrefs(key);
  return res.json({ key, prefs: null });
});

export default router;
