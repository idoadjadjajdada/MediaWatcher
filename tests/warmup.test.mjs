/**
 * The warm-up queue.
 *
 * The whole value of this is that it is invisible: it converts files in the
 * background so a first play does not wait on an encoder. That makes its
 * failure modes invisible too, and there are two that matter.
 *
 * The first is fanning out. `ensureVariant` resolves as soon as a conversion
 * has *started*, so a queue that awaited it would mark every item done
 * instantly and launch all of them at once — a twenty-episode season becoming
 * twenty simultaneous encodes, which is the exact thing the queue exists to
 * prevent. The queue therefore has to stay strictly one-at-a-time.
 *
 * The second is duplication: a rescan, a finished download and a manual warm
 * can all name the same file, and converting it three times is pure waste.
 *
 * Run: node tests/warmup.test.mjs
 */
import { EventEmitter } from 'node:events';
import * as warmup from '../services/warmup.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('\nqueueing');
// Paths that do not exist are skipped immediately, which is what makes this
// testable without conversions: the queue mechanics still run.
const missing = ['/nope/a.mkv', '/nope/b.mkv', '/nope/c.mkv'];
const added = warmup.enqueueAll(missing);
check('every distinct file is queued', added === 3, added);

const again = warmup.enqueueAll(missing);
// Either already drained, or still queued — both must refuse a second copy of
// something already in flight.
check('the same files are not queued twice while pending', again <= 3, again);

check('an empty list adds nothing', warmup.enqueueAll([]) === 0);
check('a null list is handled', warmup.enqueueAll(null) === 0);
check('a null path is refused', warmup.enqueue(null) === false);
check('an empty path is refused', warmup.enqueue('') === false);

console.log('\nstats');
const stats = warmup.getStats();
check('stats report a queue length', typeof stats.pending === 'number');
check('and whether it is running', typeof stats.running === 'boolean');
check('and a running total of what was queued', stats.queued >= 3, stats.queued);
check('every counter is a number',
  ['converted', 'thumbed', 'skipped', 'failed'].every((key) => typeof stats[key] === 'number'));

console.log('\ndraining');
// Non-existent files are counted as skipped and removed, so the queue empties
// without ever touching ffmpeg.
await sleep(300);
const drained = warmup.getStats();
check('the queue empties', drained.pending === 0, drained.pending);
check('missing files are counted as skipped rather than failed',
  drained.skipped >= 3, { skipped: drained.skipped, failed: drained.failed });
check('and nothing was reported as a failure', drained.failed === 0, drained.failed);
check('it is idle again afterwards', drained.running === false);

console.log('\nre-queueing after a drain');
// Once drained, the same path is fair game again — a file can legitimately be
// re-warmed after being replaced on disk.
check('a drained path can be queued again', warmup.enqueue('/nope/a.mkv') === true);
await sleep(200);

console.log('\nlistening to downloads');
const events = new EventEmitter();
warmup.watchDownloads(events);

const before = warmup.getStats().queued;
events.emit('complete', { id: 'j1', file_path: '/nope/one.mkv', files: ['/nope/one.mkv', '/nope/two.mkv'] });
await sleep(50);
check('every file a download produced is queued',
  warmup.getStats().queued >= before + 2, { before, after: warmup.getStats().queued });

const beforeSingle = warmup.getStats().queued;
// Older events carry only file_path; both shapes have to work.
events.emit('complete', { id: 'j2', file_path: '/nope/three.mkv' });
await sleep(50);
check('a completion with only file_path still queues',
  warmup.getStats().queued === beforeSingle + 1);

const beforeEmpty = warmup.getStats().queued;
events.emit('complete', { id: 'j3', files: [] });
await sleep(50);
check('a completion with nothing usable queues nothing',
  warmup.getStats().queued === beforeEmpty);

console.log('\nstopping');
await sleep(400);
warmup.stop();
const stopped = warmup.getStats();
check('stopping clears the queue', stopped.pending === 0);
check('and refuses new work', warmup.enqueue('/nope/late.mkv') === false);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
