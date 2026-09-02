/**
 * Two ways the scanner used to be quietly wrong about what a file is, and one
 * way the library forgot to clean up after itself.
 *
 * Wrong metadata is worse than none: nothing looks broken, the poster is simply
 * of a different film.
 *
 * Run: node tests/scanner-titles.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripJunkTokens, parseFile, pruneMissingProgress, lookupKey } from '../services/scanner.js';
import { isWithin } from '../services/watcher.js';
import { upsertProgress, getProgress, deleteProgress } from '../db/index.js';
import config from '../config/index.js';

const BACKSLASH = String.fromCharCode(92);

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/* -------------------------------------------------------------------------
 * release junk vs real words
 * ---------------------------------------------------------------------- */
console.log('\nstripJunkTokens');

const strip = (title) => stripJunkTokens(title.split(' ')).join(' ');

check('release tags go', strip('The Movie 1080p x264') === 'The Movie');
check('a run of them goes', strip('The Movie BluRay REMUX DTS 2160p') === 'The Movie');

/*
 * The bug: "web", "ts", "complete" and "multi" were treated as junk wherever
 * they appeared last, so "The Web" was sent to TMDB as "The" - and TMDB always
 * answers something.
 */
check('a title that ends in an ambiguous word survives', strip('The Web') === 'The Web');
check('so does Complete', strip('Naruto Complete') === 'Naruto Complete');
check('and TS', strip('Cowboy Bebop TS') === 'Cowboy Bebop TS');

// Alongside something unambiguous, the same words are junk again.
check('an ambiguous word next to a real tag goes', strip('The Movie 1080p WEB') === 'The Movie');
check('and in a longer run', strip('The Show COMPLETE 1080p WEB-DL') === 'The Show');

check('a title made only of junk keeps something', strip('1080p') === '1080p');

console.log('\nparseFile');
const parsed = parseFile(path.join(config.libraryPath, 'movies', 'The Web (2023) 1080p.mkv'));
check('the title survives the year and the tag', parsed.title === 'The Web');
check('the year is still read', parsed.year === 2023);

/* -------------------------------------------------------------------------
 * grouping titles for TMDB
 * ---------------------------------------------------------------------- */
console.log('\nlookupKey');

check('the same show groups together',
  lookupKey('show', 'The Office', 2005) === lookupKey('show', 'the.office', 2005));
check('punctuation and spacing do not split a group',
  lookupKey('movie', 'Spider-Man: No Way Home', 2021) === lookupKey('movie', 'spider man no way home', 2021));

/*
 * The bug: shows were keyed without their year, so two series called "The
 * Office" were one lookup and both resolved to whichever TMDB ranked first.
 * Movies already did this; shows now match.
 */
check('two shows of the same name and different years are separate',
  lookupKey('show', 'The Office', 2005) !== lookupKey('show', 'The Office', 2001));
check('a movie and a show of the same name are separate',
  lookupKey('show', 'Fargo', 1996) !== lookupKey('movie', 'Fargo', 1996));

/* -------------------------------------------------------------------------
 * what the watcher ignores
 * ---------------------------------------------------------------------- */
console.log('\nisWithin');

/*
 * temp/ may legitimately sit inside the library, and in-progress downloads
 * there must not trigger a rescan each. The old test was a string prefix, which
 * answers the wrong question when the separator or the drive-letter case
 * differs - and answers yes for "temporary" against "temp".
 */
check('a file inside is inside', isWithin('C:/lib/temp', 'C:/lib/temp/a.mkv'));
check('mixed separators do not fool it', isWithin('C:/lib/temp', 'C:' + BACKSLASH + 'lib' + BACKSLASH + 'temp' + BACKSLASH + 'a.mkv'));
check('nor does a deeper path', isWithin('C:/lib/temp', 'C:/lib/temp/sub/dir/a.mkv'));
check('the directory itself counts', isWithin('C:/lib/temp', 'C:/lib/temp'));
check('a sibling with a shared prefix is not inside', !isWithin('C:/lib/temp', 'C:/lib/temporary/a.mkv'));
check('and neither is the library beside it', !isWithin('C:/lib/temp', 'C:/lib/movies/a.mkv'));

/* -------------------------------------------------------------------------
 * progress rows for files that are gone
 * ---------------------------------------------------------------------- */
console.log('\npruneMissingProgress');

const room = fs.mkdtempSync(path.join(config.libraryPath, 'scan-test-'));
const present = path.join(room, 'here.mkv');
const deleted = path.join(room, 'gone.mkv');
const unmounted = path.join(room, 'no-such-folder', 'gone.mkv');
const outside = path.join(os.tmpdir(), 'mediawatcher-outside.mkv');

fs.writeFileSync(present, 'x');

const write = (filePath) => upsertProgress({
  file_path: filePath, position: 120, duration: 1320, type: 'movie', title: 'test'
});

for (const filePath of [present, deleted, unmounted, outside]) write(filePath);

pruneMissingProgress();

check('a row whose file is still there survives', getProgress(present) !== undefined);
check('a row whose file was deleted goes', getProgress(deleted) === undefined);
/*
 * The guard that matters: an unplugged drive takes its directories with it, and
 * wiping a household's watch history because a NAS was asleep is not a
 * recoverable mistake.
 */
check('a row under a missing directory is left alone', getProgress(unmounted) !== undefined);
check('a row outside the library is not this function to touch', getProgress(outside) !== undefined);

deleteProgress(present);
deleteProgress(unmounted);
deleteProgress(outside);
fs.rmSync(room, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
