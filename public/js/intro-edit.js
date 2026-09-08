/**
 * Intro editor arithmetic.
 *
 * The problem this solves is one of scale. An intro is about ninety seconds
 * inside a forty-minute episode, so on the seek bar it is four pixels wide:
 * fine for jumping to roughly the right place, useless for saying where a
 * title sequence actually ends. Every function here maps between a *window* —
 * a short span of the episode, blown up to the full width of the strip — and
 * the times inside it, which is what makes a second worth dragging.
 *
 * Kept out of player.js so it can be tested without a DOM: everything takes
 * numbers and returns numbers.
 */

/** An intro cannot be shorter than this, however hard the handles are dragged. */
export const MIN_LENGTH = 1;

/**
 * The spans the strip can be zoomed to, shortest first.
 *
 * 30s is about a second per two pixels on a phone, which is as fine as a
 * finger can place anything. 600s is there for the rare season whose titles
 * arrive after a long cold open.
 */
export const ZOOM_SPANS = [30, 60, 120, 300, 600];

/** Breathing room kept either side of the intro when a span is chosen for you. */
const CONTEXT_SECONDS = 12;

/** Where an unmarked season starts out: a first guess to drag into shape. */
export const DEFAULT_START = 0;
export const DEFAULT_END = 90;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/**
 * The smallest span that shows the whole intro with context either side.
 *
 * Falls to the widest span rather than refusing, so an intro longer than every
 * option still gets a strip — just a tighter-fitting one.
 */
export function defaultSpan(start, end) {
  const needed = Math.abs(finite(end) - finite(start)) + (CONTEXT_SECONDS * 2);
  return ZOOM_SPANS.find((span) => span >= needed) ?? ZOOM_SPANS[ZOOM_SPANS.length - 1];
}

/** One step wider or narrower, stopping at the ends rather than wrapping. */
export function stepSpan(span, direction) {
  const index = ZOOM_SPANS.indexOf(span);
  // An unrecognised span (from a stale draft) lands on the nearest sane value.
  if (index < 0) return defaultSpan(0, span);
  return ZOOM_SPANS[clamp(index + Math.sign(direction), 0, ZOOM_SPANS.length - 1)];
}

/**
 * The stretch of the episode the strip covers.
 *
 * Centred on the intro so both handles are reachable, then slid — not shrunk —
 * back inside the file, because a window that shrinks at the start of an
 * episode would change the scale under a drag that is already happening.
 */
export function editorWindow({ start, end, duration, span }) {
  const width = finite(span, ZOOM_SPANS[1]);
  const total = finite(duration, 0);
  // Nothing known about the file's length: show the span from where it sits.
  const limit = total > 0 ? total : Math.max(width, finite(end) + CONTEXT_SECONDS);

  if (limit <= width) return { from: 0, to: limit, span: limit };

  const middle = (finite(start) + finite(end)) / 2;
  const from = clamp(middle - (width / 2), 0, limit - width);
  return { from, to: from + width, span: width };
}

/** Where a time sits along the strip, as a fraction in [0, 1]. */
export function fractionOf(time, window) {
  const span = finite(window?.to) - finite(window?.from);
  if (span <= 0) return 0;
  return clamp((finite(time) - window.from) / span, 0, 1);
}

/** The time under a fraction of the strip's width. */
export function timeAt(fraction, window) {
  const span = finite(window?.to) - finite(window?.from);
  if (span <= 0) return finite(window?.from);
  return finite(window.from) + (clamp(finite(fraction), 0, 1) * span);
}

/** Is this time on screen at all? The playhead marker asks before drawing. */
export function withinWindow(time, window) {
  return Number.isFinite(time) && time >= finite(window?.from) && time <= finite(window?.to);
}

/**
 * Move one handle, leaving the other where it is.
 *
 * The handles cannot cross or meet: an intro that ends before it starts is not
 * a marker anyone can act on, and one a fraction of a second long would be
 * saved and then never noticed again.
 */
export function moveEdge({ start, end, edge, to, bounds }) {
  const min = finite(bounds?.min, 0);
  const max = finite(bounds?.max, Math.max(finite(end), finite(to)));
  const from = finite(start);
  const until = finite(end);
  const target = finite(to, edge === 'start' ? from : until);

  if (edge === 'start') {
    return { start: clamp(target, min, Math.max(min, until - MIN_LENGTH)), end: until };
  }
  return { start: from, end: clamp(target, Math.min(max, from + MIN_LENGTH), max) };
}

/** Which handle a click at this time was aiming for. */
export function nearestEdge({ start, end, time }) {
  const at = finite(time);
  return Math.abs(at - finite(start)) <= Math.abs(at - finite(end)) ? 'start' : 'end';
}

/**
 * A timestamp with tenths: 1:23.4.
 *
 * Whole seconds are the wrong resolution for this one screen. The difference
 * between an intro ending at 91 and at 91.5 is the difference between landing
 * on the first frame of the scene and landing on the last frame of the titles.
 */
export function formatPrecise(seconds) {
  const value = Math.max(0, finite(seconds));
  const minutes = Math.floor(value / 60);
  const rest = value - (minutes * 60);
  // Rounding can carry 59.97 up to 60.0, which must read as the next minute.
  const shown = rest.toFixed(1);
  if (Number(shown) >= 60) return formatPrecise((minutes + 1) * 60);
  return `${minutes}:${shown.padStart(4, '0')}`;
}

/** How long the intro is, spoken rather than timestamped. */
export function describeLength(start, end) {
  const length = Math.max(0, finite(end) - finite(start));
  if (length < 60) return `${length.toFixed(1)}s`;
  const minutes = Math.floor(length / 60);
  return `${minutes}m ${(length - (minutes * 60)).toFixed(0)}s`;
}

/** Tick spacings, coarsest last. One is picked to keep the scale readable. */
const TICK_STEPS = [5, 10, 15, 30, 60, 120, 300];

/**
 * Evenly spaced marks along the strip.
 *
 * Placed on round numbers rather than at even fractions of the window: a scale
 * reading 0:07, 0:22, 0:37 is arithmetic to read, and the point of the scale
 * is to be glanced at.
 */
export function ticksFor(window, target = 6) {
  const span = finite(window?.to) - finite(window?.from);
  if (span <= 0) return [];

  const wanted = Math.max(2, target);
  const step = TICK_STEPS.find((candidate) => span / candidate <= wanted)
    ?? TICK_STEPS[TICK_STEPS.length - 1];

  const ticks = [];
  const first = Math.ceil(window.from / step) * step;
  for (let time = first; time <= window.to; time += step) {
    ticks.push({ time, fraction: fractionOf(time, window) });
  }
  return ticks;
}

/**
 * Which generated thumbnails to lay across the strip.
 *
 * Frames repeat where the window is tighter than the thumbnail interval — ten
 * cells over thirty seconds of a file sampled every ten. That is honest: the
 * strip is showing everything that exists for that stretch, and the repetition
 * itself says the pictures are coarser than the times.
 */
export function framesFor({ window, count, interval, total }) {
  const cells = Math.max(0, Math.floor(finite(count)));
  const every = finite(interval);
  if (!cells || every <= 0) return [];

  const last = Math.max(0, Math.floor(finite(total)) - 1);
  const frames = [];
  for (let cell = 0; cell < cells; cell += 1) {
    // The middle of each cell, so a picture describes the slice it sits in
    // rather than the instant its left edge lands on.
    const time = timeAt((cell + 0.5) / cells, window);
    frames.push({ time, index: Math.min(last, Math.max(0, Math.floor(time / every))) });
  }
  return frames;
}

export default {
  MIN_LENGTH, ZOOM_SPANS, DEFAULT_START, DEFAULT_END,
  defaultSpan, stepSpan, editorWindow, fractionOf, timeAt, withinWindow,
  moveEdge, nearestEdge, formatPrecise, describeLength, ticksFor, framesFor
};
