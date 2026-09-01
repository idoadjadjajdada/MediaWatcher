/**
 * What identifies an HLS session, in one place.
 *
 * Two routes need this and they must agree exactly: /api/hls/playlist.m3u8
 * creates the session, and /api/stream/info tells the player which id that
 * will be so it can keep the session alive and end it on close. Building the
 * spec in both by hand would mean a drift in either producing an id the player
 * then addresses in vain.
 */
import { COOKIE_NAME, parseCookies, hashToken } from '../auth.js';
import { sessionKey } from './session.js';

/**
 * Who is asking, for the purposes of not sharing an encoder with them.
 *
 * A remembered device has a stable id; an unremembered session is identified by
 * its own token; the launcher and anything else holding the admin key share one
 * bucket, which is fine because none of them play video.
 */
export function viewerId(req) {
  if (req.device?.id) return `device:${req.device.id}`;
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  return token ? `session:${hashToken(token).slice(0, 16)}` : 'admin';
}

/**
 * Everything a session is keyed on, plus what its encoder needs.
 * `decision` comes from transcoder.decide(), `info` from transcoder.probe().
 */
export function buildSessionSpec({ req, filePath, stats, info, decision, quality, audioIndex, audioOffset, caps }) {
  return {
    viewer: viewerId(req),
    filePath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    quality: quality.level,
    audioIndex,
    audioOffset,
    caps,
    duration: info.duration,
    tonemap: Boolean(decision.tonemapped),
    sourceHeight: info.video?.height ?? null,
    // A tone-mapped stream carries its own height ceiling when no cap is set.
    maxHeight: decision.targetHeight ?? (decision.tonemapped ? decision.tonemapHeight : null),
    maxrate: decision.maxrate
  };
}

/** The id a spec will produce, without creating anything. */
export const specSessionId = (spec) => sessionKey(spec);

export default { viewerId, buildSessionSpec, specSessionId };
