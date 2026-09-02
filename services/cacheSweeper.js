/**
 * Eviction for the on-disk caches.
 *
 * `cache/mp4` holds a full-size converted copy of every file anyone has played
 * a non-direct path on. Nothing ever removed one, so a library watched through
 * once ended up stored twice — and the failure mode of a full disk is confusing
 * ffmpeg write errors in code that has nothing to do with the cache.
 *
 * `cache/thumbs` is small per file but content-addressed, so every replaced or
 * re-downloaded file silently leaves its old frame set behind forever.
 *
 * Both are keyed by a hash directory, which makes eviction a matter of picking
 * whole directories to delete. Two rules, in this order:
 *
 *   1. anything untouched for longer than the TTL goes, whatever the total
 *   2. while the total is still over budget, the least recently used goes next
 *
 * "Used" is the directory's own mtime, which the cache code stamps on every
 * hit. Access times are not usable here: NTFS updates them lazily and many
 * mounts disable them entirely, so a busy cache would look untouched.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import config, { createLogger } from '../config/index.js';
import { formatBytes } from './diskspace.js';
import * as segmentStore from './hls/segmentStore.js';

const log = createLogger('cache');

/**
 * A conversion still being written is not a candidate, however old it looks.
 * Directories that young are also skipped outright: a job that just started
 * has an old-looking directory until its first bytes land.
 */
const IN_USE_GRACE_MS = 5 * 60 * 1000;

/** Stamp a cache directory as used. Best effort — a failure only costs accuracy. */
export function markUsed(dir) {
  const now = new Date();
  fsp.utimes(dir, now, now).catch(() => { /* evicted, or read-only */ });
}

/** Total bytes of a directory tree. */
async function treeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await treeBytes(full);
    } else {
      try {
        total += (await fsp.stat(full)).size;
      } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

/** Does this tree contain a conversion in progress? */
async function hasPartial(dir) {
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.part')) return true;
      if (entry.isDirectory() && await hasPartial(path.join(dir, entry.name))) return true;
    }
  } catch { /* gone */ }
  return false;
}

/**
 * One record per cache entry: `{ path, bytes, usedAt, busy }`.
 * Missing directories measure as an empty list rather than an error.
 */
export async function measure(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    out.push({
      path: full,
      bytes: await treeBytes(full),
      usedAt: stat.mtimeMs,
      busy: await hasPartial(full)
    });
  }
  return out;
}

/**
 * Which entries to delete, oldest first. Pure, so the rules are testable
 * without a filesystem.
 *
 * @param {Array<{path,bytes,usedAt,busy}>} entries
 * @param {{maxBytes:number, ttlMs:number, now?:number, graceMs?:number}} limits
 */
export function planEviction(entries, { maxBytes, ttlMs, now = Date.now(), graceMs = IN_USE_GRACE_MS }) {
  // Anything being written, or written moments ago, is off limits: it is very
  // likely the thing a viewer is waiting for.
  const candidates = (entries || [])
    .filter((entry) => !entry.busy && now - entry.usedAt > graceMs)
    .sort((a, b) => a.usedAt - b.usedAt);

  const doomed = new Set();
  let total = (entries || []).reduce((sum, entry) => sum + entry.bytes, 0);

  if (ttlMs > 0) {
    for (const entry of candidates) {
      if (now - entry.usedAt <= ttlMs) continue;
      doomed.add(entry.path);
      total -= entry.bytes;
    }
  }

  if (maxBytes > 0) {
    for (const entry of candidates) {
      if (total <= maxBytes) break;
      if (doomed.has(entry.path)) continue;
      doomed.add(entry.path);
      total -= entry.bytes;
    }
  }

  return candidates.filter((entry) => doomed.has(entry.path)).map((entry) => entry.path);
}

/** Trim one cache root to its limits. Returns what it removed. */
export async function sweepRoot(root, limits) {
  const entries = await measure(root);
  if (entries.length === 0) return { removed: 0, freed: 0, remaining: 0 };

  const doomed = new Set(planEviction(entries, limits));
  let freed = 0;
  let removed = 0;

  for (const entry of entries) {
    if (!doomed.has(entry.path)) continue;
    try {
      // A file being streamed cannot be unlinked on Windows, which is the
      // behaviour we want: it throws, we skip it, and it goes next sweep.
      await fsp.rm(entry.path, { recursive: true, force: false });
      freed += entry.bytes;
      removed += 1;
    } catch (error) {
      log.debug(`could not evict ${path.basename(entry.path)}: ${error.message}`);
    }
  }

  const remaining = entries.reduce((sum, entry) => sum + entry.bytes, 0) - freed;
  if (removed > 0) {
    log.info(`${path.basename(root)}: evicted ${removed} entr${removed === 1 ? 'y' : 'ies'}, `
      + `freed ${formatBytes(freed)}, ${formatBytes(remaining)} left`);
  }
  return { removed, freed, remaining };
}

/** Trim every cache root. Safe to call at any time. */
export async function sweep() {
  const mp4 = await sweepRoot(config.mp4Cache.dir, {
    maxBytes: config.mp4Cache.maxBytes,
    ttlMs: config.mp4Cache.ttlMs
  });
  const thumbs = await sweepRoot(config.thumbCache.dir, {
    maxBytes: config.thumbCache.maxBytes,
    ttlMs: config.thumbCache.ttlMs
  });
  /*
   * The pooled HLS segments are swept by their own module rather than through
   * sweepRoot: they are individual files under a key directory rather than
   * whole directories to drop, and they are chosen by access time rather than
   * by age. Kept on the same schedule because it is the same question.
   */
  const hls = segmentStore.sweep();
  return { mp4, thumbs, hls };
}

let timer = null;

/** Sweep now, then on an interval. Idempotent. */
export function start() {
  if (timer) return;
  sweep().catch((error) => log.warn(`sweep failed: ${error.message}`));
  timer = setInterval(() => {
    sweep().catch((error) => log.warn(`sweep failed: ${error.message}`));
  }, config.cacheSweepIntervalMs);
  // Must not hold the process open at shutdown.
  timer.unref();
}

export function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export default { markUsed, measure, planEviction, sweepRoot, sweep, start, stop };
