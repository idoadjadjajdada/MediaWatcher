/**
 * Picture controls — brightness and contrast.
 *
 * A CSS filter on the video element, not on the player root: on the root the
 * control bar and subtitles would dim along with the picture, which is the
 * opposite of what dimming is for.
 *
 * Unlike audio delay, this never reaches ffmpeg. It is a repaint, so it is
 * instant and behaves identically in direct, remux and transcode modes.
 *
 * Settings are global rather than per-file: brightness tracks how bright the
 * room is, not how a file was mastered.
 */

export const PICTURE_MIN = 20;
export const PICTURE_MAX = 150;
export const PICTURE_DEFAULT = 100;

const STORAGE_KEY = 'mw.picture';

/**
 * Clamp to the allowed range. Anything unparseable becomes the default.
 *
 * Null and empty string are rejected before Number() sees them: both coerce to
 * 0, which is finite, so a stored `{"brightness": null}` would otherwise open
 * the player clamped to 20% rather than falling back to 100%.
 */
export function clampPicture(value) {
  if (value === null || value === undefined || value === '') return PICTURE_DEFAULT;
  const number = Number(value);
  if (!Number.isFinite(number)) return PICTURE_DEFAULT;
  return Math.max(PICTURE_MIN, Math.min(PICTURE_MAX, Math.round(number)));
}

/** The exact CSS filter string for a picture setting. */
export function pictureFilter({ brightness, contrast } = {}) {
  const b = clampPicture(brightness) / 100;
  const c = clampPicture(contrast) / 100;
  return `brightness(${b}) contrast(${c})`;
}

/**
 * Read the stored setting.
 *
 * Every failure path returns the default rather than throwing: a browser with
 * storage blocked must still play video.
 */
export function loadPicture() {
  const fallback = { brightness: PICTURE_DEFAULT, contrast: PICTURE_DEFAULT };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      brightness: clampPicture(parsed?.brightness),
      contrast: clampPicture(parsed?.contrast)
    };
  } catch {
    return fallback;
  }
}

/** Store the setting. A blocked write is not an error worth surfacing. */
export function savePicture({ brightness, contrast } = {}) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      brightness: clampPicture(brightness),
      contrast: clampPicture(contrast)
    }));
  } catch {
    // Private browsing. The filter still applies for this session.
  }
}

export default { clampPicture, pictureFilter, loadPicture, savePicture };
