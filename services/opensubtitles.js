/**
 * OpenSubtitles REST API v1 client.
 *
 * Two credentials, two capabilities. `Api-Key` alone is enough to search;
 * POST /download additionally wants `Authorization: Bearer <jwt>`, and the
 * only way to mint that JWT is POST /login with a real account. So a
 * deployment can be search-capable and not download-capable, and callers are
 * expected to check `downloadable()` before offering to fetch anything.
 *
 * The token is cached in memory. It is not persisted: a restart costs one
 * extra login, which is cheaper than owning a credential file.
 */
import axios from 'axios';
import config, { createLogger } from '../config/index.js';

const log = createLogger('opensubtitles');
const cfg = config.opensubtitles;

export class OpenSubtitlesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenSubtitlesError';
    this.status = status ?? 502;
  }
}

/** Search works with just the key. */
export const enabled = () => Boolean(cfg.apiKey);

/** Downloading additionally needs an account to log in with. */
export const downloadable = () => Boolean(cfg.apiKey && cfg.username && cfg.password);

const http = axios.create({
  baseURL: cfg.baseUrl,
  timeout: cfg.timeoutMs,
  headers: {
    'Api-Key': cfg.apiKey,
    // The docs call out generic agents as a rejection cause, so this is
    // deliberately named rather than left as axios' default.
    'User-Agent': cfg.userAgent,
    'Content-Type': 'application/json'
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request with retry on 429 and 5xx.
 *
 * 429 carries Retry-After and the account's quota is small, so the wait is
 * honoured rather than backed off blindly - guessing short would burn the
 * remaining allowance on retries.
 */
async function request(method, path, { params, data, headers, attempt = 1 } = {}) {
  try {
    const response = await http.request({ method, url: path, params, data, headers });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const retryable = status === undefined || status === 429 || status >= 500;

    if (retryable && attempt < 3) {
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30000) : 500 * 2 ** (attempt - 1);
      log.debug(`retrying ${path} in ${delay}ms (attempt ${attempt + 1})`);
      await sleep(delay);
      return request(method, path, { params, data, headers, attempt: attempt + 1 });
    }

    const body = error.response?.data;
    const message = body?.message || body?.errors?.join?.(', ') || error.message || 'request failed';
    throw new OpenSubtitlesError(`OpenSubtitles ${path}: ${message}`, status);
  }
}

/* --------------------------------------------------------------------------
 * Token
 * ----------------------------------------------------------------------- */

let token = null;
let tokenAt = 0;
let loggingIn = null;

/**
 * A cached JWT, minted on demand.
 *
 * Concurrent callers share one in-flight login: a bulk season fetch starts
 * several downloads at once, and without this each would log in separately and
 * spend the account's login allowance for nothing.
 */
async function authorize() {
  if (!downloadable()) {
    throw new OpenSubtitlesError('OpenSubtitles credentials are not configured', 503);
  }
  if (token && Date.now() - tokenAt < cfg.tokenTtlMs) return token;
  if (loggingIn) return loggingIn;

  loggingIn = (async () => {
    const body = await request('post', '/login', {
      data: { username: cfg.username, password: cfg.password }
    });
    if (!body?.token) throw new OpenSubtitlesError('login returned no token', 502);
    token = body.token;
    tokenAt = Date.now();
    log.info('logged in');
    return token;
  })().finally(() => { loggingIn = null; });

  return loggingIn;
}

/** Drop the cached token so the next call logs in again. */
function forgetToken() {
  token = null;
  tokenAt = 0;
}

/** Test seam: clear cached auth between cases. */
export function resetAuth() {
  forgetToken();
  loggingIn = null;
}

/* --------------------------------------------------------------------------
 * Search
 * ----------------------------------------------------------------------- */

/**
 * Normalise one search hit down to what ranking and downloading need.
 *
 * A subtitle entry can carry several files (a two-part rip); only the first is
 * usable as a single sidecar, and an entry with no files at all cannot be
 * downloaded, so those are dropped by the caller.
 */
function normalise(entry) {
  const a = entry?.attributes || {};
  const file = Array.isArray(a.files) ? a.files[0] : null;
  return {
    id: entry?.id ?? null,
    fileId: file?.file_id ?? null,
    fileName: file?.file_name || null,
    language: (a.language || '').toLowerCase() || null,
    release: a.release || null,
    downloads: Number(a.download_count) || 0,
    rating: Number(a.ratings) || 0,
    fromTrusted: Boolean(a.from_trusted),
    hearingImpaired: Boolean(a.hearing_impaired),
    machineTranslated: Boolean(a.machine_translated),
    aiTranslated: Boolean(a.ai_translated),
    fps: Number(a.fps) || null,
    uploadDate: a.upload_date || null
  };
}

/**
 * Search by TMDB id.
 *
 * `tmdb_id` for an episode is the *show's* id plus season and episode numbers -
 * the API resolves the episode itself, which is why the scanner's cached show
 * id is all a caller needs.
 */
export async function search({ tmdbId, season, episode, languages, query } = {}) {
  if (!enabled()) throw new OpenSubtitlesError('OpenSubtitles is not configured', 503);

  const params = { languages: String(languages || cfg.languages).toLowerCase() };
  if (tmdbId) params.tmdb_id = Number(tmdbId);
  if (query && !tmdbId) params.query = String(query);
  if (Number.isInteger(season)) params.season_number = season;
  if (Number.isInteger(episode)) params.episode_number = episode;
  params.type = Number.isInteger(episode) ? 'episode' : 'movie';

  if (!params.tmdb_id && !params.query) {
    throw new OpenSubtitlesError('search needs a tmdb id or a title', 400);
  }

  const body = await request('get', '/subtitles', { params });
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map(normalise).filter((row) => row.fileId !== null);
}

/* --------------------------------------------------------------------------
 * Ranking
 * ----------------------------------------------------------------------- */

/** Tokens from a release or file name, for comparing a subtitle to a video. */
function tokenize(name) {
  return new Set(
    String(name || '')
      .toLowerCase()
      .replace(/[._\-[\]()]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1)
  );
}

/**
 * Score a candidate against the video file it is meant to sit beside.
 *
 * Release-name overlap dominates on purpose: a subtitle cut for the same rip
 * is in sync, and a highly-rated one for a different rip usually is not. The
 * popularity terms only break ties among equally-matched candidates.
 */
export function scoreCandidate(candidate, videoName) {
  const wanted = tokenize(videoName);
  const got = tokenize(`${candidate.release || ''} ${candidate.fileName || ''}`);

  let overlap = 0;
  for (const word of got) if (wanted.has(word)) overlap += 1;
  const affinity = wanted.size > 0 ? overlap / wanted.size : 0;

  let score = affinity * 100;
  if (candidate.fromTrusted) score += 8;
  // Machine and AI translations read badly; they are a last resort, not a tie-break.
  if (candidate.machineTranslated) score -= 40;
  if (candidate.aiTranslated) score -= 30;
  // Hearing-impaired tracks are correct subtitles, just noisier for most
  // viewers, so they lose a tie rather than being filtered out.
  if (candidate.hearingImpaired) score -= 4;
  score += Math.min(6, candidate.rating);
  score += Math.min(6, Math.log10(candidate.downloads + 1) * 2);
  return score;
}

/** The best candidate for a given video file name, or null. */
export function pickBest(candidates, videoName) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, videoName) }))
    .sort((a, b) => b.score - a.score)[0].candidate;
}

/* --------------------------------------------------------------------------
 * Download
 * ----------------------------------------------------------------------- */

/**
 * Resolve a file id to a temporary link plus the account's remaining quota.
 *
 * A 401 here means the cached JWT expired early, so the token is dropped and
 * the call retried once. Any second failure is real and propagates.
 */
export async function requestLink(fileId, { retried = false } = {}) {
  const jwt = await authorize();
  try {
    const body = await request('post', '/download', {
      data: { file_id: Number(fileId) },
      headers: { Authorization: `Bearer ${jwt}` }
    });
    return {
      link: body?.link || null,
      fileName: body?.file_name || null,
      remaining: Number.isFinite(Number(body?.remaining)) ? Number(body.remaining) : null,
      resetTime: body?.reset_time || null
    };
  } catch (error) {
    if (error.status === 401 && !retried) {
      log.debug('token rejected, logging in again');
      forgetToken();
      return requestLink(fileId, { retried: true });
    }
    throw error;
  }
}

/**
 * Fetch the subtitle body from a link handed back by /download.
 *
 * The link points at a CDN, not the API, so it goes out on a bare axios call
 * without the Api-Key header. Bytes are taken raw: SubRip is routinely
 * Windows-1252 and decoding is the sidecar writer's job.
 */
export async function fetchSubtitle(link) {
  const response = await axios.get(link, {
    timeout: cfg.timeoutMs,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': cfg.userAgent }
  });
  return Buffer.from(response.data);
}

export default {
  enabled,
  downloadable,
  search,
  scoreCandidate,
  pickBest,
  requestLink,
  fetchSubtitle,
  resetAuth,
  OpenSubtitlesError
};
