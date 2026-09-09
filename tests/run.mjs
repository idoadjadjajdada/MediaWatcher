/**
 * Run every unit suite and report all of them.
 *
 * `npm test` used to be a single `&&` chain, which stops at the first failure.
 * That is the wrong shape for this repo: `search-resolution` makes a live TMDB
 * call and fails whenever the network or the key is unavailable, and because
 * it ran first it hid the twenty suites behind it. A green run and a run where
 * nineteen suites never executed looked the same from the outside.
 *
 * Every suite runs here regardless of what came before, and the exit code
 * reflects the whole set. Suites that need the network are marked so a failure
 * in one reads as "could not reach TMDB", not "the resolver is broken".
 *
 * Run: node tests/run.mjs   (or: npm test)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Order is roughly cheapest first. `network: true` means the suite talks to a
// third party and can fail for reasons that have nothing to do with the code.
const SUITES = [
  { file: 'picture.test.mjs' },
  { file: 'audio-offset.test.mjs' },
  { file: 'episode-rows.test.mjs' },
  { file: 'seek-preview.test.mjs' },
  { file: 'continue-watching.test.mjs' },
  { file: 'watch-state.test.mjs' },
  { file: 'player-nextup.test.mjs' },
  { file: 'player-gestures.test.mjs' },
  { file: 'tonemap.test.mjs' },
  { file: 'thumbnails.test.mjs' },
  { file: 'mp4cache.test.mjs' },
  { file: 'encoder-registry.test.mjs' },
  { file: 'hls-pool.test.mjs' },
  { file: 'hardware-encoder.test.mjs' },
  { file: 'hls-efficiency.test.mjs' },
  { file: 'env-file.test.mjs' },
  { file: 'updates.test.mjs' },
  { file: 'instance.test.mjs' },
  { file: 'serving.test.mjs' },
  { file: 'notify.test.mjs' },
  { file: 'source-stats.test.mjs' },
  { file: 'season-pack.test.mjs' },
  { file: 'catalog.test.mjs' },
  { file: 'enrol-changes.test.mjs' },
  { file: 'webpush.test.mjs' },
  { file: 'subtitle-sync.test.mjs' },
  { file: 'cast-link.test.mjs' },
  { file: 'encode-farm.test.mjs' },
  { file: 'warm-policy.test.mjs' },
  { file: 'pitch.test.mjs' },
  { file: 'speed.test.mjs' },
  { file: 'cache-limits.test.mjs' },
  { file: 'scanner-titles.test.mjs' },
  { file: 'downloads.test.mjs' },
  { file: 'download-retry.test.mjs' },
  { file: 'transfer.test.mjs' },
  { file: 'error-handler.test.mjs' },
  { file: 'auth.test.mjs' },
  { file: 'auth-loopback.test.mjs' },
  { file: 'remote-quality.test.mjs' },
  { file: 'intro.test.mjs' },
  { file: 'intro-editor.test.mjs' },
  { file: 'intro-detect.test.mjs' },
  { file: 'subtitle-fetch.test.mjs' },
  { file: 'subtitle-style.test.mjs' },
  { file: 'ass.test.mjs' },
  { file: 'track-prefs.test.mjs' },
  { file: 'settings.test.mjs' },
  { file: 'missing.test.mjs' },
  { file: 'offline.test.mjs' },
  { file: 'warmup.test.mjs' },
  { file: 'queue-order.test.mjs' },
  { file: 'qr.test.mjs' },
  { file: 'adaptive.test.mjs' },
  { file: 'hls-playlist.test.mjs' },
  { file: 'hls-session.test.mjs' },
  { file: 'hls-ownership.test.mjs' },
  // Runs a real encoder against a generated clip; skips itself without ffmpeg.
  { file: 'hls-tail.test.mjs' },
  { file: 'discover.test.mjs' },
  { file: 'tmdb-suggest.test.mjs', network: true },
  { file: 'search-resolution.test.mjs', network: true }
];

const results = [];

for (const suite of SUITES) {
  const target = path.join(here, suite.file);
  const run = spawnSync(process.execPath, [target], { encoding: 'utf8' });

  // A suite that does not exist yet is a mistake in this list, not a pass.
  const missing = run.status !== 0 && /Cannot find module/.test(run.stderr || '');

  results.push({
    ...suite,
    ok: run.status === 0,
    missing,
    // The per-check lines are only worth printing for a suite that failed.
    output: `${run.stdout || ''}${run.stderr || ''}`.trimEnd()
  });

  process.stdout.write(`${run.status === 0 ? '  ok  ' : ' FAIL '} ${suite.file}\n`);
}

const failed = results.filter((result) => !result.ok);

for (const result of failed) {
  console.log(`\n${'-'.repeat(72)}\n${result.file}${result.network ? '  (needs the network)' : ''}\n${'-'.repeat(72)}`);
  console.log(result.output);
}

const networkOnly = failed.length > 0 && failed.every((result) => result.network);

console.log(`\n${results.length - failed.length}/${results.length} suites passed`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((result) => result.file).join(', ')}`);
}
if (networkOnly) {
  console.log('every failure needs a third party, so this may be the network rather than the code.');
}

process.exit(failed.length === 0 ? 0 : 1);
