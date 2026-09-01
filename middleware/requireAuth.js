/**
 * The gate. Mounts ahead of the static handler and every API router.
 *
 * Note what this function does NOT take: a client address. tailscale serve
 * proxies from 127.0.0.1, so a loopback bypass would wave through every remote
 * request while looking correct on the desk it was written at. Access is
 * decided by the cookie and nothing else.
 */
import { COOKIE_NAME, parseCookies, resolveToken } from '../services/auth.js';
import { touchDevice } from '../db/devices.js';
import { classifyOrigin } from '../services/network.js';

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

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const resolved = resolveToken(token);

  if (!resolved) {
    req.device = null;
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
