/**
 * Finished segments, pooled across sessions.
 *
 * A session owns an encoder; it does not own the bytes that encoder produced.
 * Two devices watching the same episode at the same quality, or one device
 * seeking back to a stretch it already played, or the same file opened again
 * tomorrow, all want segment 214 to be the same 4 MB — and until now every one
 * of those cases paid for a full re-encode, because segments lived in a
 * per-session directory that was deleted with the session.
 *
 * Publishing is a hard link where the filesystem allows one, so a pooled
 * segment normally costs no additional disk at all: the session directory and
 * the pool point at the same data, and the last link to go frees it.
 *
 * The pool is a cache and nothing more. It is wiped at boot with the rest of
 * cache/hls, trimmed to a budget, and a miss is never an error — it just means
 * the encoder does what it did before.
 */
import fs from 'node:fs';
import path from 'node:path';
import config, { createLogger } from '../../config/index.js';

const log = createLogger('hls-store');

/** Under cache/hls, so clearing orphans at boot clears this too. */
export const storeDir = () => path.join(config.hls.dir, '_shared');

const keyDir = (contentKey) => path.join(storeDir(), contentKey);
const storedPath = (contentKey, index) => path.join(keyDir(contentKey), `${index}.ts`);

/**
 * Link `source` to `target`, falling back to a copy.
 *
 * Hard links are free and instant, and they fail for reasons that are not
 * bugs: a cache directory on a different volume from the session directory, or
 * a filesystem with no link support. Copying is the same result at the cost of
 * the bytes, so neither case is worth surfacing.
 */
function linkOrCopy(source, target) {
  try {
    fs.linkSync(source, target);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return true;
    try {
      fs.copyFileSync(source, target);
      return true;
    } catch {
      return false;
    }
  }
}

/** Is this segment already pooled? */
export function has(contentKey, index) {
  try {
    return fs.statSync(storedPath(contentKey, index)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Add a finished segment to the pool. Never throws; a pool that cannot be
 * written is a pool that misses.
 *
 * Only call this for a segment the encoder has finished — a file still being
 * written would be pooled truncated, and a truncated segment served to a
 * player is worse than no pool at all.
 */
export function publish(contentKey, index, sourceFile) {
  if (!contentKey) return false;
  const target = storedPath(contentKey, index);
  if (has(contentKey, index)) return true;

  try {
    fs.mkdirSync(keyDir(contentKey), { recursive: true });
    return linkOrCopy(sourceFile, target);
  } catch {
    return false;
  }
}

/**
 * Put a pooled segment where a session expects to find it. False on a miss.
 *
 * The session directory gets its own link, so pruning inside a session behaves
 * exactly as it did before and cannot delete anything out of the pool.
 */
export function borrow(contentKey, index, targetFile) {
  if (!contentKey || !has(contentKey, index)) return false;
  try {
    if (fs.existsSync(targetFile)) return true;
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    return linkOrCopy(storedPath(contentKey, index), targetFile);
  } catch {
    return false;
  }
}

/** Every pooled segment, with what a sweep needs to choose between them. */
function entries() {
  const found = [];
  let keys;
  try {
    keys = fs.readdirSync(storeDir(), { withFileTypes: true });
  } catch {
    return found;
  }

  for (const key of keys) {
    if (!key.isDirectory()) continue;
    const dir = path.join(storeDir(), key.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        found.push({ path: full, bytes: stat.size, atimeMs: stat.atimeMs || stat.mtimeMs });
      } catch {
        // Swept from under us; nothing to account for.
      }
    }
  }
  return found;
}

/** Total bytes pooled, and how many segments that is. */
export function size() {
  const all = entries();
  return { bytes: all.reduce((sum, entry) => sum + entry.bytes, 0), files: all.length };
}

/**
 * Trim the pool to `maxBytes`, least recently used first.
 *
 * Deliberately not TTL-based like the other caches: a pooled segment is only
 * worth keeping while someone might still ask for it, and "asked for recently"
 * is exactly what access time measures. Age says nothing here — the segments
 * for last night's episode are old and the ones for a film nobody finished are
 * new, and it is the second set that should go.
 */
export function sweep(maxBytes = config.hls.sharedMaxBytes) {
  const all = entries();
  let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= maxBytes) return { removed: 0, bytes: 0 };

  let removed = 0;
  let freed = 0;
  for (const entry of all.sort((a, b) => a.atimeMs - b.atimeMs)) {
    if (total <= maxBytes) break;
    try {
      fs.unlinkSync(entry.path);
      total -= entry.bytes;
      freed += entry.bytes;
      removed += 1;
    } catch {
      // Already gone; it is not costing anything either way.
    }
  }

  // A key whose segments have all been evicted is an empty directory, and
  // leaving thousands of them makes every later sweep slower for nothing.
  try {
    for (const key of fs.readdirSync(storeDir())) {
      const dir = path.join(storeDir(), key);
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* not empty, or not ours */ }
    }
  } catch { /* no store yet */ }

  if (removed > 0) log.info(`pool trimmed: ${removed} segments, ${freed} bytes`);
  return { removed, bytes: freed };
}

export default { has, publish, borrow, size, sweep, storeDir };
