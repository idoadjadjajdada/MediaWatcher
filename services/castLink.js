/**
 * Letting a Chromecast fetch a file it is not allowed to ask for.
 *
 * Casting is not like AirPlay. AirPlay hands the stream from the phone, which
 * is already signed in; a Chromecast is told a URL and fetches it *itself*,
 * from a device that holds no cookie, cannot be given one, and cannot be
 * signed in to anything. Two things follow, and both are the reason this file
 * exists rather than a few lines in the player.
 *
 * **It has to be able to reach the server.** MediaWatcher binds to 127.0.0.1
 * and is reached remotely through a Tailscale tunnel. A Chromecast cannot join
 * a tailnet, so casting only works on the LAN, and only when the server has
 * been told to listen there. That is opt-in — `BIND_HOST=0.0.0.0` — because
 * turning it on is a real change to what this server is exposed to, and it
 * should be a decision rather than a side effect of pressing a cast button.
 *
 * **It has to prove it may.** So the sender mints a link: an HMAC over the one
 * path it is allowed to fetch and an expiry, signed with a key only this
 * server holds. It is a capability for one file for one evening, not a way in
 * — it names a single path, it grants nothing but reading it, and it stops
 * working on its own.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import config, { createLogger } from '../config/index.js';

const log = createLogger('cast');

/**
 * How long a cast link lives.
 *
 * Long enough for a film and a pause for dinner. Shorter would mean a stream
 * dying part way through, which is the failure this must not have; longer
 * would mean a link that outlives the reason it was made.
 */
export const TTL_MS = 6 * 60 * 60 * 1000;

/** The paths a cast link may ever name. Nothing else is castable. */
const ALLOWED = [/^\/api\/stream$/, /^\/api\/hls\//, /^\/api\/subs$/];

/**
 * Signed with the admin key, which already exists, is machine-local and is
 * never sent to a browser. A second secret would be a second thing to keep.
 */
const secret = () => config.auth.adminKey;

const sign = (path, expiresAt) =>
  createHmac('sha256', secret()).update(`${path}|${expiresAt}`).digest('base64url');

/** Is casting possible at all on this install? */
export const isEnabled = () => config.cast.enabled;

/**
 * The address a Chromecast on the LAN can actually reach.
 *
 * The tailnet hostname is deliberately not used even when one is configured: a
 * Chromecast is not on the tailnet, and handing it that name produces a device
 * that spins and then fails with nothing to explain why.
 */
export function lanAddress() {
  if (config.cast.host) return config.cast.host;

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Private ranges only: a public address here would be a server exposed
      // to the internet, which this app is never meant to be.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

/**
 * A signed absolute URL a Chromecast can fetch.
 *
 * Returns null when casting is off or there is no LAN address to offer, which
 * the caller reports as "not available here" rather than as a failure.
 */
export function link(pathAndQuery, { now = Date.now() } = {}) {
  if (!isEnabled()) return null;

  const host = lanAddress();
  if (!host) return null;

  const [pathname] = pathAndQuery.split('?');
  if (!ALLOWED.some((pattern) => pattern.test(pathname))) {
    log.warn(`refused to sign a cast link for ${pathname}`);
    return null;
  }

  const expiresAt = now + TTL_MS;
  const token = sign(pathname, expiresAt);
  const separator = pathAndQuery.includes('?') ? '&' : '?';

  return `http://${host}:${config.port}${pathAndQuery}${separator}`
    + `castExp=${expiresAt}&castSig=${encodeURIComponent(token)}`;
}

/**
 * Does this request carry a link this server signed, for this path?
 *
 * Checked against the path being requested, not against whatever the token
 * says: a signature over one path must not admit a request for another, which
 * is the whole difference between a capability and a password.
 */
export function verify(req, { now = Date.now() } = {}) {
  if (!isEnabled()) return false;

  const expiresAt = Number(req.query?.castExp);
  const supplied = String(req.query?.castSig || '');
  if (!Number.isFinite(expiresAt) || !supplied) return false;
  if (expiresAt <= now) return false;

  const expected = Buffer.from(sign(req.path, expiresAt));
  const given = Buffer.from(supplied);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export default { isEnabled, link, verify, lanAddress, TTL_MS };
