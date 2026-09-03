/**
 * The gate. Mounts ahead of the static handler and every API router.
 *
 * Note what this function does NOT take: a client address. tailscale serve
 * proxies from 127.0.0.1, so a loopback bypass would wave through every remote
 * request while looking correct on the desk it was written at. Access is
 * decided by the cookie and nothing else.
 */
import { createLogger } from '../config/index.js';
import { COOKIE_NAME, parseCookies, resolveToken, verifyAdminKey } from '../services/auth.js';
import { touchDevice } from '../db/devices.js';
import { classifyOrigin } from '../services/network.js';
import * as castLink from '../services/castLink.js';

const log = createLogger('auth');

/** Exact matches only — a prefix test would let /js/login.js.map through. */
const PUBLIC_GET = new Set([
  '/login.html',
  '/js/login.js',
  '/css/login.css',
  '/api/health'
]);

const PUBLIC_POST = new Set([
  '/api/auth/login'
]);

export function isAllowlisted(method, urlPath) {
  if (method === 'GET' || method === 'HEAD') return PUBLIC_GET.has(urlPath);
  if (method === 'POST') return PUBLIC_POST.has(urlPath);
  return false;
}

export default function requireAuth(req, res, next) {
  // req.path drops the query string; the allowlist is about paths.
  const urlPath = req.path;

  if (isAllowlisted(req.method, urlPath)) return next();

  /*
   * The launcher polls the library and the job list and has no cookie, so
   * adding the gate silently broke both - it reads the admin key off disk
   * instead. This is not a loopback bypass: the key has to be presented, and
   * only something that can read the file can present it.
   */
  if (verifyAdminKey(req.headers['x-mediawatcher-key'])) {
    req.device = null;
    return next();
  }

  /*
   * A Chromecast fetches media itself, from a device that holds no cookie and
   * cannot be given one. It carries a link this server signed instead: an HMAC
   * over the one path it may fetch and an expiry.
   *
   * This is not a hole in the gate. The signature names a single path, so it
   * admits a request for that file and nothing else; it expires on its own;
   * and it can only be minted by something already signed in. It is a
   * capability for one file, not a way in.
   */
  if (castLink.verify(req)) {
    req.device = null;
    req.castLink = true;
    return next();
  }

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const resolved = resolveToken(token);

  if (!resolved) {
    req.device = null;
    /*
     * "No cookie" and "cookie we do not recognise" are completely different
     * faults - the first is a client that never logged in, the second is a
     * credential this process has lost - and they were indistinguishable from
     * the outside.
     */
    log.debug(token
      ? `rejected an unrecognised device token from ${req.ip} for ${urlPath}`
      : `no device cookie from ${req.ip} for ${urlPath}`);
    // An API caller wants a status it can branch on; a browser navigating
    // wants the login page. Sending HTML to fetch() would surface as a JSON
    // parse error and tell the user nothing.
    if (urlPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect(302, '/login.html');
  }

  if (resolved.kind === 'device') {
    req.device = resolved.device;
    // Keeps the launcher list honest about where each device is right now.
    touchDevice(resolved.device.id, {
      ip: req.ip,
      origin: classifyOrigin(req.ip)
    });
  } else {
    req.device = null;
  }

  return next();
}
