/**
 * Remembering the audio and subtitle track per show.
 *
 * The bug this exists to prevent is quiet and specific. Embedded stream
 * numbering belongs to the file, not the show: one release muxes the
 * commentary second, the next muxes it fifth. Remember "track 2" on episode
 * one and episode two opens playing the commentary - correct-looking,
 * completely wrong, and with nothing logged.
 *
 * So the tests below are mostly about what must NOT be selected: a position
 * that no longer means what it meant, and a fallback that would pick a
 * language nobody asked for.
 *
 * Run: node tests/track-prefs.test.mjs
 */
import {
  prefsKey, matchAudio, matchSubtitle, describeAudio, describeSubtitle
} from '../public/js/track-prefs.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const audio = (...langs) => langs.map((language, i) => ({ language, index: i }));
const subs = (...pairs) => pairs.map(([lang, source]) => ({ lang, source }));

console.log('\nprefsKey');
check('an episode keys on its show',
  prefsKey({ type: 'episode', item: { tmdb_id: 1234 }, season: 2 }) === 'show:1234');
// Per show, not per season: the season must not change the key.
check('every season of a show shares one key',
  prefsKey({ type: 'episode', item: { tmdb_id: 1234 }, season: 1 })
  === prefsKey({ type: 'episode', item: { tmdb_id: 1234 }, season: 9 }));
check('a movie keys separately', prefsKey({ type: 'movie', item: { tmdb_id: 77 } }) === 'movie:77');
check('a show and a movie with the same id do not collide',
  prefsKey({ type: 'episode', item: { tmdb_id: 5 } }) !== prefsKey({ type: 'movie', item: { tmdb_id: 5 } }));
check('an unlocated file has no key', prefsKey(null) === null);
check('a title with no tmdb id has no key', prefsKey({ type: 'movie', item: {} }) === null);

console.log('\nmatchAudio');
check('the remembered language is found',
  matchAudio({ audioLang: 'jpn' }, audio('eng', 'jpn', 'eng')) === 1);
check('case does not matter',
  matchAudio({ audioLang: 'JPN' }, audio('eng', 'jpn')) === 1);
// The whole point: the same language sits at a different index here.
check('a differently muxed episode still finds the language',
  matchAudio({ audioLang: 'jpn', audioIndex: 1 }, audio('eng', 'commentary', 'eng', 'jpn')) === 3);
check('a missing language yields no opinion rather than a position',
  matchAudio({ audioLang: 'jpn', audioIndex: 1 }, audio('eng', 'fre')) === null);
check('an index is used when no language was ever recorded',
  matchAudio({ audioLang: null, audioIndex: 1 }, audio(null, null, null)) === 1);
check('an index past the end of a shorter file is rejected',
  matchAudio({ audioLang: null, audioIndex: 4 }, audio(null, null)) === null);
check('a negative index is rejected',
  matchAudio({ audioLang: null, audioIndex: -1 }, audio(null, null)) === null);
check('no preference yields no opinion', matchAudio(null, audio('eng')) === null);
check('an empty track list yields no opinion', matchAudio({ audioLang: 'eng' }, []) === null);
check('index 0 is a real answer, not a falsy one',
  matchAudio({ audioLang: null, audioIndex: 0 }, audio(null, null)) === 0);

console.log('\nmatchSubtitle');
check('both language and source match',
  matchSubtitle({ subtitleLang: 'en', subtitleSource: 'embedded' },
    subs(['fr', 'embedded'], ['en', 'embedded'])) === 1);
check('the language wins when the source moved',
  matchSubtitle({ subtitleLang: 'en', subtitleSource: 'external' },
    subs(['fr', 'embedded'], ['en', 'embedded'])) === 1);
// Someone who picked English must never silently get Spanish.
check('a missing language yields no opinion, not any subtitle',
  matchSubtitle({ subtitleLang: 'en', subtitleSource: 'embedded' },
    subs(['es', 'embedded'], ['fr', 'embedded'])) === null);
check('source alone decides only when no language was recorded',
  matchSubtitle({ subtitleLang: null, subtitleSource: 'external' },
    subs(['es', 'embedded'], ['fr', 'external'])) === 1);
// "Off" is a decision, and distinct from never having chosen.
check('off is remembered as off', matchSubtitle({ subtitleOff: true }, subs(['en', 'embedded'])) === -1);
check('off wins even with a language recorded',
  matchSubtitle({ subtitleOff: true, subtitleLang: 'en' }, subs(['en', 'embedded'])) === -1);
check('off applies even when the file has no subtitles at all',
  matchSubtitle({ subtitleOff: true }, []) === -1);
check('no preference yields no opinion', matchSubtitle(null, subs(['en', 'embedded'])) === null);
check('an empty preference yields no opinion',
  matchSubtitle({ subtitleOff: false, subtitleLang: null, subtitleSource: null }, subs(['en', 'embedded'])) === null);
check('an empty track list yields no opinion',
  matchSubtitle({ subtitleLang: 'en' }, []) === null);
check('index 0 is a real answer',
  matchSubtitle({ subtitleLang: 'en', subtitleSource: 'embedded' }, subs(['en', 'embedded'])) === 0);

console.log('\nthe three outcomes are distinguishable');
const off = matchSubtitle({ subtitleOff: true }, subs(['en', 'embedded']));
const none = matchSubtitle(null, subs(['en', 'embedded']));
const found = matchSubtitle({ subtitleLang: 'en' }, subs(['en', 'embedded']));
check('off, no-opinion and a hit are all different', off !== none && none !== found && off !== found);
check('off is -1 and no-opinion is null, so a truthiness test cannot confuse them',
  off === -1 && none === null);

console.log('\ndescribeAudio');
check('the language is recorded alongside the index',
  describeAudio(audio('eng', 'jpn'), 1).audioLang === 'jpn');
check('the index is recorded too', describeAudio(audio('eng', 'jpn'), 1).audioIndex === 1);
check('a track with no language records none',
  describeAudio(audio(null, null), 0).audioLang === null);
check('an out-of-range index records no language',
  describeAudio(audio('eng'), 5).audioLang === null);

console.log('\ndescribeSubtitle');
const described = describeSubtitle({ lang: 'en', source: 'external' });
check('language and source are recorded',
  described.subtitleLang === 'en' && described.subtitleSource === 'external');
check('and it is not marked off', described.subtitleOff === false);
check('no track means off', describeSubtitle(null).subtitleOff === true);
check('off records no language', describeSubtitle(null).subtitleLang === null);

console.log('\nround trip');
// What describe writes must be what match reads, or the feature is a no-op.
const tracks = subs(['en', 'embedded'], ['fr', 'external']);
check('a described choice matches itself back',
  matchSubtitle(describeSubtitle(tracks[1]), tracks) === 1);
const audioTracks = audio('eng', 'jpn');
check('a described audio choice matches itself back',
  matchAudio(describeAudio(audioTracks, 1), audioTracks) === 1);
check('and survives a reordered file',
  matchAudio(describeAudio(audioTracks, 1), audio('jpn', 'eng')) === 0);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
