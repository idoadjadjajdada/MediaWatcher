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
import { segmentCount, SEGMENT_SECONDS } from './playlist.js';
import {
  sessionKey, contentKey, nextRunSeconds, nextAction, completedThrough, segmentsToPrune
} from './session.js';
import { buildSegmentArgs, hardwareEncoder } from '../transcoder.js';
import * as ffmpegPool from '../ffmpegPool.js';
import { createProgressReader } from '../ffmpegProgress.js';
import * as segmentStore from './segmentStore.js';

const log = createLogger('hls');

/**
 * How many times a session may restart its encoder without producing the
 * segment being asked for, before the request is failed instead.
 *
 * Running out of a bounded encode is normal and restarts are how playback
 * continues, so this has to allow several; an encoder that dies on startup
 * every time must not spin forever.
 */
const MAX_RESTARTS_WITHOUT_PROGRESS = 3;

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
  // Belongs to the run that is starting, not the one that just ended.
  session.exitCode = null;

  /*
   * How much this run produces, which is no longer a constant.
   *
   * Held on the session because the end-of-source test reads it: that test
   * asks whether a run stopped short of its own budget, and comparing against
   * the configured ceiling instead would read every short first run as the end
   * of the file and refuse the rest of the episode.
   */
  session.runSeconds = nextRunSeconds(
    session.completedRuns,
    config.hls.encodeAheadMinSeconds,
    config.hls.encodeAheadSeconds
  );

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
    encoder,
    durationSeconds: session.runSeconds
  });

  log.info(`session ${session.id}: encoding from segment ${startSegment} `
    + `for ${session.runSeconds}s (run ${session.completedRuns + 1})`);
  const proc = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
  session.proc = proc;

  /*
   * On the register for as long as it runs, so the encoder page can name it.
   * The entry removes itself on close, and killing it there is the same as any
   * other end of a run: the next request restarts wherever the viewer is.
   */
  const tracked = ffmpegPool.register({
    kind: 'hls',
    label: `session ${session.id.slice(0, 8)}`,
    filePath: session.filePath,
    detail: `from ${startSegment * SEGMENT_SECONDS}s`,
    proc
  });

  /*
   * Taken, never waited for. Someone is watching this one, so it counts against
   * the shared ffmpeg budget - which is what makes background conversions and
   * thumbnail jobs stand down - but it never queues behind them.
   */
  const releaseSlot = ffmpegPool.reserveInteractive();
  proc.once('close', releaseSlot);
  proc.once('error', releaseSlot);

  /*
   * stdout carries `-progress` output now. It still must be read either way —
   * an unread pipe that fills would block ffmpeg — but reading it is what tells
   * the encoder page how fast this run is going and how far it has reached.
   */
  const readProgress = createProgressReader(({ speed, outSeconds }) => {
    tracked.progress({
      speed,
      // On the file's own timeline, not the run's: -ss rewinds ffmpeg's output
      // clock to zero, so a run starting an hour in would otherwise report
      // itself as being at the opening titles.
      outSeconds: outSeconds === null ? null : outSeconds + (startSegment * SEGMENT_SECONDS)
    });
  });
  proc.stdout?.on('data', readProgress);

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
      // Never zero: a process that failed to start has not reached the end of
      // anything, and the end-of-stream rule keys on a clean exit.
      session.exitCode = -1;
    }
  });

  proc.on('close', (code) => {
    // Only mark exited when this is still the current process — a restart will
    // have replaced it, and that close belongs to the one we killed.
    if (session.proc !== proc) return;
    session.proc = null;
    session.exited = true;
    // Zero means ffmpeg reached the end of what it was asked for. Anything else
    // is a failure, and the two are handled very differently below.
    session.exitCode = code;
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
    /*
     * The same identity without the viewer. Segments are pooled under this, so
     * a second device on the same episode and a seek back into a stretch
     * already encoded both find finished files instead of restarting ffmpeg.
     */
    contentKey: contentKey(spec),
    // Who opened it. The touch and delete routes check this: a session id is
    // visible in the player's diagnostics panel, and without an owner any
    // signed-in device could end any other viewer's stream.
    viewer: spec.viewer,
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
    exitCode: null,
    started: false,
    restartsWithoutProgress: 0,
    /*
     * Consecutive runs that ended by exhausting their budget rather than by a
     * seek — the viewer watching straight through. Each one earns the next run
     * a longer budget; a seek resets it, because a seek is proof the last
     * run's remaining output was encoded for nobody.
     */
    completedRuns: 0,
    runSeconds: config.hls.encodeAheadMinSeconds,
    /*
     * The last segment that actually exists, once the encoder has told us.
     *
     * The playlist is arithmetic on the duration ffprobe reported, and a real
     * encode can end a fraction of a segment short of it. Those trailing
     * segments are unreachable, and without this the player spent its whole
     * retry budget on them and stalled a second before the end.
     */
    endOfStream: null,
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

/**
 * The session with this id, if `viewer` is the one that opened it.
 *
 * Passing no viewer skips the check, which is what the sweeper and shutdown
 * paths do; anything reached from a request must pass one.
 */
function ownedBy(id, viewer) {
  const session = sessions.get(id);
  if (!session) return null;
  if (viewer !== undefined && session.viewer !== viewer) return null;
  return session;
}

export function touch(id, viewer) {
  const session = ownedBy(id, viewer);
  if (session) session.lastAccess = Date.now();
  return Boolean(session);
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
 * Did the run that just ended stop for want of material rather than for want of
 * budget?
 *
 * Only a run that was expected to reach the end of the playlist can answer
 * that. A run is bounded by its own budget, so a run starting in the middle of
 * a long film always stops early and says nothing about where the file ends —
 * and treating that as the end would refuse the whole rest of the episode. A
 * run that had the budget to finish the playlist and did not is the only one
 * whose short output is evidence.
 *
 * The budget is the one *this run* was given, not the configured ceiling. Runs
 * grow as a viewer keeps watching, so reading the ceiling here would judge a
 * short early run against a length it was never asked to produce and call the
 * middle of an episode the end of the file.
 *
 * The evidence itself is a segment count, which is why the question is asked in
 * this narrow form: the segmenter is entitled to fold a short tail into the
 * previous segment, so "fewer files than expected" means "the file ended
 * somewhere around here", not an exact frame.
 */
export function isEndOfSource(session, producedThrough) {
  const runSeconds = session.runSeconds || config.hls.encodeAheadSeconds;
  const budget = Math.ceil(runSeconds / SEGMENT_SECONDS);
  if (session.startSegment + budget < session.count) return false;
  return producedThrough < session.count - 1;
}

/**
 * Move the encoder, but never while another request is already moving it.
 *
 * Two requests for different segments would otherwise kill each other's
 * process in turn and neither would ever produce anything — a livelock that
 * looks exactly like a slow encoder.
 */
async function restartTo(session, index, { continuation = false } = {}) {
  while (session.restarting) await session.restarting;

  // The winner of that wait may have already moved the encoder somewhere that
  // serves us, in which case moving it again would undo their work.
  if (session.startSegment === index && session.proc) return;

  /*
   * A run that ended because it hit its own budget is evidence the viewer is
   * still there; anything else is a seek, and a seek says the last run's
   * remaining output was wasted. That distinction is the whole input to how
   * long the next run is.
   */
  session.completedRuns = continuation ? session.completedRuns + 1 : 0;

  session.restarting = startEncoder(session, index)
    .finally(() => { session.restarting = null; });
  await session.restarting;
}

/**
 * Serve a segment from the pool, if some earlier run left one there.
 *
 * Checked before anything else, so a second viewer on an episode someone has
 * already watched, or a seek back into a stretch this session encoded an hour
 * ago, costs a hard link rather than an encoder restart.
 */
function serveFromPool(session, index) {
  const file = segmentPath(session, index);
  if (!segmentStore.borrow(session.contentKey, index, file)) return null;
  return file;
}

/**
 * The path to a finished segment, waiting for or restarting the encoder as
 * needed. Resolves null if it never arrives or the caller goes away.
 *
 * `signal` aborts when the client disconnects. hls.js drops in-flight segment
 * requests on every seek, and without this the abandoned handler keeps looping
 * — and can restart the encoder for a segment nobody is waiting for any more.
 */
export async function requestSegment(id, index, signal, viewer) {
  const session = ownedBy(id, viewer);
  if (!session) return null;
  if (index < 0 || index >= session.count) return null;
  // Already established that the file ends before here; see `endOfStream`.
  if (session.endOfStream !== null && index > session.endOfStream) return null;

  session.lastAccess = Date.now();

  const deadline = Date.now() + config.hls.segmentTimeoutMs;

  for (;;) {
    if (signal?.aborted) return null;

    /*
     * The pool first, always. A finished segment is a finished segment whoever
     * encoded it, and every path below this costs either a wait or a process.
     * A session that finds everything it needs here never spawns an encoder at
     * all, which is the case where two devices watch the same episode.
     */
    const pooled = serveFromPool(session, index);
    if (pooled) {
      session.restartsWithoutProgress = 0;
      prune(session, index);
      return pooled;
    }

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
      // Real progress: the next stall gets a full set of attempts again.
      session.restartsWithoutProgress = 0;
      /*
       * Into the pool on the way out. `completedThrough` has already
       * established that this segment is finished rather than the one ffmpeg
       * is still writing, which is the only thing that makes it safe to share.
       */
      segmentStore.publish(session.contentKey, index, file);
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
    /*
     * The encoder has stopped short of what was asked for. Normally that is
     * simply the end of its bounded run, so the answer is to start the next one
     * here rather than give up - but a genuinely broken encoder would restart
     * forever, so repeated failures without progress eventually surrender.
     */
    if (session.exited && index > through) {
      /*
       * Did the run that just ended stop because it ran out of file, or because
       * it ran out of its own time budget?
       *
       * A bounded run writes encodeAheadSeconds of video - fifty segments by
       * default - whenever there is that much material left. Fewer than that,
       * on a clean exit, means it reached the end of the source: the playlist is
       * arithmetic on the probed duration, and the real content stopped short of
       * it.
       *
       * Restarting there is not merely futile, it is actively wrong. ffmpeg
       * answers an input seek past the end of an MKV by rewinding to the start
       * and encoding the whole file, so the viewer was served the opening of
       * the film as its final segment. Refusing here is what prevents that.
       */
      if (session.exitCode === 0 && isEndOfSource(session, through)) {
        if (session.endOfStream === null) {
          session.endOfStream = through;
          log.info(`session ${id}: source ends at segment ${through}, `
            + `${session.count - 1 - through} short of the ${session.count} the playlist expects`);
        }
        return null;
      }

      if (session.restartsWithoutProgress >= MAX_RESTARTS_WITHOUT_PROGRESS) {
        log.warn(`session ${id}: giving up on segment ${index} after `
          + `${session.restartsWithoutProgress} restarts that produced nothing`);
        return null;
      }
      session.restartsWithoutProgress += 1;
      /*
       * A clean exit here means the run spent its budget rather than failed,
       * and the viewer is still asking for what comes next — so the next run
       * gets a longer one. A run that died is not evidence of anything.
       */
      await restartTo(session, index, { continuation: session.exitCode === 0 });
      continue;
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

/**
 * End one session now. True if there was one to end.
 *
 * A viewer may only end their own. Someone else's id answers exactly as a
 * made-up one does, which is also why this returns a boolean rather than a
 * 403: whether a stranger's session exists is not something to confirm.
 */
export function endSession(id, viewer) {
  const session = ownedBy(id, viewer);
  if (!session) return false;
  destroy(session);
  return true;
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
  openSession, getSession, requestSegment, touch, endSession, activeCount,
  startSweeper, stopSweeper, shutdownAll, clearOrphans
};
