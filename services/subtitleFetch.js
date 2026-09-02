/**
 * Fetch a subtitle from OpenSubtitles and drop it beside the video.
 *
 * The sidecar is the integration point. `routes/subs.js` already discovers
 * `<stem>.<lang>.<ext>` files next to a video and serves them ahead of
 * embedded tracks, so a fetched subtitle needs no new plumbing to become
 * playable - it just has to be named the way that discovery expects.
 *
 * That naming is stricter than it looks: the discovery regex accepts a two or
 * three letter language suffix and nothing else, so a code like `pt-BR` has to
 * be narrowed to `pt` on the way in or the file lands invisible.
 */
import fs from 'node:fs';
import path from 'node:path';
import config, { createLogger } from '../config/index.js';
import { isInsideLibrary } from './organizer.js';
import * as opensubtitles from './opensubtitles.js';

const log = createLogger('subs:fetch');

/** Anything not in this set cannot be discovered, so it is not worth writing. */
const WRITABLE = new Set(config.subtitleExtensions);

/**
 * Narrow a language tag to what `findSubtitles` can match.
 *
 * `pt-BR` becomes `pt`: the regional variant is lost, but a discoverable
 * approximate label beats an exact one that never appears in the track list.
 */
export function normaliseLang(language) {
  const base = String(language || '').toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/** The extension to save under, taken from the remote name when it is usable. */
export function sidecarExt(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return WRITABLE.has(ext) ? ext : '.srt';
}

/**
 * Where a fetched subtitle for `videoPath` should live.
 *
 * Returns the language-suffixed form. Without a usable language code the
 * bare stem is used, which discovery also accepts.
 */
export function sidecarPath(videoPath, language, fileName) {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  const lang = normaliseLang(language);
  return path.join(dir, `${stem}${lang ? `.${lang}` : ''}${sidecarExt(fileName)}`);
}

/**
 * Decode downloaded bytes to text.
 *
 * Same rule as reading a sidecar off disk: SubRip is frequently Windows-1252,
 * and a replacement character in the UTF-8 attempt is the tell that it was.
 * The BOM goes too, because it survives into the first cue's timestamp and
 * breaks parsing downstream.
 */
export function decodeSubtitle(buffer) {
  const utf8 = buffer.toString('utf8');
  const text = utf8.includes(String.fromCharCode(0xFFFD)) ? buffer.toString('latin1') : utf8;
  return text.replace(new RegExp('^' + String.fromCharCode(0xFEFF)), '');
}

/**
 * Search, pick the best match for this particular rip, download and write.
 *
 * `force` is what a "replace" action passes; without it an existing sidecar is
 * left alone and reported as `skipped`, so a bulk fetch over a season that is
 * half done does not spend quota re-fetching what is already there.
 */
export async function fetchForFile(videoPath, { tmdbId, season, episode, language, force = false } = {}) {
  const resolved = path.resolve(videoPath);

  if (!isInsideLibrary(resolved)) {
    return { status: 'error', path: resolved, error: 'path is outside the library' };
  }
  if (!fs.existsSync(resolved)) {
    return { status: 'error', path: resolved, error: 'video file does not exist' };
  }
  if (!opensubtitles.downloadable()) {
    return { status: 'error', path: resolved, error: 'OpenSubtitles credentials are not configured' };
  }

  const wanted = normaliseLang(language) || normaliseLang(config.opensubtitles.languages) || 'en';

  // Checked before searching, not after: the point of skipping is to spend no
  // quota at all on a file that already has a subtitle.
  const existing = sidecarPath(resolved, wanted, '.srt');
  if (!force && fs.existsSync(existing)) {
    return { status: 'skipped', path: resolved, file: existing, reason: 'already has a subtitle' };
  }

  const videoName = path.basename(resolved);

  let candidates;
  try {
    candidates = await opensubtitles.search({
      tmdbId,
      season: Number.isInteger(season) ? season : undefined,
      episode: Number.isInteger(episode) ? episode : undefined,
      languages: wanted,
      query: tmdbId ? undefined : path.basename(resolved, path.extname(resolved))
    });
  } catch (error) {
    return { status: 'error', path: resolved, error: error.message };
  }

  const best = opensubtitles.pickBest(candidates, videoName);
  if (!best) {
    return { status: 'none', path: resolved, error: `no ${wanted} subtitles found` };
  }

  let link;
  try {
    link = await opensubtitles.requestLink(best.fileId);
  } catch (error) {
    return { status: 'error', path: resolved, error: error.message, remaining: null };
  }
  if (!link.link) {
    return { status: 'error', path: resolved, error: 'no download link returned', remaining: link.remaining };
  }

  let text;
  try {
    text = decodeSubtitle(await opensubtitles.fetchSubtitle(link.link));
  } catch (error) {
    return { status: 'error', path: resolved, error: `download failed: ${error.message}`, remaining: link.remaining };
  }

  if (text.trim().length === 0) {
    return { status: 'error', path: resolved, error: 'downloaded subtitle was empty', remaining: link.remaining };
  }

  const target = sidecarPath(resolved, best.language || wanted, link.fileName || best.fileName);

  // Written through a temp file in the same directory so a failure midway
  // cannot leave a half-written sidecar that discovery would happily serve.
  const temp = `${target}.part`;
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* nothing to clean up */ }
    return { status: 'error', path: resolved, error: `could not write ${target}: ${error.message}`, remaining: link.remaining };
  }

  log.info(`saved ${path.basename(target)} (${best.release || best.fileName || best.fileId})`);

  return {
    status: 'saved',
    path: resolved,
    file: target,
    language: best.language || wanted,
    release: best.release || null,
    remaining: link.remaining
  };
}

/**
 * Fetch for many files, one at a time.
 *
 * Sequential deliberately. The account's download quota is small and the API
 * rate-limits, but the stronger reason is the same one behind sequential intro
 * detection: a bulk fetch must not compete with whatever is being streamed
 * right now. `onProgress` reports each result as it lands so a caller can
 * stream them rather than waiting for the whole season.
 */
export async function fetchForFiles(entries, { language, force = false, onProgress } = {}) {
  const results = [];
  for (const entry of entries) {
    const result = await fetchForFile(entry.path, {
      tmdbId: entry.tmdbId,
      season: entry.season,
      episode: entry.episode,
      language,
      force
    });
    results.push(result);
    if (typeof onProgress === 'function') {
      try { onProgress(result, results.length, entries.length); } catch { /* a broken reporter must not stop the fetch */ }
    }
    // A used-up quota fails every remaining file identically; stopping early
    // reports that once instead of once per episode.
    if (result.remaining === 0) {
      log.warn('download quota exhausted, stopping');
      break;
    }
  }
  return results;
}

export default { fetchForFile, fetchForFiles, sidecarPath, normaliseLang, sidecarExt, decodeSubtitle };
