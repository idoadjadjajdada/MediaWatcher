/**
 * Learning where a show's intro is, from the one signal that always exists:
 * you skipping it.
 *
 * The library offers nothing to work from — every file titles its chapters
 * "Chapter 1", so there is no metadata that says where a title sequence ends.
 * But skipping one is a deliberate act with a clear shape: a forward jump,
 * early in the episode, over roughly a minute. Seen twice in a season at
 * roughly the same place, that is an intro.
 *
 * Everything here is pure. The bar is deliberately set high because the
 * failure that matters is a false positive: offering to skip into the middle
 * of a scene is worse than never offering.
 */

/** How far into an episode an intro can plausibly begin or end. */
export const INTRO_WINDOW_SECONDS = 420;

/** Shorter than this is someone nudging past a slow moment, not skipping. */
export const MIN_INTRO_SECONDS = 20;

/** Longer than this is finding your place, not skipping a title sequence. */
export const MAX_INTRO_SECONDS = 180;

/** How far apart two skips can land and still be describing the same intro. */
export const AGREEMENT_TOLERANCE = 6;

/** How many episodes must agree before anything is offered. */
export const REQUIRED_AGREEMENT = 2;

/** Offered this long before the intro starts, so it is there when you arrive. */
const OFFER_LEAD_SECONDS = 12;

/**
 * What a learned intro belongs to.
 *
 * Season, not series: opening titles are routinely recut between seasons, and
 * a marker learned from season one applied to season four would skip into the
 * episode.
 */
export function introKey(located) {
  if (!located || located.type !== 'episode') return null;
  const showId = located.item?.tmdb_id;
  if (!showId) return null;
  const season = Number(located.season);
  if (!Number.isFinite(season)) return null;
  return `show:${showId}:s${season}`;
}

/**
 * What one episode's own marker belongs to.
 *
 * Seasons are the right unit for a guess and the wrong unit for a correction.
 * Runs recut their titles episode to episode - a cold open one week and none
 * the next moves the whole sequence by a minute - so someone who has looked at
 * the frames and says "here" is describing this episode, not twenty-two of
 * them. A season marker stays the fallback; this outranks it when it exists.
 */
export function episodeIntroKey(located) {
  const season = introKey(located);
  if (!season) return null;
  const number = Number(located.episode?.episode_number ?? located.episode);
  if (!Number.isFinite(number)) return null;
  return `${season}:e${number}`;
}

/** Does this seek look like someone skipping a title sequence? */
export function isCandidateSkip({ from, to, duration }) {
  if (![from, to, duration].every(Number.isFinite)) return false;
  if (duration <= 0) return false;

  const jump = to - from;
  if (jump < MIN_INTRO_SECONDS || jump > MAX_INTRO_SECONDS) return false;

  // Both ends have to sit in the part of the episode an intro could occupy.
  if (from < 0 || from > INTRO_WINDOW_SECONDS) return false;
  if (to > INTRO_WINDOW_SECONDS) return false;

  return true;
}

/**
 * Find the intro two or more skips agree on, or null.
 *
 * Clusters on where the skips *landed* rather than where they began: people
 * start skipping at different moments but stop at the same one, because that
 * is where the episode resumes.
 */
export function agreeOnIntro(candidates) {
  if (!Array.isArray(candidates) || candidates.length < REQUIRED_AGREEMENT) return null;

  const usable = candidates.filter((c) => Number.isFinite(c?.to) && Number.isFinite(c?.from));
  if (usable.length < REQUIRED_AGREEMENT) return null;

  let best = null;

  for (const anchor of usable) {
    const cluster = usable.filter((c) => Math.abs(c.to - anchor.to) <= AGREEMENT_TOLERANCE);
    if (cluster.length < REQUIRED_AGREEMENT) continue;
    // Biggest cluster wins; ties go to the earlier one, which is the safer
    // place to stop skipping.
    if (!best || cluster.length > best.length
      || (cluster.length === best.length && anchor.to < best[0].to)) {
      best = cluster;
    }
  }

  if (!best) return null;

  const ends = best.map((c) => c.to).sort((a, b) => a - b);
  const starts = best.map((c) => c.from);

  return {
    // The median end, so one slightly late skip does not drag the marker past
    // the start of the episode proper.
    end: ends[Math.floor(ends.length / 2)],
    // The earliest point anyone started skipping from: the intro certainly had
    // begun by then.
    start: Math.max(0, Math.min(...starts)),
    observations: best.length
  };
}

/** Should the Skip Intro button be on screen at this position? */
export function shouldOfferSkip(marker, position) {
  if (!marker || !Number.isFinite(position)) return false;
  if (!Number.isFinite(marker.start) || !Number.isFinite(marker.end)) return false;
  return position >= marker.start - OFFER_LEAD_SECONDS && position < marker.end;
}

/* --------------------------------------------------------------------------
 * Markers set by hand
 *
 * Both automatic routes are guesses, and a guess that is thirty seconds out is
 * worse than none: the button lands mid-scene, or leaves the last bars of the
 * titles playing every episode. Someone watching can see exactly where the
 * intro ends, so they are allowed to say so, and what they say outranks both.
 * ----------------------------------------------------------------------- */

/** How late in an episode a hand-placed intro may still end. */
export const MANUAL_LATEST_END = 3600;

/** And how long it may run. Longer than this is not a title sequence. */
export const MANUAL_MAX_LENGTH = 900;

/**
 * Which markers may overwrite which.
 *
 * Detection is two episodes sounding alike; learning is someone skipping the
 * same place twice; manual is someone looking at the frame. Rank them and the
 * rule that a marker set by hand survives the next background analysis stops
 * being a special case anyone has to remember to write.
 */
const SOURCE_RANK = { detected: 0, learned: 1, manual: 2 };

const rankOf = (source) => SOURCE_RANK[source] ?? 0;

/** May a `next` marker be written over an `existing` one? */
export function canReplaceMarker(existing, next) {
  if (!existing) return true;
  return rankOf(next) >= rankOf(existing);
}

/**
 * Check a hand-placed marker before it is stored.
 *
 * The bounds are deliberately loose - far looser than the ones detection works
 * within - because this is a person describing an episode they are watching,
 * and the only judgements worth making here are the ones no episode could
 * disagree with: an intro runs forwards, it is longer than a moment, and it is
 * over before the episode is.
 */
export function normaliseManualMarker({ start, end }) {
  const from = Number(start);
  const to = Number(end);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { ok: false, error: 'start and end must be numbers' };
  }
  if (from < 0) return { ok: false, error: 'start cannot be before the episode' };
  if (to <= from) return { ok: false, error: 'the intro has to end after it starts' };
  if (to - from > MANUAL_MAX_LENGTH) {
    return { ok: false, error: `an intro longer than ${MANUAL_MAX_LENGTH / 60} minutes is not an intro` };
  }
  if (to > MANUAL_LATEST_END) return { ok: false, error: 'that is too late in the episode to be an intro' };

  // Tenths are the finest thing the editor can express and the finest anyone
  // can see; storing more would be recording the mouse, not the intro.
  return { ok: true, start: Math.round(from * 10) / 10, end: Math.round(to * 10) / 10 };
}

export default {
  INTRO_WINDOW_SECONDS, MIN_INTRO_SECONDS, MAX_INTRO_SECONDS,
  AGREEMENT_TOLERANCE, REQUIRED_AGREEMENT,
  MANUAL_LATEST_END, MANUAL_MAX_LENGTH,
  introKey, episodeIntroKey, isCandidateSkip, agreeOnIntro, shouldOfferSkip,
  canReplaceMarker, normaliseManualMarker
};
