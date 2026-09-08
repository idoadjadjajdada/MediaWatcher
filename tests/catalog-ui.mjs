/** Real browser flows with deterministic API fixtures; never queues a real download. */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const app = express();
app.use(express.static(path.resolve('public')));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.UI_BROWSER || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const downloads = [], searches = [], queries = [];
const genres = [{ id: 18, name: 'Drama' }, { id: 878, name: 'Science Fiction' }];
const movie = { tmdb_id: 100, type: 'movie', title: 'Beyond the Moon', year: 2024, rating: 8.4, poster: '/fixture-poster.svg' };
const show = { ...movie, tmdb_id: 200, type: 'show', title: 'The Last Horizon' };
const library = { movies: [{ ...movie, files: [{ file_path: '/fixture.mkv', added_at: 1000 }] }], shows: [], unknown: [] };
let failCatalog = false;
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('.svg') || url.hostname === 'image.tmdb.org') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#162332"/><stop offset="1" stop-color="#394349"/></linearGradient></defs><path fill="url(#a)" d="M0 0h800v1200H0z"/><circle cx="500" cy="320" r="200" fill="#9dadaf"/><path d="M0 650L220 400 450 830 640 600 800 900v300H0" fill="#0c1722"/><text x="75" y="1020" fill="#c1cacd" font-family="sans-serif" font-size="52" letter-spacing="8">HORIZON</text></svg>' });
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const json = data => route.fulfill({ json: data });
  if (url.pathname === '/api/media/library') return json(library);
  if (url.pathname === '/api/progress' || url.pathname === '/api/torrents/jobs') return json([]);
  if (url.pathname === '/api/library/changes') return json({ first: true });
  if (url.pathname === '/api/discover') return json({ rails: [{ title: 'Recommended for you', items: [show] }] });
  if (url.pathname === '/api/discover/catalog') {
    queries.push(Object.fromEntries(url.searchParams));
    if (failCatalog) return route.fulfill({ status: 502, json: { error: 'Fixture catalog unavailable' } });
    const type = url.searchParams.get('type');
    return json({ results: type === 'show' ? [show] : [movie, { ...movie, tmdb_id: 101, title: 'A Different Sky' }], genres,
      page: Number(url.searchParams.get('page') || 1), totalPages: 2, genre: url.searchParams.get('genre') || '', query: url.searchParams.get('q') || '' });
  }
  if (/\/api\/discover\/(movie|show)\/\d+$/.test(url.pathname)) {
    const isShow = url.pathname.includes('/show/');
    const id = Number(url.pathname.split('/').at(-1));
    if (id === 999) await new Promise(resolve => setTimeout(resolve, 300));
    return json({ id, title: isShow ? undefined : 'Beyond the Moon', name: isShow ? 'The Last Horizon' : undefined,
      release_date: '2024-01-01', first_air_date: '2024-01-01', poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg',
      overview: 'At the edge of a silent world, a small crew follows a mysterious signal beyond everything they have ever known.', genres, vote_average: 8.4, runtime: isShow ? null : 128,
      credits: { cast: [{ name: 'Jordan Lane', character: 'The navigator', profile_path: '/cast.jpg' }] },
      seasons: isShow ? [{ season_number: 0, name: 'Specials', episode_count: 1 }, { season_number: 1, name: 'Season 1', episode_count: 3 }, { season_number: 2, name: 'Season 2', episode_count: 3 }] : [] });
  }
  if (/\/season\/\d+$/.test(url.pathname)) {
    const season = Number(url.pathname.split('/').at(-1));
    return json({ name: season ? `Season ${season}` : 'Specials', episodes: [1, 2, 3].map(n => ({ episode_number: n, name: ['First Light', 'The Crossing', 'A New World'][n - 1], still_path: '/still.jpg', runtime: 48,
      air_date: n === 3 ? '2099-01-01' : '2024-01-01', overview: 'The crew discovers a signal that changes their mission.' })) });
  }
  if (url.pathname === '/api/torrents/search' || url.pathname === '/api/search') {
    searches.push(Object.fromEntries(url.searchParams));
    if (url.searchParams.get('q') === 'Slow result') await new Promise(resolve => setTimeout(resolve, 300));
    return json({ sources: [{ id: 'fixture', label: 'Test source', ok: true, count: 1 }], results: [{ title: `${url.searchParams.get('q')}.S01.1080p.WEB-DL`, infoHash: 'a'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), source: 'fixture', is_1080p: true, badges: { quality: '1080p' }, final_score: .9 }] });
  }
  if (url.pathname === '/api/torrents/inspect') return json({ ready: true, files: [1, 2].map(episode => ({ filename: `Show.S00E0${episode}.mkv`, size: 100000000, video: true, sample: false, episode: { season: 0, episode } })) });
  if (url.pathname === '/api/torrents/download') { downloads.push(route.request().postDataJSON()); return json({ id: String(downloads.length), title: 'Fixture', status: 'queued' }); }
  return json({});
});
try {
  await page.goto(origin);
  await page.getByText('Recently added', { exact: true }).waitFor();
  assert.equal(await page.getByText('Your library', { exact: true }).count(), 0);
  await page.getByText('Recommended for you', { exact: true }).waitFor();
  await page.locator('[data-action="open-discover"][data-id="200"]').click();
  await page.getByRole('heading', { name: 'The Last Horizon', exact: true }).waitFor();
  await page.getByRole('heading', { name: '1. First Light' }).waitFor();
  assert.match(await page.locator('.catalog-availability').innerText(), /Not downloaded/);
  assert.equal(await page.locator('[data-action="catalog-download-episode"][data-episode="3"]').isDisabled(), true);
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/catalog-series-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Download entire season' }).click();
  await page.locator('[data-action="download-result"]').click();
  await page.waitForFunction(() => document.querySelector('.toast'));
  assert.equal(searches.at(-1).scope, 'season');
  assert.equal(searches.at(-1).tmdb_id, '200');
  assert.equal(downloads.at(-1).type, 'season');
  assert.equal(downloads.at(-1).season, 1);
  assert.equal(downloads.at(-1).tmdb_id, 200);
  assert.equal(downloads.at(-1).episode, undefined);
  await page.locator('[data-action="catalog-season"][data-season="2"]').click();
  await page.getByRole('heading', { name: '1. First Light' }).waitFor();
  await page.locator('[data-action="catalog-download-episode"][data-episode="2"]').click();
  await page.locator('[data-action="download-result"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.toast').length >= 2);
  assert.equal(downloads.at(-1).type, 'episode');
  assert.equal(downloads.at(-1).season, 2);
  assert.equal(downloads.at(-1).episode, 2);
  assert.equal(downloads.at(-1).episodeTitle, 'The Crossing');
  assert.equal(downloads.at(-1).year, 2024);
  await page.locator('[data-action="catalog-season"][data-season="0"]').click();
  await page.getByRole('heading', { name: 'Specials', exact: true }).waitFor();
  await page.locator('[data-action="catalog-download-episode"][data-episode="1"]').click();
  await page.locator('[data-action="download-result"]').waitFor();
  assert.equal(searches.at(-1).season, '0');
  await page.locator('[data-action="inspect-result"]').click();
  await page.locator('[data-action="toggle-inspect-file"]').first().waitFor();
  await page.locator('[data-action="toggle-inspect-file"]').first().uncheck();
  const pickedDownload = page.waitForResponse(r => r.url().endsWith('/api/torrents/download'));
  await page.locator('[data-action="download-chosen"]').click();
  await pickedDownload;
  assert.equal(downloads.at(-1).season, 0);
  assert.equal(downloads.at(-1).episode, 2, 'File inspection uses the chosen file numbering');
  assert.equal(downloads.at(-1).episodeTitle, undefined, 'Does not reuse a different episode title');
  await page.getByRole('button', { name: 'Back to search' }).click();
  await page.locator('.catalog-card').first().waitFor();
  await page.locator('#search-input').fill('A title');
  await page.locator('#search-input').press('Enter');
  await page.locator('.catalog-card').first().waitFor();
  assert.equal(queries.at(-1).q, 'A title');
  await page.locator('#catalog-type').selectOption('show');
  await page.locator('.catalog-card').first().waitFor();
  await page.locator('#catalog-genre').selectOption('18');
  await page.locator('.catalog-card').first().waitFor();
  await page.locator('#catalog-year').fill('2024');
  await page.locator('#catalog-rating').selectOption('8');
  await page.locator('.catalog-card').first().waitFor();
  assert.equal(queries.at(-1).genre, '18');
  assert.equal(queries.at(-1).year, '2024');
  assert.equal(queries.at(-1).rating, '8');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Page 2 of 2').waitFor();
  assert.equal(queries.at(-1).page, '2');
  await page.locator('.catalog-card').first().click();
  await page.getByRole('heading', { name: '1. First Light' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.catalog-episode__body').first().evaluate(el => el.getBoundingClientRect().width >= 160));
  await page.screenshot({ path: 'test-results/catalog-series-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Back to search' }).click();
  assert.equal(await page.locator('#search-input').inputValue(), 'A title');
  assert.equal(await page.locator('#catalog-genre').inputValue(), '18');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.locator('.catalog-card').first().waitFor();
  await page.locator('#catalog-type').selectOption('movie');
  await page.locator('.catalog-card').first().waitFor();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: 'test-results/catalog-search-desktop.png', fullPage: true });
  assert.match(await page.locator('.catalog-card').first().innerText(), /In library/);
  assert.match(await page.locator('.catalog-card').nth(1).innerText(), /Not downloaded/);
  await page.locator('.catalog-card').nth(1).click();
  await page.getByRole('button', { name: 'Download movie', exact: true }).click();
  await page.locator('[data-action="download-result"]').click();
  await page.waitForFunction(() => document.querySelector('.toast'));
  assert.equal(downloads.at(-1).type, 'movie');
  assert.equal(downloads.at(-1).tmdb_id, 101);
  assert.equal(downloads.at(-1).season, undefined);
  await page.evaluate(async () => { const c = await import('/js/catalog.js'); c.openTitle(999, 'movie'); await c.openTitle(200, 'show'); });
  await page.waitForTimeout(400);
  await page.getByRole('heading', { name: 'The Last Horizon' }).waitFor();
  const latest = await page.evaluate(async () => {
    const search = await import('/js/search.js');
    await Promise.all([search.runSearch('Slow result', 'show', 1, 1, { tmdbId: 200 }), search.runSearch('Latest result', 'movie', null, null, { tmdbId: 101 })]);
    return (await import('/js/state.js')).state.search.results[0].title;
  });
  assert.match(latest, /^Latest result/);
  failCatalog = true;
  await page.getByRole('button', { name: 'Back to search' }).click();
  await page.locator('[data-action="run-search"]').click();
  await page.getByText('Could not load titles', { exact: true }).waitFor();
  failCatalog = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('.catalog-card').first().waitFor();
  await page.evaluate(async () => { const { setState } = await import('/js/state.js'); setState({ library: { movies: [], shows: [], unknown: [] }, currentPage: 'home' }); });
  await page.getByText('Recommended for you', { exact: true }).waitFor();
  assert.equal(await page.getByText('Recently added', { exact: true }).count(), 0);

  // Typing must not rebuild the page under the caret.
  await page.evaluate(async () => { const { setState } = await import('/js/state.js'); setState({ currentPage: 'search' }); });
  await page.locator('.catalog-card').first().waitFor();
  await page.locator('[data-action="catalog-reset"]').click();
  await page.locator('.catalog-card').first().waitFor();
  const stability = await page.evaluate(async () => {
    const input = document.getElementById('search-input');
    const grid = document.querySelector('.catalog-grid');
    const poster = document.querySelector('.catalog-card');
    input.focus();
    for (const character of 'aliens') {
      input.value += character;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Deleting from the middle: "aliens" without the "en".
    input.setSelectionRange(3, 5);
    input.setRangeText('', 3, 5, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return {
      value: input.value, caret: input.selectionStart,
      sameGrid: grid === document.querySelector('.catalog-grid'),
      samePoster: poster === document.querySelector('.catalog-card'),
      focused: document.activeElement === input
    };
  });
  assert.deepEqual(stability, { value: 'alis', caret: 3, sameGrid: true, samePoster: true, focused: true });
  // What was typed is what gets searched for, whether by Enter or by a filter.
  await page.locator('#search-input').press('Enter');
  await page.locator('.catalog-card').first().waitFor();
  assert.equal(queries.at(-1).q, 'alis');
  await page.locator('#search-input').fill('aliens');
  await page.locator('#catalog-rating').selectOption('7');
  await page.locator('.catalog-card').first().waitFor();
  assert.equal(queries.at(-1).q, 'aliens', 'a filter carries the text already typed');
  assert.equal(queries.at(-1).rating, '7');
  await page.locator('[data-action="catalog-reset"]').click();
  await page.locator('.catalog-card').first().waitFor();
  assert.equal(await page.locator('#search-input').inputValue(), '');
  assert.equal(queries.at(-1).q, undefined, 'reset clears the field and the search');
  console.log('PASS: typing in search leaves the results, the posters and the caret alone');

  assert.deepEqual(errors, []);
  console.log('PASS: Home, title catalog, filters, paging, movie/season/episode payloads, specials, upcoming episodes, status, stale details, retry and mobile layout');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('UI state:', await page.locator('#main').innerText().catch(() => 'No main element'));
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
