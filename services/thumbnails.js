/**
 * Seek-preview thumbnails.
 *
 * Frames are grabbed by input-seeking - `-ss` before `-i` - so ffmpeg jumps to
 * the nearest keyframe rather than decoding forward from the start. A full
 * end-to-end decode of a 22-minute episode costs over a minute; a few hundred
 * input-seek grabs cost seconds. This is the same fast path the transcoder
 * already relies on for seeking.
 *
 * Every failure here is silent by design. The seek bar's ball, band and
 * timestamp never depend on a frame arriving, so a missing ffmpeg degrades the
 * preview rather than breaking the player.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import config, { createLogger } from '../config/index.js';
import { probe, isAvailable } from './transcoder.js';
import * as ffmpegPool from './ffmpegPool.js';
import * as cacheSweeper from './cacheSweeper.js';

const log = createLogger('thumbnails');

export const FRAME_SECONDS = 10;
export const MAX_FRAMES = 300;

const CONCURRENCY = 4;
const CACHE_DIR = config.thumbCache.dir;

/** One frame every FRAME_SECONDS, stretched so no file exceeds MAX_FRAMES. */
export function frameInterval(duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return FRAME_SECONDS;
  return Math.max(FRAME_SECONDS, Math.ceil(seconds / MAX_FRAMES));
}

/** How many frames a file of this duration produces at this interval. */
export function frameCount(duration, interval) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  return Math.ceil(seconds / interval);
}

/**
 * Cache identity for a file.
 *
 * Size and mtime are part of the key, so a replaced or re-downloaded file gets
 * a new key and regenerates with no explicit invalidation step anywhere.
 */
export function cacheKey(filePath, size, mtimeMs) {
  return crypto.createHash('sha1')
    .update(`${filePath}|${size}|${Math.floor(Number(mtimeMs) || 0)}`)
    .digest('hex');
}

/** In-flight generations, keyed by cache key, so hovering cannot double-start. */
const running = new Map();

/**
 * What the last finished run managed, keyed by cache key.
 *
 * Some files never yield a full set — a truncated download, a codec ffmpeg
 * cannot seek, a frame at a timestamp past the real end. `count < total` stays
 * true for those forever, so every hover used to re-kick the whole remaining
 * job, spawning hundreds of ffmpeg processes that fail exactly as they did the
 * first time.
 */
const attempts = new Map();   // key -> { reached, at }

/**
 * Long enough that a hover storm cannot restart a hopeless job, short enough
 * that a real fix — a repaired file, an ffmpeg that is now installed — is
 * picked up without clearing the cache by hand.
 */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Should a generation run start for this file?
 *
 * Pure so the retry rule can be tested without spawning anything: the whole
 * point is what happens on the second hover, and that is not observable from
 * the outside.
 */
export function shouldGenerate({ count, total, running: inFlight, attempt, now = Date.now() }) {
  if (total <= 0 || count >= total) return false;
  if (inFlight) return false;
  if (!attempt) return true;
  // Frames appeared since that run gave up, so it is making progress after all.
  if (count > attempt.reached) return true;
  return now - attempt.at >= RETRY_AFTER_MS;
}

function keyFor(filePath) {
  const stat = fs.statSync(filePath);
  return cacheKey(filePath, stat.size, stat.mtimeMs);
}

const dirFor = (key) => path.join(CACHE_DIR, key);

/**
 * Grab one frame. Resolves false rather than throwing on any failure.
 *
 * The slot is per frame rather than per file: a grab is a second of work, so
 * holding one for a whole 300-frame job would keep the budget occupied for
 * minutes and starve everything else that needs an encoder.
 */
async function grabFrame(filePath, seconds, outPath) {
  const release = await ffmpegPool.acquire('thumbnail');
  const done = new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-q:v', '5',
      '-y', outPath
    ], { windowsHide: true });

    // On the register for the second or two it runs. Short, but a stalled
    // thumbnail job holding a slot is exactly the thing that is otherwise
    // invisible.
    ffmpegPool.register({
      kind: 'thumbnail',
      label: `frame at ${Math.round(seconds)}s`,
      filePath,
      proc: child
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
  });

  try {
    return await done;
  } finally {
    release();
  }
}

/** Generate every frame for a file, CONCURRENCY at a time. */
async function generate(filePath, key, interval, count) {
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const outPath = path.join(dir, `${index}.jpg`);
      if (fs.existsSync(outPath)) continue;
      await grabFrame(filePath, index * interval, outPath);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const produced = fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).length;
  attempts.set(key, { reached: produced, at: Date.now() });

  if (produced < count) {
    log.warn(`only ${produced} of ${count} frames for ${path.basename(filePath)} — `
      + `not retrying for ${Math.round(RETRY_AFTER_MS / 60000)}m`);
  } else {
    log.info(`generated ${count} frames for ${path.basename(filePath)} in ${Date.now() - started}ms`);
  }
}

/**
 * Interval, expected count, and how many frames exist so far.
 *
 * Starts generation if it is not already running. Returns `ready: false` while
 * frames are still landing; the client shows the timestamp alone until then.
 */
export async function getMeta(filePath) {
  if (!(await isAvailable())) {
    return { interval: FRAME_SECONDS, count: 0, total: 0, ready: false, available: false };
  }

  const info = await probe(filePath);
  const interval = frameInterval(info?.duration);
  const total = frameCount(info?.duration, interval);
  const key = keyFor(filePath);
  const dir = dirFor(key);

  const exists = fs.existsSync(dir);
  const count = exists
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).length
    : 0;
  // Eviction is least-recently-used, and this is what makes a set that is still
  // being hovered over look recent.
  if (exists) cacheSweeper.markUsed(dir);

  if (shouldGenerate({ count, total, running: running.has(key), attempt: attempts.get(key) })) {
    const job = generate(filePath, key, interval, total)
      .catch((error) => {
        log.warn(`generation failed: ${error.message}`);
        // A thrown run counts as an attempt too, or the failure repeats on
        // every hover exactly as it did before.
        attempts.set(key, { reached: count, at: Date.now() });
      })
      .finally(() => running.delete(key));
    running.set(key, job);
  }

  return { interval, count, total, ready: total > 0 && count >= total, available: true };
}

/** Absolute path to one generated frame, or null if it does not exist yet. */
export async function framePath(filePath, index) {
  const candidate = path.join(dirFor(keyFor(filePath)), `${Number(index)}.jpg`);
  return fs.existsSync(candidate) ? candidate : null;
}

export default { frameInterval, frameCount, cacheKey, shouldGenerate, getMeta, framePath };
