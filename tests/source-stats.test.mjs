/**
 * Search source history.
 *
 * The point of keeping it is to separate three failures that look identical
 * from inside one search: a source that errors, a source that is cut off by
 * the timeout, and a source that answers quickly and returns nothing every
 * time. The last is the one nobody notices.
 *
 * Run: node tests/source-stats.test.mjs
 */
import { percentile, summarise } from '../services/sourceStats.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\npercentiles');

const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
check('median of ten', percentile(ten, 0.5) === 50);
check('p95 of ten', percentile(ten, 0.95) === 100);
check('order does not matter', percentile([50, 10, 30], 0.5) === 30);
check('a single value is its own median', percentile([7], 0.5) === 7);
check('nothing has no percentile', percentile([], 0.5) === null);
check('undefined is not a crash', percentile(undefined, 0.5) === null);

/*
 * The reason for a percentile rather than a mean: one twenty-second timeout
 * among nine fast answers drags a mean to 2.2s, describing neither the usual
 * case nor the bad one.
 */
const withTail = [100, 110, 120, 130, 140, 150, 160, 170, 180, 20000];
check('a long tail does not move the median', percentile(withTail, 0.5) === 140);
check('but the p95 sees it', percentile(withTail, 0.95) === 20000);

console.log('\nsummarising a window');

const run = (over = {}) => ({ at: 1, ok: true, ms: 100, count: 5, error: null, ...over });

{
  const summary = summarise({ label: 'Torrentio', runs: [run(), run({ ms: 300 }), run({ ms: 200 })] });
  check('counts the searches', summary.searches === 3);
  check('nothing failed', summary.failed === 0);
  check('reports the median', summary.medianMs === 200);
  check('reports results per search', summary.resultsPerSearch === 5);
  check('carries the label', summary.label === 'Torrentio');
}

{
  // A timeout and an error are both failures, and only one is a reason to
  // raise SEARCH_SOURCE_TIMEOUT_MS.
  const summary = summarise({
    label: 'Jackett',
    runs: [
      run(),
      run({ ok: false, error: 'Jackett timed out after 20000ms' }),
      run({ ok: false, error: 'connect ECONNREFUSED' })
    ]
  });
  check('counts every failure', summary.failed === 2);
  check('separates the timeouts', summary.timedOut === 1);
  check('keeps the most recent reason', summary.lastError === 'connect ECONNREFUSED');
  // Timings come from the runs that answered; a timeout has no useful duration.
  check('times only the successes', summary.medianMs === 100);
}

{
  // The quiet failure: never an error, never a result.
  const summary = summarise({ label: 'Dead source', runs: [run({ count: 0 }), run({ count: 0 })] });
  check('nothing failed', summary.failed === 0);
  check('but every search was empty', summary.empty === 2);
  check('and it contributes nothing', summary.resultsPerSearch === 0);
}

check('a source with no history summarises to nothing',
  summarise({ label: 'New', runs: [] }) === null);
check('and neither does an absent one', summarise(undefined) === null);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
