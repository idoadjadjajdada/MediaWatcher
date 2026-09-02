/**
 * One budget for every ffmpeg process the app starts.
 *
 * Four things spawn encoders — HLS sessions, MP4 conversions, thumbnail grabs
 * and intro detection — and each used to have its own limit and no idea the
 * others existed. Two viewers plus a background conversion plus a hover was a
 * dozen ffmpeg processes on a machine that can usefully run about four.
 *
 * The two classes are deliberately unequal:
 *
 *   interactive   someone is watching. Takes its slot immediately and never
 *                 queues, because making playback wait for a thumbnail is the
 *                 wrong trade in every case.
 *   background    conversions, thumbnails, intro detection. Waits for room,
 *                 and the room it waits for is what interactive work leaves.
 *
 * So the ceiling can be exceeded, but only by live playback, and only for as
 * long as someone is actually watching.
 */
import config, { createLogger } from '../config/index.js';

const log = createLogger('ffmpeg-pool');

const ceiling = () => Math.max(1, config.ffmpeg.maxProcesses);

let interactive = 0;
let background = 0;

/** Resolvers for background work waiting on a slot, oldest first. */
const waiting = [];

const inUse = () => interactive + background;

/** Hand slots to whoever has been waiting longest, while there is room. */
function drain() {
  while (waiting.length > 0 && inUse() < ceiling()) {
    const next = waiting.shift();
    background += 1;
    next();
  }
}

function releaseBackground() {
  background = Math.max(0, background - 1);
  drain();
}

/**
 * Take a slot for live playback. Never waits: an encoder a viewer is blocked
 * on is not something to queue behind a thumbnail job.
 *
 * Returns the release function, which is safe to call more than once.
 */
export function reserveInteractive() {
  interactive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    interactive = Math.max(0, interactive - 1);
    drain();
  };
}

/**
 * Wait for a slot for background work, then take it.
 *
 * Returns the release function, which the caller MUST call — in a `finally`,
 * not on the success path — or the budget leaks a slot per job.
 */
export function acquire(label = 'background') {
  if (inUse() < ceiling()) {
    background += 1;
    return Promise.resolve(makeRelease());
  }

  log.debug(`${label} waiting for an ffmpeg slot (${inUse()}/${ceiling()} in use)`);
  return new Promise((resolve) => {
    waiting.push(() => resolve(makeRelease()));
  });
}

function makeRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseBackground();
  };
}

/** Run `fn` holding a background slot, releasing it however `fn` ends. */
export async function withSlot(label, fn) {
  const release = await acquire(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Current occupancy. Exposed for diagnostics and tests. */
export const stats = () => ({
  ceiling: ceiling(),
  interactive,
  background,
  waiting: waiting.length
});

/* --------------------------------------------------------------------------
 * The register of what is actually running
 *
 * The counters above are enough to enforce the budget and useless for
 * answering "why is this machine busy". Four counts of anonymous work do not
 * say which file, on whose behalf, or how fast — so a conversion pinning the
 * CPU and a stalled encoder producing nothing look identical from outside.
 *
 * Registration is separate from acquire() because the process does not exist
 * until after a slot is taken, and a slot that is never spawned against is
 * still a slot.
 * ----------------------------------------------------------------------- */

/** Everything ffmpeg is running right now, by id. */
const running = new Map();
let nextId = 1;

/**
 * Record a spawned process, and stop recording it when it ends.
 *
 * Returns a handle: `progress` folds in whatever the caller learns as it goes
 * (a realtime factor, how far into the file it has reached), and `done` drops
 * the entry for a caller that has something to say about the ending. Closing
 * is wired up here too, so a caller that forgets cannot leak a phantom.
 */
export function register({ kind, label, filePath = null, detail = null, proc = null }) {
  const id = String(nextId);
  nextId += 1;

  const entry = {
    id,
    kind,
    label,
    filePath,
    detail,
    startedAt: Date.now(),
    // Filled in by whoever is reading the encoder's progress, if anyone is.
    speed: null,
    outSeconds: null,
    proc
  };
  running.set(id, entry);

  const done = () => { running.delete(id); };
  proc?.once('close', done);
  proc?.once('error', done);

  return {
    id,
    progress: (fields) => Object.assign(entry, fields),
    detail: (value) => { entry.detail = value; },
    done
  };
}

/**
 * What is running, oldest first, without the process handles.
 *
 * The handle is deliberately not in the payload: this is serialised straight
 * into an API response, and a ChildProcess is neither JSON nor anyone's
 * business outside this module.
 */
export function listRunning(now = Date.now()) {
  return Array.from(running.values())
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(({ proc, ...entry }) => ({
      ...entry,
      pid: proc?.pid ?? null,
      elapsedSeconds: Math.max(0, (now - entry.startedAt) / 1000)
    }));
}

/**
 * Stop one process by id. True if there was one to stop.
 *
 * SIGKILL rather than a polite signal: every one of these is restartable by
 * design — an HLS session re-encodes from wherever the viewer is, a conversion
 * is retried on the next play — so there is nothing to flush and nothing that
 * benefits from being asked twice.
 */
export function killRunning(id) {
  const entry = running.get(String(id));
  if (!entry) return false;
  try { entry.proc?.kill('SIGKILL'); } catch { /* already gone */ }
  running.delete(String(id));
  log.info(`killed ${entry.kind} ${entry.label} on request`);
  return true;
}

/** Drop every entry. Tests only — the real register empties itself. */
export const resetRegister = () => running.clear();

export default {
  reserveInteractive, acquire, withSlot, stats,
  register, listRunning, killRunning, resetRegister
};
