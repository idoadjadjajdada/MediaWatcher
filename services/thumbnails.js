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
import config, { createLogger, ROOT_DIR } from '../config/index.js';
import { probe, isAvailable } from './transcoder.js';

const log = createLogger('thumbnails');

export const FRAME_SECONDS = 10;
export const MAX_FRAMES = 300;

const CONCURRENCY = 4;
const CACHE_DIR = path.join(ROOT_DIR, 'cache', 'thumbs');

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

function keyFor(filePath) {
  const stat = fs.statSync(filePath);
  return cacheKey(filePath, stat.size, stat.mtimeMs);
}

const dirFor = (key) => path.join(CACHE_DIR, key);

/** Grab one frame. Resolves false rather than throwing on any failure. */
function grabFrame(filePath, seconds, outPath) {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-q:v', '5',
      '-y', outPath
    ], { windowsHide: true });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
  });
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
  log.info(`generated ${count} frames for ${path.basename(filePath)} in ${Date.now() - started}ms`);
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

  const count = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).length
    : 0;

  if (total > 0 && count < total && !running.has(key)) {
    const job = generate(filePath, key, interval, total)
      .catch((error) => log.warn(`generation failed: ${error.message}`))
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

export default { frameInterval, frameCount, cacheKey, getMeta, framePath };
