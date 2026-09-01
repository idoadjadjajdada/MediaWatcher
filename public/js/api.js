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
export const startDownload = (payload) => post('/api/torrents/download', payload);
export const cancelJob = (id) => del(`/api/torrents/jobs/${encodeURIComponent(id)}`);

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
    ac3: canPlay('audio/mp4; codecs="ac-3"') || canPlay('audio/mp4; codecs="ec-3"')
  };
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

export const getStreamInfo = (filePath) => {
  const caps = decoderCapabilities();
  return get(`/api/stream/info?${q({
    path: filePath,
    hevc: caps.hevc ? 1 : '',
    ac3: caps.ac3 ? 1 : '',
    q: getQuality()
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
    q: getQuality()
  })}`;
}

export const subsUrl = (filePath, track) => {
  if (track && track.source === 'embedded') {
    return `/api/subs?${q({ path: filePath, embedded: track.index })}`;
  }
  return `/api/subs?${q({ path: filePath, lang: track?.lang })}`;
};

export const listSubtitles = (filePath) => get(`/api/subs?${q({ path: filePath, list: 1 })}`);

/** Keepalive so the server does not reap a session that is still playing. */
export const touchHlsSession = (sessionId) => post(`/api/hls/${sessionId}/touch`, {});

export const thumbMetaUrl = (filePath) => `/api/thumbs/meta?${q({ path: filePath })}`;
export const thumbUrl = (filePath, index) => `/api/thumbs?${q({ path: filePath, i: index })}`;

export default {
  get, post, del, ApiError,
  health, getLibrary, rescan, refreshItem, getDiscover, getDiscoverDetail,
  searchTorrents, getSources, suggest,
  getJobs, startDownload, cancelJob,
  getContinueWatching, getAllProgress, getProgressFor, saveProgress,
  getStreamInfo, streamUrl, subsUrl, listSubtitles, decoderCapabilities,
  getQuality, setQuality, QUALITY_LEVELS,
  thumbMetaUrl, thumbUrl, touchHlsSession
};
