/**
 * Subtitle appearance — size, colour, background and vertical position.
 *
 * Global rather than per-file, for the same reason brightness is: how big
 * subtitles need to be is a property of the screen you are sitting in front
 * of, not of the episode.
 *
 * Two mechanisms, because one is not enough. Colour, size and background go
 * through a `::cue` rule in a stylesheet the player owns. Position cannot:
 * `::cue` has no say over where a cue sits, since that is decided by the cue's
 * own `line` value during WebVTT layout. So position is applied by walking the
 * track's cues and setting `line` on each, and re-applied whenever new cues
 * arrive - `line` lives on the cue object, so a cue parsed later never sees a
 * setting applied earlier.
 */

export const SIZE_MIN = 50;
export const SIZE_MAX = 250;
export const SIZE_DEFAULT = 100;

export const OPACITY_MIN = 0;
export const OPACITY_MAX = 100;
export const OPACITY_DEFAULT = 60;

/** Percent of the video height to lift subtitles off the bottom edge. */
export const POSITION_MIN = 0;
export const POSITION_MAX = 40;
export const POSITION_DEFAULT = 8;

/*
 * Deliberately few. These are the colours that stay legible over arbitrary
 * video, and a free colour picker mostly produces subtitles you cannot read.
 */
export const COLOURS = {
  white: '#ffffff',
  yellow: '#ffe14d',
  cyan: '#6fe3ff',
  green: '#7dff9c',
  grey: '#c8c8c8'
};

export const COLOUR_DEFAULT = 'white';

const STORAGE_KEY = 'mw.subtitles';

const clampNumber = (value, min, max, fallback) => {
  // Null and empty string coerce to 0 through Number(), which is finite and
  // would clamp to the minimum rather than falling back. Same trap as picture.
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
};

export const clampSize = (value) => clampNumber(value, SIZE_MIN, SIZE_MAX, SIZE_DEFAULT);
export const clampOpacity = (value) => clampNumber(value, OPACITY_MIN, OPACITY_MAX, OPACITY_DEFAULT);
export const clampPosition = (value) => clampNumber(value, POSITION_MIN, POSITION_MAX, POSITION_DEFAULT);

/** An unknown colour name falls back rather than reaching CSS unvalidated. */
export function clampColour(value) {
  return Object.prototype.hasOwnProperty.call(COLOURS, value) ? value : COLOUR_DEFAULT;
}

export function normaliseStyle(style = {}) {
  return {
    size: clampSize(style.size),
    colour: clampColour(style.colour),
    opacity: clampOpacity(style.opacity),
    position: clampPosition(style.position)
  };
}

export const DEFAULT_STYLE = normaliseStyle({});

/** Read the stored appearance. Every failure path yields the default. */
export function loadSubtitleStyle() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STYLE };
    return normaliseStyle(JSON.parse(raw));
  } catch {
    // Blocked storage or corrupt JSON. Subtitles still have to render.
    return { ...DEFAULT_STYLE };
  }
}

/** Store it. A blocked write is not worth surfacing. */
export function saveSubtitleStyle(style) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normaliseStyle(style)));
  } catch {
    // Private browsing. The setting still applies for this session.
  }
}

/**
 * The `::cue` rule for an appearance.
 *
 * `background-color` carries the opacity rather than the `opacity` property,
 * which would fade the text along with the box behind it. A fully transparent
 * background keeps a text shadow so white-on-white stays readable.
 */
export function cueCss(style, selector = '.player__video') {
  const { size, colour, opacity } = normaliseStyle(style);
  const alpha = (opacity / 100).toFixed(2);
  const shadow = opacity === 0
    ? 'text-shadow: 0 1px 3px rgba(0,0,0,.95), 0 0 6px rgba(0,0,0,.8);'
    : 'text-shadow: none;';

  return `${selector}::cue {
  font-size: ${size}%;
  color: ${COLOURS[colour]};
  background-color: rgba(0, 0, 0, ${alpha});
  ${shadow}
}`;
}

/**
 * Convert a bottom-offset percentage into a WebVTT `line` value.
 *
 * `line` as a percentage measures from the top, so lifting subtitles means a
 * smaller number. Snapped to an integer because fractional percentages render
 * inconsistently across browsers.
 */
export function positionToLine(position) {
  return Math.round(100 - clampPosition(position) - 5);
}

/**
 * Push the position onto every cue of a text track.
 *
 * Cues arrive over time on a streamed track, so this is called again on
 * `cuechange` rather than once at load. A cue that rejects the assignment
 * (some browsers throw on a detached cue) is skipped rather than aborting the
 * rest.
 */
export function applyCuePosition(textTrack, style) {
  if (!textTrack || !textTrack.cues) return 0;
  const line = positionToLine(style?.position);

  let applied = 0;
  for (const cue of Array.from(textTrack.cues)) {
    try {
      // snapToLines false makes `line` a percentage of the video box rather
      // than a count of line heights from the top.
      cue.snapToLines = false;
      cue.line = line;
      applied += 1;
    } catch {
      // A cue that will not take a position still plays where it was.
    }
  }
  return applied;
}

export default {
  SIZE_MIN, SIZE_MAX, SIZE_DEFAULT,
  OPACITY_MIN, OPACITY_MAX, OPACITY_DEFAULT,
  POSITION_MIN, POSITION_MAX, POSITION_DEFAULT,
  COLOURS, COLOUR_DEFAULT, DEFAULT_STYLE,
  clampSize, clampOpacity, clampPosition, clampColour, normaliseStyle,
  loadSubtitleStyle, saveSubtitleStyle,
  cueCss, positionToLine, applyCuePosition
};
