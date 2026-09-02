/**
 * Intro skips and the markers learned from them.
 *
 * One skip is an observation; two that agree are a marker. Both are kept: the
 * observations are the evidence, and keeping them means a marker can be
 * recomputed later without asking anyone to skip anything again.
 */
import { db } from './index.js';

const stmt = {
  addSkip: db.prepare(`
    INSERT INTO intro_skips (key, file_path, from_pos, to_pos, created_at)
    VALUES (@key, @file_path, @from_pos, @to_pos, @created_at)
  `),
  /*
   * One row per file, newest first. A single episode watched five times must
   * count once, or rewatching one episode would look like five seasons
   * agreeing with each other.
   */
  skipsFor: db.prepare(`
    SELECT file_path, from_pos AS "from", to_pos AS "to" FROM (
      SELECT *, ROW_NUMBER() OVER (
        -- id breaks the tie: created_at has millisecond resolution and two
        -- skips on one episode can share a tick, which would otherwise pick a
        -- winner arbitrarily. The rowid only ever increases.
        PARTITION BY file_path ORDER BY created_at DESC, id DESC
      ) AS rn
      FROM intro_skips WHERE key = ?
    )
    WHERE rn = 1
  `),
  getMarker: db.prepare('SELECT * FROM intro_markers WHERE key = ?'),
  upsertMarker: db.prepare(`
    INSERT INTO intro_markers (key, start_pos, end_pos, source, observations, updated_at)
    VALUES (@key, @start_pos, @end_pos, @source, @observations, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      start_pos = excluded.start_pos,
      end_pos = excluded.end_pos,
      source = excluded.source,
      observations = excluded.observations,
      updated_at = excluded.updated_at
  `),
  deleteMarker: db.prepare('DELETE FROM intro_markers WHERE key = ?'),
  clearSkips: db.prepare('DELETE FROM intro_skips WHERE key = ?')
};

export function recordSkip({ key, filePath, from, to }) {
  stmt.addSkip.run({
    key,
    file_path: filePath,
    from_pos: from,
    to_pos: to,
    created_at: Date.now()
  });
}

export const skipsFor = (key) => stmt.skipsFor.all(key);

/** The marker for a show and season, in the shape the player expects. */
export function markerFor(key) {
  const row = stmt.getMarker.get(key);
  if (!row) return null;
  return {
    start: row.start_pos,
    end: row.end_pos,
    source: row.source,
    observations: row.observations
  };
}

export function saveMarker(key, { start, end, source = 'learned', observations = 1 }) {
  stmt.upsertMarker.run({
    key,
    start_pos: start,
    end_pos: end,
    source,
    observations,
    updated_at: Date.now()
  });
}

/** Forget everything learned about one show and season. */
export function forgetIntro(key) {
  stmt.deleteMarker.run(key);
  stmt.clearSkips.run(key);
}

export default { recordSkip, skipsFor, markerFor, saveMarker, forgetIntro };
