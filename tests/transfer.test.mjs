/**
 * The transfer half of the download pipeline, against a real HTTP server.
 *
 * Two things are being pinned, and they pull in opposite directions: a link
 * that has gone silent must be given up on, and a link that is merely slow must
 * not be. A download may legitimately take hours, so the watchdog measures
 * silence rather than duration — and getting that wrong in the other direction
 * would cancel long transfers at random, which is worse than the stall.
 *
 * Run: node tests/transfer.test.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Set before the config module is imported, which is why the downloader is
// pulled in dynamically below: dotenv does not overwrite what is already set,
// so this is the whole of the wiring needed to test a two-minute default in
// under a second.
process.env.DOWNLOAD_STALL_TIMEOUT_MS = '700';

const { streamToFile, tempPathFor } = await import('../services/downloader.js');
const { default: config } = await import('../config/index.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const scratch = fs.mkdtempSync(path.join(config.tempPath, 'transfer-test-'));
const cleanup = [];

/**
 * A server whose response body is written by `feed`, so each test decides what
 * "stalled" or "slow" means for its own connection.
 */
function serve(feed) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/x-matroska' });
    feed(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/file.mkv`,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

const chunk = Buffer.alloc(64 * 1024, 7);

/* -------------------------------------------------------------------------
 * a link that goes quiet
 * ---------------------------------------------------------------------- */
console.log('\nstreamToFile — a stalled link');

const stalled = await serve((res) => {
  // Headers, one chunk, then nothing at all — the connection stays open, which
  // is exactly why an overall timeout of zero could never catch this.
  res.write(chunk);
});
cleanup.push(stalled.close);

const stalledPath = path.join(scratch, 'stalled.mkv');
const startedAt = Date.now();
let stallError = null;
try {
  await streamToFile(stalled.url, stalledPath);
} catch (error) {
  stallError = error;
}
const waited = Date.now() - startedAt;

check('a stalled transfer is abandoned', stallError !== null);
check('and says why', /stalled/i.test(stallError?.message || ''));
check('it reports how long it waited', /\d+s/.test(stallError?.message || ''));
// The job used to hold one of the two concurrency slots until someone cancelled
// it by hand; the point of the fix is that it gives the slot back on its own.
check('it gives up promptly, not eventually', waited < 4000);

/* -------------------------------------------------------------------------
 * a link that is just slow
 * ---------------------------------------------------------------------- */
console.log('\nstreamToFile — a slow link');

const slow = await serve((res) => {
  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    res.write(chunk);
    if (sent >= 6) {
      clearInterval(timer);
      res.end();
    }
  }, 250);
});
cleanup.push(slow.close);

const slowPath = path.join(scratch, 'slow.mkv');
let progress = 0;
const result = await streamToFile(slow.url, slowPath, { onBytes: () => { progress += 1; } });

check('a slow but moving transfer is left alone', result.bytes === 6 * chunk.length);
check('every chunk is written', fs.statSync(slowPath).size === 6 * chunk.length);
check('progress is reported as it arrives', progress >= 6);

/* -------------------------------------------------------------------------
 * cancelling
 * ---------------------------------------------------------------------- */
console.log('\nstreamToFile — cancelling');

const forever = await serve((res) => {
  const timer = setInterval(() => res.write(chunk), 50);
  res.on('close', () => clearInterval(timer));
});
cleanup.push(forever.close);

const controller = new AbortController();
setTimeout(() => controller.abort(), 150);

let abortError = null;
try {
  await streamToFile(forever.url, path.join(scratch, 'aborted.mkv'), { signal: controller.signal });
} catch (error) {
  abortError = error;
}
check('an aborted transfer rejects', abortError !== null);
check('and not as a stall', !/stalled/i.test(abortError?.message || ''));

/* -------------------------------------------------------------------------
 * temp names
 * ---------------------------------------------------------------------- */
console.log('\ntempPathFor');

/*
 * Two jobs run at once, and two torrents holding an identically named file is
 * ordinary. They used to write to the same path simultaneously.
 */
const first = tempPathFor('111', 'Episode 1.mkv');
const second = tempPathFor('222', 'Episode 1.mkv');
check('two jobs holding the same filename get different paths', first !== second);
check('the name still carries the filename', first.endsWith('Episode 1.mkv'));
check('and it stays inside the temp directory',
  path.dirname(first) === path.resolve(config.tempPath));
check('a nameless file still gets a path', tempPathFor('333', '', '.mkv').length > 0);
check('path separators in a filename cannot escape',
  path.dirname(tempPathFor('444', '../../evil.mkv')) === path.resolve(config.tempPath));

for (const close of cleanup) await close();
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
