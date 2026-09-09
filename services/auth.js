/**
 * Authentication primitives.
 *
 * Deliberately free of Express types so the whole surface is testable without
 * standing a server up. The middleware in middleware/requireAuth.js is the
 * only thing that knows about requests.
 *
 * A device is identified by a token this server minted, never by a browser
 * fingerprint. A fingerprint describes a device, and a description can be
 * forged by anyone who knows the shape of an authorised one; a random token
 * cannot be guessed. It also has to be a cookie rather than a header, because
 * <video src="/api/stream?..."> issues its own range requests with no
 * JavaScript in the loop to attach anything.
 */
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import { findDeviceByTokenHash } from '../db/devices.js';

export const COOKIE_NAME = 'mw_device';

export const mintToken = () => randomBytes(32).toString('hex');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * Express has no built-in cookie reader (res.cookie exists, req.cookies does
 * not), and this is the whole of what we need from cookie-parser.
 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

/**
 * Constant-time comparison. Both sides are hashed first so that comparing a
 * 4-character guess against a 40-character password does not leak the length
 * through a size mismatch.
 */
export function verifyPassword(supplied) {
  const expected = createHash('sha256').update(config.auth.password).digest();
  const actual = createHash('sha256').update(String(supplied ?? '')).digest();
  return timingSafeEqual(expected, actual);
}

/**
 * Does this request carry the machine-local admin key?
 *
 * A stronger claim than a device cookie: the key is a file only something
 * running on this host can read. The launcher uses it for every call, because
 * it has no browser and therefore no cookie to present.
 */
export function verifyAdminKey(supplied) {
  const expected = config.auth.adminKey;
  const given = String(supplied || '');
  // timingSafeEqual throws on a length mismatch, so screen for that first.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Which server this is, for something already on this machine.
 *
 * The desktop app has to tell its own running server from an unrelated one on
 * the same port, and it asks `/api/health` — which anyone can read. So the
 * answer is the data folder keyed by the admin key inside it: computable only
 * by something that can read `config/admin-key`, and meaningless to anyone
 * else. desktop/instance.cjs computes the same value from the outside;
 * tests/instance.test.mjs fails if the two ever disagree.
 */
export function instanceFingerprint(dataDir = config.dataDir, key = config.auth.adminKey) {
  // Never fall back to the working directory: "no folder" is not a library.
  if (!String(dataDir || '').trim() || String(key || '').length !== 64) return '';
  const resolved = path.resolve(String(dataDir));
  return createHmac('sha256', key).update(resolved).digest('hex').slice(0, 32);
}

/* --------------------------------------------------------------------------
 * Non-remembered sessions
 *
 * "Remember me" unchecked means no database row: nothing to audit and nothing
 * to revoke, because the credential dies with the browser or the process.
 *
 * The cookie for one is a session cookie, so it does die with the browser — but
 * the server-side entry used to live until the process restarted, so the set
 * only ever grew and a token stayed valid long after the browser holding it was
 * closed. Each entry now carries an expiry, and using it pushes that expiry
 * forward: an evening of watching never logs you out, and a phone that has not
 * been near the app since this morning is no longer a credential.
 * ----------------------------------------------------------------------- */

const sessions = new Map();   // tokenHash -> expiresAt

/** Drop every expired entry. Returns how many went. */
export function pruneSessions(now = Date.now()) {
  let dropped = 0;
  for (const [tokenHash, expiresAt] of sessions) {
    if (expiresAt <= now) {
      sessions.delete(tokenHash);
      dropped += 1;
    }
  }
  return dropped;
}

export function rememberSession(tokenHash, now = Date.now()) {
  // Logins are rare and the map is small, so this is the natural place to take
  // out the rubbish rather than running a timer for it.
  pruneSessions(now);
  sessions.set(tokenHash, now + config.auth.sessionTtlMs);
}

export function hasSession(tokenHash, now = Date.now()) {
  const expiresAt = sessions.get(tokenHash);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    sessions.delete(tokenHash);
    return false;
  }
  return true;
}

export const dropSession = (tokenHash) => { sessions.delete(tokenHash); };

/** Live session count. Exposed for tests and diagnostics. */
export const sessionCount = () => sessions.size;

/**
 * Resolve a raw cookie token to whatever issued it, or null.
 * Devices are checked first: they are the persistent, revocable credential.
 */
export function resolveToken(token, now = Date.now()) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const device = findDeviceByTokenHash(tokenHash);
  if (device) return { kind: 'device', device };

  if (hasSession(tokenHash, now)) {
    // Sliding, not fixed: the window measures idleness, and someone mid-episode
    // is not idle.
    sessions.set(tokenHash, now + config.auth.sessionTtlMs);
    return { kind: 'session' };
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Failed-attempt backoff
 *
 * A tunnel is long-lived and quiet, so an unthrottled password endpoint is
 * brute-forceable given enough time. In-memory on purpose: a restart clearing
 * the counters is not a weakness worth a table, since restarting the server is
 * not something an attacker can do.
 * ----------------------------------------------------------------------- */

const FREE_ATTEMPTS = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

/**
 * How long a quiet IP is remembered for.
 *
 * An entry that is never cleared is a slow leak — a successful login clears
 * one, but an address that only ever fails leaves its counter behind forever,
 * and each attempt from a fresh address adds another. Forgetting after an hour
 * of silence also restores the two free attempts to someone who mistyped their
 * password this morning, which is the behaviour a household wants.
 */
const FORGET_AFTER_MS = 60 * 60 * 1000;

const failures = new Map();   // ip -> { count, until, at }

/** Drop entries that are neither blocking nor recent. Returns how many went. */
export function pruneFailures(now = Date.now()) {
  let dropped = 0;
  for (const [ip, entry] of failures) {
    if (entry.until <= now && now - entry.at >= FORGET_AFTER_MS) {
      failures.delete(ip);
      dropped += 1;
    }
  }
  return dropped;
}

export function recordFailure(ip, now = Date.now()) {
  pruneFailures(now);

  const entry = failures.get(ip) || { count: 0, until: 0, at: now };
  entry.count += 1;
  entry.at = now;
  if (entry.count > FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (entry.count - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
    entry.until = now + delay;
  }
  failures.set(ip, entry);
}

/** Milliseconds this IP must wait, or 0. */
export function blockedForMs(ip, now = Date.now()) {
  const entry = failures.get(ip);
  if (!entry) return 0;
  if (entry.until <= now && now - entry.at >= FORGET_AFTER_MS) {
    failures.delete(ip);
    return 0;
  }
  return Math.max(0, entry.until - now);
}

export const clearFailures = (ip) => { failures.delete(ip); };

/** Tracked address count. Exposed for tests and diagnostics. */
export const failureCount = () => failures.size;

export default {
  COOKIE_NAME, mintToken, hashToken, parseCookies, verifyPassword, verifyAdminKey,
  rememberSession, hasSession, dropSession, resolveToken, pruneSessions, sessionCount,
  recordFailure, blockedForMs, clearFailures, pruneFailures, failureCount
};
