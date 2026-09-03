/**
 * What is worth converting ahead of time, and what is not.
 *
 * Warming used to mean everything. That is the right default for a library of
 * 1080p web rips and the wrong one for almost anything else: a 4K remux
 * converted for a phone that will never play it is an hour of encoding and
 * twenty gigabytes spent on a file nobody asked for, and the disk it fills is
 * the same disk the library lives on.
 *
 * So there is a policy, and it answers one question per file. Three kinds of
 * rule, in the order they are consulted:
 *
 *   the title    "never convert this show", "always convert that one". A
 *                decision about a specific thing beats every general rule,
 *                which is what makes it worth having.
 *   the path     a pattern, for the folder of extras or the drive that is
 *                nearly full.
 *   the shape    size and kind. The general case, and the one most people
 *                will set once and forget.
 *
 * Pure on purpose. The decision is the part worth being sure about, and it is
 * exercised without a library, a database or an encoder.
 */

/** Warm everything, which is what this did before there was a policy. */
export const DEFAULT_POLICY = {
  movies: true,
  shows: true,
  /** Files larger than this are left alone. Zero means no limit. */
  maxBytes: 0,
  /** Case-insensitive substrings matched against the whole path. */
  exclude: [],
  /** `movie:603` or `show:1396` → 'always' | 'never'. */
  titles: {}
};

/** How a title is named in the policy. Stable across renames and re-scans. */
export const titleKey = (type, tmdbId) =>
  `${type === 'episode' || type === 'show' ? 'show' : 'movie'}:${tmdbId}`;

/**
 * Fold a stored policy onto the defaults.
 *
 * A policy written before a field existed must not turn that field off, and a
 * malformed one must not stop warming altogether — the failure mode of this
 * file is silence, and silence should mean "carry on as before".
 */
export function normalise(stored) {
  const policy = stored && typeof stored === 'object' ? stored : {};

  return {
    movies: policy.movies !== false,
    shows: policy.shows !== false,
    maxBytes: Number.isFinite(Number(policy.maxBytes)) && Number(policy.maxBytes) > 0
      ? Number(policy.maxBytes)
      : 0,
    exclude: Array.isArray(policy.exclude)
      ? policy.exclude.map((entry) => String(entry).trim()).filter(Boolean)
      : [],
    titles: policy.titles && typeof policy.titles === 'object' && !Array.isArray(policy.titles)
      ? { ...policy.titles }
      : {}
  };
}

/**
 * Should this file be converted ahead of time?
 *
 * `candidate` is `{ filePath, size, type, tmdbId }`. Answers a reason as well
 * as a verdict, because "nothing happened" is the least useful thing a
 * background job can report — the reason is what the page shows next to a file
 * that was passed over.
 */
export function decide(candidate, stored) {
  const policy = normalise(stored);
  const { filePath = '', size = 0, type = 'movie', tmdbId = null } = candidate || {};

  /*
   * A decision about this specific title comes first, both ways round. Someone
   * who has said "never convert this" means it whatever the size rule says,
   * and someone who has said "always" has usually said it *because* the
   * general rule would have skipped it.
   */
  if (tmdbId != null) {
    const choice = policy.titles[titleKey(type, tmdbId)];
    if (choice === 'never') return { warm: false, reason: 'this title is set never to convert' };
    if (choice === 'always') return { warm: true, reason: 'this title is set always to convert' };
  }

  const haystack = String(filePath).toLowerCase();
  const pattern = policy.exclude.find((entry) => haystack.includes(entry.toLowerCase()));
  if (pattern) return { warm: false, reason: `the path matches "${pattern}"` };

  const isShow = type === 'episode' || type === 'show';
  if (isShow && !policy.shows) return { warm: false, reason: 'shows are not converted ahead of time' };
  if (!isShow && !policy.movies) return { warm: false, reason: 'films are not converted ahead of time' };

  if (policy.maxBytes > 0 && Number(size) > policy.maxBytes) {
    return { warm: false, reason: 'larger than the size limit' };
  }

  return { warm: true, reason: 'no rule excludes it' };
}

/**
 * Set or clear one title's rule.
 *
 * Clearing removes the key rather than storing 'auto': absent already means
 * "follow the general rules", and two ways of spelling the same thing is how a
 * settings page ends up disagreeing with itself.
 */
export function withTitle(stored, type, tmdbId, choice) {
  const policy = normalise(stored);
  const key = titleKey(type, tmdbId);

  if (choice === 'always' || choice === 'never') policy.titles[key] = choice;
  else delete policy.titles[key];

  return policy;
}

/** What a title's rule is right now. */
export const titleChoice = (stored, type, tmdbId) =>
  normalise(stored).titles[titleKey(type, tmdbId)] || 'auto';

export default { DEFAULT_POLICY, normalise, decide, withTitle, titleKey, titleChoice };
