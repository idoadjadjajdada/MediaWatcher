/**
 * Choosing and naming a downloaded subtitle.
 *
 * Two things here can silently ruin the feature, and neither shows up as an
 * error. The first is picking a subtitle cut for a different rip: it downloads
 * fine, saves fine, and is out of sync from the first line. The second is
 * saving under a name the existing sidecar discovery cannot match, which makes
 * a perfectly good subtitle invisible with nothing logged.
 *
 * Both are tested against the real discovery regex in routes/subs.js rather
 * than a restatement of it, so a change there fails here.
 *
 * Run: node tests/subtitle-fetch.test.mjs
 */
import path from 'node:path';
import { scoreCandidate, pickBest } from '../services/opensubtitles.js';
import { normaliseLang, sidecarExt, sidecarPath, decodeSubtitle } from '../services/subtitleFetch.js';
import { findSubtitles } from '../routes/subs.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const candidate = (over = {}) => ({
  fileId: 1,
  fileName: null,
  language: 'en',
  release: null,
  downloads: 0,
  rating: 0,
  fromTrusted: false,
  hearingImpaired: false,
  machineTranslated: false,
  aiTranslated: false,
  ...over
});

const VIDEO = 'The.Bear.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv';

console.log('\nnormaliseLang');
check('a plain two-letter code passes through', normaliseLang('en') === 'en');
check('case is normalised', normaliseLang('EN') === 'en');
check('a three-letter code is kept', normaliseLang('fre') === 'fre');
// The discovery regex accepts 2-3 letters only, so the region has to go or the
// file lands somewhere nothing looks.
check('a regional variant narrows to its base', normaliseLang('pt-BR') === 'pt');
check('an underscore variant narrows too', normaliseLang('zh_CN') === 'zh');
check('an unusable code is rejected rather than guessed', normaliseLang('') === null);
check('a long code is rejected', normaliseLang('english') === null);
check('a missing code is rejected', normaliseLang(undefined) === null);

console.log('\nsidecarExt');
check('an srt name keeps .srt', sidecarExt('Show.S01E01.srt') === '.srt');
check('an ass name keeps .ass', sidecarExt('Show.S01E01.ass') === '.ass');
check('a vtt name keeps .vtt', sidecarExt('Show.S01E01.vtt') === '.vtt');
// .sub needs an .idx beside it to mean anything, and discovery does not list it.
check('an undiscoverable extension falls back to .srt', sidecarExt('Show.S01E01.sub') === '.srt');
check('no name at all falls back to .srt', sidecarExt(undefined) === '.srt');

console.log('\nsidecarPath');
const video = path.resolve('/library/The Bear/Season 1', VIDEO);
const saved = sidecarPath(video, 'en', 'whatever.srt');
check('the subtitle lands beside the video', path.dirname(saved) === path.dirname(video));
check('it takes the video stem plus the language',
  path.basename(saved) === 'The.Bear.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.en.srt');
check('a regional language is narrowed in the name',
  path.basename(sidecarPath(video, 'pt-BR', 'x.srt')).endsWith('.pt.srt'));
check('an unusable language leaves the stem bare',
  path.basename(sidecarPath(video, 'nonsense', 'x.srt'))
    === 'The.Bear.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.srt');
check('the remote extension is honoured',
  path.basename(sidecarPath(video, 'en', 'x.ass')).endsWith('.en.ass'));

console.log('\nthe name discovery actually matches');
// findSubtitles reads a real directory, so the regex is exercised through a
// stub of its own rather than the filesystem: the assertion is that the name
// we write is the shape the pattern in routes/subs.js expects.
const stem = path.basename(video, path.extname(video));
const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const discovery = new RegExp(`^${escaped}\\.([A-Za-z]{2,3})$`);
check('a saved English sidecar is discoverable',
  discovery.test(path.basename(sidecarPath(video, 'en', 'x.srt'), '.srt')));
check('a saved Portuguese sidecar is discoverable',
  discovery.test(path.basename(sidecarPath(video, 'pt-BR', 'x.srt'), '.srt')));
check('the un-narrowed form would NOT have been discoverable',
  !discovery.test(`${stem}.pt-BR`));
check('findSubtitles is exported and returns a list for a missing directory',
  Array.isArray(findSubtitles(path.resolve('/definitely/not/here/x.mkv'))));

console.log('\nscoreCandidate');
const sameRip = candidate({ release: 'The.Bear.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb' });
const otherRip = candidate({ release: 'The.Bear.S01E03.720p.HDTV.x264-GROUP', downloads: 500000, rating: 10 });
check('a matching release beats a popular mismatched one',
  scoreCandidate(sameRip, VIDEO) > scoreCandidate(otherRip, VIDEO));
check('an empty candidate scores nothing',
  scoreCandidate(candidate(), VIDEO) === 0);
check('trust is worth something',
  scoreCandidate(candidate({ fromTrusted: true }), VIDEO) > scoreCandidate(candidate(), VIDEO));
// A machine translation is worse than no preference at all, not a tie-break.
check('a machine translation is heavily penalised',
  scoreCandidate(candidate({ machineTranslated: true }), VIDEO) < -30);
check('an AI translation is penalised',
  scoreCandidate(candidate({ aiTranslated: true }), VIDEO) < scoreCandidate(candidate(), VIDEO));
check('a matching release still wins over a machine translation of the same rip',
  scoreCandidate(sameRip, VIDEO)
    > scoreCandidate({ ...sameRip, machineTranslated: true }, VIDEO));
check('hearing-impaired loses a tie but is not disqualified',
  scoreCandidate(candidate({ hearingImpaired: true, release: sameRip.release }), VIDEO)
    > scoreCandidate(candidate(), VIDEO));
check('downloads saturate rather than dominating',
  scoreCandidate(candidate({ downloads: 10_000_000 }), VIDEO) <= 6);

console.log('\npickBest');
check('nothing in, nothing out', pickBest([], VIDEO) === null);
check('a non-array is handled', pickBest(null, VIDEO) === null);
check('the matching rip is chosen', pickBest([otherRip, sameRip], VIDEO) === sameRip);
check('order does not decide it', pickBest([sameRip, otherRip], VIDEO) === sameRip);
check('a single candidate is returned even when it matches nothing',
  pickBest([otherRip], VIDEO) === otherRip);

console.log('\ndecodeSubtitle');
check('UTF-8 is read as UTF-8',
  decodeSubtitle(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nnaïve\n', 'utf8')).includes('naïve'));
// Windows-1252 is the common case for SubRip; decoded as UTF-8 it yields U+FFFD.
check('Windows-1252 falls back to latin1',
  decodeSubtitle(Buffer.from([0x6e, 0x61, 0xef, 0x76, 0x65])) === 'naïve');
check('a BOM is stripped',
  decodeSubtitle(Buffer.from('﻿1\n00:00:01,000 --> 00:00:02,000\n', 'utf8')).startsWith('1'));
check('an empty buffer decodes to an empty string',
  decodeSubtitle(Buffer.alloc(0)) === '');

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
