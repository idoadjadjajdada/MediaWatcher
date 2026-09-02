/**
 * Filesystem watcher.
 *
 * Watches LIBRARY_PATH and rebuilds the library when media appears or vanishes.
 *
 * Design choices, since the spec leaves them open:
 *
 *   FULL rescan, not partial. The library object is deduped by tmdb_id and
 *   grouped by show, so a single new episode can change a show entry, create
 *   one, or merge two folders together. A full scan is the only cheap way to
 *   get that right — and it is genuinely cheap: TMDB lookups are grouped by
 *   unique title and served from cache, so a rescan after one new file is
 *   dominated by the directory walk (~100ms for 1000 files).
 *
 *   awaitWriteFinish. A file that is still being copied would otherwise be
 *   scanned mid-write and probed as a truncated video. chokidar waits for the
 *   size to stop changing before reporting it.
 *
 *   Two timers. `watchDebounceMs` (3s) coalesces a burst of events — a season
 *   pack lands as dozens of them. `scanIntervalMs` then throttles how often a
 *   rescan may actually run, so continuous writes cannot pin the scanner.
 */
import path from 'node:path';
import chokidar from 'chokidar';

import config, { createLogger } from '../config/index.js';
import * as scanner from './scanner.js';

const log = createLogger('watcher');

const WATCHED_EXTENSIONS = new Set([...config.videoExtensions, ...config.subtitleExtensions]);

let watcher = null;
let debounceTimer = null;
let lastScanStartedAt = 0;
let pending = new Set();

const stats = { events: 0, scans: 0, lastEventAt: null, lastScanAt: null };

/** Media files only — ignore artwork, nfo files, partial downloads and the rest. */
function isRelevant(filePath) {
  return WATCHED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Is `candidate` inside `parent`?
 *
 * A string prefix test is not the same question. chokidar reports paths in
 * whatever form the platform hands it — a different separator, a different
 * drive-letter case, a trailing slash — so `startsWith` could answer no for a
 * path plainly inside the directory, which is how in-progress downloads inside
 * the library would have triggered a rescan each. It also answers yes for
 * "/temporary" against "/temp", which is the opposite mistake.
 */
export function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function runScan() {
  debounceTimer = null;

  const changed = Array.from(pending);
  pending = new Set();
  if (changed.length === 0) return;

  lastScanStartedAt = Date.now();
  stats.scans += 1;

  const sample = changed.slice(0, 3).map((entry) => path.basename(entry));
  const suffix = changed.length > 3 ? ` (+${changed.length - 3} more)` : '';
  log.info(`${changed.length} change(s) detected: ${sample.join(', ')}${suffix} — rescanning`);

  try {
    await scanner.scanLibrary();
    stats.lastScanAt = Date.now();
  } catch (error) {
    log.error(`rescan failed: ${error.message}`);
  }

  // Anything that arrived while the scan was running gets its own pass.
  if (pending.size > 0) schedule();
}

function schedule() {
  if (debounceTimer) clearTimeout(debounceTimer);

  // Never start a rescan sooner than scanIntervalMs after the previous one.
  const sinceLast = Date.now() - lastScanStartedAt;
  const throttle = Math.max(0, config.scanIntervalMs - sinceLast);
  const delay = Math.max(config.watchDebounceMs, throttle);

  debounceTimer = setTimeout(runScan, delay);
}

function onChange(event, filePath) {
  if (!isRelevant(filePath)) return;

  stats.events += 1;
  stats.lastEventAt = Date.now();
  pending.add(filePath);
  log.debug(`${event}: ${filePath}`);
  schedule();
}

/** Begin watching. Safe to call twice; the second call is a no-op. */
export function start() {
  if (watcher) return watcher;

  watcher = chokidar.watch(config.libraryPath, {
    ignoreInitial: true,
    persistent: true,
    // temp/ can legitimately live inside the library; in-progress downloads
    // there must not trigger scans.
    ignored: (candidate) => {
      const name = path.basename(candidate);
      if (name.startsWith('.')) return true;
      if (config.ignoredDirectories.some((dir) => dir.toLowerCase() === name.toLowerCase())) return true;
      return isWithin(config.tempPath, candidate);
    },
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 200
    }
  });

  watcher
    .on('add', (filePath) => onChange('add', filePath))
    .on('unlink', (filePath) => onChange('unlink', filePath))
    .on('error', (error) => log.warn(`watch error: ${error.message}`))
    .on('ready', () => log.info(`watching ${config.libraryPath} for changes`));

  return watcher;
}

/** Stop watching and drop any pending rescan. */
export async function stop() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending = new Set();

  if (watcher) {
    await watcher.close();
    watcher = null;
    log.info('watcher stopped');
  }
}

export const isWatching = () => watcher !== null;
export const getStats = () => ({ ...stats, watching: isWatching(), pending: pending.size });

export default { start, stop, isWatching, isWithin, getStats };
