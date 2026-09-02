/**
 * Learning where the intro is.
 *
 * The library gives us nothing to work with — every file titles its chapters
 * "Chapter 1" — so the intro has to be inferred from the one signal that is
 * always available: you skipping it. Skip once, and every later episode of that
 * season offers the same jump.
 *
 * The risk worth testing against is a false positive. Offering to skip into the
 * middle of a scene is worse than never offering at all, so a single skip is
 * not enough and skips that disagree produce nothing.
 *
 * Run: node tests/intro.test.mjs
 */
import {
  introKey, isCandidateSkip, agreeOnIntro, shouldOfferSkip,
  INTRO_WINDOW_SECONDS, MIN_INTRO_SECONDS, MAX_INTRO_SECONDS, AGREEMENT_TOLERANCE
} from '../services/intro.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nintroKey');
const episode = { type: 'episode', item: { tmdb_id: 1234 }, season: 1 };
check('an episode keys on show and season',
  introKey(episode) === 'show:1234:s1');
check('a different season is a different key',
  introKey({ ...episode, season: 2 }) === 'show:1234:s2');
// Seasons often change their titles, so they must not share a marker.
check('season two does not inherit season one',
  introKey(episode) !== introKey({ ...episode, season: 2 }));
check('a movie has no intro to learn', introKey({ type: 'movie', item: { tmdb_id: 9 } }) === null);
check('an unlocated file has no key', introKey(null) === null);
check('a show with no id has no key',
  introKey({ type: 'episode', item: {}, season: 1 }) === null);

console.log('\nisCandidateSkip');
const skip = (over) => isCandidateSkip({ from: 20, to: 90, duration: 1400, ...over });

check('a forward skip early on counts', skip() === true);
check('skipping backwards never counts', skip({ from: 200, to: 20 }) === false);
check('a skip that goes nowhere does not count', skip({ from: 60, to: 60 }) === false);
// A ten-second nudge is someone adjusting, not skipping an intro.
check('a very short jump does not count',
  skip({ from: 20, to: 20 + MIN_INTRO_SECONDS - 1 }) === false);
check('a jump at the minimum length counts',
  skip({ from: 20, to: 20 + MIN_INTRO_SECONDS + 1 }) === true);
// Jumping ten minutes in is finding your place, not skipping a title sequence.
check('an enormous jump does not count',
  skip({ from: 20, to: 20 + MAX_INTRO_SECONDS + 60 }) === false);
check('a skip beginning past the intro window does not count',
  skip({ from: INTRO_WINDOW_SECONDS + 30, to: INTRO_WINDOW_SECONDS + 120 }) === false);
check('a skip landing past the window does not count',
  skip({ from: 10, to: INTRO_WINDOW_SECONDS + 120 }) === false);
// Guard against nonsense from a stalled player.
check('a non-finite position does not count', skip({ from: NaN }) === false);
check('a missing duration does not count', skip({ duration: 0 }) === false);

console.log('\nagreeOnIntro');
const at = (to, from = 15) => ({ from, to });

// One person skipping once could have been skipping anything.
check('a single skip is not enough', agreeOnIntro([at(90)]) === null);
check('nothing at all yields nothing', agreeOnIntro([]) === null);
check('null yields nothing', agreeOnIntro(null) === null);

const agreed = agreeOnIntro([at(90), at(92)]);
check('two close skips agree', agreed !== null);
check('the marker ends where the skips landed',
  agreed && Math.abs(agreed.end - 91) <= 2, agreed);
check('the marker starts at the earliest skip point',
  agreed && agreed.start <= 15, agreed);

check('two skips far apart do not agree',
  agreeOnIntro([at(30), at(200)]) === null);
// Two agreeing plus one outlier is still a real pattern.
const withOutlier = agreeOnIntro([at(88), at(90), at(400)]);
check('an outlier does not spoil a real agreement', withOutlier !== null);
check('and does not drag the marker toward itself',
  withOutlier && withOutlier.end < 120, withOutlier);
check('skips exactly at the tolerance edge agree',
  agreeOnIntro([at(90), at(90 + AGREEMENT_TOLERANCE)]) !== null);
check('skips beyond the tolerance do not',
  agreeOnIntro([at(90), at(90 + (AGREEMENT_TOLERANCE * 3))]) === null);

console.log('\nshouldOfferSkip');
const marker = { start: 10, end: 92 };
check('offered just before the intro', shouldOfferSkip(marker, 8) === true);
check('offered at the start', shouldOfferSkip(marker, 10) === true);
check('offered during the intro', shouldOfferSkip(marker, 50) === true);
// Once past it there is nothing to skip.
check('not offered after the intro', shouldOfferSkip(marker, 120) === false);
check('not offered right at the end', shouldOfferSkip(marker, 92) === false);
check('not offered long before', shouldOfferSkip(marker, 0) === true);
check('no marker means no offer', shouldOfferSkip(null, 50) === false);
check('a nonsense position never offers', shouldOfferSkip(marker, NaN) === false);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
