/**
 * Browser-driven checks for the PWA and offline saving.
 *
 * None of this is observable without a real browser. A service worker only
 * exists in one, `caches` only exists in one, and the thing most likely to be
 * quietly wrong — a saved file that plays from the network anyway — looks
 * identical to a working save until you pull the plug.
 *
 * So the last check does pull the plug: the context goes offline and the saved
 * file has to still play.
 *
 * Needs a running server. Defaults to port 3001; override with UI_OFFLINE_URL.
 *
 * Run:  MW_PASSWORD=... node tests/ui-offline.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_OFFLINE_URL || 'http://127.0.0.1:3001';
const PASSWORD = process.env.MW_PASSWORD || process.env.AUTH_PASSWORD;

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

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', PASSWORD);
  await page.uncheck('#remember');
  await page.click('.gate__submit');
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await page.waitForTimeout(2500);

  console.log('\nservice worker');
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  }).catch(() => false);
  check('a worker is registered and active', registered);

  const caches = await page.evaluate(() => window.caches.keys());
  check('the shell cache exists', caches.some((name) => name.startsWith('mw-shell-')), caches);

  const shellCached = await page.evaluate(async () => {
    const cache = await window.caches.open((await window.caches.keys()).find((n) => n.startsWith('mw-shell-')));
    const keys = await cache.keys();
    return keys.map((request) => new URL(request.url).pathname);
  });
  check('the app modules were precached', shellCached.includes('/js/app.js'), shellCached.length);
  check('the manifest was precached', shellCached.includes('/manifest.webmanifest'));
  // Caching a stream would break seeking; caching thumbnails would fill the
  // shell cache with thousands of entries.
  check('nothing streaming was cached',
    !shellCached.some((p) => p.startsWith('/api/stream') || p.startsWith('/api/hls') || p.startsWith('/api/thumbs')),
    shellCached.filter((p) => p.startsWith('/api/')));

  console.log('\nthe manifest is served correctly');
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return { status: response.status, type: response.headers.get('content-type'), body: await response.json() };
  });
  check('it is served', manifest.status === 200);
  check('and parses', manifest.body.name === 'MediaWatcher');
  const icon = await page.evaluate(async () => (await fetch('/icons/icon-512.png')).status);
  check('the icons are served', icon === 200);

  console.log('\npreparing something to save');
  // Deliberately the smallest file: the whole body is downloaded here.
  const target = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    const library = await api.getLibrary();
    const files = [];
    for (const movie of library.movies || []) {
      for (const file of movie.files || []) files.push({ path: file.file_path, size: file.size, title: movie.title });
    }
    for (const show of library.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          for (const file of episode.files || []) {
            files.push({ path: file.file_path, size: file.size, title: `${show.title} ${episode.episode_number}` });
          }
        }
      }
    }
    return files.filter((f) => f.size > 0).sort((a, b) => a.size - b.size)[0] || null;
  });

  if (!target) {
    console.error('No library files to test against.');
    process.exit(2);
  }
  console.log(`  smallest file: ${path.basename(target.path)} (${(target.size / 1e9).toFixed(2)} GB)`);

  const info = await page.evaluate(async (p) => {
    const api = await import('/js/api.js');
    return api.getOfflineInfo(p);
  }, target.path);
  check('the server answers whether it can be saved', typeof info.ready === 'boolean', info);

  if (!info.ready) {
    // Nothing browser-native is cached yet, so a conversion was started. That
    // is the correct answer, not a failure — but the save cannot be exercised.
    check('a not-ready answer explains itself', info.source === 'converting', info);
    console.log('\n  (no browser-native copy cached yet — skipping the download)');
  } else {
    console.log('\nsaving');
    const saved = await page.evaluate(async ({ p, t }) => {
      const offline = await import('/js/offline.js');
      const seen = [];
      const result = await offline.save(p, { title: t, onProgress: ({ ratio }) => seen.push(ratio) });
      return { bytes: result.bytes, progressCount: seen.length, monotonic: seen.every((r, i) => i === 0 || r >= seen[i - 1]) };
    }, { p: target.path, t: target.title });

    check('the file was saved', saved.bytes > 0, saved.bytes);
    check('progress was reported as it went', saved.progressCount > 1, saved.progressCount);
    check('and never went backwards', saved.monotonic);

    const listed = await page.evaluate(async () => {
      const offline = await import('/js/offline.js');
      return offline.listSaved();
    });
    check('it appears in the listing', listed.length === 1, listed.map((e) => e.title));
    check('with its size', listed[0]?.bytes === saved.bytes);
    check('and the title it was given', listed[0]?.title === target.title);

    const isSaved = await page.evaluate(async (p) => {
      const offline = await import('/js/offline.js');
      return { saved: await offline.isSaved(p), url: await offline.playbackUrl(p) };
    }, target.path);
    check('it reports as saved', isSaved.saved === true);
    check('and yields an offline URL', String(isSaved.url).startsWith('/offline-media/'), isSaved.url);

    console.log('\nwith the network down');
    await context.setOffline(true);
    // The saved body must come from the Cache via the worker, not the server.
    const offlineFetch = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return { ok: response.ok, status: response.status, length: Number(response.headers.get('content-length')) || 0 };
    }, isSaved.url);
    check('the saved file is still served', offlineFetch.ok === true, offlineFetch);
    check('at its full length', offlineFetch.length === saved.bytes, offlineFetch.length);
    // Content-Length is what lets the media element scrub rather than only play.
    check('with a length header, so it can be seeked', offlineFetch.length > 0);

    const shellOffline = await page.evaluate(async () => {
      const response = await fetch('/js/app.js');
      return response.ok;
    });
    check('the app shell still loads', shellOffline === true);

    const apiOffline = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/devices');
        return { reached: true, status: response.status };
      } catch {
        return { reached: false };
      }
    });
    // Devices is not cacheable, so it must fail rather than answer stale.
    check('an uncacheable endpoint fails rather than lying', apiOffline.reached === false, apiOffline);

    await context.setOffline(false);

    console.log('\nremoving');
    const removed = await page.evaluate(async (p) => {
      const offline = await import('/js/offline.js');
      await offline.remove(p);
      return { saved: await offline.isSaved(p), listed: (await offline.listSaved()).length };
    }, target.path);
    check('it is gone from the cache', removed.saved === false);
    check('and from the listing', removed.listed === 0);
  }

  console.log('\nthe settings page shows it');
  await page.goto(`${BASE}/#settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.settings', { timeout: 15000 });
  await page.waitForTimeout(2500);
  const headings = await page.$$eval('.settings__heading', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('an Offline group is present', headings.includes('Offline'), headings);
} finally {
  await context.setOffline(false).catch(() => {});
  await browser.close();
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
