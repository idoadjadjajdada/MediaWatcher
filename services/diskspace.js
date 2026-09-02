/**
 * How much room is left where we are about to write.
 *
 * Nothing here used to ask. A download filled the disk and the symptom was an
 * unrelated ffmpeg write error somewhere else entirely, hours later, because
 * the transfer that actually consumed the space had already finished.
 *
 * statfs is not available on every platform and network share, so every failure
 * to measure is reported as "unknown" and treated as room rather than as a
 * blocker: refusing to download because we could not stat the volume would be
 * worse than the problem.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../config/index.js';

const log = createLogger('disk');

/**
 * Free bytes on the volume holding `target`, or null if it cannot be measured.
 *
 * The target may not exist yet — a temp file about to be created — so this
 * walks up to the nearest existing ancestor before asking.
 */
export async function freeBytes(target) {
  let candidate = path.resolve(target);

  for (;;) {
    try {
      const stats = await fsp.statfs(candidate);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.debug(`cannot measure ${candidate}: ${error.message}`);
        return null;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

/**
 * Is there room for `needed` bytes at `target`, keeping `reserve` free?
 *
 * `{ ok: true, free: null }` means the volume could not be measured. The caller
 * proceeds in that case; see the note at the top of this file.
 */
export async function hasRoomFor(target, needed, reserve = 0) {
  const free = await freeBytes(target);
  if (free === null) return { ok: true, free: null, needed, reserve };
  return { ok: free >= Number(needed || 0) + Number(reserve || 0), free, needed, reserve };
}

/** "12.3 GB", for log lines and error messages. */
export function formatBytes(bytes) {
  // Null is what freeBytes returns for a volume it could not measure, and
  // Number(null) is 0 - which would report a full disk as an empty one.
  if (bytes === null || bytes === undefined || bytes === '') return 'unknown';
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = Math.abs(value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default { freeBytes, hasRoomFor, formatBytes };
