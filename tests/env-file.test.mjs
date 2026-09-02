/**
 * Reading and rewriting `.env`.
 *
 * The requirement that matters is that nothing is ever lost: comments,
 * ordering and unrelated keys survive a write, secrets do not leave in the
 * clear, and a masked value coming back means "unchanged" rather than a
 * literal row of dots. A settings page that can corrupt the settings file is
 * worse than no settings page.
 *
 * Run: node tests/env-file.test.mjs
 */
import {
  parseEnvText, serialiseEnv, applyChanges, validate, isSecret, MASK, REQUIRED
} from '../services/envFile.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const SAMPLE = [
  '# MediaWatcher configuration',
  '',
  '# Required. Metadata.',
  'TMDB_API_KEY=abc123',
  'ALLDEBRID_API_KEY=def456',
  'AUTH_PASSWORD=hunter22',
  '',
  '# Where your media lives',
  'LIBRARY_PATH=./library        # Where your media files live',
  'PORT=3000',
  'EMPTY_ONE=',
  'QUOTED="value with spaces"',
  'not a pair at all'
].join('\n');

console.log('\nparsing');

const lines = parseEnvText(SAMPLE);
const pairs = lines.filter((line) => line.kind === 'pair');
check('finds every pair', pairs.length === 7);
check('keeps the comments', lines.filter((line) => line.kind === 'comment').length === 3);
check('keeps the blank lines', lines.filter((line) => line.kind === 'blank').length === 2);
check('a line with no = is not a pair',
  lines.some((line) => line.kind === 'other' && line.raw === 'not a pair at all'));
check('reads a value', pairs.find((p) => p.key === 'PORT').value === '3000');
check('an empty value is still a pair', pairs.find((p) => p.key === 'EMPTY_ONE').value === '');
// dotenv strips one layer of quotes, so round-tripping has to agree with it or
// a quoted value gains a pair of quotes on every save.
check('strips matching quotes', pairs.find((p) => p.key === 'QUOTED').value === 'value with spaces');

console.log('\nround-tripping');

const rewritten = serialiseEnv(parseEnvText(SAMPLE));
check('keeps every comment', rewritten.includes('# Where your media lives'));
check('keeps the non-pair line', rewritten.includes('not a pair at all'));
// dotenv reads an unquoted value up to the end of the line, so interior
// spaces need no quotes and adding them would change the value on every save.
check('does not quote a value with interior spaces', rewritten.includes('QUOTED=value with spaces'));
check('does not quote one that needs nothing', rewritten.includes('PORT=3000'));
check('quotes a value whose # could be read as a comment',
  serialiseEnv(parseEnvText('KEY="a # b"')).includes('KEY="a # b"'));
check('quotes a value with a trailing space',
  serialiseEnv(parseEnvText('KEY="a "')).includes('KEY="a "'));
// A file ending in a newline must not gain a blank line per save.
check('a second round trip changes nothing',
  serialiseEnv(parseEnvText(rewritten)) === rewritten);
check('and a third', serialiseEnv(parseEnvText(serialiseEnv(parseEnvText(rewritten)))) === rewritten);

console.log('\ninline comments');

/*
 * Nearly every line in .env.example documents itself with a trailing comment,
 * and dotenv stops the value at the whitespace before the #. Reading the whole
 * tail as the value put the comment inside the input box - and then saving any
 * other key rewrote this one with the comment quoted into the value, silently
 * pointing the library at a path that does not exist.
 */
{
  const withComment = parseEnvText('LIBRARY_PATH=./library        # Where your media files live');
  check('the value stops before the comment', withComment[0].value === './library');
  check('and the comment is kept', withComment[0].comment.includes('Where your media files live'));
  check('and is put back exactly where it was',
    serialiseEnv(withComment) === 'LIBRARY_PATH=./library        # Where your media files live\n');
  check('so the comment is never quoted into the value',
    !serialiseEnv(withComment).includes('"./library'));
}

{
  // No whitespace before it, so it is part of the value - which is how a
  // password containing a hash survives being read back.
  const hashInValue = parseEnvText('AUTH_PASSWORD=abc#def');
  check('a # with no space before it is part of the value', hashInValue[0].value === 'abc#def');
  check('and round-trips unchanged', serialiseEnv(hashInValue) === 'AUTH_PASSWORD=abc#def\n');
}

{
  const quotedHash = parseEnvText('KEY="a # b"   # trailing');
  check('a # inside quotes is content', quotedHash[0].value === 'a # b');
  check('and a comment after them is still a comment', quotedHash[0].comment.includes('trailing'));
  check('both survive a round trip', serialiseEnv(quotedHash) === 'KEY="a # b"   # trailing\n');
}

{
  const empty = parseEnvText('SOMETHING=   # not set yet');
  check('a commented empty value is empty', empty[0].value === '');
  check('and keeps its comment', empty[0].comment.includes('not set yet'));
}

console.log('\napplying changes');

{
  const { lines: updated, applied } = applyChanges(parseEnvText(SAMPLE), { PORT: '8080' });
  check('reports what it changed', applied.length === 1 && applied[0] === 'PORT');
  check('changes the value', serialiseEnv(updated).includes('PORT=8080'));
  check('leaves everything else alone',
    serialiseEnv(updated).includes('LIBRARY_PATH=./library        # Where your media files live'));
  check('and the comments', serialiseEnv(updated).includes('# MediaWatcher configuration'));
}

{
  // The property that keeps a secret a secret: the page never receives the
  // real value, so it echoes back the mask, and that must not be written.
  const { lines: updated, applied } = applyChanges(parseEnvText(SAMPLE), { TMDB_API_KEY: MASK });
  check('a masked value is not a change', applied.length === 0);
  check('and the real value survives', serialiseEnv(updated).includes('TMDB_API_KEY=abc123'));
}

{
  const { applied } = applyChanges(parseEnvText(SAMPLE), { PORT: '3000' });
  check('setting a value to what it already is is not a change', applied.length === 0);
}

{
  const { lines: updated, applied } = applyChanges(parseEnvText(SAMPLE), { TAILNET_HOST: 'box.ts.net' });
  check('a key that is not there yet is appended', applied[0] === 'TAILNET_HOST');
  check('and appears in the output', serialiseEnv(updated).includes('TAILNET_HOST=box.ts.net'));
}

{
  const { applied } = applyChanges(parseEnvText(SAMPLE), { PORT: '8080', LIBRARY_PATH: '/media' });
  check('several at once', applied.length === 2);
}

console.log('\nvalidation');

check('a required key cannot be emptied', validate('TMDB_API_KEY', '') !== null);
check('every required key is checked', REQUIRED.every((key) => validate(key, '') !== null));
check('a short password is refused', validate('AUTH_PASSWORD', 'short') !== null);
check('an eight-character password is fine', validate('AUTH_PASSWORD', 'eightch8') === null);
// The mask is not a password, and validating it as one would refuse every save
// that left the password alone.
check('a masked password is not measured', validate('AUTH_PASSWORD', MASK) === null);
check('a numeric setting must be numeric', validate('PORT', 'nope') !== null);
check('and accepts a number', validate('PORT', '8080') === null);
check('an interval must be numeric', validate('SCAN_INTERVAL_MS', 'soon') !== null);
check('a size must be numeric', validate('MP4_CACHE_MAX_GB', 'lots') !== null);
check('an empty optional value is allowed', validate('TAILNET_HOST', '') === null);
// A line break would write a second, bogus line into the file.
check('a line break is refused', validate('LIBRARY_PATH', 'a\nb') !== null);
check('an ordinary value passes', validate('LIBRARY_PATH', 'D:/media') === null);

console.log('\nsecrets');

check('an api key is secret', isSecret('TMDB_API_KEY'));
check('a password is secret', isSecret('AUTH_PASSWORD'));
check('a token is secret', isSecret('SOME_TOKEN'));
check('a path is not', !isSecret('LIBRARY_PATH'));
check('a port is not', !isSecret('PORT'));
// Named for what it is rather than what it contains: JACKETT_URL holds a host,
// and masking it would hide something people need to read.
check('a url is not', !isSecret('JACKETT_URL'));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
