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

export default { reserveInteractive, acquire, withSlot, stats };
