/**
 * Finding a season's intro by matching two of its episodes.
 *
 * A title sequence is the same audio every week, and almost nothing else in
 * two different episodes is. So the intro is simply the longest stretch of
 * audio the two have in common.
 *
 * Black frames and silence — the obvious alternative — were rejected: they
 * find scene cuts, every episode has dozens, and nothing about a cut says
 * "title sequence".
 *
 * The comparison is deliberately coarse. A quarter-second loudness envelope,
 * normalised, is enough to recognise the same music while being cheap to
 * compute and indifferent to encoding, bitrate and mastering level.
 */
import { spawn } from 'node:child_process';
import config, { createLogger } from '../config/index.js';
import { INTRO_WINDOW_SECONDS, MIN_INTRO_SECONDS, MAX_INTRO_SECONDS } from './intro.js';
import * as ffmpegPool from './ffmpegPool.js';

const log = createLogger('intro');

/** One bucket per quarter second: fine enough to place a cut, cheap to match. */
export const BUCKET_SECONDS = 0.25;

/** Mono, and low: this is loudness over time, not something anyone listens to. */
const SAMPLE_RATE = 8000;

/**
 * How far apart the same intro may start in two episodes.
 *
 * Cold opens vary in length, so the title sequence can begin minutes apart.
 */
const MAX_OFFSET_SECONDS = 300;

/*
 * Thresholds measured rather than guessed, against two episodes whose intro
 * position is independently known from their chapter marks.
 *
 * On this scale the median bucket is 0.5 by construction, silence sits below
 * 0.1, and the title sequence runs about 1.1-1.3. The same intro in two
 * episodes differed by 0.16 at the median and 0.21 at worst - so a tolerance
 * of 0.08, which is what this started at, could never have matched anything.
 */
const TOLERANCE = 0.26;

/**
 * Below this, a bucket is effectively silence and cannot evidence a match.
 *
 * Without it the algorithm reliably found the wrong thing: two episodes both
 * open with near-silence and a production ident, those buckets agree
 * trivially, and the "longest shared run" is the quiet start of the file
 * rather than the title sequence. Silence is not distinctive, so it does not
 * get a vote.
 */
const SILENCE_FLOOR = 0.25;

/**
 * A title sequence is loud and varied. A run that is uniformly quiet, or flat,
 * matched something that is not music.
 */
const MIN_RUN_ENERGY = 0.8;
const MIN_RUN_VARIATION = 0.12;

/**
 * Reduce raw PCM to a normalised loudness envelope.
 *
 * Normalised against the median of the audible buckets, not the peak. Peak
 * normalisation looks obvious and fails badly here: one loud moment anywhere
 * in the window rescales everything else, so the same title sequence measured
 * beside a quiet cold open and beside a loud one lands at two different
 * scales and never matches itself. The median barely moves.
 */
export function envelopeFromPcm(buffer, { sampleRate = SAMPLE_RATE, bucketSeconds = BUCKET_SECONDS } = {}) {
  const samplesPerBucket = Math.max(1, Math.round(sampleRate * bucketSeconds));
  const totalSamples = Math.floor(buffer.length / 2);
  const buckets = Math.floor(totalSamples / samplesPerBucket);
  if (buckets === 0) return new Float32Array(0);

  const envelope = new Float32Array(buckets);

  for (let b = 0; b < buckets; b += 1) {
    let sum = 0;
    const base = b * samplesPerBucket;
    for (let i = 0; i < samplesPerBucket; i += 1) {
      const sample = buffer.readInt16LE((base + i) * 2) / 32768;
      sum += sample * sample;
    }
    envelope[b] = Math.sqrt(sum / samplesPerBucket);
  }

  const audible = Array.from(envelope).filter((v) => v > 0).sort((x, y) => x - y);
  const median = audible.length ? audible[Math.floor(audible.length / 2)] : 0;
  if (median > 0) {
    for (let b = 0; b < buckets; b += 1) {
      // Clamped: a normalised envelope that runs to 8 on an explosion would
      // put every loud moment outside the comparison tolerance anyway.
      envelope[b] = Math.min(2, envelope[b] / (median * 2));
    }
  }
  return envelope;
}

/**
 * The longest stretch the two envelopes share, or null.
 *
 * Every plausible time offset between the two is tried, and for each the
 * longest run of agreeing buckets is measured. Requiring the run to be
 * intro-length is what keeps a coincidence from being reported as a title
 * sequence.
 */
export function findCommonRun(a, b, {
  minBuckets, maxBuckets, tolerance = TOLERANCE, maxOffsetBuckets
} = {}) {
  if (!a?.length || !b?.length) return null;

  let best = null;

  for (let offset = -maxOffsetBuckets; offset <= maxOffsetBuckets; offset += 1) {
    let runStart = -1;
    let runLength = 0;

    const from = Math.max(0, -offset);
    const to = Math.min(b.length, a.length - offset);

    for (let i = from; i < to; i += 1) {
      // Both sides must carry actual sound: agreeing on silence is not
      // evidence of anything.
      const loud = a[i + offset] > SILENCE_FLOOR && b[i] > SILENCE_FLOOR;
      const same = loud && Math.abs(a[i + offset] - b[i]) <= tolerance;

      if (same) {
        if (runStart === -1) runStart = i;
        runLength += 1;
        // Cap the run: anything longer than an intro is two episodes that
        // simply sound alike, not a title sequence.
        if (runLength <= maxBuckets && runLength >= minBuckets
          && (!best || runLength > best.length)) {
          best = { startA: runStart + offset, startB: runStart, length: runLength };
        }
      } else {
        runStart = -1;
        runLength = 0;
      }
    }
  }

  return best && isMusical(a, best) ? best : null;
}

/**
 * Does this run look like a title sequence rather than a coincidence?
 *
 * Checked after the fact rather than during the scan, because it is a property
 * of the whole run: loud enough to be music, and varied enough not to be a
 * held tone or a stretch of room noise.
 */
function isMusical(envelope, run) {
  const slice = envelope.subarray(run.startA, run.startA + run.length);
  if (slice.length === 0) return false;

  let sum = 0;
  for (const v of slice) sum += v;
  const mean = sum / slice.length;
  if (mean < MIN_RUN_ENERGY) return false;

  let variance = 0;
  for (const v of slice) variance += (v - mean) ** 2;
  return Math.sqrt(variance / slice.length) >= MIN_RUN_VARIATION;
}

/** Turn a run of buckets into a marker in seconds. */
export function runToMarker(run) {
  if (!run) return null;
  return {
    start: run.startA * BUCKET_SECONDS,
    end: (run.startA + run.length) * BUCKET_SECONDS
  };
}

/**
 * Decode the opening of a file to a loudness envelope.
 *
 * Only the window an intro could occupy is decoded, and only the audio — this
 * runs in the background behind live playback, so it must stay cheap.
 */
async function envelopeFor(filePath) {
  // Two of these run per pair, behind live playback, so they queue for a slot
  // in the shared ffmpeg budget rather than adding to it.
  const release = await ffmpegPool.acquire('intro-detect');
  const decoded = new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-t', String(INTRO_WINDOW_SECONDS),
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1'
    ], { windowsHide: true });

    ffmpegPool.register({
      kind: 'intro',
      label: 'decoding the opening',
      filePath,
      proc: child
    });

    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) return resolve(null);
      resolve(envelopeFromPcm(Buffer.concat(chunks)));
    });
  });

  try {
    return await decoded;
  } finally {
    release();
  }
}

/**
 * Compare two episodes and return the intro they share, or null.
 *
 * Null is the common and correct answer: a season whose episodes genuinely
 * have no shared opening should produce nothing rather than a guess.
 */
export async function detectIntro(fileA, fileB) {
  const [a, b] = await Promise.all([envelopeFor(fileA), envelopeFor(fileB)]);
  if (!a || !b) return null;

  const run = findCommonRun(a, b, {
    minBuckets: Math.round(MIN_INTRO_SECONDS / BUCKET_SECONDS),
    maxBuckets: Math.round(MAX_INTRO_SECONDS / BUCKET_SECONDS),
    maxOffsetBuckets: Math.round(MAX_OFFSET_SECONDS / BUCKET_SECONDS)
  });

  const marker = runToMarker(run);
  if (!marker) return null;

  log.info(`detected intro ${marker.start.toFixed(0)}s-${marker.end.toFixed(0)}s `
    + `by matching two episodes`);
  return marker;
}

/**
 * Find a season's intro by trying several pairs of its episodes.
 *
 * One pair failing is ordinary rather than alarming: a mix can differ, an
 * episode can open on the titles while its neighbour opens cold, and a run can
 * fall just outside the tolerance. Measured across season one of the library
 * here, some pairs matched and others found nothing, so the answer is to ask
 * more than once and stop at the first agreement.
 */
export async function detectIntroForSeason(files, { maxPairs = 4 } = {}) {
  const usable = (files || []).filter(Boolean);
  if (usable.length < 2) return null;

  // Consecutive episodes, which are the most likely to share a mix.
  const pairs = [];
  for (let i = 0; i + 1 < usable.length && pairs.length < maxPairs; i += 1) {
    pairs.push([usable[i], usable[i + 1]]);
  }

  for (const [a, b] of pairs) {
    // Sequential on purpose: this runs behind live playback and four ffmpeg
    // decodes at once would compete with the encoder serving the viewer.
    const marker = await detectIntro(a, b);
    if (marker) return marker;
  }
  return null;
}

export default {
  BUCKET_SECONDS, envelopeFromPcm, findCommonRun, runToMarker,
  detectIntro, detectIntroForSeason
};
