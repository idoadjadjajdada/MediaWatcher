/**
 * Continue Watching — one row per title, and the card content behind it.
 *
 * Uses the real database, writing rows under tmdb ids far outside anything TMDB
 * issues so it cannot collide with the live library, and deleting them after.
 *
 * Run: node tests/continue-watching.test.mjs
 */
import { upsertProgress, listContinueWatching, deleteProgress } from '../db/index.js';
import { continueEntry } from '../public/js/state.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/* -------------------------------------------------------------------------
 * one row per title
 * ---------------------------------------------------------------------- */
console.log('\nlistContinueWatching');

const SHOW = 990001;
const OTHER_SHOW = 990002;
const MOVIE = 990003;
const paths = [];

const write = (over) => {
  const row = {
    file_path: over.file_path,
    position: 120,
    duration: 1320,
    type: over.type || 'episode',
    tmdb_id: over.tmdb_id ?? null,
    parent_tmdb_id: over.parent_tmdb_id ?? null,
    season_number: over.season_number ?? null,
    episode_number: over.episode_number ?? null,
    title: over.title || 'x',
    completed: 0
  };
  paths.push(row.file_path);
  return upsertProgress(row);
};

// updated_at is millisecond resolution, and real viewing is minutes apart.
// Writing three rows in the same tick would test the tie-break rather than the
// ordering this is about.
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

// Three episodes of one show, written oldest to newest.
write({ file_path: '/t/s1e1.mkv', parent_tmdb_id: SHOW, season_number: 1, episode_number: 1 });
await tick();
write({ file_path: '/t/s1e2.mkv', parent_tmdb_id: SHOW, season_number: 1, episode_number: 2 });
await tick();
write({ file_path: '/t/s1e3.mkv', parent_tmdb_id: SHOW, season_number: 1, episode_number: 3 });
await tick();
write({ file_path: '/t/other-s2e5.mkv', parent_tmdb_id: OTHER_SHOW, season_number: 2, episode_number: 5 });
write({ file_path: '/t/film.mkv', type: 'movie', tmdb_id: MOVIE });

const rows = listContinueWatching(50);
const mine = rows.filter((r) => String(r.file_path).startsWith('/t/'));

check('a part-watched show appears once, not once per episode',
  mine.filter((r) => r.parent_tmdb_id === SHOW).length === 1,
  mine.filter((r) => r.parent_tmdb_id === SHOW).map((r) => r.file_path));
check('the episode kept is the most recently watched',
  mine.find((r) => r.parent_tmdb_id === SHOW)?.episode_number === 3);
check('a second show is its own entry',
  mine.filter((r) => r.parent_tmdb_id === OTHER_SHOW).length === 1);
check('a movie is its own entry', mine.filter((r) => r.tmdb_id === MOVIE).length === 1);
check('three shows/films give three entries, not five files', mine.length === 3, mine.length);

// Watching an earlier episode again promotes it.
await tick();
write({ file_path: '/t/s1e1.mkv', parent_tmdb_id: SHOW, season_number: 1, episode_number: 1 });
const after = listContinueWatching(50).filter((r) => r.parent_tmdb_id === SHOW);
check('rewatching an earlier episode makes it the shown one',
  after.length === 1 && after[0].episode_number === 1, after.map((r) => r.episode_number));

for (const p of paths) deleteProgress(p);
check('cleanup removed the test rows',
  listContinueWatching(50).filter((r) => String(r.file_path).startsWith('/t/')).length === 0);

/* -------------------------------------------------------------------------
 * card content
 * ---------------------------------------------------------------------- */
console.log('\ncontinueEntry');

const library = {
  movies: [{
    tmdb_id: MOVIE, title: 'Blade Runner', year: 1982,
    poster: 'https://image.tmdb.org/t/p/w500/br.jpg',
    files: [{ file_path: '/t/film.mkv' }]
  }],
  shows: [{
    tmdb_id: SHOW, title: 'Rick and Morty', year: 2013,
    poster: 'https://image.tmdb.org/t/p/w500/rm.jpg',
    seasons: [{ number: 4, episodes: [{
      episode_number: 2, title: 'The Old Man and the Seat',
      overview: 'Rick looks for a private place.',
      still: 'https://image.tmdb.org/t/p/w1280/seat.jpg',
      air_date: '2019-11-17',
      files: [{ file_path: '/t/s4e2.mkv' }]
    }] }]
  }],
  unknown: []
};

const ep = continueEntry({ file_path: '/t/s4e2.mkv', position: 300, duration: 1320 }, library);
check('an episode entry is found', Boolean(ep));
check('it is typed as an episode', ep.type === 'episode');
check('it uses the episode still, not the show poster',
  ep.art.includes('seat.jpg') && !ep.art.includes('rm.jpg'));
check('the still is downsized', ep.art.includes('/w300/'));
check('it names the show', ep.title === 'Rick and Morty');
check('it labels the exact episode', ep.subtitle.includes('S04E02'));
check('the label carries the episode title', ep.subtitle.includes('The Old Man and the Seat'));
check('it carries the episode description', ep.description === 'Rick looks for a private place.');
// The episode's own air year, not the show's first-aired year.
check('the year is the episode air year, not the show year', ep.year === 2019);
check('progress is a fraction', Math.abs(ep.progress - (300 / 1320)) < 1e-9);
check('it knows where to resume', ep.position === 300);

const movie = continueEntry({ file_path: '/t/film.mkv', position: 600, duration: 6000 }, library);
check('a movie entry is found', Boolean(movie));
check('it is typed as a movie', movie.type === 'movie');
check('a movie keeps its poster art', movie.art.includes('br.jpg'));
check('a movie has no episode subtitle', !movie.subtitle);
check('a movie uses its own release year', movie.year === 1982);
check('a movie carries its position for the hover frame', movie.position === 600);

check('an unknown path gives null', continueEntry({ file_path: '/t/nope.mkv' }, library) === null);
check('a null row gives null', continueEntry(null, library) === null);
check('a null library gives null', continueEntry({ file_path: '/t/film.mkv' }, null) === null);
check('a zero duration gives zero progress',
  continueEntry({ file_path: '/t/film.mkv', position: 10, duration: 0 }, library).progress === 0);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
