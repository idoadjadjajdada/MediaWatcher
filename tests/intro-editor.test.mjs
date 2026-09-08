/**
 * Intro editor arithmetic.
 *
 * The editor exists because the seek bar cannot say where a title sequence
 * ends: ninety seconds of a forty-minute episode is four pixels of it. So all
 * of this is about one thing — mapping a short window of the file onto the full
 * width of a strip, and keeping two handles sane inside it while they are
 * dragged around.
 *
 * The failures worth guarding against are the ones that produce a marker
 * nobody can use: handles that cross, a window that slides off the end of a
 * file, or a timestamp that reads 1:60.0.
 *
 * Run: node tests/intro-editor.test.mjs
 */
import {
  MIN_LENGTH, ZOOM_SPANS, defaultSpan, stepSpan, editorWindow, fractionOf, timeAt,
  withinWindow, moveEdge, nearestEdge, formatPrecise, describeLength, ticksFor, framesFor
} from '../public/js/intro-edit.js';

let total = 0;
let failures = 0;
const check = (name, condition, detail) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  }
};
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

console.log('\ndefaultSpan');
check('a typical intro gets a two-minute window', defaultSpan(10, 100) === 120);
check('a short one gets a tighter window', defaultSpan(0, 25) === 60);
// Context either side matters: a window exactly as long as the intro puts both
// handles on the edges of the strip, where neither can be dragged outward.
check('the window is always longer than the intro', defaultSpan(0, 60) > 60);
check('an absurd intro still gets the widest window',
  defaultSpan(0, 5000) === ZOOM_SPANS[ZOOM_SPANS.length - 1]);

console.log('\nstepSpan');
check('zooming in goes one step tighter', stepSpan(120, -1) === 60);
check('zooming out goes one step wider', stepSpan(120, 1) === 300);
check('the tightest zoom does not wrap around', stepSpan(ZOOM_SPANS[0], -1) === ZOOM_SPANS[0]);
check('nor does the widest', stepSpan(ZOOM_SPANS.at(-1), 1) === ZOOM_SPANS.at(-1));

console.log('\neditorWindow');
const early = editorWindow({ start: 10, end: 100, duration: 2400, span: 300 });
check('an intro at the start of a file gives a window at 0', early.from === 0);
check('and the window is the span it asked for', near(early.to - early.from, 300));

const middle = editorWindow({ start: 600, end: 700, duration: 2400, span: 120 });
check('a late intro is centred in its window', near((middle.from + middle.to) / 2, 650));
check('with the intro inside it', middle.from < 600 && middle.to > 700, middle);

// Sliding rather than shrinking: a window that narrowed at the end of a file
// would change the scale under a drag already in progress.
const atEnd = editorWindow({ start: 2350, end: 2380, duration: 2400, span: 300 });
check('a window near the end stays its full width', near(atEnd.to - atEnd.from, 300), atEnd);
check('and does not run past the file', atEnd.to <= 2400);

const tiny = editorWindow({ start: 0, end: 20, duration: 45, span: 300 });
check('a file shorter than the span shows all of it', tiny.from === 0 && tiny.to === 45, tiny);
check('an unknown duration still yields a usable window',
  editorWindow({ start: 0, end: 90, duration: 0, span: 120 }).to > 90);

console.log('\nfractionOf and timeAt');
const view = { from: 60, to: 180 };
check('the start of the window is 0', fractionOf(60, view) === 0);
check('the end of the window is 1', fractionOf(180, view) === 1);
check('the middle is a half', fractionOf(120, view) === 0.5);
check('before the window clamps to 0', fractionOf(0, view) === 0);
check('after it clamps to 1', fractionOf(999, view) === 1);
check('a fraction maps back to its time', timeAt(0.5, view) === 120);
check('the round trip survives', near(timeAt(fractionOf(93.7, view), view), 93.7));
check('a zero-width window does not divide by zero',
  fractionOf(10, { from: 5, to: 5 }) === 0);

check('the playhead is on screen inside the window', withinWindow(120, view) === true);
check('and off it outside', withinWindow(20, view) === false);
check('a stalled position is never on screen', withinWindow(NaN, view) === false);

console.log('\nmoveEdge');
const draft = { start: 30, end: 120 };
const bounds = { min: 0, max: 600 };

const movedStart = moveEdge({ ...draft, edge: 'start', to: 45, bounds });
check('moving the start moves only the start',
  movedStart.start === 45 && movedStart.end === 120, movedStart);

// An intro that ends before it starts cannot be acted on, and one a fraction of
// a second long would be saved and then never noticed again.
const crossed = moveEdge({ ...draft, edge: 'start', to: 300, bounds });
check('the start cannot pass the end', crossed.start < crossed.end, crossed);
check('and stops a real distance short of it',
  near(crossed.end - crossed.start, MIN_LENGTH), crossed);

const crossedBack = moveEdge({ ...draft, edge: 'end', to: 5, bounds });
check('the end cannot pass the start', crossedBack.end > crossedBack.start, crossedBack);

check('the start cannot go before the file',
  moveEdge({ ...draft, edge: 'start', to: -50, bounds }).start === 0);
check('the end cannot go past the bound',
  moveEdge({ ...draft, edge: 'end', to: 9000, bounds }).end === 600);
check('a nonsense target leaves the edge alone',
  moveEdge({ ...draft, edge: 'end', to: NaN, bounds }).end === 120);

console.log('\nnearestEdge');
check('a click near the front takes the start',
  nearestEdge({ start: 30, end: 120, time: 40 }) === 'start');
check('a click near the back takes the end',
  nearestEdge({ start: 30, end: 120, time: 110 }) === 'end');
// Ties go to the start: it is the edge that can always move somewhere.
check('a click in the middle takes the start',
  nearestEdge({ start: 0, end: 100, time: 50 }) === 'start');

console.log('\nformatPrecise');
check('zero reads as a timestamp', formatPrecise(0) === '0:00.0');
check('tenths are kept', formatPrecise(91.2) === '1:31.2');
check('single digits are padded', formatPrecise(65) === '1:05.0');
// 59.97 rounds to 60.0, which must read as the next minute rather than 0:60.0.
check('a rounded-up second carries into the minute', formatPrecise(59.97) === '1:00.0');
check('a negative position never appears', formatPrecise(-10) === '0:00.0');
check('nonsense reads as zero rather than NaN', formatPrecise(undefined) === '0:00.0');

console.log('\ndescribeLength');
check('a short intro is said in seconds', describeLength(0, 45) === '45.0s');
check('a longer one in minutes', describeLength(10, 100) === '1m 30s');
check('a backwards pair is not negative', describeLength(100, 10) === '0.0s');

console.log('\nticksFor');
const ticks = ticksFor({ from: 0, to: 120 }, 6);
check('a two-minute window gets a handful of marks',
  ticks.length >= 3 && ticks.length <= 7, ticks.length);
// Round numbers, because a scale reading 0:07, 0:22, 0:37 is arithmetic to read.
check('every mark lands on a round number',
  ticks.every((tick) => tick.time % 5 === 0), ticks);
check('every mark is on the strip',
  ticks.every((tick) => tick.fraction >= 0 && tick.fraction <= 1));
check('an offset window still gets round marks',
  ticksFor({ from: 613, to: 733 }, 6).every((tick) => tick.time % 5 === 0));
check('a zero-width window has no scale', ticksFor({ from: 5, to: 5 }).length === 0);

console.log('\nframesFor');
const frames = framesFor({ window: { from: 0, to: 120 }, count: 4, interval: 10, total: 100 });
check('one frame per cell', frames.length === 4);
check('the first frame is inside the first cell',
  frames[0].time > 0 && frames[0].time < 30, frames[0]);
check('frames run left to right',
  frames.every((frame, i) => i === 0 || frame.index >= frames[i - 1].index), frames);
check('no frame is asked for past the end',
  framesFor({ window: { from: 3000, to: 3120 }, count: 4, interval: 10, total: 100 })
    .every((frame) => frame.index <= 99));
check('no thumbnails means no filmstrip',
  framesFor({ window: { from: 0, to: 120 }, count: 6, interval: 0, total: 0 }).length === 0);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
