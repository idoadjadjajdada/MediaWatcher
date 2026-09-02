/**
 * Dropping quality when the connection cannot keep up, and raising it again.
 *
 * Textbook adaptive bitrate publishes several renditions in one playlist and
 * lets the player switch between them mid-stream. That is the right design
 * when the renditions already exist as files. Here they do not: every stream
 * is encoded on demand, so a three-rung ladder means three ffmpeg processes
 * per viewer on a machine that usefully runs about four in total — which would
 * make the thing this is supposed to fix considerably worse.
 *
 * So the adaptation is at the level the server already understands: the
 * quality parameter it takes when a stream is opened. Stalls are counted, and
 * enough of them close together reopen the stream a rung lower. A long clean
 * stretch at a reduced level puts it back up.
 *
 * The costly part is that changing level restarts the stream, so the rules are
 * deliberately reluctant: one stall is a hiccup, and a switch that fires on
 * every hiccup is worse than the hiccup. Two inside the window is a pattern.
 *
 * Pure and side-effect free — the player owns the timers and the reloading.
 */

/** Worst to best. 'auto' is not here: it is a request, not a rung. */
export const LADDER = ['low', 'medium', 'high', 'original'];

/** Two stalls this close together is a pattern rather than bad luck. */
export const STALL_WINDOW_MS = 30_000;
export const STALLS_BEFORE_DROP = 2;

/**
 * How long a reduced stream must behave before trying the next rung up.
 *
 * Long on purpose. Stepping up costs another restart, and a level that was
 * genuinely too high will stall again shortly after — so an eager recovery
 * produces a loop of restarts, which is a far worse experience than simply
 * staying one rung low.
 */
export const RECOVERY_MS = 120_000;

export function newAdaptiveState(startingLevel) {
  return {
    // Where the ladder started. Nothing ever climbs above it: the viewer or
    // the server's LAN/tunnel default chose it, and this is a fallback
    // mechanism, not a second opinion about what they wanted.
    ceiling: LADDER.includes(startingLevel) ? startingLevel : null,
    current: LADDER.includes(startingLevel) ? startingLevel : null,
    stalls: [],
    lastChangeAt: 0,
    // Set once the viewer picks a level by hand. After that this does nothing:
    // an explicit choice is not a suggestion to be overridden.
    pinned: false
  };
}

/** The rung below `level`, or null when already at the bottom. */
export function stepDown(level) {
  const index = LADDER.indexOf(level);
  return index > 0 ? LADDER[index - 1] : null;
}

/** The rung above `level`, or null when already at the top. */
export function stepUp(level) {
  const index = LADDER.indexOf(level);
  return index >= 0 && index < LADDER.length - 1 ? LADDER[index + 1] : null;
}

/** Record a stall, keeping only those inside the window. */
export function recordStall(state, now = Date.now()) {
  if (!state) return state;
  state.stalls = [...state.stalls, now].filter((at) => now - at <= STALL_WINDOW_MS);
  return state;
}

/**
 * What to do, given what has happened. Answers a level to switch to, or null.
 *
 * `null` is the overwhelmingly common answer, and the function is written so
 * that every reason to do nothing is explicit rather than falling out of the
 * arithmetic.
 */
export function decide(state, { now = Date.now(), buffering = false } = {}) {
  if (!state || state.pinned || !state.current) return null;

  // A switch restarts the stream. Two in quick succession would be a stutter
  // of its own, so nothing happens for a while after one.
  if (now - state.lastChangeAt < STALL_WINDOW_MS) return null;

  const recent = state.stalls.filter((at) => now - at <= STALL_WINDOW_MS);
  if (recent.length >= STALLS_BEFORE_DROP) {
    const next = stepDown(state.current);
    // Already at the bottom: stalling at 'low' is not a bitrate problem, and
    // there is nothing below it to try.
    return next ? { level: next, direction: 'down', reason: 'the connection is not keeping up' } : null;
  }

  // Climbing back is only ever a return to where it started.
  if (state.current !== state.ceiling && !buffering && recent.length === 0) {
    const quiet = now - state.lastChangeAt;
    if (quiet >= RECOVERY_MS) {
      const next = stepUp(state.current);
      if (next && LADDER.indexOf(next) <= LADDER.indexOf(state.ceiling)) {
        return { level: next, direction: 'up', reason: 'the connection has settled' };
      }
    }
  }

  return null;
}

/** Apply a decision. Stalls are cleared so the new level is judged afresh. */
export function applyDecision(state, decision, now = Date.now()) {
  if (!state || !decision) return state;
  state.current = decision.level;
  state.lastChangeAt = now;
  state.stalls = [];
  return state;
}

/** The viewer chose a level: stop adapting, and treat it as the new ceiling. */
export function pin(state, level) {
  if (!state) return state;
  state.pinned = true;
  if (LADDER.includes(level)) {
    state.ceiling = level;
    state.current = level;
  }
  return state;
}

export default {
  LADDER, STALL_WINDOW_MS, STALLS_BEFORE_DROP, RECOVERY_MS,
  newAdaptiveState, stepDown, stepUp, recordStall, decide, applyDecision, pin
};
