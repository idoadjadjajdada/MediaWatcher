/**
 * What this machine can actually keep up with.
 *
 * Every performance decision here rests on numbers measured once, by hand, and
 * written into a comment: libx264 at 1080p runs 1.18x realtime, NVENC 1.56x,
 * tone mapping 4K at native height 0.60x — which is why it is capped to 1080p.
 * Those numbers are from one machine on one day, and anyone else running this
 * has different hardware and no way to find out where they stand.
 *
 * So measure it. A short encode of a real file from the library, timed, per
 * path, reported as a realtime factor: above 1.0 the encoder produces video
 * faster than it is watched and playback holds; below it, playback stalls and
 * no amount of buffering fixes that.
 *
 * A real file rather than a synthetic source, because decoding is half the
 * cost and `testsrc` does not decode anything. The benchmark is only as
 * relevant as the thing it measures.
 */
import { spawn } from 'node:child_process';
import config, { createLogger } from '../config/index.js';
import { probe, isAvailable, hardwareEncoder, isHdr, tonemapChain, TONEMAP_MAX_HEIGHT } from './transcoder.js';
import * as scanner from './scanner.js';
import * as ffmpegPool from './ffmpegPool.js';
import { createProgressReader } from './ffmpegProgress.js';
import { readState, writeState } from '../db/index.js';

const log = createLogger('benchmark');

/** How much video each run encodes. Long enough to settle, short enough to wait for. */
const SAMPLE_SECONDS = 12;

/** Where in the file to sample. Opening titles are atypically cheap. */
const SAMPLE_START_SECONDS = 120;

/** Where the last result is kept, so the page has something before you press it. */
const STATE_KEY = 'benchmark';

/* --------------------------------------------------------------------------
 * Picking something to measure
 * ----------------------------------------------------------------------- */

/** Every video file in the library, with the little the index knows about it. */
function libraryFiles() {
  const library = scanner.getLibrary();
  const files = [];
  for (const movie of library.movies || []) {
    for (const file of movie.files || []) files.push(file);
  }
  for (const show of library.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        for (const file of episode.files || []) files.push(file);
      }
    }
  }
  return files;
}

/**
 * The hardest file in the library, because that is the one that decides
 * whether this machine copes.
 *
 * Bitrate is the proxy: the index has size and no codec, and size over runtime
 * is what separates a 4K remux from a 720p web rip without probing a thousand
 * files to find out.
 */
export function pickSample(files, { minBytes = 200 * 1024 ** 2 } = {}) {
  const candidates = (files || []).filter((file) => Number(file.size) >= minBytes);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, file) => (Number(file.size) > Number(best.size) ? file : best));
}

/* --------------------------------------------------------------------------
 * Running one
 * ----------------------------------------------------------------------- */

/**
 * Encode a sample and report how fast it went.
 *
 * Output goes nowhere: `-f null -` runs the whole decode, filter and encode
 * chain and discards the muxed result, so the number measures the work rather
 * than the disk it would have been written to.
 */
function timeEncode(filePath, { label, videoArgs, filter = null, startSeconds = SAMPLE_START_SECONDS }) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(startSeconds),
      '-i', filePath,
      '-t', String(SAMPLE_SECONDS),
      '-map', '0:v:0', '-an', '-sn', '-dn'
    ];
    if (filter) args.push('-vf', filter);
    args.push(...videoArgs, '-progress', 'pipe:1', '-f', 'null', '-');

    const started = Date.now();
    const child = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
    ffmpegPool.register({ kind: 'benchmark', label, filePath, proc: child });

    let encoded = 0;
    let reported = null;
    child.stdout?.on('data', createProgressReader(({ speed, outSeconds }) => {
      if (outSeconds !== null) encoded = outSeconds;
      if (speed !== null) reported = speed;
    }));

    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-400); });

    child.on('error', (error) => resolve({ label, ok: false, error: error.message }));
    child.on('close', (code) => {
      const wall = (Date.now() - started) / 1000;
      if (code !== 0 || encoded <= 0) {
        return resolve({ label, ok: false, error: stderr.trim().split('\n').pop() || `exit ${code}` });
      }
      /*
       * ffmpeg's own `speed` is the better number where there is one: it
       * excludes process startup, which is a fixed second or so and would drag
       * a twelve-second sample down by most of a tenth. Wall time is the
       * fallback, and it is never flattering.
       */
      return resolve({
        label,
        ok: true,
        speed: Number((reported ?? (encoded / wall)).toFixed(2)),
        encodedSeconds: Number(encoded.toFixed(1)),
        wallSeconds: Number(wall.toFixed(1))
      });
    });
  });
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */

/** The encodes worth timing for a given source, in the order they are reported. */
function plan(info, encoder) {
  const height = info.video?.height || null;
  const runs = [];

  const cpu = [
    '-c:v', 'libx264',
    '-preset', config.ffmpeg.videoPreset,
    '-crf', String(config.ffmpeg.videoCrf)
  ];

  /*
   * The same pixel format the real encode sets, and not decoration: most of a
   * 4K library is 10-bit, libx264 will happily encode that as High 10, and
   * NVENC refuses it outright — "at least one of its streams received no
   * packets", which reads as a broken GPU rather than as a format it cannot
   * take. Measuring a chain the app does not run would be worse than not
   * measuring at all.
   */
  const eightBit = ['-pix_fmt', 'yuv420p'];

  runs.push({
    label: 'H.264, software, 1080p',
    videoArgs: [...cpu, ...eightBit],
    filter: 'scale=-2:1080'
  });

  if (encoder) {
    const gpu = encoder === 'h264_nvenc'
      ? ['-c:v', encoder, '-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf)]
      : ['-c:v', encoder, '-global_quality', String(config.ffmpeg.videoCrf)];
    runs.push({
      label: `H.264, ${encoder}, 1080p`,
      videoArgs: [...gpu, ...eightBit],
      filter: 'scale=-2:1080'
    });
  }

  /*
   * The tone map is the expensive path and the one with a cap on it, so it is
   * the one worth knowing about — but only against a source that actually
   * needs it, since tone mapping an SDR file measures a chain nothing runs.
   */
  if (isHdr(info.video)) {
    runs.push({
      label: 'HDR tone map to 1080p',
      videoArgs: encoder === 'h264_nvenc'
        ? ['-c:v', encoder, '-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf)]
        : cpu,
      filter: tonemapChain(height, TONEMAP_MAX_HEIGHT)
    });
    if (height && height > TONEMAP_MAX_HEIGHT) {
      runs.push({
        label: `HDR tone map at ${height}p`,
        videoArgs: cpu,
        filter: tonemapChain(height, height)
      });
    }
  }

  return runs;
}

/** What a set of results means for someone who has to decide something. */
export function verdict(runs) {
  const usable = runs.filter((run) => run.ok);
  if (usable.length === 0) return 'Nothing could be measured.';

  const best = Math.max(...usable.map((run) => run.speed));
  if (best < 1) {
    return 'This machine cannot transcode in real time. Anything that is not '
      + 'browser-native will stall unless it has been converted ahead of time.';
  }
  if (best < 1.5) {
    return 'Transcoding keeps up, but only just. Convert ahead of time and '
      + 'avoid two people watching different transcoded files at once.';
  }
  return 'Transcoding keeps up comfortably, including a second viewer.';
}

let running = null;

/** The last result, whenever it was measured. */
export const lastResult = () => readState(STATE_KEY);

/**
 * Measure this machine. One at a time — two benchmarks would measure each
 * other rather than the hardware.
 */
export async function run() {
  if (running) return running;

  running = (async () => {
    if (!(await isAvailable())) {
      return { ok: false, error: 'ffmpeg is not available' };
    }

    const sample = pickSample(libraryFiles());
    if (!sample) {
      return { ok: false, error: 'no file in the library is big enough to be worth measuring' };
    }

    const info = await probe(sample.file_path);
    if (!info?.video) {
      return { ok: false, error: 'could not probe a sample file' };
    }
    // A file shorter than the sample window would measure a run that ends
    // early, which reads as a fast machine rather than a short file.
    const start = (info.duration || 0) > SAMPLE_START_SECONDS + SAMPLE_SECONDS ? SAMPLE_START_SECONDS : 0;

    const encoder = await hardwareEncoder();
    const runs = [];
    for (const step of plan(info, encoder)) {
      // Sequentially, and never in parallel: the answer is what one encode can
      // do with the whole machine, which is the situation being predicted.
      runs.push(await timeEncode(sample.file_path, { ...step, startSeconds: start }));
    }

    const result = {
      ok: true,
      at: Date.now(),
      sample: {
        name: String(sample.file_path).split(/[\\/]/).pop(),
        height: info.video.height || null,
        codec: info.video.codec || null,
        hdr: isHdr(info.video),
        bytes: Number(sample.size) || null
      },
      encoder: encoder || null,
      runs,
      verdict: verdict(runs)
    };

    writeState(STATE_KEY, result);
    log.info(`benchmark: ${runs.map((r) => `${r.label} ${r.ok ? `${r.speed}x` : 'failed'}`).join(', ')}`);
    return result;
  })().finally(() => { running = null; });

  return running;
}

/** Is one in flight? The page disables its button on this. */
export const isRunning = () => Boolean(running);

export default { run, lastResult, isRunning, pickSample, verdict };
