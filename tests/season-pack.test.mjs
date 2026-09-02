/**
 * Season packs, and picking files by hand.
 *
 * The common real-world release for a show is one torrent holding a whole
 * season, and a job used to be one file with one destination — so taking every
 * file wrote the entire season over one name, and the selector refused packs
 * outright rather than do that. What makes them usable is that each file
 * carries its own numbering, which is read here.
 *
 * The rule that matters most is the refusal: a file that will not say which
 * episode it is gets skipped, never guessed at. A wrong episode number is
 * silent, and a missing file is visible in the season list.
 *
 * Run: node tests/season-pack.test.mjs
 */
import { selectFiles, planPlacements, parseEpisodeName } from '../services/downloader.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const GB = 1024 ** 3;
const file = (filename, size = 2 * GB) => ({ link: `https://ad/${filename}`, filename, size });

const PACK = [
  file('Severance.S01E01.1080p.WEB-DL.mkv'),
  file('Severance.S01E02.1080p.WEB-DL.mkv'),
  file('Severance.S01E03.1080p.WEB-DL.mkv'),
  file('sample.mkv', 20 * 1024 * 1024),
  file('readme.txt', 1024)
];

console.log('\nreading an episode number off a name');

check('SxxExx', JSON.stringify(parseEpisodeName('Show.S02E07.mkv')) === '{"season":2,"episode":7}');
check('1x05', JSON.stringify(parseEpisodeName('Show.1x05.mkv')) === '{"season":1,"episode":5}');
check('verbose', JSON.stringify(parseEpisodeName('Show.Season 3 Episode 2.mkv')) === '{"season":3,"episode":2}');
check('a movie names no episode', parseEpisodeName('Arrival.2016.1080p.mkv') === null);
check('nor does a bare name', parseEpisodeName('somefile.mkv') === null);
// Folder inference is deliberately not trusted here: the path is synthetic and
// only the filename carries anything.
check('an empty name is not an episode', parseEpisodeName('') === null);

console.log('\nselecting from a pack');

{
  const chosen = selectFiles(PACK, { type: 'season', season: 1 });
  check('takes every episode', chosen.length === 3);
  check('leaves the sample', !chosen.some((entry) => /sample/i.test(entry.filename)));
  check('leaves the text file', !chosen.some((entry) => entry.filename.endsWith('.txt')));
}

{
  // Unchanged behaviour: a request for one episode still takes exactly that
  // one, even out of a pack.
  const chosen = selectFiles(PACK, { type: 'episode', season: 1, episode: 2 });
  check('one named episode takes one file', chosen.length === 1);
  check('and it is the right one', chosen[0].filename.includes('S01E02'));
}

{
  const chosen = selectFiles(PACK, { type: 'movie' });
  check('a movie takes a single file', chosen.length === 1);
}

console.log('\nplacing them');

{
  const placed = planPlacements(
    selectFiles(PACK, { type: 'season', season: 1 }).map((entry) => ({ ...entry })),
    { type: 'season', title: 'Severance', season: 1 }
  );
  check('every file gets a placement', placed.length === 3);
  check('each keeps its own episode number',
    placed.map((place) => place.episode).join(',') === '1,2,3');
  check('all in the requested season', placed.every((place) => place.season === 1));
  // The pack has no episode titles in it, and inventing one would put a wrong
  // name in the filename forever.
  check('and no invented episode titles', placed.every((place) => place.episodeTitle === null));
}

{
  // The refusal. Two of these say what they are; the third does not.
  const mixed = [file('Show.S01E01.mkv'), file('Show.S01E02.mkv'), file('bonus-feature.mkv')];
  const placed = planPlacements(mixed, { type: 'season', title: 'Show', season: 1 });
  check('the unnumbered file is skipped, not guessed', placed.length === 2);
  check('and the skip says why',
    placed.skipped.length === 1 && /no episode number/.test(placed.skipped[0].reason));
}

{
  // A proper and a repack of the same episode: file one, skip the other,
  // rather than race two transfers to one path.
  const duplicated = [file('Show.S01E01.PROPER.mkv'), file('Show.S01E01.REPACK.mkv')];
  const placed = planPlacements(duplicated, { type: 'season', title: 'Show', season: 1 });
  check('a duplicate episode is filed once', placed.length === 1);
  check('and the second is reported', placed.skipped.length === 1);
}

{
  // A "season 1" pack that smuggles in season 2 files.
  const spanning = [file('Show.S01E01.mkv'), file('Show.S02E01.mkv')];
  const placed = planPlacements(spanning, { type: 'season', title: 'Show', season: 1 });
  check('only the requested season is filed', placed.length === 1);
  check('the other season is skipped', /season 2/.test(placed.skipped[0].reason));
}

{
  // Not a pack: the request is better evidence than the filename, because
  // plenty of single-episode releases are named something unreadable.
  const placed = planPlacements([file('whatever.mkv')], {
    type: 'episode', title: 'Show', season: 4, episode: 9, episodeTitle: 'The One'
  });
  check('a named episode keeps the request numbering',
    placed[0].season === 4 && placed[0].episode === 9);
  check('and its episode title', placed[0].episodeTitle === 'The One');
}

console.log('\npicking files by hand');

{
  const chosen = selectFiles(PACK, {
    type: 'season',
    season: 1,
    files: ['Severance.S01E01.1080p.WEB-DL.mkv', 'Severance.S01E03.1080p.WEB-DL.mkv']
  });
  check('takes exactly what was ticked', chosen.length === 2);
  check('and nothing else', !chosen.some((entry) => entry.filename.includes('S01E02')));
}

{
  // An explicit choice beats every rule below it, including the sample filter:
  // if someone ticks it, they meant it.
  const chosen = selectFiles(PACK, { type: 'movie', files: ['sample.mkv'] });
  check('an explicit choice overrides the guessing', chosen.length === 1);
  check('even for a file the rules would have dropped', chosen[0].filename === 'sample.mkv');
}

{
  // A choice naming nothing in this torrent falls back rather than downloading
  // nothing: the alternative is a job that fails for a reason nobody can see.
  const chosen = selectFiles(PACK, { type: 'movie', files: ['not-in-here.mkv'] });
  check('a choice that matches nothing falls back to the rules', chosen.length === 1);
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
