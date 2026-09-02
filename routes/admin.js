/**
 * Operating the server from somewhere other than the machine it runs on.
 *
 * Everything here was previously possible only at the desk: reading the log
 * meant the launcher window, changing a setting meant a text editor, and
 * restarting meant going home. Over the tunnel none of those are available,
 * which is exactly when they are wanted.
 *
 * Two levels of access, because these are not all the same kind of act.
 *
 *   signed in       reading the log, reading the settings, measuring the
 *                   machine. Nothing here changes anything.
 *   password again  writing settings and restarting. A signed-in device is a
 *                   cookie on a phone that might be sitting unlocked on a
 *                   table; rewriting the config or bouncing the server on the
 *                   strength of that alone is too much. Re-entering the
 *                   password costs one prompt and makes the act deliberate.
 *
 * The admin key still works for everything, because the launcher holds it and
 * the launcher is on the machine already.
 */
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import config, { createLogger, recentLogs } from '../config/index.js';
import * as envFile from '../services/envFile.js';
import * as benchmark from '../services/benchmark.js';
import { requestRestart } from '../services/lifecycle.js';

const log = createLogger('api:admin');
const router = express.Router();

/**
 * Compare without leaking the answer in the timing.
 *
 * The same care as the login route: an early-exit comparison tells an attacker
 * how much of a guess was right, which turns guessing a password into guessing
 * one character at a time.
 */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Confirm this really is the person, not just their browser.
 *
 * The admin key is accepted in its place: whoever holds it is already on the
 * machine, where every one of these acts is available without asking anyone.
 */
function confirmed(req) {
  const key = req.get('x-mediawatcher-key');
  if (key && sameSecret(key, config.auth.adminKey)) return true;
  return sameSecret(req.body?.password, config.auth.password);
}

const requireConfirmation = (req, res, next) => {
  if (confirmed(req)) return next();
  log.warn(`unconfirmed attempt at ${req.method} ${req.path}`);
  // Deliberately the same answer whether the password was wrong or absent.
  return res.status(403).json({ error: 'That needs your password.' });
};

/* --------------------------------------------------------------------------
 * The log
 * ----------------------------------------------------------------------- */

/**
 * GET /api/admin/log?since=&limit=&level=
 *
 * `since` is the sequence number of the last line the caller has, so following
 * the log is a series of small requests rather than the whole buffer each
 * time. Values that look like keys are redacted on the way into the buffer,
 * not here — this is served over the tunnel, the console is not.
 */
router.get('/log', (req, res) => {
  const since = Number.parseInt(req.query.since, 10);
  const limit = Number.parseInt(req.query.limit, 10);
  const lines = recentLogs({
    since: Number.isInteger(since) ? since : 0,
    limit: Number.isInteger(limit) ? limit : 500,
    level: ['error', 'warn', 'info', 'debug'].includes(req.query.level) ? req.query.level : null
  });
  res.json({ level: config.logLevel, lines });
});

/* --------------------------------------------------------------------------
 * Settings
 * ----------------------------------------------------------------------- */

/** GET /api/admin/env — every setting, with the secrets masked. */
router.get('/env', (_req, res) => {
  res.json(envFile.readEnv());
});

/**
 * PUT /api/admin/env — change some of them.
 *
 * Validation happens before anything is written, so a rejected change leaves
 * the file exactly as it was. A masked value coming back means "unchanged"
 * rather than a literal string of dots.
 */
router.put('/env', requireConfirmation, (req, res) => {
  const changes = req.body?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return res.status(400).json({ error: 'changes must be an object of key to value' });
  }

  const result = envFile.writeEnv(changes);
  if (!result.ok) return res.status(400).json({ error: result.problems.join('; '), problems: result.problems });

  return res.json({
    applied: result.applied,
    changed: result.changed,
    // Said plainly rather than implied: config is read once at boot and frozen,
    // so nothing here is in effect until the process starts again.
    restartRequired: result.changed && envFile.needsRestart()
  });
});

/* --------------------------------------------------------------------------
 * Restarting
 * ----------------------------------------------------------------------- */

/**
 * POST /api/admin/restart
 *
 * Only useful where something is supervising the process — the launcher, or
 * the Windows service. Started from a bare `npm start` there is nothing to
 * bring it back, so the answer says which case this is rather than leaving
 * someone to find out by losing their server.
 */
router.post('/restart', requireConfirmation, (req, res) => {
  const supervised = process.env.MW_SUPERVISED === '1';
  if (!supervised && req.body?.force !== true) {
    return res.status(409).json({
      error: 'Nothing is supervising this server, so it would not come back. '
        + 'Start it from the launcher, or pass force to stop it anyway.',
      supervised: false
    });
  }

  if (!requestRestart(`asked for by ${req.device?.name || 'an admin client'}`)) {
    return res.status(503).json({ error: 'This server cannot restart itself.' });
  }
  return res.json({ restarting: true, supervised });
});

/* --------------------------------------------------------------------------
 * The benchmark
 * ----------------------------------------------------------------------- */

/** GET /api/admin/benchmark — the last measurement, or null. */
router.get('/benchmark', (_req, res) => {
  res.json({ running: benchmark.isRunning(), result: benchmark.lastResult() });
});

/**
 * POST /api/admin/benchmark — measure now.
 *
 * Takes a minute and occupies an encoder slot, so it answers with the result
 * rather than starting something and leaving the caller to poll.
 */
router.post('/benchmark', async (_req, res, next) => {
  try {
    res.json(await benchmark.run());
  } catch (error) {
    next(error);
  }
});

export default router;
