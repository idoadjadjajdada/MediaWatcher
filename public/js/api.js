/**
 * Fetch wrappers.
 *
 * Every call resolves with parsed JSON or throws an ApiError carrying
 * { status, message }, so callers only ever need one catch shape.
 */

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body ?? null;
  }
}

async function request(method, url, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch {
    // Network-level failure: the server is down or unreachable.
    throw new ApiError(0, 'Cannot reach MediaWatcher. Is the server still running?');
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  // A revoked or expired device goes back to the gate rather than leaving
  // every panel on the page to fail with its own error toast.
  if (response.status === 401) {
    window.location.replace('/login.html');
    throw new ApiError(401, 'Authentication required');
  }

  if (!response.ok) {
    const message = (data && data.error) || `Request failed (${response.status})`;
    throw new ApiError(response.status, message, data);
  }

  return data;
}

export const get = (url) => request('GET', url);
export const post = (url, body) => request('POST', url, body);
export const put = (url, body) => request('PUT', url, body);
export const del = (url) => request('DELETE', url);

/* --------------------------------------------------------------------------
 * Endpoint helpers
 * ----------------------------------------------------------------------- */

const q = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const health = () => get('/api/health');

export const getLibrary = () => get('/api/media/library');
export const getDiscover = (force = false) => get(`/api/discover?${q({ force: force ? 1 : '' })}`);
export const getDiscoverDetail = (type, tmdbId) => get(`/api/discover/${type}/${tmdbId}`);
export const rescan = (force = false) => post(`/api/media/rescan?${q({ force: force ? 1 : '' })}`);
export const refreshItem = (tmdbId, type) => get(`/api/media/refresh/${tmdbId}?${q({ type })}`);

export const searchTorrents = (params) => get(`/api/search?${q(params)}`);
export const getSources = () => get('/api/torrents/sources');

/** Titles for the search box dropdown. Answers [] rather than failing. */
export const suggest = (query, limit = 8) => get(`/api/search/suggest?${q({ q: query, limit })}`);

export const getJobs = () => get('/api/torrents/jobs');

/** How each search source has behaved lately, over a rolling window. */
export const getSourceStats = () => get('/api/torrents/source-stats');

/** Start that history again — for a source that has just been fixed. */
export const resetSourceStats = () => del('/api/torrents/source-stats');

/** The AllDebrid account every download depends on. */
export const getDebridAccount = () => get('/api/torrents/account');
export const startDownload = (payload) => post('/api/torrents/download', payload);

/**
 * What is actually inside a torrent.
 *
 * Answers ready:false rather than waiting when AllDebrid does not already hold
 * it — the file list does not exist until they have fetched it.
 */
export const inspectTorrent = (payload) => post('/api/torrents/inspect', payload);
export const cancelJob = (id) => del(`/api/torrents/jobs/${encodeURIComponent(id)}`);

/**
 * Pause, resume or retry one job.
 *
 * Pausing an active transfer aborts it and discards the partial file — there
 * is no resume-from-offset — but the job keeps its place in the queue.
 */
export const setJobState = (id, state) =>
  post(`/api/torrents/jobs/${encodeURIComponent(id)}/${state}`, {});

/** Reorder within the queue: up, down, top or bottom. */
export const moveJob = (id, move) =>
  post(`/api/torrents/jobs/${encodeURIComponent(id)}/move`, { move });

export const getContinueWatching = () => get('/api/progress');
/** Every row, completed included — the detail page marks watched episodes. */
export const getAllProgress = () => get('/api/progress?all=1');
export const getProgressFor = (filePath) => get(`/api/progress?${q({ file_path: filePath })}`);
export const saveProgress = (payload) => post('/api/progress', payload);

/* --------------------------------------------------------------------------
 * Playback URLs
 * ----------------------------------------------------------------------- */

/**
 * What this browser can decode. The server uses these to decide whether a file
 * can be copied through untouched or has to be re-encoded, so getting them
 * right is the difference between a lossless remux and a transcode.
 */
export function decoderCapabilities() {
  const probe = document.createElement('video');
  const canPlay = (type) => probe.canPlayType(type) !== '';
  const supportedByMse = (type) =>
    typeof MediaSource !== 'undefined'
    && typeof MediaSource.isTypeSupported === 'function'
    && MediaSource.isTypeSupported(type);

  return {
    hevc: canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"')
      || supportedByMse('video/mp4; codecs="hev1.1.6.L93.B0"'),
    ac3: canPlay('audio/mp4; codecs="ac-3"') || canPlay('audio/mp4; codecs="ec-3"'),
    hdr: displayIsHdr()
  };
}

/**
 * Can this screen actually show HDR?
 *
 * `video-dynamic-range` is the precise question - it asks about the video
 * plane specifically - but it is newer, so `dynamic-range` is the fallback.
 * Anything that answers neither is treated as SDR, which keeps tone mapping on
 * for every client that cannot tell us, and that is the safe direction: a
 * tone-mapped stream on an HDR screen looks slightly flat, while a PQ stream
 * on an SDR screen looks washed out and far too bright.
 *
 * This has to be read at request time rather than cached, because a laptop
 * moved onto an HDR monitor changes the answer without a reload.
 */
function displayIsHdr() {
  try {
    if (typeof window.matchMedia !== 'function') return false;
    if (window.matchMedia('(video-dynamic-range: high)').matches) return true;
    return window.matchMedia('(dynamic-range: high)').matches;
  } catch {
    // Some embedded webviews throw on an unrecognised media feature.
    return false;
  }
}

/*
 * Playback quality, per device rather than per account: the right level is a
 * property of the connection you are on, which is also why it lives in
 * localStorage rather than in the database. 'auto' lets the server decide from
 * whether the request arrived over the LAN or the tunnel.
 */
const QUALITY_KEY = 'mw.quality';
export const QUALITY_LEVELS = ['auto', 'original', 'high', 'medium', 'low'];

export function getQuality() {
  try {
    const stored = localStorage.getItem(QUALITY_KEY);
    return QUALITY_LEVELS.includes(stored) ? stored : 'auto';
  } catch {
    // Private mode and some embedded webviews throw on access.
    return 'auto';
  }
}

export function setQuality(level) {
  if (!QUALITY_LEVELS.includes(level)) return;
  try { localStorage.setItem(QUALITY_KEY, level); } catch { /* not worth failing playback over */ }
}

/**
 * How this file should be played, and the URL to play it from.
 *
 * The audio track and delay have to be sent: the server bakes both into the
 * HLS playlist URL it returns, so asking without them yields a URL for a
 * stream with no delay and the first audio track - which is why the delay
 * control silently did nothing on anything that went through ffmpeg.
 */
export const getStreamInfo = (filePath, { audioOffset = 0, audio = 0 } = {}) => {
  const caps = decoderCapabilities();
  return get(`/api/stream/info?${q({
    path: filePath,
    hevc: caps.hevc ? 1 : '',
    ac3: caps.ac3 ? 1 : '',
    hdr: caps.hdr ? 1 : '',
    q: getQuality(),
    audioOffset: audioOffset || '',
    audio: audio || ''
  })}`);
};

export function streamUrl(filePath, { start = 0, audio, audioOffset = 0 } = {}) {
  const caps = decoderCapabilities();
  return `/api/stream?${q({
    path: filePath,
    t: start > 0 ? Math.floor(start) : '',
    audio,
    audioOffset: audioOffset || '',
    hevc: caps.hevc ? 1 : '',
    ac3: caps.ac3 ? 1 : '',
    hdr: caps.hdr ? 1 : '',
    q: getQuality()
  })}`;
}

/*
 * `raw` asks for ASS rather than the WebVTT a <track> element wants. Only the
 * overlay renderer passes it; everything else takes the converted form.
 */
export const subsUrl = (filePath, track, { raw = false } = {}) => {
  if (track && track.source === 'embedded') {
    return `/api/subs?${q({ path: filePath, embedded: track.index, raw: raw ? 1 : '' })}`;
  }
  // An external sidecar is served in whatever format it already is, so `raw`
  // has nothing to change there.
  return `/api/subs?${q({ path: filePath, lang: track?.lang })}`;
};

export const listSubtitles = (filePath) => get(`/api/subs?${q({ path: filePath, list: 1 })}`);

/* --------------------------------------------------------------------------
 * Fetching subtitles from OpenSubtitles
 *
 * Downloading needs an account, searching only a key, so a deployment can
 * legitimately offer one and not the other. Callers read `capabilities` once
 * and hide what is unavailable rather than surfacing a 503 on click.
 * ----------------------------------------------------------------------- */

export const subtitleCapabilities = () => get('/api/subs/capabilities');

export const searchSubtitles = (filePath, { tmdbId, season, episode, lang } = {}) =>
  get(`/api/subs/search?${q({ path: filePath, tmdbId, season, episode, lang })}`);

/** Download one and save it beside the video. Resolves for "none" too. */
export const fetchSubtitle = (payload) => post('/api/subs/fetch', payload);

/** One per episode across a whole season. Slow by design; show a pending state. */
export const fetchSeasonSubtitles = (payload) => post('/api/subs/fetch-season', payload);

/** Keepalive so the server does not reap a session that is still playing. */
export const touchHlsSession = (sessionId) => post(`/api/hls/${sessionId}/touch`, {});

/** Stop a session's encoder immediately rather than waiting for the sweeper. */
export const endHlsSession = (sessionId) => del(`/api/hls/${sessionId}`);

/* --------------------------------------------------------------------------
 * Intro markers
 * ----------------------------------------------------------------------- */

/** The learned intro for a show and season, or null. */
export const getIntro = (show, season) => get(`/api/intro?${q({ show, season })}`);

/** Report a jump that might be someone skipping the title sequence. */
export const reportSkip = (payload) => post('/api/intro/skip', payload);

/** Forget what was learned, when the offer turns out to be wrong. */
export const forgetIntro = (show, season) => del(`/api/intro?${q({ show, season })}`);

/* --------------------------------------------------------------------------
 * Remembered track choices
 *
 * Storage only. Which track a given file should open with depends on that
 * file's own track list, so the matching lives in track-prefs.js on this side.
 * ----------------------------------------------------------------------- */

/** Answers { key, prefs }, with prefs null when nothing was ever chosen. */
export const getTrackPrefs = (key) => get(`/api/track-prefs?${q({ key })}`);

export const saveTrackPrefs = (payload) => put('/api/track-prefs', payload);

export const forgetTrackPrefs = (key) => del(`/api/track-prefs?${q({ key })}`);

/* --------------------------------------------------------------------------
 * Devices, access history and health
 * ----------------------------------------------------------------------- */

/** Remembered devices. Each row is a live credential, not a log entry. */
export const getDevices = () => get('/api/devices');

/**
 * Mint a code that signs another device in without typing the password.
 *
 * Single use, five minutes. The URL comes back built from the origin this
 * request arrived on, so a code minted over the tunnel points at the tunnel.
 */
export const createEnrolment = (password) => post('/api/auth/enrol', { password });

/** Cancel outstanding codes — for one shown to the wrong room. */
export const cancelEnrolments = (password) => post('/api/auth/enrol/cancel', { password });

/** A QR for any text, as an SVG document. */
export const qrUrl = (text) => `/api/diagnostics/qr?${q({ text })}`;

/** Revoking locks that device out on its very next request. */
export const revokeDevice = (id) => del(`/api/devices/${encodeURIComponent(id)}`);

/** Every attempt at the gate, newest first, successes and failures alike. */
export const getLoginHistory = (limit = 100) => get(`/api/diagnostics/logins?${q({ limit })}`);

/** Whether this install is actually healthy, and what it is using. */
export const getDiagnostics = () => get('/api/diagnostics');

/* --------------------------------------------------------------------------
 * Operating the server from somewhere else
 * ----------------------------------------------------------------------- */

/**
 * Recent log lines. `since` is the sequence number of the last line held, so
 * following the log costs one small request per poll rather than the buffer.
 */
export const getServerLog = ({ since = 0, limit = 500, level = '' } = {}) =>
  get(`/api/admin/log?${q({ since, limit, level })}`);

/** Every setting, with the secrets masked. */
export const getEnv = () => get('/api/admin/env');

/** Change some. A value still masked means "leave that one alone". */
export const saveEnv = (changes, password) => put('/api/admin/env', { changes, password });

/** Stop and come back. Only works where something is supervising the process. */
export const restartServer = (password, force = false) =>
  post('/api/admin/restart', { password, force });

/** The last measurement of this machine, and whether one is running. */
export const getBenchmark = () => get('/api/admin/benchmark');

/** Measure now. Takes about a minute and answers with the result. */
export const runBenchmark = () => post('/api/admin/benchmark', {});

/**
 * Whether the subtitle track chosen for this file is actually in time with it.
 *
 * Costs an audio decode of the first ten minutes, so it is asked for rather
 * than run on opening a file.
 */
export const checkSubtitleSync = (filePath, { lang = '', embedded = '', audio = 0 } = {}) =>
  get(`/api/subs/sync?${q({ path: filePath, lang, embedded, audio })}`);

/* --------------------------------------------------------------------------
 * Notifications
 * ----------------------------------------------------------------------- */

/** The server's push identity. Public: every subscription is bound to it. */
export const getPushKey = () => get('/api/notifications/key');

/** Register this browser's endpoint. It goes in and never comes back out. */
export const subscribePush = (endpoint) => post('/api/notifications/subscribe', { endpoint });

export const unsubscribePush = (endpoint) => post('/api/notifications/unsubscribe', { endpoint });

/** Prove the whole chain works, rather than finding out on the night it matters. */
export const testPush = () => post('/api/notifications/test', {});

/** Every ffmpeg process running right now, with the budget it sits in. */
export const getEncoders = () => get('/api/diagnostics/encoders');

/** Stop one encoder. Everything on that list is restartable by design. */
export const killEncoder = (id) => del(`/api/diagnostics/encoders/${encodeURIComponent(id)}`);

/* --------------------------------------------------------------------------
 * Library gaps and storage
 * ----------------------------------------------------------------------- */

/**
 * Episodes TMDB knows about that are not on disk.
 *
 * Costs a TMDB season lookup per season the first time; they are cached after
 * that, so it is asked for per show on demand rather than for the whole
 * library at boot.
 */
export const getMissingEpisodes = (show) => get(`/api/library/missing?${q({ show })}`);

/** Where the space went, by title rather than by folder. */
export const getStorage = () => get('/api/library/storage');

/**
 * Convert and thumbnail everything ahead of time.
 *
 * Answers immediately with what was queued; the work runs on background ffmpeg
 * slots and yields to anyone watching, so this is safe to start and leave.
 */
export const warmLibrary = (show) => post('/api/library/warm', show ? { show } : {});
export const getWarmStatus = () => get('/api/library/warm');

/** What this device has not seen in the library since it last caught up. */
export const getChanges = () => get('/api/library/changes');

/** Caught up. Called when the list has actually been shown, not when fetched. */
export const markChangesSeen = () => post('/api/library/changes/seen', {});

/* --------------------------------------------------------------------------
 * Saving for offline
 * ----------------------------------------------------------------------- */

/**
 * Whether a single-file copy exists yet, and how big it is.
 *
 * Decoder capabilities are sent because they decide which variant counts as
 * browser-native — the same question playback already asks.
 */
export const getOfflineInfo = (filePath) => {
  const caps = decoderCapabilities();
  return get(`/api/offline/info?${q({ path: filePath, hevc: caps.hevc ? 1 : '', ac3: caps.ac3 ? 1 : '' })}`);
};

/** The whole file, for downloading into the offline cache. */
export const offlineFileUrl = (filePath) => {
  const caps = decoderCapabilities();
  return `/api/offline/file?${q({ path: filePath, hevc: caps.hevc ? 1 : '', ac3: caps.ac3 ? 1 : '' })}`;
};

export const thumbMetaUrl = (filePath) => `/api/thumbs/meta?${q({ path: filePath })}`;
export const thumbUrl = (filePath, index) => `/api/thumbs?${q({ path: filePath, i: index })}`;

export default {
  get, post, put, del, ApiError,
  health, getLibrary, rescan, refreshItem, getDiscover, getDiscoverDetail,
  searchTorrents, getSources, suggest,
  getJobs, startDownload, cancelJob, setJobState, moveJob,
  getContinueWatching, getAllProgress, getProgressFor, saveProgress,
  getStreamInfo, streamUrl, subsUrl, listSubtitles, decoderCapabilities,
  subtitleCapabilities, searchSubtitles, fetchSubtitle, fetchSeasonSubtitles,
  getQuality, setQuality, QUALITY_LEVELS,
  thumbMetaUrl, thumbUrl, touchHlsSession, endHlsSession,
  getIntro, reportSkip, forgetIntro,
  getTrackPrefs, saveTrackPrefs, forgetTrackPrefs,
  getDevices, revokeDevice, getLoginHistory, createEnrolment, cancelEnrolments, qrUrl, createEnrolment, cancelEnrolments, qrUrl, getDiagnostics, getEncoders, killEncoder,
  getServerLog, getEnv, saveEnv, restartServer, getBenchmark, runBenchmark,
  getSourceStats, resetSourceStats, getDebridAccount, inspectTorrent,
  getPushKey, subscribePush, unsubscribePush, testPush, checkSubtitleSync,
  getMissingEpisodes, getStorage, warmLibrary, getWarmStatus, getChanges, markChangesSeen,
  getOfflineInfo, offlineFileUrl
};
