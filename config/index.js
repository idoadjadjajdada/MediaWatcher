/**
 * Central configuration.
 *
 * Importing this module loads `.env`, validates the two required API keys and
 * exposes a deeply frozen config object. If a required key is missing the
 * process prints a clear message and exits with code 1 — nothing downstream
 * has to defend against a half-configured app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/* --------------------------------------------------------------------------
 * Logger (leveled, honours LOG_LEVEL)
 * ----------------------------------------------------------------------- */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const THRESHOLD = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function emit(level, scope, args) {
  if (LEVELS[level] > THRESHOLD) return;
  // Local time, not UTC: this is a desktop app and the log is read next to a clock.
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const prefix = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(prefix, ...args);
}

/** Create a logger bound to a scope name, e.g. createLogger('scanner'). */
export function createLogger(scope) {
  return {
    error: (...args) => emit('error', scope, args),
    warn: (...args) => emit('warn', scope, args),
    info: (...args) => emit('info', scope, args),
    debug: (...args) => emit('debug', scope, args)
  };
}

export const log = createLogger('app');

/* --------------------------------------------------------------------------
 * Env helpers
 * ----------------------------------------------------------------------- */

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : String(value).trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    log.warn(`${name}="${raw}" is not a number, falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Resolve a possibly-relative path against the project root. */
function resolvePath(value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(ROOT_DIR, raw);
}

/* --------------------------------------------------------------------------
 * Required key validation
 * ----------------------------------------------------------------------- */

const REQUIRED = [
  ['TMDB_API_KEY', 'https://www.themoviedb.org/settings/api'],
  ['ALLDEBRID_API_KEY', 'https://alldebrid.com/apikeys']
];

const missing = REQUIRED.filter(([name]) => str(name) === '');

if (missing.length > 0) {
  const lines = [
    '',
    'MediaWatcher cannot start: required configuration is missing.',
    '',
    ...missing.map(([name, where]) => `  - ${name} is empty or unset. Get one at ${where}`),
    '',
    `Fix: copy .env.example to .env in ${ROOT_DIR} and fill in the values.`,
    ''
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}

/* --------------------------------------------------------------------------
 * Config object
 * ----------------------------------------------------------------------- */

const libraryPath = resolvePath(str('LIBRARY_PATH'), './library');
const tempPath = resolvePath(str('TEMP_PATH'), './temp');

const config = {
  rootDir: ROOT_DIR,
  port: int('PORT', 3000),
  host: '127.0.0.1',
  logLevel: LOG_LEVEL,

  // Filesystem
  libraryPath,
  moviesPath: path.join(libraryPath, 'movies'),
  showsPath: path.join(libraryPath, 'shows'),
  tempPath,
  dbPath: path.join(ROOT_DIR, 'db', 'mediawatcher.db'),

  // Scanning
  scanIntervalMs: int('SCAN_INTERVAL_MS', 5000),
  watchDebounceMs: 3000,
  videoExtensions: ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ts'],
  subtitleExtensions: ['.srt', '.vtt', '.ass'],
  ignoredDirectories: ['node_modules', '.git', '@eaDir', '.Trash', '$RECYCLE.BIN', 'System Volume Information'],

  // TMDB
  tmdb: {
    apiKey: str('TMDB_API_KEY'),
    // Overridable so the scanner can be exercised against a local stub.
    baseUrl: str('TMDB_BASE_URL', 'https://api.themoviedb.org/3'),
    imageBaseUrl: 'https://image.tmdb.org/t/p',
    posterSize: 'w500',
    backdropSize: 'w1280',
    profileSize: 'w185',
    language: str('TMDB_LANGUAGE', 'en-US'),
    cacheTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    concurrency: 8,
    timeoutMs: 15000
  },

  // AllDebrid
  alldebrid: {
    apiKey: str('ALLDEBRID_API_KEY'),
    // Overridable so the download pipeline can be exercised against a local stub.
    baseUrl: str('ALLDEBRID_BASE_URL', 'https://api.alldebrid.com/v4'),
    agent: 'mediawatcher',
    pollIntervalMs: 3000,
    pollTimeoutMs: 600000,
    timeoutMs: 20000
  },

  // Torrentio public addon.
  // TORRENTIO_CONFIG is the option segment generated by torrentio.strem.fun/configure,
  // e.g. "providers=yts,eztv,1337x,thepiratebay|sort=qualitysize". Adding an indexer
  // is an .env edit, not a code change.
  torrentio: {
    baseUrl: 'https://torrentio.strem.fun',
    configSegment: str('TORRENTIO_CONFIG'),
    timeoutMs: 15000
  },

  // Jackett — optional local indexer aggregator. Leave JACKETT_URL empty to
  // disable the source entirely; torrentSearch skips disabled sources.
  jackett: {
    url: str('JACKETT_URL').replace(/\/+$/, ''),
    apiKey: str('JACKETT_API_KEY'),
    indexers: str('JACKETT_INDEXERS', 'all'),
    timeoutMs: int('JACKETT_TIMEOUT_MS', 20000)
  },

  // Per-source ceiling so one slow indexer can't stall a search.
  search: {
    sourceTimeoutMs: int('SEARCH_SOURCE_TIMEOUT_MS', 20000),
    maxResults: int('SEARCH_MAX_RESULTS', 60)
  },

  // Playback. ffmpeg is an external binary, not an npm dependency. It is only
  // used when the browser cannot decode a file as it sits on disk: compatible
  // files are still served as raw bytes with zero processing.
  ffmpeg: {
    enabled: str('FFMPEG_ENABLED', '1') !== '0',
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    probeTimeoutMs: int('FFPROBE_TIMEOUT_MS', 15000),
    // Audio re-encode settings (used when the source is DTS/TrueHD/etc).
    audioBitrate: str('TRANSCODE_AUDIO_BITRATE', '192k'),
    audioChannels: int('TRANSCODE_AUDIO_CHANNELS', 2),
    // Video re-encode settings (last resort — only when the codec is undecodable).
    videoPreset: str('TRANSCODE_VIDEO_PRESET', 'veryfast'),
    videoCrf: int('TRANSCODE_VIDEO_CRF', 20),
    videoMaxrate: str('TRANSCODE_VIDEO_MAXRATE', '12M')
  },

  // Downloads
  downloads: {
    maxConcurrent: 2,
    progressStepPercent: 5
  }
};

/** Recursively freeze plain objects so config is immutable at every level. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

deepFreeze(config);

/** Create the runtime directories the app writes into. Safe to call repeatedly. */
export function ensureRuntimeDirs() {
  for (const dir of [config.libraryPath, config.moviesPath, config.showsPath, config.tempPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export default config;
