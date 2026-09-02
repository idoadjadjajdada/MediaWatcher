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
  recordFailure, blockedForMs, clearFailures
} from '../services/auth.js';
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

  const { password, deviceName, remember } = req.body || {};

  if (!verifyPassword(password)) {
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
    deviceName: remember ? name : null,
    remembered: Boolean(remember)
  });

  res.cookie(COOKIE_NAME, token, cookieOptions(req, Boolean(remember)));
  return res.json({ ok: true, remembered: Boolean(remember) });
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
