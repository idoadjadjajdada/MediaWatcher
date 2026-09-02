/**
 * The download pipeline's two decisions that used to go quietly wrong:
 * which files a torrent gives up, and what survives a restart.
 *
 * Both are the difference between an episode landing where it belongs and a
 * season pack being written ten times over one filename, so they are worth
 * pinning even though neither is visible until something has already gone in
 * the library.
 *
 * Run: node tests/downloads.test.mjs
 */
import { selectFiles, requestFromJob } from '../services/downloader.js';
import { targetPath } from '../services/organizer.js';
import { insertJob, getJob, deleteJob } from '../db/index.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const GB = 1024 ** 3;
const file = (filename, size = 2 * GB) => ({ link: `https://d/${filename}`, filename, size });

const seasonPack = [
  file('Show.S01E01.1080p.mkv'),
  file('Show.S01E02.1080p.mkv'),
  file('Show.S01E03.1080p.mkv'),
  file('sample.mkv', 20 * 1024 * 1024)
];

/* -------------------------------------------------------------------------
 * selectFiles
 * ---------------------------------------------------------------------- */
console.log('\nselectFiles — episodes');

const wanted = selectFiles(seasonPack, { type: 'episode', season: 1, episode: 2 });
check('takes only the episode asked for', wanted.length === 1);
check('and it is the right one', wanted[0]?.filename === 'Show.S01E02.1080p.mkv');

const alt = selectFiles([file('Show.1x02.mkv')], { type: 'episode', season: 1, episode: 2 });
check('recognises the 1x02 form', alt.length === 1);

/*
 * The whole point of this suite. An episode request that matches nothing used
 * to fall through to "every video in the torrent", and every one of them was
 * then written to the same episode's path: "Show - S01E05.mkv", " (2).mkv",
 * " (3).mkv" - wrong bandwidth, wrong disk, wrong library.
 */
const missing = selectFiles(seasonPack, { type: 'episode', season: 2, episode: 5 });
check('takes nothing when the episode is not in the torrent', missing.length === 0);

/*
 * The other half of that rule. Plenty of single-episode releases name the file
 * something no pattern can read, and refusing those would be a worse bug than
 * the one above: there is only one video, so there is nothing to confuse it
 * with.
 */
const oddlyNamed = selectFiles([file('some.release.group.file.mkv')], { type: 'episode', season: 1, episode: 5 });
check('a lone video with an unreadable name is still taken', oddlyNamed.length === 1);
check('but two of them are not', selectFiles(
  [file('unreadable.a.mkv'), file('unreadable.b.mkv')],
  { type: 'episode', season: 1, episode: 5 }
).length === 0);

// A pack with no episode named is still a pack: every video is wanted.
const wholePack = selectFiles(seasonPack, { type: 'episode' });
check('an episode request with no numbers still takes the pack', wholePack.length === 3);
check('and drops the sample', !wholePack.some((entry) => entry.filename === 'sample.mkv'));

console.log('\nselectFiles — movies');
const movie = selectFiles([file('Film.720p.mkv', 3 * GB), file('Film.1080p.mkv', 9 * GB)], { type: 'movie' });
check('takes the largest copy', movie.length === 1 && movie[0].filename === 'Film.1080p.mkv');
check('never takes more than one', selectFiles(seasonPack, { type: 'movie' }).length === 1);

console.log('\nselectFiles — nothing usable');
check('an empty torrent selects nothing', selectFiles([], { type: 'movie' }).length === 0);

/* -------------------------------------------------------------------------
 * surviving a restart
 * ---------------------------------------------------------------------- */
console.log('\nreconciliation after a restart');

const JOB_ID = 'test-job-990001';
deleteJob(JOB_ID);

insertJob({
  id: JOB_ID,
  type: 'episode',
  title: 'Some Show',
  tmdb_id: 990001,
  year: 2019,
  season: 3,
  episode: 7,
  episode_title: 'The One With The Restart',
  magnet: 'magnet:?xt=urn:btih:deadbeef',
  source: 'torrentio',
  status: 'downloading',
  progress: 0.4
});

const stored = getJob(JOB_ID);
check('the season is stored', stored.season === 3);
check('the episode is stored', stored.episode === 7);
check('the episode title is stored', stored.episode_title === 'The One With The Restart');
check('the year is stored', stored.year === 2019);

const rebuilt = requestFromJob(stored);
check('the request is rebuilt with its numbers', rebuilt.season === 3 && rebuilt.episode === 7);
check('and with its episode title', rebuilt.episodeTitle === 'The One With The Restart');

/*
 * The failure this prevents: a re-queued job used to carry no season or
 * episode, so episodeTag(undefined, undefined) produced "S00E00" and the file
 * landed in "Season 00".
 */
const destination = targetPath({ ...rebuilt, ext: '.mkv' });
check('the destination keeps its season folder', /Season 03/.test(destination));
check('the destination keeps its episode tag', /S03E07/.test(destination));
check('nothing lands in Season 00', !/Season 00|S00E00/.test(destination));

deleteJob(JOB_ID);
check('the test row is cleaned up', getJob(JOB_ID) === undefined);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
