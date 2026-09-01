/**
 * The remote quality ladder.
 *
 * The host uplink is not the constraint here — it is symmetric and fast. What
 * this protects is the far end: hotel wifi, cellular, and Tailscale's DERP
 * relay fallback when a direct peer-to-peer connection cannot be established.
 */
import config from '../config/index.js';

export const LEVELS = config.remote.levels;

/** "12M" -> 12000000. Returns null for anything unparseable. */
export function parseBitrate(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(String(value).trim());
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2].toLowerCase();
  if (unit === 'm') return Math.round(amount * 1_000_000);
  if (unit === 'k') return Math.round(amount * 1_000);
  return Math.round(amount);
}

/**
 * Turn a requested level and a connection origin into a concrete cap.
 *
 * Auto deliberately never resolves to Original over the tunnel even though the
 * host could serve it: a 4K remux runs 60-100 Mbps, past most client links,
 * and shipping tens of gigabytes over a possibly-metered connection is not
 * something to do without being asked. Original stays available by request.
 */
export function resolveQuality(requested, origin) {
  const asked = String(requested || 'auto').toLowerCase();

  const level = Object.prototype.hasOwnProperty.call(LEVELS, asked)
    ? asked
    : (origin === 'tailscale' ? config.remote.defaultLevel : 'original');

  const resolved = LEVELS[level] || LEVELS.original;
  return { level, height: resolved.height, maxrate: resolved.maxrate };
}

export default { LEVELS, parseBitrate, resolveQuality };
