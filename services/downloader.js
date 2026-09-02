/**
 * Download pipeline: magnet → AllDebrid → premium link → disk → library.
 *
 * Progress is reported as a single 0..1 figure covering two phases, because the
 * UI has one bar to fill:
 *   0.00 → 0.50  AllDebrid fetching the torrent (instant for cached ones)
 *   0.50 → 1.00  streaming the unlocked link to local disk
 *
 * Files land in TEMP_PATH first and are moved into the library only once the
 * byte count matches, so a half-written file is never visible to the scanner.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import axios from 'axios';

import config, { createLogger } from '../config/index.js';
import {
  insertJob, updateJob, getJob, deleteJob, listJobs, listJobsByStatus, reorderJobs
} from '../db/index.js';
import * as alldebrid from './alldebrid.js';
import * as organizer from './organizer.js';
import {
  nextRunnable, nextPosition, moveJob as planMove, canTransition, sortQueue
} from './queueOrder.js';
import { hasRoomFor, formatBytes } from './diskspace.js';

const log = createLogger('downloader');

/** Emits: progress {id, progress, phase}, complete {id, file_path}, error {id, error}. */
export const events = new EventEmitter();
events.setMaxListeners(50);

/*
 * 'error' is the one event name EventEmitter treats specially: emitting it with
 * no listener attached throws ERR_UNHANDLED_ERROR rather than doing nothing.
 * Nothing in the app subscribes to this bus today, so every failed download
 * threw out of its own catch block and surfaced as an unhandled rejection —
 * with the useful message already logged a line earlier, so the noise carried
 * no information.
 *
 * A listener that does nothing is the fix: failures are logged and written to
 * the job row regardless, and a real subscriber can be added beside it.
 */
events.on('error', () => {});

const DEBRID_SHARE = 0.5;
const SAMPLE_PATTERN = /(^|[^a-z])sample([^a-z]|$)/i;
const MIN_VIDEO_BYTES = 50 * 1024 * 1024;

// id -> { controller, tempPaths[], request }
const active = new Map();
const queue = [];

// id -> { progress, phase, updated_at }. The DB row only moves every 5%, so the
// polling endpoint reads live values from here for jobs still in flight.
const liveProgress = new Map();

/** Live progress for one job, or undefined once it has finished. */
export function getLiveProgress(id) {
  return liveProgress.get(String(id));
}

/* --------------------------------------------------------------------------
 * File selection
 * ----------------------------------------------------------------------- */

function isVideo(name) {
  return config.videoExtensions.includes(path.extname(String(name || '')).toLowerCase());
}

/**
 * Pick which of a torrent's files to keep.
 *
 * Season packs return many episodes; a single-episode request pulls just the
 * matching file, a movie takes the largest, and anything else takes every video.
 *
 * A request that names an episode it cannot find takes nothing, unless the
 * torrent holds exactly one video — see below.
 */
export function selectFiles(links, request) {
  const videos = links
    .map((entry) => ({
      link: entry.link,
      filename: entry.filename || entry.link,
      size: Number(entry.size) || 0
    }))
    .filter((entry) => isVideo(entry.filename) && !SAMPLE_PATTERN.test(entry.filename));

  const usable = videos.length > 0 ? videos : links.map((entry) => ({
    link: entry.link,
    filename: entry.filename || entry.link,
    size: Number(entry.size) || 0
  }));

  if (usable.length === 0) return [];

  const bigEnough = usable.filter((entry) => entry.size >= MIN_VIDEO_BYTES);
  const pool = bigEnough.length > 0 ? bigEnough : usable;

  if (request.type === 'episode' && request.season != null && request.episode != null) {
    const tag = organizer.episodeTag(request.season, request.episode);
    const alt = `${Number(request.season)}x${organizer.pad2(request.episode)}`;
    const match = pool.find((entry) => {
      const name = entry.filename.toLowerCase();
      return name.includes(tag.toLowerCase()) || name.includes(alt.toLowerCase());
    });
    if (match) return [match];

    /*
     * One video and no episode marker in its name is not ambiguous: whatever
     * it is called, it is the only thing this torrent holds and the torrent was
     * chosen for this episode. Plenty of single-episode releases name the file
     * something the pattern cannot read.
     *
     * More than one, though, and there is no way to tell which — that is the
     * season pack, and taking all of them wrote every episode to the requested
     * episode's path: "Show - S01E05.mkv", " (2).mkv", " (3).mkv".
     */
    return pool.length === 1 ? pool : [];
  }

  if (request.type === 'movie') {
    return [pool.reduce((biggest, entry) => (entry.size > biggest.size ? entry : biggest), pool[0])];
  }

  return pool.sort((a, b) => b.size - a.size);
}

/* --------------------------------------------------------------------------
 * Transfer
 * ----------------------------------------------------------------------- */

function persistProgress(job, fraction, phase) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const step = config.downloads.progressStepPercent / 100;

  liveProgress.set(String(job.id), { progress: clamped, phase, updated_at: Date.now() });

  if (clamped >= 1 || clamped - (job._lastPersisted ?? -1) >= step) {
    job._lastPersisted = clamped;
    updateJob(job.id, { progress: clamped });
  }
  events.emit('progress', { id: job.id, progress: clamped, phase });
}

/**
 * Stream one unlocked link to disk.
 *
 * `timeout: 0` is deliberate — a multi-hour transfer must not be cut off for
 * taking a long time — but an overall timeout is not the same thing as noticing
 * that nothing is arriving. A stalled link used to hold one of the two
 * concurrency slots indefinitely with nothing but a manual cancel to free it,
 * so the watchdog below measures silence rather than duration.
 */
export async function streamToFile(url, destination, { signal, onBytes = () => {} } = {}) {
  const response = await axios.get(url, {
    responseType: 'stream',
    signal,
    timeout: 0,
    maxRedirects: 5
  });

  const declared = Number(response.headers['content-length']) || 0;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const writer = fs.createWriteStream(destination);

  let received = 0;
  let lastByteAt = Date.now();

  response.data.on('data', (chunk) => {
    received += chunk.length;
    lastByteAt = Date.now();
    onBytes(chunk.length, received, declared);
  });

  const stallMs = config.downloads.stallTimeoutMs;
  let watchdog = null;

  try {
    await new Promise((resolve, reject) => {
      if (stallMs > 0) {
        // Checked at a fraction of the limit so the reported idle time is close
        // to the real one rather than up to double it.
        watchdog = setInterval(() => {
          const idle = Date.now() - lastByteAt;
          if (idle < stallMs) return;
          response.data.destroy();
          reject(new Error(`transfer stalled: nothing received for ${Math.round(idle / 1000)}s`));
        }, Math.max(1000, Math.floor(stallMs / 4)));
        watchdog.unref?.();
      }

      response.data.pipe(writer);
      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
    });
  } finally {
    if (watchdog) clearInterval(watchdog);
  }

  return { bytes: received, declared, contentType: response.headers['content-type'] || null };
}

async function removeQuietly(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch {
    // already gone
  }
}

/* --------------------------------------------------------------------------
 * Job execution
 * ----------------------------------------------------------------------- */

/**
 * Where one file of one job is written while it transfers.
 *
 * The job id is part of the name, not decoration. Two jobs run at once and two
 * torrents holding an identically named file is ordinary - "Episode 1.mkv" from
 * two different seasons, say - so without it both transfers wrote to the same
 * path at the same time, and the interleaved result could still pass the size
 * check at the end.
 */
export function tempPathFor(jobId, filename, ext = '.mkv') {
  const base = organizer.sanitizeName(filename || `download${ext}`);
  return path.join(config.tempPath, `${organizer.sanitizeName(String(jobId))}-${base}`);
}

async function runJob(jobId, request) {
  const controller = new AbortController();
  const state = { controller, tempPaths: [], request };
  active.set(jobId, state);

  let job = updateJob(jobId, { status: 'downloading', error: null });
  job._lastPersisted = -1;

  try {
    // Phase 1 — AllDebrid resolves the torrent.
    const ready = await alldebrid.pollUntilReady(jobId, config.alldebrid.pollTimeoutMs, (tick) => {
      if (controller.signal.aborted) return;
      persistProgress(job, tick.progress * DEBRID_SHARE, 'debrid');
    });

    if (controller.signal.aborted) throw new Error('cancelled');
    persistProgress(job, DEBRID_SHARE, 'debrid');

    const selected = selectFiles(ready.links, request);
    if (selected.length === 0) {
      const wanted = request.type === 'episode' && request.season != null && request.episode != null
        ? ` matching ${organizer.episodeTag(request.season, request.episode)}`
        : '';
      throw new Error(`torrent contains no downloadable files${wanted}`);
    }

    // Phase 2 — unlock and stream each file.
    const unlocked = [];
    for (const file of selected) {
      const link = await alldebrid.unlockLink(file.link);
      unlocked.push({ ...file, url: link.link, filename: link.filename || file.filename, size: link.filesize || file.size });
    }

    const totalBytes = unlocked.reduce((sum, file) => sum + (file.size || 0), 0);
    let completedBytes = 0;
    const finalPaths = [];

    /*
     * Both ends are checked, because temp/ and library/ are routinely on
     * different drives - that is what the EXDEV fallback in organizer.moveInto
     * exists for - and either one filling up loses the transfer. On a
     * single-volume setup this is the same question asked twice, which costs a
     * statfs and nothing else.
     *
     * Checking before the first byte is what turns "the disk filled up" from a
     * confusing ffmpeg write error in some unrelated request into a job that
     * says what happened.
     */
    if (totalBytes > 0) {
      for (const target of [config.tempPath, config.libraryPath]) {
        const room = await hasRoomFor(target, totalBytes, config.downloads.minFreeBytes);
        if (!room.ok) {
          throw new Error(`not enough disk space: ${formatBytes(totalBytes)} needed, `
            + `${formatBytes(room.free)} free (keeping ${formatBytes(room.reserve)} in reserve)`);
        }
      }
    }

    for (const file of unlocked) {
      if (controller.signal.aborted) throw new Error('cancelled');

      const ext = organizer.extensionFrom(file.filename, organizer.extensionFrom(file.url));
      const tempPath = tempPathFor(jobId, file.filename, ext);
      state.tempPaths.push(tempPath);

      const { bytes } = await streamToFile(file.url, tempPath, {
        signal: controller.signal,
        onBytes: (_chunk, received) => {
          const fraction = totalBytes > 0
            ? (completedBytes + received) / totalBytes
            : 0;
          persistProgress(job, DEBRID_SHARE + fraction * (1 - DEBRID_SHARE), 'transfer');
        }
      });

      if (file.size > 0 && bytes < file.size) {
        throw new Error(`truncated download: got ${bytes} of ${file.size} bytes`);
      }
      completedBytes += bytes;

      const destination = organizer.targetPath({
        type: request.type,
        title: request.title,
        year: request.year,
        season: request.season,
        episode: request.episode,
        episodeTitle: request.episodeTitle,
        ext
      });

      finalPaths.push(await organizer.moveInto(tempPath, destination));
      state.tempPaths = state.tempPaths.filter((entry) => entry !== tempPath);
    }

    job = updateJob(jobId, { status: 'complete', progress: 1, file_path: finalPaths[0], error: null });
    log.info(`completed ${request.title} -> ${finalPaths[0]}`);
    events.emit('complete', { id: jobId, file_path: finalPaths[0], files: finalPaths });
    return job;
  } catch (error) {
    const cancelled = controller.signal.aborted || error.message === 'cancelled';
    for (const temp of state.tempPaths) await removeQuietly(temp);

    if (cancelled) {
      log.info(`cancelled ${request.title}`);
      events.emit('cancelled', { id: jobId });
      return null;
    }

    log.error(`failed ${request.title}: ${error.message}`);
    updateJob(jobId, { status: 'error', error: error.message });
    events.emit('error', { id: jobId, error: error.message });
    return null;
  } finally {
    active.delete(jobId);
    liveProgress.delete(String(jobId));
    pump();
  }
}

/**
 * Start queued jobs while under the concurrency ceiling.
 *
 * The order comes from the database rather than the in-memory array, because
 * that is where pausing and reordering write. The array is still what holds
 * each job's request payload — the row cannot carry an AbortController or the
 * original search result — so the two are matched by id.
 */
function pump() {
  while (active.size < config.downloads.maxConcurrent) {
    const waiting = queue.map((entry) => getJob(entry.id)).filter(Boolean);
    const next = nextRunnable(waiting);
    if (!next) break;

    const index = queue.findIndex((entry) => String(entry.id) === String(next.id));
    // A row that says queued with nothing behind it in the array is a job
    // whose request was lost to a restart; recover() re-queues those properly.
    if (index === -1) break;

    const [entry] = queue.splice(index, 1);
    runJob(entry.id, entry.request);
  }
}

/* --------------------------------------------------------------------------
 * Queue management
 *
 * Pausing an active transfer aborts it. There is no resume-from-byte-offset
 * here: AllDebrid serves a fresh link each time and the partial file is
 * discarded, so a paused download restarts. That is worth saying plainly
 * rather than implying otherwise, and it is why pause leaves the job in the
 * queue at its own position instead of cancelling it.
 * ----------------------------------------------------------------------- */

/** Apply one of pause / resume / retry. */
export async function setJobState(id, action) {
  const key = String(id);
  const job = getJob(key);
  const verdict = canTransition(job, action);
  if (!verdict.ok) {
    const error = new Error(verdict.reason);
    error.status = job ? 409 : 404;
    throw error;
  }

  if (action === 'pause' && job.status === 'downloading') {
    const state = active.get(key);
    if (state) {
      state.controller.abort();
      for (const temp of state.tempPaths) await removeQuietly(temp);
    }
  }

  // A retry goes back to the end of nothing — it keeps its place, because the
  // failure was not the fault of whatever is queued behind it.
  const patch = { status: verdict.status };
  if (action === 'retry') patch.error = null;
  if (action === 'retry' || action === 'resume') patch.progress = 0;

  const updated = updateJob(key, patch);
  events.emit('state', { id: key, status: verdict.status });

  // Resuming or retrying makes something runnable; pausing frees a slot.
  pump();
  return updated;
}

/** Move a job within the queue: up, down, top or bottom. */
export function moveJob(id, move) {
  const updates = planMove(listJobs(), id, move);
  if (updates.length === 0) return { moved: false, updates: 0 };
  reorderJobs(updates);
  return { moved: true, updates: updates.length };
}

/* --------------------------------------------------------------------------
 * Public API
 * ----------------------------------------------------------------------- */

/**
 * Queue a download.
 *
 * The magnet is uploaded synchronously so the AllDebrid torrent id can be used
 * as the job's primary key (as the schema requires); everything after that runs
 * in the background.
 */
export async function startDownload(request) {
  if (!request?.magnet && !request?.infoHash) {
    const error = new Error('a magnet or infoHash is required');
    error.status = 400;
    throw error;
  }
  if (!request.title) {
    const error = new Error('title is required');
    error.status = 400;
    throw error;
  }

  const magnet = request.magnet || `magnet:?xt=urn:btih:${request.infoHash}`;
  const uploaded = await alldebrid.uploadMagnet(magnet);

  const existing = getJob(uploaded.id);
  if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
    return existing;
  }
  /*
   * A finished job whose file is still there is already the answer. The UI only
   * offers Retry on an error, but the API is reachable directly and the manual
   * "Add torrent" box posts the same magnet - and that used to reset the row to
   * queued and transfer the whole thing a second time.
   */
  if (existing?.status === 'complete' && existing.file_path && fs.existsSync(existing.file_path)) {
    log.info(`already downloaded: ${existing.title} -> ${existing.file_path}`);
    return existing;
  }

  const job = insertJob({
    id: uploaded.id,
    type: request.type === 'episode' || request.type === 'show' ? 'episode' : 'movie',
    title: request.title,
    tmdb_id: request.tmdb_id ?? null,
    // Stored, not just used: reconcileOnBoot rebuilds the destination path from
    // these, and a row without them files a resumed episode under "Season 00".
    year: request.year ?? null,
    season: request.season ?? null,
    episode: request.episode ?? null,
    episode_title: request.episodeTitle ?? null,
    magnet,
    source: request.source || 'torrentio',
    status: 'queued',
    position: nextPosition(listJobs()),
    progress: 0
  });

  queue.push({ id: uploaded.id, request: { ...request, type: job.type } });
  log.info(`queued ${request.title} (torrent ${uploaded.id}, cached: ${uploaded.ready})`);
  pump();

  return job;
}

/** Abort an in-flight download, drop it at AllDebrid, and remove the job row. */
export async function cancelJob(id) {
  const key = String(id);
  const queuedIndex = queue.findIndex((entry) => entry.id === key);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);

  const state = active.get(key);
  if (state) {
    state.controller.abort();
    for (const temp of state.tempPaths) await removeQuietly(temp);
  }

  await alldebrid.deleteMagnet(key);
  const removed = deleteJob(key);
  events.emit('cancelled', { id: key });
  return removed;
}

/**
 * Every job, in the order the queue will run them.
 *
 * The jobs endpoint used to return database order, which is insertion order —
 * fine until anything could be reordered, at which point the list on screen
 * and the order things actually run in disagree.
 */
export function listQueue() {
  return sortQueue(listJobs());
}

/** Ids of jobs currently transferring. */
export function getActive() {
  return Array.from(active.keys());
}

/**
 * The original request, rebuilt from its row.
 *
 * Everything targetPath() needs has to survive a restart, or the re-run lands
 * somewhere else than the run it is replacing: episodeTag(undefined, undefined)
 * is "S00E00" and seasonFolder(undefined) is "Season 00".
 */
export function requestFromJob(job) {
  return {
    type: job.type,
    title: job.title,
    tmdb_id: job.tmdb_id,
    year: job.year ?? null,
    season: job.season ?? null,
    episode: job.episode ?? null,
    episodeTitle: job.episode_title ?? null,
    magnet: job.magnet,
    source: job.source
  };
}

/**
 * On boot, jobs left in 'downloading' are orphans from a previous process.
 * Ones AllDebrid still has ready are re-queued; the rest are marked errored so
 * the Downloads page shows a Retry button instead of a stuck bar.
 */
export async function reconcileOnBoot() {
  const orphans = [...listJobsByStatus('downloading'), ...listJobsByStatus('queued')];
  if (orphans.length === 0) return [];

  log.info(`reconciling ${orphans.length} interrupted job(s)`);
  const outcomes = [];

  for (const job of orphans) {
    try {
      const status = await alldebrid.getTorrentStatus(job.id);
      if (status.failed) {
        updateJob(job.id, { status: 'error', error: `AllDebrid reported: ${status.status}` });
        outcomes.push({ id: job.id, outcome: 'error' });
        continue;
      }
      queue.push({ id: job.id, request: requestFromJob(job) });
      updateJob(job.id, { status: 'queued' });
      outcomes.push({ id: job.id, outcome: 'requeued' });
    } catch (error) {
      updateJob(job.id, { status: 'error', error: error.message });
      outcomes.push({ id: job.id, outcome: 'error' });
    }
  }

  pump();
  return outcomes;
}

export default {
  startDownload, cancelJob, getActive, getLiveProgress, reconcileOnBoot,
  selectFiles, requestFromJob, tempPathFor, streamToFile, events
};
