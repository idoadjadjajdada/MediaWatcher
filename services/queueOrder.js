/**
 * The order downloads come off the queue in, and the moves that change it.
 *
 * Separated from the downloader because the downloader owns network sockets,
 * temp files and an AllDebrid session, and none of that is needed to answer
 * "what runs next" — which is the part with the edge cases.
 *
 * Order is an explicit `position`, lowest first, maintained by the server.
 * The first design used a priority number with age as the tie-break, and it
 * could not express "move down one place" at all: when the neighbours share a
 * priority, the only way past one of them is to go below the whole band, so
 * pressing ↓ once sent a job to the bottom. A position that moves by swapping
 * with its neighbour does exactly what the arrow says.
 *
 * Jobs from before this existed have no position; they fall back to `created_at`
 * and sort after everything explicitly placed, which is where an unordered
 * backlog belongs.
 *
 * Paused entries keep their place and are simply never selected. A pause that
 * also lost your position would make pausing something you avoid doing.
 */

/** Waiting, in either sense — these are the jobs the ordering applies to. */
const WAITING = new Set(['queued', 'paused']);

const rank = (job) => {
  const position = Number(job?.position);
  return Number.isFinite(position) ? position : Number.POSITIVE_INFINITY;
};

/** Ascending by what runs next. */
export function compareJobs(a, b) {
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA - rankB;

  const atA = Number(a?.created_at) || 0;
  const atB = Number(b?.created_at) || 0;
  if (atA !== atB) return atA - atB;

  // Two jobs queued in the same millisecond still need a stable order, or the
  // list reshuffles itself between renders for no visible reason.
  return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/** A copy of `jobs` in the order they will run. */
export const sortQueue = (jobs) => [...(jobs || [])].sort(compareJobs);

/** Just the ones the ordering applies to, in order. */
export const waitingJobs = (jobs) => sortQueue(jobs).filter((job) => WAITING.has(job?.status));

/** Is this job eligible to be started? */
export const isRunnable = (job) => job?.status === 'queued';

/**
 * The next job to start, or null.
 *
 * Paused and errored jobs are skipped rather than stopping the scan: a paused
 * item at the head must not block everything behind it, which is the
 * difference between pausing one download and pausing all of them.
 */
export function nextRunnable(jobs) {
  return sortQueue(jobs).find(isRunnable) || null;
}

/** The position a newly queued job takes: the back of the line. */
export function nextPosition(jobs) {
  const positions = (jobs || []).map(rank).filter(Number.isFinite);
  return positions.length === 0 ? 0 : Math.max(...positions) + 1;
}

/**
 * Position updates that move `id` one place, to the top, or to the bottom.
 *
 * Returns a list of `{ id, position }` to write, or an empty list when the
 * move is impossible — the job is not waiting, or it is already at that end.
 * A list rather than a single value because a swap necessarily touches two
 * rows, and applying half of one would corrupt the order.
 */
export function moveJob(jobs, id, move) {
  const waiting = waitingJobs(jobs);
  const index = waiting.findIndex((job) => String(job.id) === String(id));
  if (index === -1) return [];

  /*
   * Positions are normalised to 0..n-1 first. Legacy rows have none at all,
   * and a swap between a numbered row and an unnumbered one has nothing to
   * exchange — so the move writes a complete, dense order every time.
   */
  const order = waiting.map((job) => String(job.id));

  let target;
  if (move === 'up') target = index - 1;
  else if (move === 'down') target = index + 1;
  else if (move === 'top') target = 0;
  else if (move === 'bottom') target = order.length - 1;
  else return [];

  if (target < 0 || target >= order.length || target === index) return [];

  const [moved] = order.splice(index, 1);
  order.splice(target, 0, moved);

  // Only the rows whose position actually changes are written back.
  const updates = [];
  order.forEach((jobId, position) => {
    const before = waiting.find((job) => String(job.id) === jobId);
    if (rank(before) !== position) updates.push({ id: jobId, position });
  });
  return updates;
}

/** Which transitions are allowed, and what they mean. */
export const TRANSITIONS = {
  // A queued job simply stops being eligible; an active one has to be aborted
  // first, which is the downloader's job rather than this module's.
  pause: { from: ['queued', 'downloading'], to: 'paused' },
  resume: { from: ['paused'], to: 'queued' },
  // Retry is for something that failed. Re-running a completed job would
  // re-download a file that is already on disk.
  retry: { from: ['error'], to: 'queued' }
};

/**
 * Can this job take this action?
 *
 * Answers a reason rather than a bare false, because the API returns it and
 * "already downloading" is a different problem from "no such job".
 */
export function canTransition(job, action) {
  const rule = TRANSITIONS[action];
  if (!rule) return { ok: false, reason: `unknown action "${action}"` };
  if (!job) return { ok: false, reason: 'no such job' };
  if (!rule.from.includes(job.status)) {
    return { ok: false, reason: `cannot ${action} a job that is ${job.status}` };
  }
  return { ok: true, status: rule.to };
}

export default {
  compareJobs, sortQueue, waitingJobs, isRunnable, nextRunnable,
  nextPosition, moveJob, canTransition, TRANSITIONS
};
