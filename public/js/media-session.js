/**
 * Lock-screen and Control Centre integration.
 *
 * Without this a phone shows "MediaWatcher" and a generic play button on the
 * lock screen, and the hardware keys on a keyboard do nothing. With it you get
 * the poster, the episode title, and next/previous where they belong.
 *
 * Every call is guarded: the API is absent in older Safari and partially
 * implemented elsewhere, and a missing action handler must never break
 * playback.
 */

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator;

/**
 * Describe what is playing.
 *
 * `artwork` wants absolute URLs; TMDB posters already are. Several sizes are
 * declared because the platform picks one and a single small image looks poor
 * on a lock screen.
 */
export function publishMetadata({ title, subtitle, poster }) {
  if (!supported() || typeof MediaMetadata === 'undefined') return;

  const artwork = poster
    ? [
      { src: poster, sizes: '342x513', type: 'image/jpeg' },
      { src: poster, sizes: '500x750', type: 'image/jpeg' }
    ]
    : [];

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title || 'MediaWatcher',
      artist: subtitle || '',
      album: 'MediaWatcher',
      artwork
    });
  } catch {
    // A malformed artwork URL should not stop playback.
  }
}

/**
 * Wire the transport controls.
 *
 * Handlers that are not supported throw on assignment rather than returning
 * false, so each one is set independently — one unsupported action must not
 * cost the others.
 */
export function publishHandlers(handlers) {
  if (!supported()) return;

  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler || null);
    } catch {
      // Not supported on this platform; the rest still are.
    }
  }
}

/** Keep the scrubber on the lock screen honest. */
export function publishPosition({ duration, position, playbackRate = 1 }) {
  if (!supported() || typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!Number.isFinite(position) || position < 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate: playbackRate || 1
    });
  } catch {
    // Some platforms reject a position state mid-seek; it corrects itself.
  }
}

export function publishPlaybackState(state) {
  if (!supported()) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch { /* optional */ }
}

/** Hand the lock screen back when the player closes. */
export function clearSession() {
  if (!supported()) return;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch { /* optional */ }

  publishHandlers({
    play: null, pause: null, seekbackward: null, seekforward: null,
    seekto: null, previoustrack: null, nexttrack: null
  });
}

export default {
  publishMetadata, publishHandlers, publishPosition, publishPlaybackState, clearSession
};
