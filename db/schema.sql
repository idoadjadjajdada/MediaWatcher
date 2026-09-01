-- MediaWatcher schema. Executed on every boot; every statement is IF NOT EXISTS
-- so it doubles as the migration path for existing databases.

CREATE TABLE IF NOT EXISTS metadata_cache (
  tmdb_id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('movie', 'show')),
  data TEXT NOT NULL,           -- full JSON blob from TMDB
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  file_path TEXT PRIMARY KEY,   -- absolute path, used as unique key
  tmdb_id INTEGER,
  type TEXT,                    -- 'movie' or 'episode'
  parent_tmdb_id INTEGER,       -- show ID for episodes, movie ID for movies
  season_number INTEGER,
  episode_number INTEGER,
  title TEXT,
  position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  completed INTEGER DEFAULT 0,  -- 0 or 1
  audio_offset REAL NOT NULL DEFAULT 0,  -- seconds; + delays audio, - advances it
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_updated
  ON progress(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_completed
  ON progress(completed);

CREATE TABLE IF NOT EXISTS download_jobs (
  id TEXT PRIMARY KEY,          -- AllDebrid torrent ID
  type TEXT NOT NULL,           -- 'movie' or 'episode'
  title TEXT NOT NULL,
  tmdb_id INTEGER,
  magnet TEXT,
  source TEXT,                  -- 'alldebrid' or 'torrentio' or 'public'
  status TEXT NOT NULL,         -- 'queued' 'downloading' 'complete' 'error'
  progress REAL DEFAULT 0,
  file_path TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON download_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created
  ON download_jobs(created_at DESC);

-- Discovery rails. Cached because recommendations cost one TMDB call per
-- owned title and the lists change slowly. Keyed by rail id, not tmdb_id,
-- which is why this cannot share metadata_cache.
CREATE TABLE IF NOT EXISTS discover_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Remembered devices. One row per "remember me" login; the row IS the
-- credential, so revoking it locks that device out on its very next request.
-- Only the hash is stored: a leaked database file yields nothing usable.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  user_agent   TEXT,
  last_ip      TEXT,
  origin       TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON devices(last_seen DESC);
