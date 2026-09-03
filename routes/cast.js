/**
 * /api/cast — what a Chromecast needs in order to play something.
 *
 * The sender in the browser cannot build these URLs itself: they are signed
 * with a key that never leaves the machine, and they have to name an address a
 * Chromecast can reach rather than the one the browser is using. A phone on
 * the tunnel asking to cast is the case that makes this obvious — its own
 * origin is a tailnet name the Chromecast in the room has never heard of.
 */
import express from 'express';
import path from 'node:path';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as castLink from '../services/castLink.js';
import * as transcoder from '../services/transcoder.js';
import { findSubtitles } from './subs.js';

const log = createLogger('api:cast');
const router = express.Router();

/**
 * GET /api/cast/status — can this install cast at all?
 *
 * Answered plainly rather than as a boolean, because there are two different
 * reasons it might be off and they have different fixes: casting was never
 * switched on, or it was but the server is still only listening on loopback.
 */
router.get('/status', (_req, res) => {
  res.json({
    enabled: castLink.isEnabled(),
    address: castLink.isEnabled() ? castLink.lanAddress() : null
  });
});

/**
 * GET /api/cast/media?path=&hevc=&ac3= — a link a Chromecast can fetch.
 *
 * The capability report is the sender's, not the receiver's, and that is
 * wrong here in a way worth stating: what matters is what the *Chromecast* can
 * decode. A first-generation device is H.264 only, so the conservative answer
 * is the right default — the client passes what it knows about the receiver,
 * and passing nothing means "assume the least".
 */
router.get('/media', async (req, res, next) => {
  if (!castLink.isEnabled()) {
    return res.status(503).json({
      error: 'Casting is off. Set BIND_HOST so the server listens on your network, then CAST_ENABLED=1.'
    });
  }

  try {
    const requested = req.query.path;
    if (!requested || typeof requested !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    const filePath = path.resolve(requested);
    if (!isInsideLibrary(filePath)) {
      log.warn(`refused a cast link outside the library: ${requested}`);
      return res.status(403).json({ error: 'path is outside the library' });
    }

    const caps = { hevc: req.query.hevc === '1', ac3: req.query.ac3 === '1' };
    const info = await transcoder.probe(filePath);
    const decision = transcoder.decide(info, caps);

    /*
     * Always the stream endpoint, never a direct file path. It already knows
     * how to remux or transcode for a client that cannot decode the source,
     * and a Chromecast is exactly such a client more often than a browser is.
     */
    const query = new URLSearchParams({ path: filePath });
    if (caps.hevc) query.set('hevc', '1');
    if (caps.ac3) query.set('ac3', '1');

    const media = castLink.link(`/api/stream?${query.toString()}`);
    if (!media) {
      return res.status(503).json({ error: 'No address on this network for a Chromecast to reach.' });
    }

    // Sidecar subtitles only: an embedded track would have to be extracted on
    // demand, and a receiver fetching one cannot wait for ffmpeg to start.
    const subtitles = findSubtitles(filePath)
      .map((entry, index) => ({
        id: index + 1,
        lang: entry.lang || 'und',
        url: castLink.link(`/api/subs?${new URLSearchParams({ path: filePath, lang: entry.lang || '' })}`)
      }))
      .filter((entry) => entry.url);

    return res.json({
      url: media,
      // What the receiver is being handed, so the player can say "casting a
      // transcode" rather than leaving someone to wonder why it looks soft.
      mode: decision.mode,
      contentType: 'video/mp4',
      duration: info?.duration ?? null,
      subtitles,
      expiresInMs: castLink.TTL_MS
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
