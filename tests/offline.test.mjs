/**
 * Saving for offline, and the service worker's caching rules.
 *
 * Two classes of bug matter here and neither shows up as an error.
 *
 * The first is caching something that must not be cached. A stale library
 * listing shows episodes you deleted and hides ones you just downloaded; a
 * cached range response corrupts playback. The rules deciding what the worker
 * touches are therefore asserted directly rather than trusted to a comment.
 *
 * The second is a saved file that is not actually saved — an index entry
 * pointing at a Cache the browser has since evicted. Offering to play
 * something that is gone is the worst version of this feature, so the listing
 * reconciles against the Cache rather than believing its own index.
 *
 * Run: node tests/offline.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/* --------------------------------------------------------------------------
 * The service worker's routing rules
 *
 * sw.js runs in a worker scope with no DOM and no module system, so it is read
 * and its two predicates evaluated here rather than imported.
 * ----------------------------------------------------------------------- */

const swSource = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

const extract = (name) => {
  const match = new RegExp(`(?:function ${name}|const ${name} =)([\\s\\S]*?)\\n\\}|(?:const ${name} = )(.*?);`).exec(swSource);
  if (!match) throw new Error(`could not find ${name} in sw.js`);
  return match[0];
};

// eslint-disable-next-line no-new-func
const isPassThrough = new Function(`${extract('isPassThrough')}; return isPassThrough;`)();
// eslint-disable-next-line no-new-func
const isOfflineAsset = new Function(`${extract('isOfflineAsset')}; return isOfflineAsset;`)();

const url = (pathname) => new URL(pathname, 'http://localhost:3000');

console.log('\nthe worker never touches streaming');
// A worker in the middle of a range request breaks seeking rather than
// speeding anything up.
check('stream requests pass through', isPassThrough(url('/api/stream?path=x')) === true);
check('HLS playlists pass through', isPassThrough(url('/api/hls/playlist.m3u8')) === true);
check('HLS segments pass through', isPassThrough(url('/api/hls/abc/3.ts')) === true);
check('the offline file download passes through', isPassThrough(url('/api/offline/file?path=x')) === true);
check('seek thumbnails pass through', isPassThrough(url('/api/thumbs?path=x&i=4')) === true);
check('subtitles pass through', isPassThrough(url('/api/subs?path=x')) === true);

console.log('\nbut it does handle the app');
check('the app shell is not passed through', isPassThrough(url('/js/app.js')) === false);
check('stylesheets are not passed through', isPassThrough(url('/css/styles.css')) === false);
check('the library listing is not passed through', isPassThrough(url('/api/media/library')) === false);
check('the manifest is not passed through', isPassThrough(url('/manifest.webmanifest')) === false);

console.log('\nsaved video has its own namespace');
check('a saved file is recognised', isOfflineAsset(url('/offline-media/C%3A%5Cfilm.mkv')) === true);
check('a normal path is not', isOfflineAsset(url('/js/app.js')) === false);
check('the API is not', isOfflineAsset(url('/api/offline/file?path=x')) === false);

console.log('\ncache policy');
// Saved video must survive a deploy; the shell must not.
check('the shell cache is versioned', /const SHELL_CACHE = `mw-shell-\$\{VERSION\}`/.test(swSource));
check('the offline cache is NOT versioned', /const OFFLINE_CACHE = 'mw-offline'/.test(swSource));
check('activation keeps the offline cache',
  /const keep = new Set\(\[SHELL_CACHE, DATA_CACHE, OFFLINE_CACHE\]\)/.test(swSource));
check('only the library listing is cached from the API',
  /const cacheable = url\.pathname === '\/api\/media\/library'/.test(swSource));
check('non-GET requests are ignored',
  /if \(request\.method !== 'GET'\) return;/.test(swSource));
check('other origins are ignored',
  /if \(url\.origin !== self\.location\.origin\) return;/.test(swSource));
check('install does not fail the batch on one bad entry',
  swSource.includes('cache.add(') && !swSource.includes('cache.addAll('));

console.log('\nthe shell list covers what the app boots from');
const shellList = /const SHELL = \[([\s\S]*?)\];/.exec(swSource)[1];
const listed = Array.from(shellList.matchAll(/'([^']+)'/g)).map((m) => m[1]);
const missingFromDisk = listed
  .filter((entry) => entry !== '/' && entry !== '/index.html')
  .filter((entry) => !fs.existsSync(path.join(ROOT, 'public', entry.replace(/^\//, ''))));
check('every precached file actually exists', missingFromDisk.length === 0, missingFromDisk);

// A module the app imports but the worker does not precache loads from the
// network, so the app half-boots offline instead of failing cleanly.
const appModules = fs.readdirSync(path.join(ROOT, 'public', 'js'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `/js/${name}`);
const notPrecached = appModules.filter((module) => !listed.includes(module));
check('every app module is precached', notPrecached.length === 0, notPrecached);

console.log('\nthe manifest is installable');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
check('it has a name', typeof manifest.name === 'string' && manifest.name.length > 0);
check('it has a start url', manifest.start_url === '/');
check('it is standalone', manifest.display === 'standalone');
// Chrome requires both a 192 and a 512 to consider an app installable.
check('a 192px icon is declared', manifest.icons.some((i) => i.sizes === '192x192'));
check('a 512px icon is declared', manifest.icons.some((i) => i.sizes === '512x512'));
check('a maskable icon is declared', manifest.icons.some((i) => i.purpose === 'maskable'));
check('every declared icon exists',
  manifest.icons.every((i) => fs.existsSync(path.join(ROOT, 'public', i.src.replace(/^\//, '')))));
check('the apple touch icon exists',
  fs.existsSync(path.join(ROOT, 'public', 'icons', 'apple-touch-icon.png')));

console.log('\nthe icons are real PNGs');
for (const name of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  const buffer = fs.readFileSync(path.join(ROOT, 'public', 'icons', name));
  const signature = buffer.subarray(0, 8).toString('hex');
  check(`${name} has a PNG signature`, signature === '89504e470d0a1a0a');
  // Width and height live at bytes 16-24, inside IHDR.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  check(`${name} is square and non-empty`, width === height && width > 0);
}

console.log('\nthe page links it all up');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
check('the manifest is linked', html.includes('rel="manifest"'));
check('a theme colour is set', html.includes('name="theme-color"'));
check('the apple touch icon is linked', html.includes('rel="apple-touch-icon"'));

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
