/**
 * Chapter handling.
 *
 * Nearly every file in this library carries chapters and none of them carry
 * useful titles — they are all "Chapter 1", "Chapter 2". So the value is in the
 * boundaries, not the names: markers to see and points to jump between.
 *
 * Run: node tests/chapters.test.mjs
 */
// Normalising raw probe output is the server's half; navigating the result is
// the browser's, so the tests import each from where it actually lives.
import { normaliseChapters } from '../services/chapters.js';
import {
  chapterIndexAt, nextChapterStart, previousChapterStart, chapterLabel
} from '../public/js/chapters.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

// The shape ffprobe -show_chapters actually returns.
const raw = [
  { start_time: '0.000000', end_time: '89.965000', tags: { title: 'Chapter 1' } },
  { start_time: '89.965000', end_time: '121.788000', tags: { title: 'Chapter 2' } },
  { start_time: '121.788000', end_time: '518.143000', tags: { title: 'Cold Open' } }
];

console.log('\nnormaliseChapters');
const chapters = normaliseChapters(raw, 600);
check('keeps every chapter', chapters.length === 3);
check('parses start times', Math.abs(chapters[1].start - 89.965) < 0.001);
check('carries the title through', chapters[2].title === 'Cold Open');
check('numbers them from one', chapters[0].number === 1 && chapters[2].number === 3);
// The last chapter's end is often the file end; trust the duration over it.
check('the final chapter ends at the duration', Math.abs(chapters[2].end - 600) < 0.001);

check('no chapters yields an empty list', normaliseChapters([], 600).length === 0);
check('null yields an empty list', normaliseChapters(null, 600).length === 0);
check('undefined yields an empty list', normaliseChapters(undefined, 600).length === 0);

// A single chapter spanning the whole file tells the viewer nothing.
check('one chapter covering everything is discarded', normaliseChapters([
  { start_time: '0.000000', end_time: '600.000000', tags: {} }
], 600).length === 0);

// Junk from an unusual muxer should not produce NaN markers on the scrub bar.
check('unparseable times are dropped', normaliseChapters([
  { start_time: 'x', end_time: 'y', tags: {} },
  { start_time: '10', end_time: '20', tags: {} },
  { start_time: '20', end_time: '30', tags: {} }
], 600).length === 2);
check('a chapter starting past the duration is dropped', normaliseChapters([
  { start_time: '0', end_time: '10', tags: {} },
  { start_time: '10', end_time: '20', tags: {} },
  { start_time: '900', end_time: '950', tags: {} }
], 600).length === 2);

console.log('\nchapterIndexAt');
check('the start of the file is the first chapter', chapterIndexAt(chapters, 0) === 0);
check('mid first chapter', chapterIndexAt(chapters, 50) === 0);
check('exactly on a boundary belongs to the later chapter',
  chapterIndexAt(chapters, 89.965) === 1);
check('mid last chapter', chapterIndexAt(chapters, 400) === 2);
check('past the end clamps to the last', chapterIndexAt(chapters, 10000) === 2);
check('before the start clamps to the first', chapterIndexAt(chapters, -5) === 0);
check('no chapters has no index', chapterIndexAt([], 10) === -1);

console.log('\njumping');
check('next from the first goes to the second',
  Math.abs(nextChapterStart(chapters, 10) - 89.965) < 0.001);
check('next from the last has nowhere to go', nextChapterStart(chapters, 400) === null);
check('next from exactly a boundary goes to the one after',
  Math.abs(nextChapterStart(chapters, 89.965) - 121.788) < 0.001);

/*
 * Previous restarts the current chapter first, the way a CD player does: from
 * halfway through chapter two you expect to land at its start, not skip back a
 * whole chapter.
 */
check('previous from mid-chapter restarts that chapter',
  Math.abs(previousChapterStart(chapters, 100) - 89.965) < 0.001);
check('previous from just after a boundary goes back one',
  previousChapterStart(chapters, 90.5) === 0 || Math.abs(previousChapterStart(chapters, 90.5) - 89.965) < 0.001);
check('previous near a chapter start goes to the one before',
  previousChapterStart(chapters, 90.2) === 0);
check('previous in the first chapter goes to zero',
  previousChapterStart(chapters, 40) === 0);
check('no chapters has nothing to jump to',
  nextChapterStart([], 10) === null && previousChapterStart([], 10) === null);

console.log('\nchapterLabel');
check('a real title is used', chapterLabel(chapters[2]) === 'Cold Open');
// "Chapter 3" adds nothing over the number already shown beside it.
check('a generic title falls back to the number',
  chapterLabel({ number: 3, title: 'Chapter 3' }) === 'Chapter 3');
check('a padded generic title is still generic',
  chapterLabel({ number: 4, title: 'Chapter 04' }) === 'Chapter 4');
check('a missing title becomes the number',
  chapterLabel({ number: 7, title: '' }) === 'Chapter 7');

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
