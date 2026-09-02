/**
 * SQLite connection + typed helpers.
 *
 * better-sqlite3 is synchronous, so every helper here returns plain values
 * rather than promises. The schema is applied on import (all statements are
 * IF NOT EXISTS), then statements are prepared once and reused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config, { createLogger } from '../config/index.js';

const log = createLogger('db');
const HERE = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

/*
 * CREATE TABLE IF NOT EXISTS cannot add a column to a table that already
 * exists, and SQLite has no IF NOT EXISTS for columns - a duplicate is the
 * expected no-op on every boot after the first.
 */
const COLUMN_MIGRATIONS = [
  'ALTER TABLE progress ADD COLUMN audio_offset REAL NOT NULL DEFAULT 0',
  // A job re-queued after a restart rebuilds its destination path from these,
  // so a database written before they existed has to gain them.
  'ALTER TABLE download_jobs ADD COLUMN year INTEGER',
  'ALTER TABLE download_jobs ADD COLUMN season INTEGER',
  'ALTER TABLE download_jobs ADD COLUMN episode INTEGER',
  'ALTER TABLE download_jobs ADD COLUMN episode_title TEXT'
];

for (const statement of COLUMN_MIGRATIONS) {
  try {
    db.exec(statement);
    log.info(`migrated: ${statement.split(' ADD COLUMN ')[1].split(' ')[0]} added`);
  } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

log.info(`database ready at ${config.dbPath}`);

const now = () => Date.now();

/* --------------------------------------------------------------------------
 * metadata_cache
 * ----------------------------------------------------------------------- */

const stmt = {
  metaGet: db.prepare('SELECT * FROM metadata_cache WHERE tmdb_id = ?'),
  metaUpsert: db.prepare(`
    INSERT INTO metadata_cache (tmdb_id, type, data, updated_at)
    VALUES (@tmdb_id, @type, @data, @updated_at)
    ON CONFLICT(tmdb_id) DO UPDATE SET
      type = excluded.type,
      data = excluded.data,
      updated_at = excluded.updated_at
  `),
  metaDelete: db.prepare('DELETE FROM metadata_cache WHERE tmdb_id = ?'),

  discoverGet: db.prepare('SELECT * FROM discover_cache WHERE key = ?'),
  discoverUpsert: db.prepare(`
    INSERT INTO discover_cache (key, data, updated_at)
    VALUES (@key, @data, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `),

  progressGet: db.prepare('SELECT * FROM progress WHERE file_path = ?'),
  progressUpsert: db.prepare(`
    INSERT INTO progress (
      file_path, tmdb_id, type, parent_tmdb_id, season_number, episode_number,
      title, position, duration, completed, audio_offset, updated_at
    ) VALUES (
      @file_path, @tmdb_id, @type, @parent_tmdb_id, @season_number, @episode_number,
      @title, @position, @duration, @completed, @audio_offset, @updated_at
    )
    ON CONFLICT(file_path) DO UPDATE SET
      tmdb_id = COALESCE(excluded.tmdb_id, progress.tmdb_id),
      type = COALESCE(excluded.type, progress.type),
      parent_tmdb_id = COALESCE(excluded.parent_tmdb_id, progress.parent_tmdb_id),
      season_number = COALESCE(excluded.season_number, progress.season_number),
      episode_number = COALESCE(excluded.episode_number, progress.episode_number),
      title = COALESCE(excluded.title, progress.title),
      position = excluded.position,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE progress.duration END,
      completed = excluded.completed,
      -- Only overwrite when the caller actually sent one. COALESCE cannot
      -- express this: the column is NOT NULL, so "not supplied" cannot be
      -- bound as NULL, and 0 is a legitimate value we must not confuse with it.
      audio_offset = CASE WHEN @audio_offset_set = 1
        THEN excluded.audio_offset ELSE progress.audio_offset END,
      updated_at = excluded.updated_at
  `),
  /**
   * One row per title, not per file.
   *
   * A part-watched show used to contribute an entry for every episode you had
   * ever left unfinished, so Continue Watching filled up with the same series
   * several times over. Partitioning on the show id (falling back to the movie
   * id, then the path for anything unmatched) keeps only the most recent.
   */
  progressContinue: db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(parent_tmdb_id, tmdb_id, file_path)
        -- updated_at has millisecond resolution, so two rows written in the
        -- same tick would otherwise pick a winner arbitrarily. Highest episode
        -- wins the tie, which is the one you most plausibly reached.
        ORDER BY updated_at DESC, season_number DESC, episode_number DESC
      ) AS rn
      FROM progress
      WHERE completed = 0 AND position > 5
    )
    WHERE rn = 1
    ORDER BY updated_at DESC
    LIMIT ?
  `),
  progressAll: db.prepare('SELECT * FROM progress ORDER BY updated_at DESC'),
  progressDelete: db.prepare('DELETE FROM progress WHERE file_path = ?'),

  jobInsert: db.prepare(`
    INSERT INTO download_jobs (
      id, type, title, tmdb_id, year, season, episode, episode_title,
      magnet, source, status, progress, file_path, error, created_at, updated_at
    ) VALUES (
      @id, @type, @title, @tmdb_id, @year, @season, @episode, @episode_title,
      @magnet, @source, @status, @progress, @file_path, @error, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      tmdb_id = excluded.tmdb_id,
      year = excluded.year,
      season = excluded.season,
      episode = excluded.episode,
      episode_title = excluded.episode_title,
      magnet = excluded.magnet,
      source = excluded.source,
      status = excluded.status,
      updated_at = excluded.updated_at
  `),
  jobGet: db.prepare('SELECT * FROM download_jobs WHERE id = ?'),
  jobList: db.prepare('SELECT * FROM download_jobs ORDER BY created_at DESC'),
  jobByStatus: db.prepare('SELECT * FROM download_jobs WHERE status = ? ORDER BY created_at DESC'),
  jobDelete: db.prepare('DELETE FROM download_jobs WHERE id = ?')
};

/** Raw cache row, or undefined. */
export function getMetadataRow(tmdbId) {
  return stmt.metaGet.get(tmdbId);
}

/**
 * Parsed TMDB payload if it is younger than `ttlMs`, otherwise undefined.
 * Corrupt JSON is treated as a cache miss rather than an error.
 */
export function readMetadata(tmdbId, ttlMs = config.tmdb.cacheTtlMs) {
  const row = stmt.metaGet.get(tmdbId);
  if (!row) return undefined;
  if (ttlMs >= 0 && row.updated_at < now() - ttlMs) return undefined;
  try {
    return JSON.parse(row.data);
  } catch {
    log.warn(`corrupt metadata_cache row for tmdb_id=${tmdbId}, refetching`);
    return undefined;
  }
}

export function writeMetadata(tmdbId, type, data) {
  stmt.metaUpsert.run({
    tmdb_id: tmdbId,
    type,
    data: JSON.stringify(data),
    updated_at: now()
  });
  return data;
}

export function deleteMetadata(tmdbId) {
  return stmt.metaDelete.run(tmdbId).changes > 0;
}

/* --------------------------------------------------------------------------
 * discover_cache
 * ----------------------------------------------------------------------- */

/**
 * Cached rail payload if it is younger than `ttlMs`, otherwise undefined.
 * Corrupt JSON is treated as a cache miss rather than an error, matching
 * readMetadata.
 *
 * A negative ttlMs means "always refetch", which is how `force` is expressed.
 * Note this is the opposite of readMetadata, where negative means never
 * expire; the difference is deliberate and pinned by a test.
 */
export function readDiscover(key, ttlMs) {
  if (ttlMs < 0) return undefined;
  const row = stmt.discoverGet.get(key);
  if (!row) return undefined;
  // Fresh means age is strictly less than the TTL, so a TTL of zero is always
  // stale. Comparing timestamps directly made that a race: a read in the same
  // millisecond as the write looked fresh.
  if (now() - row.updated_at >= ttlMs) return undefined;
  try {
    return JSON.parse(row.data);
  } catch {
    log.warn(`corrupt discover_cache row for "${key}", refetching`);
    return undefined;
  }
}

export function writeDiscover(key, data) {
  stmt.discoverUpsert.run({ key, data: JSON.stringify(data), updated_at: now() });
  return data;
}

/* --------------------------------------------------------------------------
 * progress
 * ----------------------------------------------------------------------- */

export function getProgress(filePath) {
  return stmt.progressGet.get(filePath);
}

/**
 * Upsert a progress row. `completed` is derived here so every caller — the
 * player, the API and future importers — agrees on the 95% rule.
 */
export function upsertProgress(input) {
  const position = Number(input.position) || 0;
  const duration = Number(input.duration) || 0;
  const completed = input.completed !== undefined
    ? (input.completed ? 1 : 0)
    : (duration > 0 && position > 0.95 * duration ? 1 : 0);

  const row = {
    file_path: input.file_path,
    tmdb_id: input.tmdb_id ?? null,
    type: input.type ?? null,
    parent_tmdb_id: input.parent_tmdb_id ?? null,
    season_number: input.season_number ?? null,
    episode_number: input.episode_number ?? null,
    title: input.title ?? null,
    position,
    duration,
    completed,
    audio_offset: Number(input.audio_offset) || 0,
    audio_offset_set: input.audio_offset === undefined || input.audio_offset === null ? 0 : 1,
    updated_at: now()
  };

  stmt.progressUpsert.run(row);
  return stmt.progressGet.get(row.file_path);
}

export function listContinueWatching(limit = 20) {
  return stmt.progressContinue.all(limit);
}

export function listAllProgress() {
  return stmt.progressAll.all();
}

export function deleteProgress(filePath) {
  return stmt.progressDelete.run(filePath).changes > 0;
}

/**
 * Drop several rows at once. Used by the post-scan sweep, where a deleted file
 * would otherwise keep its place in Continue Watching and fail on click.
 */
export const deleteProgressPaths = db.transaction((paths) => {
  let removed = 0;
  for (const filePath of paths) removed += stmt.progressDelete.run(filePath).changes;
  return removed;
});

/* --------------------------------------------------------------------------
 * download_jobs
 * ----------------------------------------------------------------------- */

const JOB_COLUMNS = [
  'type', 'title', 'tmdb_id', 'year', 'season', 'episode', 'episode_title',
  'magnet', 'source', 'status', 'progress', 'file_path', 'error'
];
const updateCache = new Map();

export function insertJob(job) {
  const ts = now();
  stmt.jobInsert.run({
    id: String(job.id),
    type: job.type,
    title: job.title,
    tmdb_id: job.tmdb_id ?? null,
    year: job.year ?? null,
    season: job.season ?? null,
    episode: job.episode ?? null,
    episode_title: job.episode_title ?? null,
    magnet: job.magnet ?? null,
    source: job.source ?? null,
    status: job.status ?? 'queued',
    progress: job.progress ?? 0,
    file_path: job.file_path ?? null,
    error: job.error ?? null,
    created_at: job.created_at ?? ts,
    updated_at: ts
  });
  return stmt.jobGet.get(String(job.id));
}

/** Patch a job by column whitelist; unknown keys are ignored. */
export function updateJob(id, patch) {
  const keys = Object.keys(patch).filter((key) => JOB_COLUMNS.includes(key));
  if (keys.length === 0) return stmt.jobGet.get(String(id));

  const cacheKey = keys.join(',');
  let statement = updateCache.get(cacheKey);
  if (!statement) {
    const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
    statement = db.prepare(`UPDATE download_jobs SET ${assignments}, updated_at = @updated_at WHERE id = @id`);
    updateCache.set(cacheKey, statement);
  }

  const params = { id: String(id), updated_at: now() };
  for (const key of keys) params[key] = patch[key] ?? null;
  statement.run(params);
  return stmt.jobGet.get(String(id));
}

export function getJob(id) {
  return stmt.jobGet.get(String(id));
}

export function listJobs() {
  return stmt.jobList.all();
}

export function listJobsByStatus(status) {
  return stmt.jobByStatus.all(status);
}

export function deleteJob(id) {
  return stmt.jobDelete.run(String(id)).changes > 0;
}

/** Close the handle on shutdown so WAL files are checkpointed cleanly. */
export function closeDatabase() {
  try {
    db.close();
    log.info('database closed');
  } catch (error) {
    log.warn('error closing database:', error.message);
  }
}

export default db;
