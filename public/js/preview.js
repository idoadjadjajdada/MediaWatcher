/**
 * Seek bar preview arithmetic.
 *
 * Kept out of player.js so it can be tested without a DOM: every function here
 * takes numbers and returns numbers.
 */

/** Pointer position along the track, as a fraction in [0, 1]. */
export function previewFraction(x, width) {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.min(1, x / width));
}

/** Which generated frame covers this position. */
export function frameIndex(time, interval) {
  if (!Number.isFinite(time) || !Number.isFinite(interval) || interval <= 0) return 0;
  return Math.max(0, Math.floor(time / interval));
}

/**
 * Left offset for the preview card, centred on the cursor but clamped so it
 * never overhangs either end of the track.
 */
export function cardLeft(fraction, trackWidth, cardWidth) {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return 0;
  if (!Number.isFinite(cardWidth) || cardWidth <= 0) return 0;
  const centred = (fraction * trackWidth) - (cardWidth / 2);
  return Math.max(0, Math.min(trackWidth - cardWidth, centred));
}

export default { previewFraction, frameIndex, cardLeft };
