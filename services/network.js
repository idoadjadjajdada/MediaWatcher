/**
 * Where a request came from.
 *
 * Tailscale hands every node an address in 100.64.0.0/10 (the CGNAT range), so
 * that is what separates "on the sofa" from "in a hotel". This is only reliable
 * because server.js sets trust proxy to loopback: without it every tunnelled
 * request reports as 127.0.0.1 and everything below answers 'lan'.
 */

/** 100.64.0.0/10 == 100.64.0.0 through 100.127.255.255. */
const TAILSCALE_SECOND_OCTET_MIN = 64;
const TAILSCALE_SECOND_OCTET_MAX = 127;

export function isTailscaleAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false;

  // Express reports IPv4 over a dual-stack listener as ::ffff:a.b.c.d.
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const octets = bare.split('.');
  if (octets.length !== 4) return false;

  const parsed = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;

  return parsed[0] === 100
    && parsed[1] >= TAILSCALE_SECOND_OCTET_MIN
    && parsed[1] <= TAILSCALE_SECOND_OCTET_MAX;
}

/**
 * Anything not on the tailnet is treated as local. Erring towards 'lan' means
 * an unrecognised address gets full quality rather than being throttled, which
 * is the harmless direction to be wrong in on a home network.
 */
export const classifyOrigin = (ip) => (isTailscaleAddress(ip) ? 'tailscale' : 'lan');

export default { isTailscaleAddress, classifyOrigin };
