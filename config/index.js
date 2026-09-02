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
import { randomBytes } from 'node:crypto';
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

/*
 * The last few thousand lines, in memory.
 *
 * The log existed only in whatever window the server was started from, so
 * anything that happened before you opened the launcher — or anything at all,
 * from a phone on the other side of the tunnel — was gone. This is the same
 * stream the console gets, kept so it can be read from somewhere other than
 * the machine it happened on.
 *
 * Deliberately a ring in memory rather than a file: a file is a different
 * feature with rotation, permissions and a disk budget attached, and the
 * question this answers is "what has this server been doing lately".
 */
const LOG_BUFFER_LINES = 2000;
const buffer = [];
let sequence = 0;

/** Anything that looks like a key, whoever logged it. */
const SECRET = /\b([A-Za-z0-9_-]{24,})\b/g;

/**
 * Redact before storing, not before printing.
 *
 * The console is on the machine that owns the keys; this buffer is served over
 * the tunnel to whoever is signed in. A URL with an API key in its query
 * string is the realistic way one ends up in a log line, and it should not
 * become readable from a phone.
 */
const redact = (text) => text.replace(SECRET, (match) => `${match.slice(0, 4)}…${match.slice(-2)}`);

function emit(level, scope, args) {
  if (LEVELS[level] > THRESHOLD) return;
  // Local time, not UTC: this is a desktop app and the log is read next to a clock.
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const prefix = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(prefix, ...args);

  sequence += 1;
  buffer.push({
    seq: sequence,
    at: now.getTime(),
    level,
    scope,
    text: redact(args.map((arg) => (
      arg instanceof Error ? (arg.stack || arg.message) : String(arg)
    )).join(' '))
  });
  if (buffer.length > LOG_BUFFER_LINES) buffer.splice(0, buffer.length - LOG_BUFFER_LINES);
}

/**
 * Recent lines, oldest first.
 *
 * `since` is a sequence number rather than a timestamp so a client can ask for
 * "everything after what I already have" without worrying about two lines
 * sharing a millisecond.
 */
export function recentLogs({ limit = 500, since = 0, level = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.debug;
  const matching = buffer.filter((line) => line.seq > since && LEVELS[line.level] <= threshold);
  return matching.slice(-Math.max(1, Math.min(limit, LOG_BUFFER_LINES)));
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

/**
 * Normalise TORRENTIO_CONFIG down to the options segment.
 *
 * The configure page hands you a whole install URL, and pasting it verbatim is
 * the obvious mistake — it produces a request to
 *   torrentio.strem.fun/torrentio.strem.fun/<opts>/manifest.json/stream/...
 * which 404s, taking out the only always-on search source. Strip the scheme,
 * the host, a trailing /manifest.json and any stray slashes so both the full
 * URL and the bare segment work.
 */
export function torrentioSegment(raw) {
  let segment = String(raw || '').trim();
  if (!segment) return '';

  segment = segment.replace(/^[a-z]+:\/\//i, '');
  segment = segment.replace(/^torrentio\.strem\.fun/i, '');
  segment = segment.replace(/\/?manifest\.json\/?$/i, '');
  segment = segment.replace(/^\/+|\/+$/g, '');
  return segment;
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

/*
 * The password gate is the only thing between a tunnelled server and the
 * internet-facing world, so a missing or trivial password is fatal rather than
 * a warning. Booting open behind a tunnel is the worst failure available here.
 */
const authPassword = str('AUTH_PASSWORD');
if (authPassword.length < 8) {
  console.error([
    '',
    'MediaWatcher cannot start: AUTH_PASSWORD is missing or too short.',
    '',
    '  Set AUTH_PASSWORD in .env to at least 8 characters. Every device must',
    '  enter it once before it can browse or play anything.',
    ''
  ].join('\n'));
  process.exit(1);
}

/*
 * A key only something on this machine can read. The launcher needs to list
 * and revoke devices, and it cannot be waved through on the basis of coming
 * from loopback — tailscale serve makes every remote request look local. So it
 * proves itself with a file instead.
 */
const ADMIN_KEY_PATH = path.join(ROOT_DIR, 'config', 'admin-key');

function loadOrCreateAdminKey() {
  try {
    const existing = fs.readFileSync(ADMIN_KEY_PATH, 'utf8').trim();
    if (existing.length === 64) return existing;
  } catch {
    // Absent or unreadable: fall through and mint a new one.
  }
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(ADMIN_KEY_PATH, key, { mode: 0o600 });
  return key;
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

  // Remote playback caps. The host serves at ~800 Mbps symmetric, so none of
  // this protects the server — it protects a client on hotel wifi or cellular,
  // and it is why Auto never picks Original over the tunnel.
  remote: {
    defaultLevel: str('REMOTE_DEFAULT_QUALITY', 'high'),
    levels: {
      original: { height: null, maxrate: null },
      high: { height: int('QUALITY_HIGH_HEIGHT', 1080), maxrate: str('QUALITY_HIGH_MAXRATE', '12M') },
      medium: { height: int('QUALITY_MEDIUM_HEIGHT', 720), maxrate: str('QUALITY_MEDIUM_MAXRATE', '5M') },
      low: { height: int('QUALITY_LOW_HEIGHT', 480), maxrate: str('QUALITY_LOW_MAXRATE', '1.5M') }
    }
  },

  auth: {
    password: authPassword,
    adminKey: loadOrCreateAdminKey(),
    // The tailnet hostname tailscale serve publishes, e.g.
    // "mediapc.tail1a2b3c.ts.net". Needed so CORS accepts that origin.
    tailnetHost: str('TAILNET_HOST'),
    /*
     * How long an unremembered login survives on the server.
     *
     * The cookie for one is a session cookie and dies with the browser, but the
     * server-side entry has to expire on its own or the set only ever grows —
     * and a token stays valid long after the browser that held it is gone.
     */
    sessionTtlMs: int('AUTH_SESSION_TTL_HOURS', 12) * 60 * 60 * 1000
  },

  // Filesystem
  libraryPath,
  moviesPath: path.join(libraryPath, 'movies'),
  showsPath: path.join(libraryPath, 'shows'),
  tempPath,
  cachePath: path.join(ROOT_DIR, 'cache'),
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
  // AllDebrid.
  //
  // v4.1, not v4: AllDebrid discontinued the v4 magnet endpoints, and
  // /v4/magnet/status now answers with
  //   DISCONTINUED: This API endpoint has been discontinued
  // which breaks every download at the polling step. /v4/user still works,
  // so the failure only shows up once a transfer starts. v4.1 serves the
  // whole surface (verified against the live API).
  alldebrid: {
    // Read through str() so the name matches .env and the value is trimmed.
    // Reading process.env directly here once silently yielded undefined,
    // because the variable is ALLDEBRID_API_KEY, not ALLDEBRID_APIKEY - and
    // the required-key check below passes either way, so the app booted fine
    // and only failed later with an auth error.
    apiKey: str('ALLDEBRID_API_KEY'),
    // Overridable so the download pipeline can be exercised against a local stub.
    baseUrl: str('ALLDEBRID_BASE_URL', 'https://api.alldebrid.com/v4.1'),
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
    configSegment: torrentioSegment(str('TORRENTIO_CONFIG')),
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

  // OpenSubtitles REST API v1 — optional. Leave OPENSUBTITLES_API_KEY empty to
  // disable subtitle downloading; the routes answer 503 and nothing else cares.
  //
  // Searching needs only the key, but /download also requires a JWT minted by
  // /login, which means real account credentials. That split is why there are
  // two capability flags rather than one: a deployment with a key and no
  // credentials can search and never fetch, and the routes gate on
  // `downloadable` so it fails at the point of asking rather than mid-write.
  opensubtitles: {
    apiKey: str('OPENSUBTITLES_API_KEY'),
    username: str('OPENSUBTITLES_USERNAME'),
    password: str('OPENSUBTITLES_PASSWORD'),
    baseUrl: str('OPENSUBTITLES_BASE_URL', 'https://api.opensubtitles.com/api/v1'),
    // The docs single out generic agents as a rejection cause, so this names
    // the app and version rather than leaving axios' default in place.
    userAgent: str('OPENSUBTITLES_USER_AGENT', 'MediaWatcher v1.0'),
    languages: str('OPENSUBTITLES_LANGUAGES', 'en'),
    // A JWT lasts 24h; refreshed early so a long bulk fetch cannot expire
    // halfway through.
    tokenTtlMs: 20 * 60 * 60 * 1000,
    timeoutMs: int('OPENSUBTITLES_TIMEOUT_MS', 20000)
  },

  // Per-source ceiling so one slow indexer can't stall a search.
  search: {
    sourceTimeoutMs: int('SEARCH_SOURCE_TIMEOUT_MS', 20000),
    maxResults: int('SEARCH_MAX_RESULTS', 60)
  },

  // Playback. ffmpeg is an external binary, not an npm dependency. It is only
  // used when the browser cannot decode a file as it sits on disk: compatible
  // files are still served as raw bytes with zero processing.
  // Browser-native MP4s cached on disk. Playing from one is byte-range
  // seekable, which is the only way to get instant seeking - an ffmpeg pipe
  // has no byte offsets. Sources are never touched or replaced.
  mp4Cache: {
    enabled: str('MP4_CACHE_ENABLED', '1') !== '0',
    dir: path.join(ROOT_DIR, 'cache', 'mp4'),
    /*
     * A converted copy is roughly the size of the source, so an unbounded cache
     * is a second library. Least-recently-played variants are evicted once the
     * directory passes this, and anything untouched for the TTL goes regardless
     * of how much room is left.
     */
    maxBytes: Math.round(Number(str('MP4_CACHE_MAX_GB', '50')) * 1024 ** 3),
    ttlMs: int('MP4_CACHE_TTL_DAYS', 30) * 24 * 60 * 60 * 1000
  },

  // Seek-preview frames. Tiny per file, but the keys are content-addressed, so
  // every replaced or re-downloaded file leaves its old set behind.
  thumbCache: {
    dir: path.join(ROOT_DIR, 'cache', 'thumbs'),
    maxBytes: Math.round(Number(str('THUMB_CACHE_MAX_GB', '2')) * 1024 ** 3),
    ttlMs: int('THUMB_CACHE_TTL_DAYS', 60) * 24 * 60 * 60 * 1000
  },

  // How often the cache directories are measured and trimmed.
  cacheSweepIntervalMs: int('CACHE_SWEEP_INTERVAL_MS', 30 * 60 * 1000),

  hls: {
    // Overridable so the pool can be exercised against a scratch directory
    // rather than the live cache.
    dir: resolvePath(str('HLS_CACHE_DIR'), path.join(ROOT_DIR, 'cache', 'hls')),
    // How long a session survives without a keepalive before it is reaped.
    // Long enough to cover a pause and a phone locking its screen.
    idleTimeoutMs: int('HLS_IDLE_TIMEOUT_MS', 60000),
    sweepIntervalMs: int('HLS_SWEEP_INTERVAL_MS', 30000),
    /*
     * Segments kept behind the play position, in segments (6s each).
     *
     * 6 was far too tight. Players re-request recent segments routinely - a
     * buffer flush, a track change, a brief seek back - and finding one deleted
     * forces the encoder to restart to rewrite it, which stalls playback. Ten
     * minutes of history costs roughly 150MB at the capped bitrate, which is
     * nothing beside the MP4 cache, and makes that case disappear.
     */
    keepBehind: int('HLS_KEEP_BEHIND', 100),
    // How long a request waits for the encoder to reach a segment before
    // giving up. Generous: a restart has to seek and refill first.
    segmentTimeoutMs: int('HLS_SEGMENT_TIMEOUT_MS', 30000),
    /*
     * Seconds of video one encoder run produces before stopping.
     *
     * Unbounded, ffmpeg races to the end of the file as fast as the GPU
     * allows: watching two minutes of a forty-minute episode still encoded the
     * whole episode and wrote it to disk. Five minutes is far more than any
     * player buffers, so the bound is invisible during playback, and running
     * out simply starts the next run where the last one stopped.
     */
    encodeAheadSeconds: int('HLS_ENCODE_AHEAD_SECONDS', 300),
    /*
     * What the *first* run produces, before anyone has proved they are
     * watching.
     *
     * The bound above is now a ceiling rather than a fixed size. Opening a
     * title to see what it is used to cost five minutes of encoding for the
     * thirty seconds actually watched; a run that ends by exhausting its
     * budget doubles the next one, so a viewer watching straight through
     * reaches the ceiling within a couple of runs and a browser never does.
     */
    encodeAheadMinSeconds: int('HLS_ENCODE_AHEAD_MIN_SECONDS', 120),
    /*
     * Budget for segments pooled across sessions.
     *
     * Small beside the MP4 cache because these are capped-bitrate segments and
     * they are only worth keeping while someone might still ask for them: a
     * second viewer, a seek back, the same episode reopened. Least recently
     * used goes first.
     */
    sharedMaxBytes: Math.round(Number(str('HLS_SHARED_CACHE_MAX_GB', '4')) * 1024 ** 3)
  },

  ffmpeg: {
    enabled: str('FFMPEG_ENABLED', '1') !== '0',
    /*
     * Ceiling on ffmpeg processes across the whole app.
     *
     * HLS encoders, MP4 conversions, thumbnail grabs and intro detection each
     * had their own pool and no idea the others existed, so a couple of viewers
     * plus background work could put a dozen encodes on one machine. Live
     * playback never queues behind this — it takes its slot and background work
     * waits for what is left.
     */
    maxProcesses: int('FFMPEG_MAX_PROCESSES', 4),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    probeTimeoutMs: int('FFPROBE_TIMEOUT_MS', 15000),
    // Audio re-encode settings (used when the source is DTS/TrueHD/etc).
    audioBitrate: str('TRANSCODE_AUDIO_BITRATE', '192k'),
    audioChannels: int('TRANSCODE_AUDIO_CHANNELS', 2),
    // Use a GPU encoder when one is available. Only consulted for HDR tone
    // mapping, where the CPU is already busy with the colour conversion.
    hardwareEncode: str('FFMPEG_HARDWARE_ENCODE', '1') !== '0',
    // Video re-encode settings (last resort — only when the codec is undecodable).
    videoPreset: str('TRANSCODE_VIDEO_PRESET', 'veryfast'),
    videoCrf: int('TRANSCODE_VIDEO_CRF', 20),
    videoMaxrate: str('TRANSCODE_VIDEO_MAXRATE', '12M')
  },

  // Downloads
  downloads: {
    maxConcurrent: 2,
    progressStepPercent: 5,
    /*
     * Longest a transfer may receive nothing before it is treated as dead.
     *
     * The HTTP request itself has no timeout, which is right for a multi-hour
     * download but means a silently stalled link would hold one of the two
     * slots forever.
     */
    stallTimeoutMs: int('DOWNLOAD_STALL_TIMEOUT_MS', 120000),
    // Refuse to start a transfer that would leave less than this free. Running
    // the disk to zero surfaces as unrelated ffmpeg write errors elsewhere.
    minFreeBytes: Math.round(Number(str('DOWNLOAD_MIN_FREE_GB', '5')) * 1024 ** 3)
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
  const dirs = [
    config.libraryPath, config.moviesPath, config.showsPath, config.tempPath,
    config.cachePath, config.mp4Cache.dir, config.thumbCache.dir
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export default config;
