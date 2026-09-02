/**
 * Finding an intro by matching two episodes.
 *
 * The signal is that a season's title sequence is the same audio every week.
 * Two episodes are reduced to a coarse loudness envelope and the longest run
 * that matches between them is the intro.
 *
 * Black frames and silence were the obvious alternative and are much worse:
 * they find scene cuts, which every episode has dozens of, and nothing about a
 * scene cut says "title sequence".
 *
 * Run: node tests/intro-detect.test.mjs
 */
import {
  BUCKET_SECONDS, envelopeFromPcm, findCommonRun, runToMarker
} from '../services/introDetect.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/** A 16-bit mono PCM buffer of `samples` at a constant amplitude. */
function pcm(values, samplesPerValue) {
  const buf = Buffer.alloc(values.length * samplesPerValue * 2);
  let offset = 0;
  for (const amplitude of values) {
    for (let i = 0; i < samplesPerValue; i += 1) {
      buf.writeInt16LE(Math.round(amplitude), offset);
      offset += 2;
    }
  }
  return buf;
}

console.log('\nenvelopeFromPcm');
const flat = envelopeFromPcm(pcm([1000, 1000, 1000, 1000], 2000), { sampleRate: 8000, bucketSeconds: 0.25 });
check('one bucket per quarter second', flat.length === 4, flat.length);
check('a constant tone is a flat envelope',
  flat.every((v) => Math.abs(v - flat[0]) < 0.001), Array.from(flat));

const varied = envelopeFromPcm(pcm([0, 8000, 0, 8000], 2000), { sampleRate: 8000, bucketSeconds: 0.25 });
check('silence reads lower than sound', varied[0] < varied[1], Array.from(varied));
// Normalised against the median, so two episodes mastered at different levels
// still compare.
check('the envelope is normalised', Math.max(...varied) <= 1.0001, Array.from(varied));
check('an empty buffer yields an empty envelope',
  envelopeFromPcm(Buffer.alloc(0), { sampleRate: 8000, bucketSeconds: 0.25 }).length === 0);

console.log('\nfindCommonRun');
/*
 * A shared 60-second stretch, in different places in each episode, built to
 * the scale real envelopes actually have: measured against two episodes, the
 * median bucket normalises to 0.5, dialogue sits around it, and a title
 * sequence runs about 1.2. Synthetic data on some other scale would sail past
 * the loudness thresholds and prove nothing about the real thing.
 */
const shared = Array.from({ length: 240 }, (_, i) => 1.2 + Math.sin(i / 4) * 0.35);
const noiseA = Array.from({ length: 80 }, (_, i) => 0.3 + ((i * 37) % 60) / 100);
const noiseB = Array.from({ length: 40 }, (_, i) => 0.3 + ((i * 53) % 60) / 100);

const a = Float32Array.from([...noiseA, ...shared, ...noiseA]);
const b = Float32Array.from([...noiseB, ...shared, ...noiseB]);

const run = findCommonRun(a, b, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 400 });
check('a shared stretch is found', run !== null);
check('it starts where the shared audio starts in A',
  run && Math.abs(run.startA - noiseA.length) <= 4, run);
check('it is about the right length',
  run && Math.abs(run.length - shared.length) <= 8, run);

// Two unrelated episodes must produce nothing rather than a wrong answer.
const randomA = Float32Array.from({ length: 400 }, (_, i) => 0.4 + ((i * 71) % 130) / 100);
const randomB = Float32Array.from({ length: 400 }, (_, i) => 0.4 + ((i * 29) % 130) / 100);
check('unrelated audio finds nothing',
  findCommonRun(randomA, randomB, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 200 }) === null);

// Silence is identical in every episode ever made and means nothing. Before
// this was excluded, the detector reliably reported the quiet opening seconds
// of two files as their shared intro.
const quietA = Float32Array.from({ length: 400 }, () => 0.02);
const quietB = Float32Array.from({ length: 400 }, () => 0.02);
check('shared silence is not an intro',
  findCommonRun(quietA, quietB, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 200 }) === null);

// A sustained tone is loud but carries no shape to recognise.
const toneA = Float32Array.from({ length: 400 }, () => 1.2);
const toneB = Float32Array.from({ length: 400 }, () => 1.2);
check('a flat loud tone is not an intro',
  findCommonRun(toneA, toneB, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 200 }) === null);

// A brief coincidence is not a title sequence.
const briefA = Float32Array.from([...noiseA, ...shared.slice(0, 12), ...noiseA]);
const briefB = Float32Array.from([...noiseB, ...shared.slice(0, 12), ...noiseB]);
check('a match shorter than an intro is rejected',
  findCommonRun(briefA, briefB, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 200 }) === null);

check('an empty envelope finds nothing',
  findCommonRun(new Float32Array(0), b, { minBuckets: 40, maxBuckets: 720, maxOffsetBuckets: 200 }) === null);

console.log('\nrunToMarker');
const marker = runToMarker({ startA: 40, length: 240 });
check('buckets become seconds', Math.abs(marker.start - 40 * BUCKET_SECONDS) < 0.001, marker);
check('the end is the far side of the run',
  Math.abs(marker.end - (280 * BUCKET_SECONDS)) < 0.001, marker);
check('nothing in, nothing out', runToMarker(null) === null);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
