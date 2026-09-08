/** Catalog endpoints and season selection, with all external services mocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import axios from 'axios';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-catalog-test-'));
Object.assign(process.env, { MW_DATA_DIR: scratch, TMDB_API_KEY: 'fixture-key', ALLDEBRID_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password', LOG_LEVEL: 'error', JACKETT_URL: 'http://fixture-jackett', JACKETT_API_KEY: 'fixture-key' });
const requests = [];
axios.defaults.adapter = async config => {
  requests.push(config);
  let data;
  if (config.url.includes('/genre/')) data = { genres: [{ id: 18, name: 'Drama' }] };
  else if (/\/(discover|search)\/(movie|tv)$/.test(config.url)) data = { total_pages: 3, results: [
    { id: 1, title: 'Good Movie', name: 'Good Show', genre_ids: [18], vote_average: 8, release_date: '2024-01-01', first_air_date: '2024-01-01' },
    { id: 2, title: 'Other Genre', name: 'Other Genre', genre_ids: [35], vote_average: 9 },
    { id: 3, title: 'Low Rated', name: 'Low Rated', genre_ids: [18], vote_average: 4 }
  ] };
  else if (config.url.includes('/season/')) data = { season_number: 0, episodes: [{ episode_number: 1, name: 'Special' }] };
  else if (/\/tv\/\d+$/.test(config.url)) data = { id: 1, name: 'Good Show', seasons: [] };
  else if (config.url.includes('torrentio')) data = { streams: [
    { title: 'Good.Show.S01.Complete.1080p\n👤 12 💾 8 GB', behaviorHints: { filename: 'Good.Show.S01E01.mkv' }, infoHash: 'a'.repeat(40) },
    { title: 'Good.Show.S01E01.1080p', infoHash: 'b'.repeat(40) },
    { title: 'Good.Show.S02.Complete.1080p', infoHash: 'c'.repeat(40) }
  ] };
  else if (config.url.includes('fixture-jackett')) data = { Results: [] };
  else throw new Error(`Unexpected external request: ${config.url}`);
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
const { default: router } = await import('../routes/discover.js');
const { search, isSeasonPack } = await import('../services/torrentSearch.js');
const { selectFiles } = await import('../services/downloader.js');
const { closeDatabase } = await import('../db/index.js');
const app = express();
app.use('/api/discover', router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/discover`;
try {
  let response = await fetch(`${base}/catalog?type=movie&q=drama&year=2024&rating=7&sort=rating`);
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map(r => r.tmdb_id), [1]);
  assert.equal(body.results[0].type, 'movie');
  assert.equal(body.genre, 18);
  assert.equal(body.query, '');
  assert.equal(requests.at(-1).url, '/discover/movie');
  assert.equal(requests.at(-1).params.with_genres, 18);
  assert.equal(requests.at(-1).params.primary_release_year, 2024);
  assert.equal(requests.at(-1).params.sort_by, 'vote_average.desc');
  response = await fetch(`${base}/catalog?type=show&q=Good&genre=18&year=2024&rating=7&page=2`);
  body = await response.json();
  assert.deepEqual(body.results.map(r => r.title), ['Good Show']);
  assert.equal(body.results[0].type, 'show');
  assert.equal(body.page, 2);
  assert.equal(body.totalPages, 3);
  assert.equal(requests.at(-1).url, '/search/tv');
  assert.equal(requests.at(-1).params.first_air_date_year, 2024);
  for (const filters of ['year=oops', 'genre=bad', 'type=person', 'page=0', 'rating=11', 'genre=999', 'sort=wrong']) {
    assert.equal((await fetch(`${base}/catalog?${filters}`)).status, 400, filters);
  }
  body = await (await fetch(`${base}/show/1/season/0`)).json();
  assert.equal(body.episodes[0].name, 'Special');
  assert.equal((await fetch(`${base}/show/1/season/-1`)).status, 400);
  assert.ok(isSeasonPack('Good.Show.S01.Complete', 1));
  assert.ok(isSeasonPack('Good Show Season 0', 0));
  assert.ok(!isSeasonPack('Good.Show.S01E01', 1));
  assert.ok(!isSeasonPack('Good.Show.S01.E01', 1));
  assert.ok(!isSeasonPack('Good.Show.S02', 1));
  const outcome = await search({ query: 'Good Show', type: 'show', imdbId: 'tt1234567', season: 1, episode: 1, scope: 'season' });
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].infoHash, 'a'.repeat(40));
  const jackett = requests.find(r => r.url.includes('fixture-jackett'));
  assert.equal(new URL(jackett.url).searchParams.get('Query'), 'Good Show S01');
  assert.ok(requests.some(r => r.url.includes('tt1234567%3A1%3A1')));
  const files = ['Show.S01E01.mkv', 'Show.S01E02.mkv', 'Show.S02E01.mkv', 'bonus.mkv'].map(filename => ({ filename, link: filename, size: 100000000 }));
  assert.deepEqual(selectFiles(files, { type: 'season', season: 1 }).map(f => f.filename), ['Show.S01E01.mkv', 'Show.S01E02.mkv']);
  assert.deepEqual(selectFiles(files, { type: 'season', season: 0 }), []);
  assert.equal(selectFiles(files, { type: 'episode', season: 1, episode: 2 })[0].filename, 'Show.S01E02.mkv');
  console.log('PASS: genre lookup, movie/TV filters, paging, validation, specials, pack discovery, and selected-season file isolation');
} finally {
  await new Promise(resolve => server.close(resolve));
  closeDatabase();
  fs.rmSync(scratch, { recursive: true, force: true });
}
