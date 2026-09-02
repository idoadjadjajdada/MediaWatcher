/**
 * Seek bar preview arithmetic.
 *
 * Kept out of player.js so it can be tested without a DOM: every function here
 * takes numbers and returns numbers.
 */

/** Pointer position along the track, as a fraction in [0, 1]. */
/**
 * Where along the track a pointer at `x` is.
 *
 * `thumb` is why this is not simply x/width. Seeking goes through a native
 * `<input type="range">`, and a range input does not map clicks across its
 * whole width: the thumb has to stay inside the track, so the usable span is
 * `width - thumb` and the value at a point is measured from half a thumb in.
 *
 * Computing the preview as x/width therefore disagreed with where the click
 * actually landed - exactly at the middle, and by half a thumb width at the
 * ends - so the tooltip named one time and playback jumped to another.
 * Passing the real thumb width makes the preview say what the input will do.
 */
export function previewFraction(x, width, thumb = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;

  const inset = Number.isFinite(thumb) && thumb > 0 ? Math.min(thumb, width) : 0;
  const usable = width - inset;
  // A track narrower than its own thumb has no usable span to map onto.
  if (usable <= 0) return 0;

  return Math.max(0, Math.min(1, (x - inset / 2) / usable));
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
