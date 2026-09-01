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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

/* --------------------------------------------------------------------------
 * Non-remembered sessions
 *
 * "Remember me" unchecked means no database row: nothing to audit and nothing
 * to revoke, because the credential dies with the browser or the process.
 * ----------------------------------------------------------------------- */

const sessions = new Set();

export const rememberSession = (tokenHash) => { sessions.add(tokenHash); };
export const hasSession = (tokenHash) => sessions.has(tokenHash);
export const dropSession = (tokenHash) => { sessions.delete(tokenHash); };

/**
 * Resolve a raw cookie token to whatever issued it, or null.
 * Devices are checked first: they are the persistent, revocable credential.
 */
export function resolveToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const device = findDeviceByTokenHash(tokenHash);
  if (device) return { kind: 'device', device };

  if (sessions.has(tokenHash)) return { kind: 'session' };
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

const failures = new Map();   // ip -> { count, until }

export function recordFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count > FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (entry.count - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
    entry.until = Date.now() + delay;
  }
  failures.set(ip, entry);
}

/** Milliseconds this IP must wait, or 0. */
export function blockedForMs(ip) {
  const entry = failures.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

export const clearFailures = (ip) => { failures.delete(ip); };

export default {
  COOKIE_NAME, mintToken, hashToken, parseCookies, verifyPassword, verifyAdminKey,
  rememberSession, hasSession, dropSession, resolveToken,
  recordFailure, blockedForMs, clearFailures
};
