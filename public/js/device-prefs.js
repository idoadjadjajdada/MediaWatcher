/**
 * Settings that belong to this device rather than to the account.
 *
 * The split matters and is not arbitrary. Watch progress, remembered tracks
 * and intro markers describe the *content*, so they live in the database and
 * follow you between screens. How loud, how bright, how big the subtitles are
 * and whether the next episode starts on its own describe the *room* you are
 * sitting in - a phone on a train and a TV across a lounge want different
 * answers, and syncing them would make one of the two wrong.
 *
 * So these live in localStorage, like quality and picture already did. This
 * module is the one place that knows the shape, so a setting added here shows
 * up in the settings page without anything else changing.
 */

const STORAGE_KEY = 'mw.device';

/**
 * Every device setting, with its default and how to coerce a stored value.
 *
 * A coercion rather than a bare default: storage is user-writable and survives
 * across versions, so a value that was valid two releases ago has to become
 * something usable rather than reaching the UI as-is.
 */
export const FIELDS = {
  // Auto-advance is the one people most often want off, because it turns a
  // "one more episode" decision into something that happens to you.
  autoplayNext: { default: true, coerce: (v) => v === true || v === 'true' },
  // The next-up card appears this many seconds before the end.
  nextUpLeadSeconds: { default: 25, coerce: (v) => clampInt(v, 5, 120, 25) },
  // Skip Intro can be offered, taken automatically, or never shown.
  introBehaviour: { default: 'offer', coerce: (v) => (['offer', 'auto', 'off'].includes(v) ? v : 'offer') },
  // Whether the resume pill appears at all.
  resumePrompt: { default: true, coerce: (v) => v === true || v === 'true' },
  // Seek step for the on-screen buttons and arrow keys.
  seekSeconds: { default: 10, coerce: (v) => clampInt(v, 5, 60, 10) }
};

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export const DEFAULTS = Object.fromEntries(
  Object.entries(FIELDS).map(([name, field]) => [name, field.default])
);

/** Coerce an arbitrary object into a complete, valid settings object. */
export function normaliseDevicePrefs(input = {}) {
  const out = {};
  for (const [name, field] of Object.entries(FIELDS)) {
    out[name] = Object.prototype.hasOwnProperty.call(input || {}, name)
      ? field.coerce(input[name])
      : field.default;
  }
  return out;
}

/*
 * Read once, then served from memory.
 *
 * These are read on the playback hot path - the seek step, the next-up lead
 * and the intro behaviour are all consulted from `tick`, which runs on every
 * `timeupdate`. Going to localStorage there means a synchronous storage read
 * and a JSON.parse several times a second, for values that change when someone
 * visits the settings page and at no other time.
 *
 * The cache is dropped on every write, so a change still applies to the very
 * next press rather than the next reload — which was the point of reading them
 * live in the first place.
 */
let cached = null;

/** Read them. Every failure path yields the defaults; nothing throws. */
export function loadDevicePrefs() {
  if (cached) return cached;

  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    cached = raw ? normaliseDevicePrefs(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/** Forget the cached copy, so the next read goes back to storage. */
export function invalidateDevicePrefs() {
  cached = null;
}

/** Merge a patch in and store the result, returning what was stored. */
export function saveDevicePrefs(patch) {
  const merged = normaliseDevicePrefs({ ...loadDevicePrefs(), ...patch });
  cached = merged;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Private browsing. The value still applies for this session.
  }
  return merged;
}

export function resetDevicePrefs() {
  cached = { ...DEFAULTS };
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to remove is the same outcome as removing it.
  }
  return cached;
}

/*
 * Another tab changing a setting invalidates this one's copy. Without it, two
 * open tabs disagree until one of them is reloaded - and the settings page is
 * exactly the sort of thing someone opens in a second tab.
 */
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) invalidateDevicePrefs();
  });
}

export default {
  FIELDS, DEFAULTS, normaliseDevicePrefs, loadDevicePrefs, saveDevicePrefs, resetDevicePrefs
};
