/**
 * Is this subtitle track actually in time with this file?
 *
 * A subtitle cut for a different release is out from the first line, and the
 * way anyone finds out is by watching two minutes of dialogue arrive at the
 * wrong moment. The file already knows: a cue begins when someone begins
 * speaking, so the starts of cues and the starts of sounds should coincide,
 * and if one set has to be slid eight seconds to meet the other then the track
 * is eight seconds out.
 *
 * ## Why onsets rather than loudness
 *
 * The obvious version of this — mark the bins where the audio is loud, mark
 * the bins where a cue is on screen, correlate — does not work, and it fails
 * in the direction that matters. Measured over five films in this library, a
 * loudness threshold marks 58-74% of the opening ten minutes as "loud":
 * music, effects, room tone and dialogue all together. With most of the film
 * lit up, every candidate offset scores well, the peak is flat, and the
 * argmax lands wherever the noise is highest. All five files reported
 * themselves out of sync against their own embedded tracks.
 *
 * Onsets are rare where loudness is common. A film has a couple of hundred
 * sharp rises in ten minutes and a few dozen cues that begin after a pause,
 * and a coincidence between two sparse sets means something.
 *
 * ## Why it would rather say nothing
 *
 * Thresholds here were set from measurement, not taste: each of five files was
 * checked against its own embedded track, which must read as in sync, and
 * again with the cues deliberately moved eight seconds, which must read as
 * out. One of the five — a quiet film with sparse dialogue over a lot of
 * ambient sound — cannot be told apart in either direction. It is reported as
 * "cannot tell" rather than guessed at, because a warning that cries wolf on a
 * correct track is worse than no warning at all.
 */
import { spawn } from 'node:child_process';
import config, { createLogger } from '../config/index.js';
import * as ffmpegPool from './ffmpegPool.js';
import { envelopeFromPcm, BUCKET_SECONDS } from './introDetect.js';

const log = createLogger('sub-sync');

/** Mono 8 kHz: this measures where sound starts, not what it says. */
const SAMPLE_RATE = 8000;

/**
 * How much of the file to look at.
 *
 * Ten minutes is enough dialogue for the peak to be unambiguous and short
 * enough to decode in a few seconds. The whole file would also fold in drift,
 * which is a different fault needing a different fix.
 */
export const WINDOW_SECONDS = 600;

/**
 * How far out of time a track can be and still be found.
 *
 * Twenty seconds covers every ordinary mismatch — a different cut of the same
 * film, a release with a distributor logo at the front. Searching wider found
 * better-scoring coincidences than the truth on two of five test files, which
 * is the failure mode a wider search buys.
 */
export const MAX_SHIFT_SECONDS = 20;

/** Below this nobody notices, and saying so would be noise. */
export const TOLERANCE_SECONDS = 1;

/** A cue start and a sound start this far apart still count as the same moment. */
const MATCH_BINS = 2;

/* --------------------------------------------------------------------------
 * Onsets
 * ----------------------------------------------------------------------- */

/**
 * Bins where the level rises sharply above what came just before.
 *
 * Compared against the loudest of the previous four bins rather than the
 * immediately preceding one: speech is not a single step up, and comparing
 * with one neighbour fires repeatedly through a sentence instead of once at
 * its start.
 */
export function audioOnsets(envelope, { rise = 0.15, lookback = 4 } = {}) {
  const onsets = [];
  for (let i = lookback; i < envelope.length; i += 1) {
    let before = 0;
    for (let k = 1; k <= lookback; k += 1) before = Math.max(before, envelope[i - k]);
    if (envelope[i] - before >= rise) onsets.push(i);
  }
  return onsets;
}

/**
 * Cue starts that follow a silence — the beginning of an exchange.
 *
 * The second line of a conversation begins when the first ends, which is a
 * property of the subtitle rather than of the audio, so counting it adds
 * timings that no sound corresponds to and dilutes the ones that do.
 */
export function cueOnsets(cues, { gapSeconds = 1.5, bucketSeconds = BUCKET_SECONDS } = {}) {
  const onsets = [];
  let lastEnd = -Infinity;
  for (const cue of cues || []) {
    if (cue.start - lastEnd >= gapSeconds) onsets.push(Math.round(cue.start / bucketSeconds));
    lastEnd = Math.max(lastEnd, cue.end);
  }
  return onsets;
}

/* --------------------------------------------------------------------------
 * Lining them up
 * ----------------------------------------------------------------------- */

/**
 * The share of cue starts that meet a sound start when shifted by `shift`.
 *
 * Divided by the number of cue starts, not by the number of matches available:
 * a shift that pushes cues off the end of the audio should score badly, and
 * normalising by what remains in range would flatter exactly those.
 */
export function agreementAt(audioOnsetSet, cueStarts, shift, tolerance = MATCH_BINS) {
  if (cueStarts.length === 0) return 0;

  let hits = 0;
  for (const at of cueStarts) {
    for (let d = -tolerance; d <= tolerance; d += 1) {
      if (audioOnsetSet.has(at + shift + d)) { hits += 1; break; }
    }
  }
  return hits / cueStarts.length;
}

/**
 * The shift that lines the two sets up best, and how much it is worth.
 *
 * `atZero` is reported alongside the peak because the decision needs both: a
 * track whose peak is elsewhere but which scores nearly as well unshifted is
 * in sync with a noisy neighbour, not out of sync.
 */
export function bestOffset(audioOnsetList, cueStarts, {
  maxShiftSeconds = MAX_SHIFT_SECONDS, bucketSeconds = BUCKET_SECONDS, tolerance = MATCH_BINS
} = {}) {
  const audio = new Set(audioOnsetList);
  const maxShift = Math.round(maxShiftSeconds / bucketSeconds);

  const scores = [];
  let best = { shift: 0, score: -1 };

  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    const score = agreementAt(audio, cueStarts, shift, tolerance);
    scores.push(score);
    if (score > best.score || (score === best.score && Math.abs(shift) < Math.abs(best.shift))) {
      best = { shift, score };
    }
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const atZero = agreementAt(audio, cueStarts, 0, tolerance);

  return {
    offsetSeconds: Number((best.shift * bucketSeconds).toFixed(2)),
    score: Number(best.score.toFixed(3)),
    atZero: Number(atZero.toFixed(3)),
    // How much better the peak is than a typical offset. A real alignment
    // stands well clear of the field; noise does not.
    sharpness: Number((median > 0 ? best.score / median : best.score > 0 ? 9 : 0).toFixed(2)),
    cueStarts: cueStarts.length
  };
}

/* --------------------------------------------------------------------------
 * Deciding what to say
 * ----------------------------------------------------------------------- */

/** Below this the measurement carries no information about anything. */
const MIN_SCORE = 0.35;

/** Below this the peak is not distinct enough from the field to believe. */
const MIN_SHARPNESS = 1.8;

/** At least this share of the peak, unshifted, and the track is in time. */
const KEEP_ZERO = 0.7;

/** Fewer starts than this and there is not enough dialogue to measure. */
const MIN_CUE_STARTS = 12;

/**
 * What to tell someone, given a measurement.
 *
 * Four outcomes, and two of them are ways of declining to answer. That is
 * deliberate: this exists to catch a track that is visibly wrong, and every
 * false alarm on a correct one spends the credibility that makes the true
 * warnings worth reading.
 */
export function verdict(measured) {
  const { offsetSeconds, score, atZero, sharpness, cueStarts } = measured;

  if (cueStarts < MIN_CUE_STARTS) {
    return { state: 'unknown', offsetSeconds: 0, message: 'Not enough dialogue near the start to check.' };
  }

  if (score < MIN_SCORE) {
    return {
      state: 'unmatched',
      offsetSeconds: 0,
      message: 'These subtitles do not line up with this audio at any offset — they are probably for a different release.'
    };
  }

  if (sharpness < MIN_SHARPNESS) {
    return {
      state: 'unknown',
      offsetSeconds: 0,
      message: 'Cannot tell — this soundtrack does not give a clear enough answer.'
    };
  }

  /*
   * The prior that keeps this useful: almost every track is in sync, so a peak
   * somewhere else has to be decisively better than no shift at all, not
   * merely better. Without this a correct track whose peak wanders a few
   * seconds - which happens - is reported as needing an offset it does not.
   */
  if (atZero >= score * KEEP_ZERO || Math.abs(offsetSeconds) <= TOLERANCE_SECONDS) {
    return { state: 'ok', offsetSeconds: 0, message: 'In time with the audio.' };
  }

  const seconds = Math.abs(offsetSeconds).toFixed(1);
  return {
    state: 'out',
    offsetSeconds,
    message: offsetSeconds > 0
      ? `Subtitles run about ${seconds}s early — they appear before the line is spoken.`
      : `Subtitles run about ${seconds}s late — the line is spoken before they appear.`
  };
}

/* --------------------------------------------------------------------------
 * Measuring a real file
 * ----------------------------------------------------------------------- */

/** Decode the opening of the file to a mono envelope. */
async function envelopeFor(filePath, audioIndex = 0) {
  const release = await ffmpegPool.acquire('subtitle-sync');

  const decoded = new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-t', String(WINDOW_SECONDS),
      '-i', filePath,
      '-map', `0:a:${audioIndex}?`,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1'
    ], { windowsHide: true });

    ffmpegPool.register({ kind: 'subsync', label: 'checking subtitle timing', filePath, proc: child });

    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) return resolve(null);
      return resolve(envelopeFromPcm(Buffer.concat(chunks), { sampleRate: SAMPLE_RATE }));
    });
  });

  try {
    return await decoded;
  } finally {
    release();
  }
}

/**
 * Check one track against one file.
 *
 * `cues` is `[{ start, end }]` in seconds — parsed by the caller, which
 * already holds the subtitle in whatever form it arrived in.
 */
export async function check(filePath, cues, { audioIndex = 0 } = {}) {
  const inWindow = (cues || []).filter((cue) => cue.start < WINDOW_SECONDS);
  const starts = cueOnsets(inWindow);

  if (starts.length < MIN_CUE_STARTS) {
    return { state: 'unknown', offsetSeconds: 0, message: 'Not enough dialogue near the start to check.' };
  }

  const envelope = await envelopeFor(filePath, audioIndex);
  if (!envelope || envelope.length === 0) {
    return { state: 'unknown', offsetSeconds: 0, message: 'Could not read the audio.' };
  }

  const measured = bestOffset(audioOnsets(envelope), starts);
  const answer = verdict(measured);

  log.info(`${filePath}: ${answer.state} (${measured.offsetSeconds}s, score ${measured.score}, `
    + `at zero ${measured.atZero}, sharpness ${measured.sharpness}, ${measured.cueStarts} cue starts)`);

  return { ...answer, score: measured.score, sharpness: measured.sharpness };
}

export default {
  check, audioOnsets, cueOnsets, agreementAt, bestOffset, verdict,
  WINDOW_SECONDS, MAX_SHIFT_SECONDS, TOLERANCE_SECONDS
};
