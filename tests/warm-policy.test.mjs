/**
 * What is worth converting ahead of time.
 *
 * Warming everything is right for a library of 1080p web rips and wrong for
 * almost anything else: a 4K remux converted for a phone that will never play
 * it is an hour of encoding and twenty gigabytes on a file nobody asked for.
 *
 * The rule that matters most is precedence. A decision about one title has to
 * beat every general rule in both directions — "never convert this" must
 * survive someone raising the size limit, and "always convert that" is usually
 * said *because* the general rules would have skipped it.
 *
 * Run: node tests/warm-policy.test.mjs
 */
import { decide, normalise, withTitle, titleKey, titleChoice, DEFAULT_POLICY } from '../services/warmPolicy.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const GB = 1024 ** 3;
const film = (over = {}) => ({
  filePath: 'C:/library/movies/Arrival (2016)/Arrival.mkv',
  size: 8 * GB,
  type: 'movie',
  tmdbId: 329865,
  ...over
});
const episode = (over = {}) => ({
  filePath: 'C:/library/shows/Severance/Season 01/Severance - S01E01.mkv',
  size: 4 * GB,
  type: 'episode',
  tmdbId: 95396,
  ...over
});

console.log('\nby default, everything');

check('a film is converted', decide(film(), null).warm === true);
check('an episode is converted', decide(episode(), null).warm === true);
check('even a very large one', decide(film({ size: 90 * GB }), null).warm === true);
check('an empty policy is the default', decide(film(), {}).warm === true);
// A malformed policy must not stop warming altogether: the failure mode here
// is silence, and silence should mean "carry on as before".
check('nonsense is the default too', decide(film(), 'not a policy').warm === true);
check('and so is a policy with a broken titles field',
  decide(film(), { titles: 'nope' }).warm === true);

console.log('\nby kind');

check('films can be turned off', decide(film(), { movies: false }).warm === false);
check('and say why', /films/.test(decide(film(), { movies: false }).reason));
check('without affecting shows', decide(episode(), { movies: false }).warm === true);
check('shows can be turned off', decide(episode(), { shows: false }).warm === false);
check('without affecting films', decide(film(), { shows: false }).warm === true);
// 'show' and 'episode' are the same thing to a rule: one names the library
// entry, the other names a file inside it.
check('a show and an episode are treated alike',
  decide(episode({ type: 'show' }), { shows: false }).warm === false);

console.log('\nby size');

check('over the limit is passed over', decide(film({ size: 40 * GB }), { maxBytes: 20 * GB }).warm === false);
check('and says why', /size limit/.test(decide(film({ size: 40 * GB }), { maxBytes: 20 * GB }).reason));
check('under it is converted', decide(film({ size: 8 * GB }), { maxBytes: 20 * GB }).warm === true);
check('exactly at it is converted', decide(film({ size: 20 * GB }), { maxBytes: 20 * GB }).warm === true);
// Zero is "no limit" rather than "convert nothing", which is what the stepper
// bottoming out at zero relies on.
check('a limit of zero is no limit', decide(film({ size: 90 * GB }), { maxBytes: 0 }).warm === true);
check('a negative limit is no limit', decide(film({ size: 90 * GB }), { maxBytes: -5 }).warm === true);

console.log('\nby path');

const excluded = { exclude: ['Extras', 'behind the scenes'] };
check('a matching path is passed over',
  decide(film({ filePath: 'C:/library/movies/Dune/Extras/deleted.mkv' }), excluded).warm === false);
check('matching ignores case',
  decide(film({ filePath: 'C:/library/movies/Dune/EXTRAS/x.mkv' }), excluded).warm === false);
check('and matches anywhere in the path',
  decide(film({ filePath: 'C:/Behind The Scenes/film.mkv' }), excluded).warm === false);
check('a non-matching path is fine', decide(film(), excluded).warm === true);
check('the reason names the pattern that did it',
  /Extras/.test(decide(film({ filePath: 'C:/x/Extras/y.mkv' }), excluded).reason));
check('an empty pattern is ignored rather than matching everything',
  decide(film(), { exclude: ['', '   '] }).warm === true);

console.log('\nby title, which beats everything');

const never = withTitle(null, 'movie', 329865, 'never');
check('never means never', decide(film(), never).warm === false);
// The point of a per-title rule: it is not overridden by the general ones.
check('even when the size rule would allow it',
  decide(film({ size: 1 * GB }), { ...never, maxBytes: 50 * GB }).warm === false);
check('and it says which rule did it', /this title/.test(decide(film(), never).reason));

const always = withTitle(null, 'movie', 329865, 'always');
check('always means always', decide(film({ size: 90 * GB }), { ...always, maxBytes: 5 * GB }).warm === true);
check('over a kind that is switched off',
  decide(film(), { ...always, movies: false }).warm === true);
check('and over a path exclusion',
  decide(film({ filePath: 'C:/x/Extras/y.mkv' }), { ...always, exclude: ['Extras'] }).warm === true);

check('a rule for one title does not touch another',
  decide(film({ tmdbId: 603 }), never).warm === true);
check('a show rule does not touch a film with the same id',
  decide(film({ tmdbId: 95396 }), withTitle(null, 'show', 95396, 'never')).warm === true);

console.log('\nkeeping the rules');

check('a show key names a show', titleKey('show', 1396) === 'show:1396');
check('an episode is filed under its show', titleKey('episode', 1396) === 'show:1396');
check('a film is its own key', titleKey('movie', 603) === 'movie:603');

{
  let policy = withTitle(null, 'show', 1396, 'never');
  check('reads back', titleChoice(policy, 'show', 1396) === 'never');

  policy = withTitle(policy, 'movie', 603, 'always');
  check('two rules coexist', Object.keys(policy.titles).length === 2);
  check('and neither disturbs the other', titleChoice(policy, 'show', 1396) === 'never');

  // Clearing removes the key rather than storing 'auto': absent already means
  // "follow the general rules", and two spellings of one thing is how a page
  // ends up disagreeing with itself.
  policy = withTitle(policy, 'show', 1396, 'auto');
  check('clearing removes it', Object.keys(policy.titles).length === 1);
  check('and it reads as auto', titleChoice(policy, 'show', 1396) === 'auto');
  check('an unknown title is auto', titleChoice(policy, 'movie', 999999) === 'auto');
}

console.log('\nnormalising');

const clean = normalise({ movies: false, maxBytes: '5', exclude: [' Extras ', ''], titles: { 'movie:1': 'never' } });
check('keeps a false', clean.movies === false);
check('defaults a missing field to on', clean.shows === true);
check('reads a numeric string', clean.maxBytes === 5);
check('trims patterns', clean.exclude[0] === 'Extras');
check('drops empty ones', clean.exclude.length === 1);
check('keeps titles', clean.titles['movie:1'] === 'never');
check('the default converts everything',
  DEFAULT_POLICY.movies && DEFAULT_POLICY.shows && DEFAULT_POLICY.maxBytes === 0);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
