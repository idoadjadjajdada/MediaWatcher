/**
 * Deciding whether a subtitle track is in time with a file.
 *
 * The measurement lines up two sparse sets of events — the moments a sound
 * starts, and the moments a cue starts after a pause — so those are what is
 * tested, with synthetic series: the question is whether the arithmetic finds
 * a shift, not whether ffmpeg decodes audio.
 *
 * The thresholds these tests pin were set from measurement rather than taste:
 * five films checked against their own embedded tracks, which must read as in
 * sync, and again with every cue moved eight seconds, which must read as out.
 * The rules that fell out of that are the ones asserted here, and the most
 * important is the last group: this would rather say nothing than cry wolf on
 * a correct track.
 *
 * Run: node tests/subtitle-sync.test.mjs
 */
import {
  audioOnsets, cueOnsets, agreementAt, bestOffset, verdict, TOLERANCE_SECONDS
} from '../services/subtitleSync.js';
import { BUCKET_SECONDS } from '../services/introDetect.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const bins = (seconds) => Math.round(seconds / BUCKET_SECONDS);

/** Speech in bursts with gaps, the way a film actually is. */
function conversation(count, { seed = 7, from = 40 } = {}) {
  const cues = [];
  let value = seed;
  let at = from;
  for (let i = 0; i < count; i += 1) {
    value = (value * 1103515245 + 12345) % 2147483648;
    at += 3 + (value % 12);
    cues.push({ start: at, end: at + 2 });
    at += 2;
  }
  return cues;
}

console.log('\nfinding onsets');

{
  // A rise above the loudest of the previous four bins, so a sentence fires
  // once at its start rather than repeatedly through it.
  const envelope = Float32Array.from([0, 0, 0, 0, 0.5, 0.55, 0.6, 0.1, 0.1, 0.1, 0.1, 0.7]);
  const onsets = audioOnsets(envelope, { rise: 0.15, lookback: 4 });
  check('fires at a sharp rise', onsets.includes(4));
  check('and not again through the same sound', !onsets.includes(5) && !onsets.includes(6));
  // Four quiet bins have to pass before the next rise counts, because the
  // lookback still sees the previous sound until then.
  check('but does fire at the next one', onsets.includes(11));
}

check('silence has no onsets', audioOnsets(new Float32Array(20)).length === 0);

{
  const cues = [
    { start: 10, end: 12 },
    { start: 12.5, end: 14 },   // the reply, not a new exchange
    { start: 30, end: 32 }
  ];
  const starts = cueOnsets(cues);
  check('a cue after a gap is a start', starts.length === 2);
  check('the reply is not', starts[0] === bins(10) && starts[1] === bins(30));
}

console.log('\nlining them up');

const cues = conversation(40);
const starts = cueOnsets(cues);

{
  // Perfectly aligned: an audio onset exactly where every cue starts.
  const found = bestOffset(starts, starts);
  check('an aligned pair measures zero', found.offsetSeconds === 0);
  check('with a perfect score', found.score === 1);
  check('and reads the same unshifted', found.atZero === 1);
  check('and says it is in time', verdict(found).state === 'ok');
}

{
  /*
   * The real case: subtitles for another release, eight seconds late. The
   * audio is where it always was; the cues arrive later.
   */
  const late = starts.map((at) => at + bins(8));
  const found = bestOffset(starts, late);
  check('finds the eight second shift', Math.abs(found.offsetSeconds + 8) < 0.6);
  check('scores badly unshifted', found.atZero < found.score * 0.7);
  const answer = verdict(found);
  check('and reports it', answer.state === 'out');
  check('naming the direction', /late/.test(answer.message));
  // The reported figure is the measured one, which lands within a bin of the
  // truth rather than exactly on it.
  check('and the amount, to within a bin', Math.abs(answer.offsetSeconds + 8) < 0.6);
}

{
  const early = starts.map((at) => at - bins(5));
  const answer = verdict(bestOffset(starts, early));
  check('finds a shift the other way too', answer.state === 'out');
  check('and names that direction', /early/.test(answer.message));
}

console.log('\nagreement');

{
  const audio = new Set([10, 20, 30]);
  check('a hit within tolerance counts', agreementAt(audio, [11], 0, 2) === 1);
  check('outside it does not', agreementAt(audio, [14], 0, 2) === 0);
  check('a shift can rescue it', agreementAt(audio, [14], -4, 2) === 1);
}

// Divided by the cues asked about, not by the ones still in range: a shift
// that pushes cues off the end of the audio must score badly, and normalising
// by what remains would flatter exactly those.
check('cues shifted out of range score zero',
  agreementAt(new Set([10, 20]), [10, 20], 5000, 2) === 0);
check('no cues is no agreement', agreementAt(new Set([1]), [], 0, 2) === 0);

console.log('\nwhen to say nothing');

const strong = { offsetSeconds: 0, score: 0.8, atZero: 0.8, sharpness: 2.5, cueStarts: 30 };

check('a film with four lines in ten minutes is not measured',
  verdict({ ...strong, cueStarts: 4 }).state === 'unknown');

// A track for an entirely different film matches nothing at any offset. That
// is a different message from "shift this by eight seconds", and offering the
// second would send someone chasing a number that will never work.
check('a track that matches nothing is unmatched',
  verdict({ ...strong, score: 0.2, offsetSeconds: 9 }).state === 'unmatched');
check('and is offered no shift',
  verdict({ ...strong, score: 0.2, offsetSeconds: 9 }).offsetSeconds === 0);

/*
 * The measured case that produced this rule: a quiet film with sparse dialogue
 * over a lot of ambient sound, whose peak is barely above the field. It reads
 * the same whether its track is in sync or eight seconds out, so the honest
 * answer is that there is no answer.
 */
check('a peak that is not distinct is not believed',
  verdict({ ...strong, sharpness: 1.6, offsetSeconds: 13, atZero: 0.3 }).state === 'unknown');
check('and it says so plainly',
  /Cannot tell/.test(verdict({ ...strong, sharpness: 1.6, offsetSeconds: 13, atZero: 0.3 }).message));

/*
 * The prior that keeps this useful: almost every track is in sync, so a peak
 * elsewhere must be decisively better than no shift at all. Four of the five
 * measured films peak slightly off zero while scoring nearly as well there.
 */
check('a peak that is barely better than zero is in sync',
  verdict({ offsetSeconds: 19.5, score: 0.458, atZero: 0.417, sharpness: 1.83, cueStarts: 24 }).state === 'ok');
check('a peak that is decisively better is not',
  verdict({ offsetSeconds: 8, score: 0.727, atZero: 0.3, sharpness: 2.6, cueStarts: 22 }).state === 'out');

check('a shift inside the tolerance is in sync',
  verdict({ ...strong, offsetSeconds: TOLERANCE_SECONDS - 0.1, atZero: 0.1 }).state === 'ok');
check('and reports no shift to apply',
  verdict({ ...strong, offsetSeconds: TOLERANCE_SECONDS - 0.1, atZero: 0.1 }).offsetSeconds === 0);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
