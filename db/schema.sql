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

-- The whole request, not just what the Downloads page displays. A job that is
-- re-queued after a restart has to land in the same file as the one that was
-- interrupted, and season/episode/year/episode_title are what decide that
-- path; without them a resumed episode filed itself under "Season 00".
CREATE TABLE IF NOT EXISTS download_jobs (
  id TEXT PRIMARY KEY,          -- AllDebrid torrent ID
  type TEXT NOT NULL,           -- 'movie' or 'episode'
  title TEXT NOT NULL,
  tmdb_id INTEGER,
  year INTEGER,
  season INTEGER,
  episode INTEGER,
  episode_title TEXT,
  magnet TEXT,
  source TEXT,                  -- 'alldebrid' or 'torrentio' or 'public'
  status TEXT NOT NULL,         -- 'queued' 'paused' 'downloading' 'complete' 'error'
  -- Explicit queue order, lowest first. Rows from before this existed are
  -- NULL and fall back to created_at, behind anything placed by hand.
  position INTEGER,
  progress REAL DEFAULT 0,
  -- Whether AllDebrid already held this torrent. Null until the first status
  -- poll answers: "not asked yet" and "not cached" are very different waits.
  cached INTEGER,
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

-- Skips someone made near the start of an episode. Two that agree become an
-- intro marker; the raw observations are kept so a marker can be recomputed
-- if the rules for agreement change.
CREATE TABLE IF NOT EXISTS intro_skips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL,        -- show:<tmdb_id>:s<season>
  file_path  TEXT NOT NULL,
  from_pos   REAL NOT NULL,
  to_pos     REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intro_skips_key ON intro_skips(key);

-- One intro per show and season. Seasons get their own row because opening
-- titles are routinely recut between them.
CREATE TABLE IF NOT EXISTS intro_markers (
  key          TEXT PRIMARY KEY,
  start_pos    REAL NOT NULL,
  end_pos      REAL NOT NULL,
  source       TEXT NOT NULL,      -- 'learned' | 'detected' | 'manual'
  observations INTEGER NOT NULL DEFAULT 1,
  updated_at   INTEGER NOT NULL
);

-- The audio and subtitle track someone chose, remembered per title so the next
-- episode opens the way the last one was left.
--
-- Neither choice is stored as an index. Embedded stream numbering differs
-- between files in the same season - one release muxes a commentary track
-- second, the next muxes it fifth - so an index carried across episodes points
-- at whatever happens to sit there. What is stored is enough to recognise the
-- same track again: its source and language.
CREATE TABLE IF NOT EXISTS track_prefs (
  key           TEXT PRIMARY KEY,   -- show:<tmdb_id> | movie:<tmdb_id>
  audio_lang    TEXT,               -- language of the chosen audio track
  audio_index   INTEGER,            -- fallback when no language matches
  subtitle_off  INTEGER NOT NULL DEFAULT 0,  -- 1 means deliberately none
  subtitle_lang TEXT,
  subtitle_src  TEXT,               -- 'external' | 'embedded'
  updated_at    INTEGER NOT NULL
);

-- Every attempt at the gate, successful or not.
--
-- Separate from `devices`: a device row is a live credential and disappears
-- when revoked, which is exactly when you most want to look at the history.
-- These rows are an append-only log and outlive the device they created.
CREATE TABLE IF NOT EXISTS login_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  ok         INTEGER NOT NULL,          -- 1 success, 0 wrong password
  ip         TEXT,
  origin     TEXT,                      -- 'lan' | 'tailnet' | 'loopback' | 'other'
  user_agent TEXT,
  device_name TEXT,                     -- only when "remember me" was ticked
  remembered INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_login_events_at ON login_events(at DESC);

-- Small durable facts that belong to the app rather than to any library item:
-- the last benchmark, when someone last looked at what changed, how a search
-- source has been behaving. One row each, JSON in `value`.
--
-- Separate from discover_cache, which is a cache with a TTL and is expected to
-- be thrown away. Nothing here can be recomputed by asking TMDB again.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Devices that have asked to be told when something happens.
--
-- The endpoint IS the credential: anyone holding it can push to that browser,
-- which is why it is never returned by any API. No encryption keys are stored
-- because no push carries a payload — the worker wakes and asks this server
-- what happened, so nothing about the library ever reaches a push service.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  device_id  TEXT,
  created_at INTEGER NOT NULL,
  last_ok    INTEGER
);
