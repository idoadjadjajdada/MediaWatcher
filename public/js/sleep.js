/**
 * Sleep timer.
 *
 * Falling asleep mid-episode is the normal case this exists for, so the design
 * leans on two things: it must not stop mid-scene when you are still watching,
 * and it must not run on after you have gone.
 *
 * Two shapes of timer:
 *
 *   duration        stop after N minutes of wall clock
 *   end-of-episode  stop when this episode finishes, however long is left
 *
 * Pure: the decision is a function of the clock and the playback position, so
 * it can be tested without waiting fifteen minutes.
 */

export const SLEEP_OPTIONS = [
  { id: 'off', label: 'Off', minutes: 0 },
  { id: '15', label: '15 minutes', minutes: 15 },
  { id: '30', label: '30 minutes', minutes: 30 },
  { id: '60', label: '1 hour', minutes: 60 },
  { id: 'episode', label: 'End of episode', minutes: 0 }
];

/**
 * How long a duration timer has left, in milliseconds.
 * Null when no timer is set, or when the timer is not a duration one.
 */
export function remainingMs(timer, now) {
  if (!timer || timer.kind !== 'duration') return null;
  return Math.max(0, timer.endsAt - now);
}

/**
 * Should playback stop?
 *
 * A duration timer fires on the clock. An end-of-episode timer fires when the
 * position reaches the end, which is deliberately the same threshold the
 * next-episode card uses so the two cannot disagree about when an episode is
 * over.
 */
export function shouldSleep(timer, { now, position, duration }) {
  if (!timer) return false;

  if (timer.kind === 'duration') return now >= timer.endsAt;

  if (timer.kind === 'episode') {
    if (!Number.isFinite(duration) || duration <= 0) return false;
    if (!Number.isFinite(position)) return false;
    // Within a second of the end counts as the end: the last frames of a file
    // are often not reachable exactly.
    return position >= duration - 1;
  }

  return false;
}

/** Build a timer from one of the options, or null for "off". */
export function createTimer(optionId, now) {
  const option = SLEEP_OPTIONS.find((o) => o.id === optionId);
  if (!option || option.id === 'off') return null;

  if (option.id === 'episode') return { kind: 'episode', optionId: option.id };
  return { kind: 'duration', optionId: option.id, endsAt: now + (option.minutes * 60000) };
}

/**
 * What to show on the control.
 *
 * A duration timer counts down, because the number is the point; an
 * end-of-episode timer has no meaningful number until the episode is nearly
 * over, so it just names itself.
 */
export function timerLabel(timer, now) {
  if (!timer) return 'Off';
  if (timer.kind === 'episode') return 'End of episode';

  const left = remainingMs(timer, now);
  const minutes = Math.ceil(left / 60000);
  if (left <= 0) return 'Now';
  return minutes === 1 ? '1 min left' : `${minutes} min left`;
}

export default { SLEEP_OPTIONS, remainingMs, shouldSleep, createTimer, timerLabel };
