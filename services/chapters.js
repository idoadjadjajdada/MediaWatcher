/**
 * Chapters: the boundaries, not the names.
 *
 * Nearly every file in this library has them and none of them are usefully
 * titled — a sampled thirty files gave twenty-nine with chapters and zero with
 * a name more informative than "Chapter 3". So this exists to answer two
 * questions: where are the breaks, and where does jumping put me.
 *
 * This half turns raw ffprobe output into markers. The player's half - where
 * am I and where does jumping put me - lives in public/js/chapters.js, because
 * only the browser needs it.
 */

/** ffprobe hands times back as strings, and occasionally as nonsense. */
function seconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A generic "Chapter 7" carries no information the number beside it does not.
 * Anything else is a real title worth showing.
 */
const GENERIC_TITLE = /^\s*chapter\s*0*\d+\s*$/i;

/**
 * Turn ffprobe's chapter list into markers.
 *
 * A single chapter spanning the whole file is dropped: it is what a muxer
 * writes when there are no real chapters, and it would put one useless tick at
 * the very start of the scrub bar.
 */
export function normaliseChapters(raw, duration) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const total = Number.isFinite(duration) && duration > 0 ? duration : null;

  const parsed = raw
    .map((chapter) => ({
      start: seconds(chapter?.start_time),
      end: seconds(chapter?.end_time),
      title: String(chapter?.tags?.title || '').trim()
    }))
    .filter((chapter) => chapter.start !== null && chapter.start >= 0)
    // A chapter beginning after the file ends is metadata rot, not a marker.
    .filter((chapter) => total === null || chapter.start < total)
    .sort((a, b) => a.start - b.start);

  if (parsed.length < 2) return [];

  return parsed.map((chapter, index) => ({
    number: index + 1,
    start: chapter.start,
    // Trust the next chapter's start over a stated end, and the duration over
    // the last chapter's end — muxers disagree about the final boundary.
    end: index + 1 < parsed.length
      ? parsed[index + 1].start
      : (total ?? chapter.end ?? chapter.start),
    title: chapter.title
  }));
}

export default { normaliseChapters };
