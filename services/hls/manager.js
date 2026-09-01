/**
 * HLS sessions: one ffmpeg process producing segments forward from a point.
 *
 * The only file in services/hls that touches the filesystem or spawns anything.
 * Every decision it acts on — which segment to serve, when to restart, what to
 * delete — lives in session.js so it can be tested without an encoder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config, { createLogger } from '../../config/index.js';
import { segmentCount } from './playlist.js';
import { sessionKey, nextAction, completedThrough, segmentsToPrune } from './session.js';
import { buildSegmentArgs, hardwareEncoder } from '../transcoder.js';

const log = createLogger('hls');

/** Live sessions by id. */
const sessions = new Map();

const segmentPath = (session, index) => path.join(session.dir, `${index}.ts`);

/** Segment indices currently on disk. */
function segmentIndices(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => Number.parseInt(name, 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

function killEncoder(session) {
  if (!session.proc) return;
  const proc = session.proc;
  session.proc = null;
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Start (or restart) the encoder at a segment boundary. */
async function startEncoder(session, startSegment) {
  killEncoder(session);

  /*
   * Segments from the previous run are numbered on the same timeline, but the
   * ones at and after the new start point are about to be rewritten. Leaving
   * them would let completedThrough() count a stale file as finished.
   */
  for (const index of segmentIndices(session.dir)) {
    if (index >= startSegment) {
      try { fs.unlinkSync(segmentPath(session, index)); } catch { /* already gone */ }
    }
  }

  session.startSegment = startSegment;
  session.exited = false;

  const encoder = await hardwareEncoder();
  const args = buildSegmentArgs(session.filePath, {
    startSegment,
    outputPattern: path.join(session.dir, '%d.ts'),
    audioIndex: session.audioIndex,
    audioOffset: session.audioOffset,
    tonemap: session.tonemap,
    height: session.sourceHeight,
    maxHeight: session.maxHeight,
    maxrate: session.maxrate,
    encoder
  });

  log.info(`session ${session.id}: encoding from segment ${startSegment}`);
  const proc = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
  session.proc = proc;

  // Nothing reads stdout, and an unread pipe that fills would block ffmpeg.
  proc.stdout?.resume();

  // Kept so a failure can say why. An encoder that dies on startup otherwise
  // shows up only as segments that never arrive.
  let stderrTail = '';
  proc.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (!text) return;
    stderrTail = `${stderrTail}
${text}`.slice(-400);
    log.debug(`session ${session.id}: ${text}`);
  });

  proc.on('error', (error) => {
    log.error(`session ${session.id}: ${error.message}`);
    if (session.proc === proc) {
      session.proc = null;
      session.exited = true;
    }
  });

  proc.on('close', (code) => {
    // Only mark exited when this is still the current process — a restart will
    // have replaced it, and that close belongs to the one we killed.
    if (session.proc !== proc) return;
    session.proc = null;
    session.exited = true;
    /*
     * A non-zero exit here is the difference between "the encoder is still
     * working" and "no segment is ever coming", and it used to be invisible:
     * stderr went to debug, so a failed start looked exactly like a slow one.
     */
    if (code !== 0) {
      log.warn(`session ${session.id}: encoder exited ${code}${stderrTail ? ` -${stderrTail}` : ''}`);
    }
  });
}

/**
 * Create a session, or hand back the running one for an identical request.
 * `spec` carries everything sessionKey hashes plus what the encoder needs.
 */
export async function openSession(spec) {
  const id = sessionKey(spec);
  const existing = sessions.get(id);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const dir = path.join(config.hls.dir, id);
  fs.mkdirSync(dir, { recursive: true });

  const session = {
    id,
    dir,
    filePath: spec.filePath,
    duration: spec.duration,
    count: segmentCount(spec.duration),
    audioIndex: spec.audioIndex,
    audioOffset: spec.audioOffset,
    tonemap: spec.tonemap,
    sourceHeight: spec.sourceHeight,
    maxHeight: spec.maxHeight,
    maxrate: spec.maxrate,
    proc: null,
    startSegment: 0,
    // No encoder has run yet, so nothing is finished and nothing is coming.
    exited: false,
    started: false,
    lastAccess: Date.now()
  };

  sessions.set(id, session);
  // The spec is in the log because two sessions for one file means two
  // different specs, and without this there is no way to see which field
  // differed.
  log.info(`session ${id}: opened for ${path.basename(spec.filePath)} `
    + `(${session.count} segments, quality=${spec.quality} audio=${spec.audioIndex} `
    + `offset=${spec.audioOffset} hevc=${spec.caps?.hevc ? 1 : 0} ac3=${spec.caps?.ac3 ? 1 : 0} `
    + `maxHeight=${spec.maxHeight} maxrate=${spec.maxrate})`);
  return session;
}

export const getSession = (id) => sessions.get(id) || null;

export function touch(id) {
  const session = sessions.get(id);
  if (session) session.lastAccess = Date.now();
}

/** Delete segments far enough behind the play position. */
function prune(session, current) {
  const stale = segmentsToPrune(segmentIndices(session.dir), current, config.hls.keepBehind);
  for (const index of stale) {
    // Never touch what the running encoder is still writing towards; deleting
    // ahead of it would make completedThrough read a gap as the end.
    if (session.proc && index >= session.startSegment) continue;
    try { fs.unlinkSync(segmentPath(session, index)); } catch { /* already gone */ }
  }
}

/**
 * The path to a finished segment, waiting for or restarting the encoder as
 * needed. Resolves null if it never arrives.
 */
/**
 * Move the encoder, but never while another request is already moving it.
 *
 * Two requests for different segments would otherwise kill each other's
 * process in turn and neither would ever produce anything — a livelock that
 * looks exactly like a slow encoder.
 */
async function restartTo(session, index) {
  while (session.restarting) await session.restarting;

  // The winner of that wait may have already moved the encoder somewhere that
  // serves us, in which case moving it again would undo their work.
  if (session.startSegment === index && session.proc) return;

  session.restarting = startEncoder(session, index)
    .finally(() => { session.restarting = null; });
  await session.restarting;
}

/**
 * The path to a finished segment, waiting for or restarting the encoder as
 * needed. Resolves null if it never arrives or the caller goes away.
 *
 * `signal` aborts when the client disconnects. hls.js drops in-flight segment
 * requests on every seek, and without this the abandoned handler keeps looping
 * — and can restart the encoder for a segment nobody is waiting for any more.
 */
export async function requestSegment(id, index, signal) {
  const session = sessions.get(id);
  if (!session) return null;
  if (index < 0 || index >= session.count) return null;

  session.lastAccess = Date.now();

  const deadline = Date.now() + config.hls.segmentTimeoutMs;

  for (;;) {
    if (signal?.aborted) return null;

    // A session that has never encoded anything has nothing to wait for.
    if (!session.started) {
      session.started = true;
      await restartTo(session, index);
      continue;
    }

    const through = completedThrough(segmentIndices(session.dir), session.startSegment, session.exited);
    const action = nextAction({
      requested: index,
      startSegment: session.startSegment,
      producedThrough: through
    });

    if (action === 'serve') {
      const file = segmentPath(session, index);
      /*
       * Existence is not implied by the bookkeeping. Pruning removes segments
       * behind the play position, so a player that re-requests one it has
       * already passed - hls.js does after a buffer flush - would otherwise be
       * handed a path to a deleted file.
       */
      if (!fs.existsSync(file)) {
        /*
         * The bookkeeping says produced, the file says otherwise: it was
         * pruned behind the play position and the viewer has come back for it.
         * restartTo is serialised, so concurrent requests for the same gap
         * queue behind one restart rather than each starting their own.
         */
        log.info(`session ${id}: segment ${index} was pruned, re-encoding`);
        await restartTo(session, index);
        continue;
      }
      prune(session, index);
      return file;
    }

    if (action === 'restart') {
      await restartTo(session, index);
      continue;
    }

    // 'wait' — the encoder is heading there.
    if (Date.now() > deadline) {
      log.warn(`session ${id}: segment ${index} timed out`);
      return null;
    }
    // A dead encoder that never reached the segment will never reach it now.
    if (session.exited && index > through) {
      log.warn(`session ${id}: encoder ended before segment ${index}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function destroy(session) {
  killEncoder(session);
  sessions.delete(session.id);
  try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  log.info(`session ${session.id}: reaped`);
}

let sweeper = null;

export function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - config.hls.idleTimeoutMs;
    for (const session of Array.from(sessions.values())) {
      if (session.lastAccess < cutoff) destroy(session);
    }
  }, config.hls.sweepIntervalMs);
  // Must not hold the process open at shutdown.
  sweeper.unref();
}

export function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

/** Kill every session, so no ffmpeg outlives the server. */
export function shutdownAll() {
  stopSweeper();
  for (const session of Array.from(sessions.values())) destroy(session);
}

/**
 * Anything left in cache/hls from a previous run is orphaned: the encoders that
 * owned those directories died with that process, so the segments belong to
 * sessions that no longer exist.
 */
export function clearOrphans() {
  try {
    fs.rmSync(config.hls.dir, { recursive: true, force: true });
  } catch { /* best effort */ }
  fs.mkdirSync(config.hls.dir, { recursive: true });
}

/** Live session count. Exposed for tests and diagnostics. */
export const activeCount = () => sessions.size;

export default {
  openSession, getSession, requestSegment, touch, activeCount,
  startSweeper, stopSweeper, shutdownAll, clearOrphans
};
