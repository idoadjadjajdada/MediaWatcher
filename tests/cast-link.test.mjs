/**
 * Signed cast links.
 *
 * A Chromecast fetches media itself, from a device that holds no cookie and
 * cannot be given one, so it carries a signature instead. That signature is
 * the only thing standing between "a Chromecast can play this film" and "any
 * device on the network can read the library", which makes it the part of
 * casting worth testing even though the casting itself cannot be.
 *
 * The property that matters: a signature is over one path. A link for one file
 * must not admit a request for another, or it is a password rather than a
 * capability.
 *
 * Run: node tests/cast-link.test.mjs
 */
process.env.BIND_HOST = '0.0.0.0';
process.env.CAST_ENABLED = '1';

const castLink = await import('../services/castLink.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/** An express-shaped request carrying whatever a link put in its query. */
function requestFor(url) {
  const parsed = new URL(url);
  return {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries())
  };
}

console.log('\nmaking a link');

const media = castLink.link('/api/stream?path=C:/lib/film.mkv');
check('is made at all', typeof media === 'string');
check('is absolute', /^http:\/\//.test(media));
// Never the tailnet hostname even when one is configured: a Chromecast is not
// on the tailnet, and handing it that name produces a device that spins.
check('names an address rather than a hostname', /^http:\/\/\d+\.\d+\.\d+\.\d+:/.test(media));
check('keeps the original query', media.includes('path=C%3A%2Flib%2Ffilm.mkv') || media.includes('path=C:/lib/film.mkv'));
check('carries an expiry', /castExp=\d+/.test(media));
check('carries a signature', /castSig=/.test(media));

console.log('\nusing one');

check('a fresh link verifies', castLink.verify(requestFor(media)) === true);

{
  // The whole point of signing the path: a link for one file admits a request
  // for that file and nothing else.
  const request = requestFor(media);
  request.path = '/api/stream/../../etc/passwd';
  check('the signature does not travel to another path', castLink.verify(request) === false);
}

{
  const request = requestFor(media);
  request.query.castSig = `${request.query.castSig.slice(0, -1)}x`;
  check('a tampered signature is refused', castLink.verify(request) === false);
}

{
  // Moving the expiry forward has to invalidate it, or the expiry is decoration.
  const request = requestFor(media);
  request.query.castExp = String(Number(request.query.castExp) + 86400000);
  check('the expiry is signed too', castLink.verify(request) === false);
}

{
  const request = requestFor(media);
  const expired = Number(request.query.castExp) + 1000;
  check('an expired link is refused', castLink.verify(request, { now: expired }) === false);
  check('and a live one is not', castLink.verify(request, { now: Date.now() }) === true);
}

check('a request with no signature is refused',
  castLink.verify({ path: '/api/stream', query: {} }) === false);
check('nor does an expiry alone do anything',
  castLink.verify({ path: '/api/stream', query: { castExp: String(Date.now() + 10000) } }) === false);

console.log('\nwhat may be signed');

check('the stream endpoint may', castLink.link('/api/stream?path=x') !== null);
check('an hls segment may', castLink.link('/api/hls/abc/1.ts') !== null);
check('a subtitle may', castLink.link('/api/subs?path=x') !== null);
// Everything else is refused at the point of signing rather than at the point
// of use: a link to the settings API should never exist in the first place.
check('the library may not', castLink.link('/api/media/library') === null);
check('the admin api may not', castLink.link('/api/admin/env') === null);
check('the device list may not', castLink.link('/api/devices') === null);

console.log('\nthe link lives long enough');

// Long enough for a film and a pause for dinner. A link that dies mid-stream
// is the one failure this must not have.
check('at least four hours', castLink.TTL_MS >= 4 * 60 * 60 * 1000);
check('and not indefinitely', castLink.TTL_MS <= 24 * 60 * 60 * 1000);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
