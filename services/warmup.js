/**
 * Do the expensive work before anyone is waiting for it.
 *
 * The first play of an MKV costs a tone map and an encode before the first
 * frame appears, and the first hover over the seek bar costs a few hundred
 * frame grabs. Both are unavoidable — but neither has to happen while someone
 * is sitting there. A download finished at 3am is the ideal moment to pay for
 * them, and a file that has been warmed opens directly from a cached MP4 with
 * no encoder involved at all.
 *
 * Three rules make this safe to run unattended:
 *
 *   background   every process goes through the ffmpeg pool as background
 *                work, so a warm-up always yields to someone watching.
 *   sequential   one file at a time. A finished season is twenty files, and
 *                twenty conversions racing is how a machine becomes unusable.
 *   space-aware  a converted copy is roughly the size of its source, so the
 *                disk is checked before each one rather than after.
 *
 * Nothing here is required for correctness. Every step is an optimisation that
 * playback would otherwise do on demand, so every failure is logged and
 * dropped rather than surfaced.
 */
import fs from 'node:fs';
import config, { createLogger } from '../config/index.js';
import * as transcoder from './transcoder.js';
import * as mp4cache from './mp4cache.js';
import * as thumbnails from './thumbnails.js';
import * as diskspace from './diskspace.js';

const log = createLogger('warmup');

/*
 * The capabilities a warm-up converts for.
 *
 * A cache entry is per-variant, and the variant depends on what the client can
 * decode — so warming has to guess. It guesses the conservative case: no HEVC,
 * no AC3, which is what a browser on a phone reports and what therefore needs
 * the conversion most. A desktop that can take HEVC natively plays direct and
 * never looks at the cache anyway.
 */
const WARM_CAPS = { hevc: false, ac3: false };

const queue = [];
const queued = new Set();
let running = false;
let stopped = false;

const stats = {
  queued: 0,
  converted: 0,
  thumbed: 0,
  skipped: 0,
  failed: 0
};

/** What is waiting, and what has happened so far. */
export const getStats = () => ({
  ...stats,
  pending: queue.length,
  running,
  current: running ? queue[0] || null : null
});

/**
 * Add a file to the queue.
 *
 * De-duplicated: a download that produces several files, and a rescan that
 * sees the same one again, must not queue it twice.
 */
export function enqueue(filePath) {
  if (!filePath || queued.has(filePath) || stopped) return false;
  if (!config.mp4Cache.enabled) return false;

  queued.add(filePath);
  queue.push(filePath);
  stats.queued += 1;
  log.debug(`queued ${filePath}`);

  drain();
  return true;
}

/** Warm several, in the order given. */
export function enqueueAll(filePaths) {
  let added = 0;
  for (const filePath of filePaths || []) if (enqueue(filePath)) added += 1;
  return added;
}

/**
 * Convert one file, if it needs converting and there is room for it.
 *
 * Returns what happened so the caller can count it. `ensureVariant` resolves
 * as soon as the conversion is *started*, not finished, so this waits on the
 * cache entry appearing rather than on that promise.
 */
async function warmVariant(filePath) {
  const info = await transcoder.probe(filePath);
  const decision = transcoder.decide(info, WARM_CAPS);

  // Already browser-native: nothing to convert, and playback will serve the
  // original bytes untouched.
  if (decision.mode === 'direct') return 'direct';

  const variant = mp4cache.pickVariant(info, WARM_CAPS);
  if (mp4cache.readyVariant(filePath, variant)) return 'cached';

  /*
   * A converted copy is roughly the size of its source. Checking before rather
   * than after is the difference between declining to warm a file and filling
   * the disk, which surfaces as write errors somewhere unrelated.
   */
  const { size } = fs.statSync(filePath);
  const room = await diskspace.hasRoomFor(config.mp4Cache.dir, size, config.downloads.minFreeBytes);
  // `ok` is true for a volume that could not be measured — deliberately, since
  // refusing to warm because statfs failed would be worse than the problem.
  if (!room.ok) {
    log.info(`skipping ${filePath}: needs ${diskspace.formatBytes(size)}, ${diskspace.formatBytes(room.free)} free`);
    return 'no-room';
  }

  await mp4cache.ensureVariant(filePath, variant);

  /*
   * ensureVariant hands back as soon as the job is running, so waiting for the
   * file to appear is what makes this queue sequential in the way that matters
   * — otherwise every item would "finish" instantly and all of them would run
   * at once, which is the exact behaviour the queue exists to prevent.
   */
  for (let waited = 0; waited < CONVERT_TIMEOUT_MS; waited += POLL_MS) {
    if (mp4cache.readyVariant(filePath, variant)) return 'converted';
    if (stopped) return 'stopped';
    await sleep(POLL_MS);
  }

  log.warn(`gave up waiting for ${filePath} to convert`);
  return 'timeout';
}

const POLL_MS = 2000;
// Long, because this is a full re-encode of a feature-length file on a
// background slot. Shorter than "forever" so a wedged job cannot block the
// queue for the life of the process.
const CONVERT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function warmOne(filePath) {
  if (!fs.existsSync(filePath)) {
    stats.skipped += 1;
    return;
  }

  try {
    const outcome = await warmVariant(filePath);
    if (outcome === 'converted') stats.converted += 1;
    else if (outcome === 'direct' || outcome === 'cached') stats.skipped += 1;

    /*
     * Thumbnails after the conversion, not alongside it. getMeta starts
     * generation as a side effect, and running it during a conversion would
     * put two background jobs on the pool for one file while everything behind
     * it in the queue waits.
     */
    if (!stopped) {
      const meta = await thumbnails.getMeta(filePath);
      if (meta.available && !meta.ready) stats.thumbed += 1;
    }
  } catch (error) {
    stats.failed += 1;
    // Nothing here is required: playback does all of it on demand.
    log.warn(`could not warm ${filePath}: ${error.message}`);
  }
}

async function drain() {
  if (running || stopped) return;
  running = true;

  try {
    while (queue.length > 0 && !stopped) {
      const filePath = queue[0];
      await warmOne(filePath);
      queue.shift();
      queued.delete(filePath);
    }
  } finally {
    running = false;
  }
}

/**
 * Warm whatever a finished download produced.
 *
 * Wired to the downloader's `complete` event rather than called from inside
 * it: the download is finished either way, and a failure to warm must not be
 * able to fail the transfer that already succeeded.
 */
export function watchDownloads(events) {
  events.on('complete', ({ files, file_path: filePath }) => {
    const produced = Array.isArray(files) && files.length > 0 ? files : [filePath];
    const added = enqueueAll(produced.filter(Boolean));
    if (added > 0) log.info(`warming ${added} file(s) from a finished download`);
  });
}

export function stop() {
  stopped = true;
  queue.length = 0;
  queued.clear();
}

export default { enqueue, enqueueAll, watchDownloads, getStats, stop };
