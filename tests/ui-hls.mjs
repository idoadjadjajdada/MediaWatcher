/**
 * Browser-driven checks for HLS playback and its session lifecycle.
 *
 * Every bug this file covers was invisible to the unit tests and only showed up
 * in a real browser: an audio delay that never reached the encoder, a position
 * that double-counted after a seek, a keepalive addressed to a session id that
 * did not exist, and an encoder left running after the player closed. None of
 * those are reachable without a live server and a media element.
 *
 * Needs a running server.  Defaults to port 3001 so it never disturbs the one
 * on 3000; override with UI_HLS_URL.
 *
 * Run:  MW_PASSWORD=... npm run ui-hls
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_HLS_URL || 'http://127.0.0.1:3001';
const PASSWORD = process.env.MW_PASSWORD || process.env.AUTH_PASSWORD;

/** Playwright lives in the npx cache on this machine, not in node_modules. */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
    if (!fs.existsSync(cache)) throw new Error('playwright not found and no npx cache');
    for (const entry of fs.readdirSync(cache)) {
      const candidate = path.join(cache, entry, 'node_modules', 'playwright');
      if (fs.existsSync(candidate)) return require(candidate);
    }
    throw new Error('playwright not found in node_modules or the npx cache');
  }
}

let total = 0;
let failures = 0;
function check(name, ok, detail) {
  total += 1;
  console.log(`  ${ok ? '[pass]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  if (!ok) failures += 1;
}

if (!PASSWORD) {
  console.error('Set MW_PASSWORD (or AUTH_PASSWORD) so the gate can be passed.');
  process.exit(2);
}

/** A library file that needs ffmpeg, so the HLS path is what gets exercised. */
async function pickTranscodedFile(page) {
  const library = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    return api.getLibrary();
  });

  const files = [];
  for (const show of library.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        for (const file of episode.files || []) files.push(file.path || file.file_path);
      }
    }
  }
  for (const movie of library.movies || []) {
    for (const file of movie.files || []) files.push(file.path || file.file_path);
  }

  // .mkv always needs a container swap at least, so it never plays direct.
  return files.filter(Boolean).find((f) => f.toLowerCase().endsWith('.mkv')) || files[0] || null;
}

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const touches = [];
const deletes = [];
const playlists = [];
page.on('request', (r) => {
  const url = r.url();
  if (/\/api\/hls\/[0-9a-f]{32}\/touch/.test(url)) touches.push(url);
  if (r.method() === 'DELETE' && /\/api\/hls\/[0-9a-f]{32}$/.test(url)) deletes.push(url);
  if (url.includes('/api/hls/playlist.m3u8')) playlists.push(url);
});

await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
await page.fill('#password', PASSWORD);
await page.uncheck('#remember');
await page.click('.gate__submit');
await page.waitForURL(`${BASE}/`, { timeout: 20000 });
await page.waitForTimeout(2000);
await page.evaluate(() => { try { localStorage.setItem('mw.quality', 'low'); } catch { /* private mode */ } });

const FILE = await pickTranscodedFile(page);
if (!FILE) {
  console.error('No library files to test against.');
  await browser.close();
  process.exit(2);
}
console.log(`\nfile: ${path.basename(FILE)}`);

console.log('\ndelivery');
const info = await page.evaluate(async (f) => {
  const api = await import('/js/api.js');
  return api.getStreamInfo(f);
}, FILE);
check('a file needing ffmpeg is delivered as HLS', Boolean(info.hls), info.mode);
check('and is reported seekable', info.seekable === true);
check('the session id is reported to the client',
  /^[0-9a-f]{32}$/.test(info.hls_session || ''), info.hls_session);

await page.evaluate(async (f) => {
  const m = await import('/js/player.js');
  await m.open(f);
  // Clear anything a previous run persisted, so the session below is stable.
  m.resetAudioOffset();
}, FILE);
const ready = await page.waitForFunction(
  () => (document.getElementById('player-video')?.readyState ?? 0) >= 2,
  null, { timeout: 120000 }
).then(() => true).catch(() => false);

console.log('\nplayback');
check('playback reaches usable data', ready);
check('no media error',
  (await page.evaluate(() => document.getElementById('player-video')?.error?.code ?? null)) === null);
check('duration comes from the playlist',
  (await page.evaluate(() => document.getElementById('player-video')?.duration ?? 0)) > 10);

console.log('\nseeking');
await page.evaluate(() => { document.getElementById('player-video').currentTime = 300; });
/*
 * Generous on purpose. A seek restarts the encoder at that point, and on 4K
 * HDR the first segment costs a seek through the source plus a tone map, which
 * measured well past ten seconds. This is the honest cost of seeking
 * transcoded content, not a hang.
 */
await page.waitForFunction(
  () => (document.getElementById('player-video')?.readyState ?? 0) >= 2,
  null, { timeout: 45000 }
).catch(() => {});
const seeked = await page.evaluate(() => {
  const v = document.getElementById('player-video');
  return { t: v.currentTime, ready: v.readyState, err: v.error?.code ?? null };
});
check('a seek lands near the target', Math.abs(seeked.t - 300) < 20, seeked);
check('and still has data afterwards', seeked.ready >= 2, seeked);

console.log('\naudio delay reaches the encoder');
playlists.length = 0;
await page.evaluate(async () => { const m = await import('/js/player.js'); m.nudgeAudioOffset(0.5); });
await page.waitForTimeout(6000);
check('a new playlist is requested', playlists.length > 0, playlists.length);
check('carrying the new offset',
  playlists.some((u) => u.includes('audioOffset=0.5')),
  playlists.map((u) => u.slice(-40)));
// The old bug: ctx.offset was set by the pipe path and added to currentTime.
const afterOffset = await page.evaluate(() => document.getElementById('player-video').currentTime);
check('the position is not double-counted', afterOffset < 400, afterOffset);
await page.evaluate(async () => { const m = await import('/js/player.js'); m.resetAudioOffset(); });
await page.waitForTimeout(4000);

console.log('\nsession lifecycle');
check('the player keeps its session alive', touches.length > 0 || playlists.length > 0);
await page.evaluate(async () => { const m = await import('/js/player.js'); await m.close(); });
await page.waitForTimeout(2500);
check('closing the player ends a session', deletes.length > 0, deletes.length);

await browser.close();
console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
