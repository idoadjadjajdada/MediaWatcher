/**
 * POST /api/auth/login  — password in, device cookie out
 * POST /api/auth/logout — drop this device
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createLogger } from '../config/index.js';
import {
  COOKIE_NAME, mintToken, hashToken, parseCookies, verifyPassword,
  rememberSession, dropSession, resolveToken,
  recordFailure, blockedForMs, clearFailures, verifyAdminKey
} from '../services/auth.js';
import * as enrolment from '../services/enrolment.js';
import { insertDevice, revokeDevice } from '../db/devices.js';
import { recordLogin } from '../db/loginEvents.js';
import { classifyOrigin } from '../services/network.js';

const log = createLogger('api:auth');
const router = express.Router();

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Secure is decided per request rather than hardcoded: over the tunnel the
 * origin is HTTPS and the flag is required, but on plain http://localhost the
 * browser would refuse to send a Secure cookie at all and the host machine
 * could never stay logged in.
 */
const cookieOptions = (req, persistent) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/',
  ...(persistent ? { maxAge: ONE_YEAR_MS } : {})
});

router.post('/login', (req, res) => {
  const wait = blockedForMs(req.ip);
  if (wait > 0) {
    return res.status(429).json({
      error: 'Too many attempts. Try again shortly.',
      retry_after_ms: wait
    });
  }

  const { password, deviceName, remember, enrol } = req.body || {};

  /*
   * An enrolment code stands in for the password.
   *
   * It was minted on a device that is already trusted and carried here in a
   * QR, which is the whole point: entering a twelve-character password on a
   * television with a D-pad is miserable, and the code is single use and dies
   * in five minutes. It is checked first because redeeming consumes it — a
   * request carrying both should not spend the code on a password failure.
   */
  const enrolled = enrol ? enrolment.redeem(enrol) : false;

  if (!enrolled && !verifyPassword(password)) {
    recordFailure(req.ip);
    // Logged to the database as well as the console: the console scrolls away
    // with the launcher window, and a run of these is the one thing on this
    // server worth being able to look back at.
    recordLogin({
      ok: false,
      ip: req.ip,
      origin: classifyOrigin(req.ip),
      userAgent: req.headers['user-agent']
    });
    log.warn(`failed login from ${req.ip}`);
    return res.status(401).json({ error: 'Wrong password' });
  }

  clearFailures(req.ip);

  const name = String(deviceName || '').trim().slice(0, 60);
  if (remember && !name) {
    return res.status(400).json({ error: 'Name this device so you can recognise it later' });
  }

  const token = mintToken();

  if (remember) {
    insertDevice({
      id: randomUUID(),
      tokenHash: hashToken(token),
      name,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip: req.ip,
      origin: classifyOrigin(req.ip)
    });
    log.info(`device remembered: ${name} (${req.ip})`);
  } else {
    rememberSession(hashToken(token));
  }

  recordLogin({
    ok: true,
    ip: req.ip,
    origin: classifyOrigin(req.ip),
    userAgent: req.headers['user-agent'],
    // Named for how it got in, not just that it did: a sign-in nobody typed a
    // password for is exactly the row you want to be able to find later.
    deviceName: remember ? name : (enrolled ? 'enrolled by code' : null),
    remembered: Boolean(remember)
  });

  res.cookie(COOKIE_NAME, token, cookieOptions(req, Boolean(remember)));
  return res.json({ ok: true, remembered: Boolean(remember) });
});

/**
 * POST /api/auth/enrol — mint a code for a device that cannot type.
 *
 * Mounted under /api/auth, which sits above the gate so that logging in is
 * possible at all — so this cannot rely on the gate and checks for itself. The
 * admin key or the password, nothing else: a code is a way into the server, and
 * handing one out has to be at least as hard as signing in.
 */
router.post('/enrol', (req, res) => {
  const key = req.get('x-mediawatcher-key');
  const byKey = key ? verifyAdminKey(key) : false;
  const byPassword = verifyPassword(req.body?.password);

  if (!byKey && !byPassword) {
    recordFailure(req.ip);
    log.warn(`refused an enrolment request from ${req.ip}`);
    return res.status(403).json({ error: 'That needs your password.' });
  }

  const { code, expiresAt } = enrolment.create({ issuedBy: req.device?.name || (byKey ? 'the launcher' : req.ip) });

  /*
   * The URL is built from the origin the request arrived on, not from
   * configuration. A code minted from the tailnet has to point at the tailnet
   * hostname, and one minted at the desk at localhost — and the request itself
   * is the only thing that knows which of those happened.
   */
  const host = req.get('host');
  const scheme = req.secure ? 'https' : 'http';
  return res.json({
    url: `${scheme}://${host}/login.html?enrol=${encodeURIComponent(code)}`,
    expiresAt,
    expiresInMs: enrolment.TTL_MS
  });
});

/**
 * POST /api/auth/enrol/cancel — drop outstanding codes, for one shown by mistake.
 *
 * A POST rather than a DELETE because it carries the password in its body, and
 * a DELETE with a body is the kind of thing intermediaries feel free to strip.
 */
router.post('/enrol/cancel', (req, res) => {
  const key = req.get('x-mediawatcher-key');
  if (!(key && verifyAdminKey(key)) && !verifyPassword(req.body?.password)) {
    return res.status(403).json({ error: 'That needs your password.' });
  }
  return res.json({ cancelled: enrolment.clear() });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const resolved = resolveToken(token);

  if (resolved?.kind === 'device') revokeDevice(resolved.device.id);
  else if (token) dropSession(hashToken(token));

  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

export default router;
