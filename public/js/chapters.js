/**
 * Navigating chapters, in the browser.
 *
 * The server normalises the raw ffprobe output (services/chapters.js); this is
 * the half the player needs — where am I, and where does jumping put me. Split
 * on that line rather than duplicated, because each side genuinely uses only
 * its own half.
 *
 * Pure, so the jump maths is testable without a media element.
 */

/**
 * A generic "Chapter 7" carries no information the number beside it does not.
 * Anything else is a real title worth showing.
 */
const GENERIC_TITLE = /^\s*chapter\s*0*\d+\s*$/i;

/** Which chapter a position falls in, or -1 when there are none. */
export function chapterIndexAt(chapters, position) {
  if (!Array.isArray(chapters) || chapters.length === 0) return -1;
  const at = Number.isFinite(position) ? position : 0;

  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    if (at >= chapters[index].start) return index;
  }
  return 0;
}

/** Where "next chapter" lands, or null at the last one. */
export function nextChapterStart(chapters, position) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;
  const next = chapters.find((chapter) => chapter.start > (position ?? 0) + 0.001);
  return next ? next.start : null;
}

/**
 * Where "previous chapter" lands.
 *
 * Restarts the current chapter rather than leaving it, the way a CD player
 * does — unless you are already within a moment of its start, in which case you
 * clearly meant the one before.
 */
const RESTART_WINDOW_SECONDS = 1.5;

export function previousChapterStart(chapters, position) {
  if (!Array.isArray(chapters) || chapters.length === 0) return null;

  const index = chapterIndexAt(chapters, position);
  const current = chapters[index];
  const into = (position ?? 0) - current.start;

  if (into > RESTART_WINDOW_SECONDS) return current.start;
  return index > 0 ? chapters[index - 1].start : 0;
}

/** What to show for a chapter, given most titles are just its number. */
export function chapterLabel(chapter) {
  const title = String(chapter?.title || '').trim();
  if (title && !GENERIC_TITLE.test(title)) return title;
  return `Chapter ${chapter?.number ?? '?'}`;
}

export default { chapterIndexAt, nextChapterStart, previousChapterStart, chapterLabel };
