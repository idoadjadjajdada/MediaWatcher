/**
 * Which downloads are worth interrupting someone for.
 *
 * The desktop app raises these from the job poll rather than from a push
 * service, so "what just finished" is a diff between two polls — and the
 * failure mode of a diff done carelessly is a burst of notifications for
 * downloads that finished last week, every time the app opens.
 *
 * Run: node tests/notify.test.mjs
 */
import { finishedBetween, enabled, inDesktopApp } from '../public/js/notify.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};
const job = (id, status, title = `Job ${id}`) => ({ id, status, title });
const ids = (rows) => rows.map((row) => row.id).join(',');

console.log('\nwhat counts as news');

check('a download that just completed',
  ids(finishedBetween([job(1, 'downloading')], [job(1, 'complete')])) === '1');
check('a download that just failed',
  ids(finishedBetween([job(1, 'downloading')], [job(1, 'error')])) === '1');
check('a queued job that failed without ever running',
  ids(finishedBetween([job(1, 'queued')], [job(1, 'error')])) === '1');
check('two at once',
  ids(finishedBetween([job(1, 'downloading'), job(2, 'downloading')],
    [job(1, 'complete'), job(2, 'error')])) === '1,2');

console.log('\nwhat does not');

check('a job that was already finished when the app opened',
  ids(finishedBetween([job(1, 'complete')], [job(1, 'complete')])) === '');
check('the first poll of a session, which has nothing to compare against',
  ids(finishedBetween([], [job(1, 'complete'), job(2, 'error')])) === '');
check('a job still running', ids(finishedBetween([job(1, 'queued')], [job(1, 'downloading')])) === '');
check('a job that was paused', ids(finishedBetween([job(1, 'downloading')], [job(1, 'paused')])) === '');
check('a job that vanished', ids(finishedBetween([job(1, 'downloading')], [])) === '');
check('nothing at all', ids(finishedBetween()) === '');
/*
 * A retry goes error → queued → complete. The second ending is news again,
 * because the first one was reported as a failure.
 */
check('a retried job ending well is news again',
  ids(finishedBetween([job(1, 'queued')], [job(1, 'complete')])) === '1');
check('but not while it sits in error', ids(finishedBetween([job(1, 'error')], [job(1, 'error')])) === '');

console.log('\noutside the desktop app');

// A browser tab has web push for this and must not be raising its own.
check('there is no desktop shell here', inDesktopApp() === false);
check('so nothing is announced', enabled() === false);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
