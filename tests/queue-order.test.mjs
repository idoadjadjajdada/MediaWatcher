/**
 * Download queue ordering.
 *
 * Two bugs shaped this module.
 *
 * The first: a paused job at the head of the queue must not stop everything
 * behind it. That would turn "pause this one" into "pause all of them", and it
 * looks exactly like the downloader having hung.
 *
 * The second is why order is a position rather than a priority number. The
 * first version ranked by priority with age as the tie-break, and it could not
 * express "move down one place" at all: when neighbours share a priority the
 * only way past one of them is to drop below the entire band, so pressing ↓
 * once sent a job to the bottom. The test below is the one that caught it.
 *
 * Run: node tests/queue-order.test.mjs
 */
import {
  compareJobs, sortQueue, waitingJobs, nextRunnable, nextPosition, moveJob, canTransition
} from '../services/queueOrder.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const job = (id, over = {}) => ({ id, status: 'queued', created_at: 1000, ...over });
const ids = (list) => list.map((entry) => entry.id).join(',');

/** Apply what moveJob returned, the way the caller would. */
const apply = (jobs, updates) => jobs.map((entry) => {
  const update = updates.find((u) => String(u.id) === String(entry.id));
  return update ? { ...entry, position: update.position } : entry;
});

const line = [
  job('a', { position: 0, created_at: 1000 }),
  job('b', { position: 1, created_at: 2000 }),
  job('c', { position: 2, created_at: 3000 })
];

console.log('\nordering');
check('position decides the order', ids(sortQueue(line)) === 'a,b,c');
check('a lower position runs sooner',
  ids(sortQueue([job('x', { position: 5 }), job('y', { position: 2 })])) === 'y,x');
// Rows from before positions existed fall back to age, behind everything placed.
check('unpositioned jobs fall back to age',
  ids(sortQueue([job('old', { created_at: 1 }), job('new', { created_at: 9 })])) === 'old,new');
check('and sort after anything explicitly placed',
  ids(sortQueue([job('legacy', { created_at: 1 }), job('placed', { position: 9, created_at: 99 })])) === 'placed,legacy');
check('sorting does not mutate the input', ids(line) === 'a,b,c');

const sameMs = [job('z', { created_at: 1000 }), job('y', { created_at: 1000 })];
check('a tie is broken deterministically', ids(sortQueue(sameMs)) === 'y,z');
check('and the same way every time', ids(sortQueue(sameMs)) === ids(sortQueue([...sameMs].reverse())));
check('an empty list sorts to nothing', sortQueue([]).length === 0);
check('a null list is handled', sortQueue(null).length === 0);
check('compareJobs orders a pair directly',
  compareJobs(job('a', { position: 1 }), job('b', { position: 2 })) < 0);

console.log('\nwhat counts as waiting');
const mixedStatus = [
  job('q', { position: 0 }),
  job('p', { position: 1, status: 'paused' }),
  job('d', { position: 2, status: 'downloading' }),
  job('e', { position: 3, status: 'error' }),
  job('done', { position: 4, status: 'complete' })
];
check('queued and paused are waiting', ids(waitingJobs(mixedStatus)) === 'q,p');
check('downloading, errored and complete are not', waitingJobs(mixedStatus).length === 2);

console.log('\npicking what runs next');
check('the front of the queue runs', nextRunnable(line)?.id === 'a');
// The bug this module exists to prevent.
check('a paused job at the head does not block the rest',
  nextRunnable([job('a', { position: 0, status: 'paused' }), job('b', { position: 1 })])?.id === 'b');
check('an errored job is skipped too',
  nextRunnable([job('a', { position: 0, status: 'error' }), job('b', { position: 1 })])?.id === 'b');
check('a downloading job is not started again',
  nextRunnable([job('a', { position: 0, status: 'downloading' }), job('b', { position: 1 })])?.id === 'b');
check('a completed job is never runnable',
  nextRunnable([job('a', { status: 'complete' })]) === null);
check('nothing runnable answers null',
  nextRunnable([job('a', { status: 'paused' }), job('b', { status: 'error' })]) === null);
check('an empty queue answers null', nextRunnable([]) === null);

console.log('\nwhere a new job lands');
check('a new job goes to the back', nextPosition(line) === 3);
check('the first job takes position zero', nextPosition([]) === 0);
check('legacy rows do not confuse it', nextPosition([job('legacy')]) === 0);
check('and a mix takes the highest placed', nextPosition([job('legacy'), job('x', { position: 7 })]) === 8);

console.log('\nmoving');
// The case the priority design got wrong: one place, not to the end.
const downA = apply(line, moveJob(line, 'a', 'down'));
check('moving down goes exactly one place', ids(sortQueue(downA)) === 'b,a,c', ids(sortQueue(downA)));

const upC = apply(line, moveJob(line, 'c', 'up'));
check('moving up goes exactly one place', ids(sortQueue(upC)) === 'a,c,b', ids(sortQueue(upC)));

const topC = apply(line, moveJob(line, 'c', 'top'));
check('to the top jumps the whole queue', ids(sortQueue(topC)) === 'c,a,b');

const bottomA = apply(line, moveJob(line, 'a', 'bottom'));
check('to the bottom does too', ids(sortQueue(bottomA)) === 'b,c,a');

check('the first cannot move up', moveJob(line, 'a', 'up').length === 0);
check('the last cannot move down', moveJob(line, 'c', 'down').length === 0);
check('the first is already at the top', moveJob(line, 'a', 'top').length === 0);
check('the last is already at the bottom', moveJob(line, 'c', 'bottom').length === 0);
check('an unknown id does not move', moveJob(line, 'nope', 'up').length === 0);
check('an unknown move is refused', moveJob(line, 'a', 'sideways').length === 0);

// Only what actually changed is written back.
check('a swap writes exactly two rows', moveJob(line, 'a', 'down').length === 2);
check('a move to the top writes only what shifted',
  moveJob(line, 'c', 'top').length === 3);

console.log('\nmoving around a paused job');
const withPaused = [
  job('a', { position: 0 }),
  job('p', { position: 1, status: 'paused' }),
  job('b', { position: 2 })
];
const movedPastPause = apply(withPaused, moveJob(withPaused, 'b', 'up'));
check('a paused job holds its place in the ordering',
  ids(waitingJobs(movedPastPause)) === 'a,b,p', ids(waitingJobs(movedPastPause)));
check('and the queue still runs the right job next',
  nextRunnable(movedPastPause)?.id === 'a');

// A running job is not part of the ordering at all.
check('a downloading job cannot be reordered',
  moveJob([job('d', { position: 0, status: 'downloading' }), job('q', { position: 1 })], 'd', 'down').length === 0);

console.log('\nrepeated moves settle');
let queue = line;
for (let i = 0; i < 3; i += 1) queue = apply(queue, moveJob(queue, 'a', 'down'));
check('moving past the end is a no-op, not a corruption',
  ids(sortQueue(queue)) === 'b,c,a', ids(sortQueue(queue)));
check('positions stay dense after several moves',
  waitingJobs(queue).every((entry, index) => entry.position === index),
  waitingJobs(queue).map((e) => e.position));

console.log('\ntransitions');
check('a queued job can be paused', canTransition(job('a'), 'pause').ok === true);
check('and becomes paused', canTransition(job('a'), 'pause').status === 'paused');
check('a downloading job can be paused',
  canTransition(job('a', { status: 'downloading' }), 'pause').ok === true);
check('a paused job can be resumed', canTransition(job('a', { status: 'paused' }), 'resume').ok === true);
check('a queued job cannot be resumed', canTransition(job('a'), 'resume').ok === false);
check('an errored job can be retried', canTransition(job('a', { status: 'error' }), 'retry').ok === true);
// Retrying something finished would re-download a file already on disk.
check('a completed job cannot be retried',
  canTransition(job('a', { status: 'complete' }), 'retry').ok === false);
check('a completed job cannot be paused',
  canTransition(job('a', { status: 'complete' }), 'pause').ok === false);
check('the refusal explains itself',
  /complete/.test(canTransition(job('a', { status: 'complete' }), 'pause').reason));
check('a missing job is refused by name', canTransition(null, 'pause').reason === 'no such job');
check('an unknown action is refused', canTransition(job('a'), 'explode').ok === false);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
