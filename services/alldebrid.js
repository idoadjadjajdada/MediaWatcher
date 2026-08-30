/**
 * AllDebrid v4 client.
 *
 * AllDebrid answers with HTTP 200 even for application errors, shaped as
 * `{ status: "error", error: { code, message } }`, so every response is
 * inspected rather than trusted by status code alone. All failures surface as
 * AllDebridError with a `status` (HTTP-ish) and `code` (AllDebrid's own).
 */
import axios from 'axios';
import config, { createLogger } from '../config/index.js';

const log = createLogger('alldebrid');

export class AllDebridError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AllDebridError';
    this.status = status ?? 502;
    this.code = code ?? null;
  }
}

const http = axios.create({
  baseURL: config.alldebrid.baseUrl,
  timeout: config.alldebrid.timeoutMs,
  headers: { Authorization: `Bearer ${config.alldebrid.apiKey}` },
  params: { agent: config.alldebrid.agent }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Unwrap AllDebrid's envelope, converting `status: "error"` into a throw. */
function unwrap(payload, context) {
  if (!payload || typeof payload !== 'object') {
    throw new AllDebridError(`${context}: empty response from AllDebrid`, 502);
  }
  if (payload.status === 'error' || payload.error) {
    const error = payload.error || {};
    throw new AllDebridError(
      `${context}: ${error.message || 'AllDebrid returned an error'}`,
      error.code === 'AUTH_BAD_APIKEY' || error.code === 'AUTH_MISSING_APIKEY' ? 401 : 502,
      error.code || null
    );
  }
  return payload.data;
}

async function call(method, path, { params, form } = {}) {
  const context = `${method} ${path}`;
  try {
    const response = method === 'POST'
      ? await http.post(path, form ? new URLSearchParams(form).toString() : undefined, {
        params,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      })
      : await http.get(path, { params });
    return unwrap(response.data, context);
  } catch (error) {
    if (error instanceof AllDebridError) throw error;
    const status = error.response?.status;
    const message = error.response?.data?.error?.message || error.message;
    throw new AllDebridError(`${context}: ${message}`, status || 502, error.response?.data?.error?.code || error.code);
  }
}

/* --------------------------------------------------------------------------
 * Status normalisation
 * ----------------------------------------------------------------------- */

// AllDebrid magnet status codes: 0 queued, 1 downloading, 2 compressing/moving,
// 3 uploading, 4 ready, >=5 terminal failure.
const READY_CODE = 4;

function normalizeMagnet(raw) {
  if (!raw) return null;
  const size = Number(raw.size) || 0;
  const downloaded = Number(raw.downloaded) || 0;
  const statusCode = Number(raw.statusCode ?? raw.status_code);

  return {
    id: String(raw.id),
    filename: raw.filename || raw.name || null,
    hash: raw.hash || null,
    size,
    status: raw.status || null,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    ready: Number.isFinite(statusCode) ? statusCode === READY_CODE : Boolean(raw.ready),
    failed: Number.isFinite(statusCode) ? statusCode > READY_CODE : false,
    progress: size > 0 ? Math.min(1, downloaded / size) : 0,
    downloaded,
    seeders: Number(raw.seeders) || 0,
    downloadSpeed: Number(raw.downloadSpeed) || 0,
    links: Array.isArray(raw.links) ? raw.links : []
  };
}

/* --------------------------------------------------------------------------
 * API
 * ----------------------------------------------------------------------- */

/** Upload a magnet (or bare infohash). Returns { id, hash, name, size, ready }. */
export async function uploadMagnet(magnet) {
  if (!magnet) throw new AllDebridError('uploadMagnet: magnet is required', 400);

  const data = await call('POST', '/magnet/upload', { form: { 'magnets[]': magnet } });
  const entry = data?.magnets?.[0];
  if (!entry) throw new AllDebridError('uploadMagnet: AllDebrid returned no magnet entry', 502);
  if (entry.error) {
    throw new AllDebridError(`uploadMagnet: ${entry.error.message}`, 502, entry.error.code);
  }

  log.info(`uploaded magnet ${entry.hash || ''} as torrent ${entry.id}`);
  return {
    id: String(entry.id),
    hash: entry.hash || null,
    name: entry.name || entry.filename_original || null,
    size: Number(entry.size) || 0,
    ready: Boolean(entry.ready),
    status: entry.ready ? 'Ready' : 'In Queue'
  };
}

/** Current state of one torrent. */
export async function getTorrentStatus(id) {
  const data = await call('GET', '/magnet/status', { params: { id } });
  const raw = Array.isArray(data?.magnets)
    ? data.magnets.find((entry) => String(entry.id) === String(id))
    : data?.magnets;

  const magnet = normalizeMagnet(raw);
  if (!magnet) throw new AllDebridError(`getTorrentStatus: torrent ${id} not found`, 404);
  return magnet;
}

/**
 * Poll until the torrent is Ready.
 *
 * Cached torrents come back ready on the first tick; uncached ones download on
 * AllDebrid's servers first, which is what the generous default timeout covers.
 */
export async function pollUntilReady(id, timeoutMs = config.alldebrid.pollTimeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = await getTorrentStatus(id);
    if (typeof onTick === 'function') onTick(status);

    if (status.ready) return status;
    if (status.failed) {
      throw new AllDebridError(`torrent ${id} failed on AllDebrid: ${status.status}`, 502, status.statusCode);
    }
    if (Date.now() >= deadline) {
      throw new AllDebridError(`torrent ${id} not ready after ${Math.round(timeoutMs / 1000)}s (last state: ${status.status})`, 504);
    }

    await sleep(config.alldebrid.pollIntervalMs);
  }
}

/** Convert an AllDebrid link into a direct premium URL. */
export async function unlockLink(url) {
  if (!url) throw new AllDebridError('unlockLink: link is required', 400);

  const data = await call('POST', '/link/unlock', { form: { link: url } });
  if (!data?.link) throw new AllDebridError('unlockLink: no link in response', 502);

  return {
    link: data.link,
    filename: data.filename || null,
    filesize: Number(data.filesize) || 0,
    host: data.host || null
  };
}

/** Remove a torrent from the AllDebrid account (used when cancelling a job). */
export async function deleteMagnet(id) {
  try {
    await call('GET', '/magnet/delete', { params: { id } });
    return true;
  } catch (error) {
    log.warn(`could not delete torrent ${id}: ${error.message}`);
    return false;
  }
}

/**
 * Search AllDebrid's cached-torrent index.
 *
 * This endpoint is not part of AllDebrid's published v4 documentation, so it is
 * treated as best-effort: any failure or unexpected shape yields [] and the
 * other search sources carry the query.
 */
export async function searchCached(query) {
  if (!query) return [];

  try {
    const data = await call('POST', `/torrents/search/${encodeURIComponent(query)}`);
    const torrents = data?.torrents || data?.magnets || (Array.isArray(data) ? data : []);
    if (!Array.isArray(torrents)) return [];

    return torrents.map((entry) => ({
      id: entry.id ? String(entry.id) : null,
      name: entry.name || entry.filename || entry.title || '',
      size: Number(entry.size) || 0,
      hash: entry.hash || entry.infoHash || null,
      seeders: Number(entry.seeders) || 0
    })).filter((entry) => entry.name);
  } catch (error) {
    log.debug(`cached search unavailable: ${error.message}`);
    return [];
  }
}

/** Account sanity check — used by the README troubleshooting steps. */
export async function getUser() {
  const data = await call('GET', '/user');
  return data?.user || null;
}

export default {
  uploadMagnet,
  getTorrentStatus,
  pollUntilReady,
  unlockLink,
  deleteMagnet,
  searchCached,
  getUser,
  AllDebridError
};
