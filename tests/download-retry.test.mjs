/**
 * Asking for something already downloaded does not download it again.
 *
 * The UI only offers Retry on a failed job, but the API is reachable directly
 * and the manual "Add torrent" box posts the same magnet — and that used to
 * push a completed row back to `queued` and transfer the whole file a second
 * time. Nothing about the result looked wrong; it just cost the bandwidth and
 * the wait all over again.
 *
 * Runs against a stub AllDebrid on loopback, which is what
 * `ALLDEBRID_BASE_URL` exists for. Nothing here reaches the real service.
 *
 * Run: node tests/download-retry.test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TORRENT_ID = '990002';
const calls = [];

/*
 * Every call the download path can make. `magnet/status` answers with a
 * terminal failure so that a job which *is* re-queued dies immediately instead
 * of starting a transfer inside a unit test.
 */
const stub = http.createServer((req, res) => {
  calls.push(req.url.split('?')[0]);
  let body = { status: 'success', data: {} };

  if (req.url.startsWith('/magnet/upload')) {
    body.data = { magnets: [{ id: TORRENT_ID, hash: 'abc', name: 'Test', size: 1, ready: true }] };
  } else if (req.url.startsWith('/magnet/status')) {
    body.data = { magnets: [{ id: TORRENT_ID, status: 'Error', statusCode: 6, size: 1 }] };
  } else if (req.url.startsWith('/magnet/delete')) {
    body.data = { message: 'deleted' };
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
});

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
process.env.ALLDEBRID_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

const { startDownload, cancelJob } = await import('../services/downloader.js');
const { insertJob, getJob, deleteJob } = await import('../db/index.js');
const { default: config } = await import('../config/index.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const magnet = 'magnet:?xt=urn:btih:abc';
const finished = path.join(config.tempPath, 'retry-test-finished.mkv');
fs.writeFileSync(finished, 'x');

const seedCompleted = (filePath) => {
  deleteJob(TORRENT_ID);
  insertJob({
    id: TORRENT_ID,
    type: 'movie',
    title: 'Test',
    magnet,
    source: 'torrentio',
    status: 'complete',
    progress: 1,
    file_path: filePath
  });
};

/* -------------------------------------------------------------------------
 * the file is still there
 * ---------------------------------------------------------------------- */
console.log('\na completed job whose file exists');

seedCompleted(finished);
const again = await startDownload({ magnet, title: 'Test', type: 'movie' });

check('the completed row is handed back as it is', again.status === 'complete');
check('with its file path intact', again.file_path === finished);
check('the row was not reset to queued', getJob(TORRENT_ID).status === 'complete');
check('progress was not rewound', getJob(TORRENT_ID).progress === 1);
// The one call it should make is the upload, because that is where the torrent
// id comes from; nothing past it should have run.
check('no transfer was started', !calls.some((url) => url.startsWith('/magnet/status')));

/* -------------------------------------------------------------------------
 * the file is gone
 * ---------------------------------------------------------------------- */
console.log('\na completed job whose file was deleted');

const missing = path.join(config.tempPath, 'retry-test-missing.mkv');
fs.rmSync(missing, { force: true });
seedCompleted(missing);

const requeued = await startDownload({ magnet, title: 'Test', type: 'movie' });
check('it is queued again', requeued.status === 'queued');

// The stub reports the torrent as failed, so the job settles as an error rather
// than transferring anything. Give it a tick to get there.
await new Promise((resolve) => setTimeout(resolve, 300));
check('and the run actually started', calls.some((url) => url.startsWith('/magnet/status')));

await cancelJob(TORRENT_ID).catch(() => {});
deleteJob(TORRENT_ID);
check('the test row is cleaned up', getJob(TORRENT_ID) === undefined);

fs.rmSync(finished, { force: true });
await new Promise((resolve) => stub.close(resolve));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
