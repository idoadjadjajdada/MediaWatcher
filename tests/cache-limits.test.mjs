/**
 * The two ceilings nothing used to enforce: disk held by the caches, and
 * ffmpeg processes running at once.
 *
 * Both are pure decision functions on purpose — the alternative is a test that
 * fills a disk or starts a dozen encoders to find out what happens.
 *
 * Run: node tests/cache-limits.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { planEviction, sweepRoot, measure, markUsed } from '../services/cacheSweeper.js';
import { reserveInteractive, acquire, stats } from '../services/ffmpegPool.js';
import { shouldGenerate, RETRY_AFTER_MS } from '../services/thumbnails.js';
import { formatBytes } from '../services/diskspace.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const GB = 1024 ** 3;
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const entry = (name, bytes, ageDays, busy = false) =>
  ({ path: name, bytes, usedAt: NOW - ageDays * DAY, busy });

/* -------------------------------------------------------------------------
 * cache eviction
 * ---------------------------------------------------------------------- */
console.log('\nplanEviction — the budget');

const limits = { maxBytes: 10 * GB, ttlMs: 30 * DAY, now: NOW };

const underBudget = planEviction([entry('a', 2 * GB, 1), entry('b', 3 * GB, 2)], limits);
check('a cache inside its budget loses nothing', underBudget.length === 0);

const overBudget = planEviction([
  entry('oldest', 4 * GB, 9),
  entry('middle', 4 * GB, 5),
  entry('newest', 4 * GB, 1)
], limits);
check('an over-budget cache evicts', overBudget.length === 1);
check('and evicts the least recently used first', overBudget[0] === 'oldest');

const wayOver = planEviction([
  entry('oldest', 6 * GB, 9),
  entry('middle', 6 * GB, 5),
  entry('newest', 6 * GB, 1)
], limits);
check('it keeps going until it is under', wayOver.length === 2);
check('the most recently used survives', !wayOver.includes('newest'));

console.log('\nplanEviction — the TTL');

const stale = planEviction([entry('ancient', 1 * GB, 90), entry('fresh', 1 * GB, 2)], limits);
check('anything past the TTL goes even with room to spare', stale.length === 1 && stale[0] === 'ancient');

console.log('\nplanEviction — what is off limits');

/*
 * A conversion writes to a .part file for the length of an encode, which is
 * long enough for the sweeper to run more than once. Evicting one deletes the
 * output from under a running ffmpeg.
 */
const busy = planEviction([entry('converting', 40 * GB, 9, true)], limits);
check('a directory with a conversion in it is never evicted', busy.length === 0);

// Written moments ago: very likely the thing someone is waiting for.
const young = planEviction([entry('just-made', 40 * GB, 0)], { ...limits, graceMs: 5 * 60 * 1000 });
check('a directory written moments ago is never evicted', young.length === 0);

console.log('\nformatBytes');
check('bytes stay bytes', formatBytes(512) === '512 B');
check('gigabytes read as gigabytes', formatBytes(2.5 * GB) === '2.5 GB');
check('unmeasurable is not a number', formatBytes(null) === 'unknown');

/* -------------------------------------------------------------------------
 * sweeping a real directory
 *
 * planEviction decides; this is the part that actually deletes, and it deletes
 * whole directories, so it is worth watching do it once.
 * ---------------------------------------------------------------------- */
console.log('\nsweepRoot');

const root = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'mw-cache-test-'));
const oldEnough = Date.now() - 60 * 60 * 1000;

const makeEntry = (name, bytes, { partial = false, aged = true } = {}) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, partial ? 'copy.mp4.part' : 'copy.mp4'), Buffer.alloc(bytes, 1));
  if (aged) fs.utimesSync(dir, new Date(oldEnough), new Date(oldEnough));
  return dir;
};

const cold = makeEntry('cold', 4096);
const warm = makeEntry('warm', 4096);
const converting = makeEntry('converting', 4096, { partial: true });

// Make "warm" the most recently used, which is the whole basis of the ordering.
fs.utimesSync(warm, new Date(), new Date());

const measured = await measure(root);
check('every entry is measured', measured.length === 3);
check('sizes are summed from the files inside', measured.every((item) => item.bytes >= 4096));
check('a conversion in progress is flagged',
  measured.find((item) => item.path === converting)?.busy === true);

// A budget of 5KB with three ~4KB entries: something has to go.
const swept = await sweepRoot(root, { maxBytes: 5000, ttlMs: 0 });
check('it evicts to get under budget', swept.removed >= 1);
check('the least recently used goes first', !fs.existsSync(cold));
check('the most recently used survives', fs.existsSync(warm));
check('a conversion in progress is never deleted', fs.existsSync(converting));
check('it reports what it freed', swept.freed >= 4096);

console.log('\nmarkUsed');
const stamped = makeEntry('stamped', 512);
markUsed(stamped);
await new Promise((resolve) => setTimeout(resolve, 50));
check('a cache hit makes an entry look recent',
  Date.now() - fs.statSync(stamped).mtimeMs < 10_000);

fs.rmSync(root, { recursive: true, force: true });

/* -------------------------------------------------------------------------
 * the shared ffmpeg budget
 * ---------------------------------------------------------------------- */
console.log('\nffmpegPool');

const ceiling = stats().ceiling;
const held = [];

// Fill it with background work.
for (let i = 0; i < ceiling; i += 1) held.push(await acquire('test'));
check('background work fills the budget', stats().background === ceiling);

let extraTaken = false;
const extra = acquire('test-waiter').then((release) => { extraTaken = true; return release; });
await new Promise((resolve) => setTimeout(resolve, 20));
check('background work past the ceiling waits', extraTaken === false);
check('and is counted as waiting', stats().waiting === 1);

/*
 * The rule that matters: someone is watching, so playback takes a slot now.
 * Queueing an encoder behind a thumbnail job is a stall the viewer sees.
 */
const playback = reserveInteractive();
check('playback never waits for a slot', stats().interactive === 1);

// Playback is over the ceiling, so a freed background slot is not free room:
// the budget is still full, and background work stays where it is.
held.pop()();
await new Promise((resolve) => setTimeout(resolve, 20));
check('playback keeps background work waiting', extraTaken === false);

playback();
check('playback gives its slot back', stats().interactive === 0);

held.push(await extra);
check('a released slot goes to whoever waited longest', extraTaken === true);

for (const release of held) release();
check('everything is handed back', stats().background === 0 && stats().waiting === 0);

// Releasing twice is a mistake the callers can make in a finally; it must not
// hand out a slot that was never taken.
const once = await acquire('test');
once();
once();
check('a double release does not inflate the budget', stats().background === 0);

/* -------------------------------------------------------------------------
 * thumbnail retries
 * ---------------------------------------------------------------------- */
console.log('\nshouldGenerate');

check('a fresh file generates', shouldGenerate({ count: 0, total: 100, running: false, attempt: null }));
check('a complete set does not', !shouldGenerate({ count: 100, total: 100, running: false, attempt: null }));
check('a running job is not started twice', !shouldGenerate({ count: 0, total: 100, running: true, attempt: null }));

/*
 * The bug: `count < total` stays true forever for a file whose frames cannot be
 * grabbed, so every hover re-kicked the whole remaining job.
 */
const gaveUp = { reached: 12, at: NOW };
check('a job that gave up is not restarted on the next hover',
  !shouldGenerate({ count: 12, total: 100, running: false, attempt: gaveUp, now: NOW + 1000 }));
check('but it is retried eventually',
  shouldGenerate({ count: 12, total: 100, running: false, attempt: gaveUp, now: NOW + RETRY_AFTER_MS + 1 }));
check('and immediately if frames have appeared since',
  shouldGenerate({ count: 30, total: 100, running: false, attempt: gaveUp, now: NOW + 1000 }));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
