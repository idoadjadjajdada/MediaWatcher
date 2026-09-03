/**
 * Handing a conversion to another machine.
 *
 * Two servers, no people: neither end holds a device cookie and neither can be
 * given one, so the whole arrangement rests on a shared secret and a signature
 * over the one file a worker is allowed to read. Those are what is tested
 * here — the encoding itself is ffmpeg's, and the protocol around it was
 * exercised by running a second server as a worker.
 *
 * Run: node tests/encode-farm.test.mjs
 */
process.env.ENCODE_SECRET = 'a-shared-secret-between-two-machines';
process.env.ENCODE_WORKERS = 'http://box2:3000, http://box3:3000/';
process.env.ENCODE_SELF_URL = 'http://box1:3000';

const farm = await import('../services/encodeFarm.js');
const config = (await import('../config/index.js')).default;

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nconfiguration');

check('is configured with a secret and a worker', farm.isConfigured() === true);
check('reads several workers', config.encode.workers.length === 2);
check('trims a trailing slash', config.encode.workers[1] === 'http://box3:3000');
check('and the whitespace around one', config.encode.workers[0] === 'http://box2:3000');

console.log('\nthe shared secret');

check('accepts the secret', farm.verifySecret(process.env.ENCODE_SECRET) === true);
check('rejects a different one', farm.verifySecret('not-the-secret') === false);
// Length is checked before the comparison, so a short guess cannot reveal how
// much of it was right by how long the answer took.
check('rejects a shorter one', farm.verifySecret('short') === false);
check('rejects nothing at all', farm.verifySecret('') === false);
check('rejects undefined', farm.verifySecret(undefined) === false);

console.log('\nsigning one file');

const file = 'C:/library/movies/Arrival/Arrival.mkv';
const expiresAt = Date.now() + 3600000;
const signature = farm.signSource(file, expiresAt);

check('signs', typeof signature === 'string' && signature.length > 20);
check('and verifies', farm.verifySource(file, expiresAt, signature) === true);

/*
 * The property that makes this a capability rather than a password: the
 * signature is over one path, so a worker given a link to one film cannot use
 * it to read another.
 */
check('does not verify a different file',
  farm.verifySource('C:/library/movies/Other/Other.mkv', expiresAt, signature) === false);

check('does not verify a moved expiry',
  farm.verifySource(file, expiresAt + 1000, signature) === false);
check('does not verify a tampered signature',
  farm.verifySource(file, expiresAt, `${signature.slice(0, -1)}x`) === false);
check('does not verify an absent signature',
  farm.verifySource(file, expiresAt, '') === false);

console.log('\nexpiry');

check('an expired link is refused',
  farm.verifySource(file, expiresAt, signature, { now: expiresAt + 1 }) === false);
check('and a live one is not',
  farm.verifySource(file, expiresAt, signature, { now: expiresAt - 1 }) === true);
check('a link with no expiry at all is refused',
  farm.verifySource(file, undefined, signature) === false);
check('so is one with nonsense in place of an expiry',
  farm.verifySource(file, 'soon', signature) === false);

console.log('\nsigning is stable');

check('the same input signs the same way', farm.signSource(file, expiresAt) === signature);
check('a different file signs differently',
  farm.signSource('C:/library/movies/Other.mkv', expiresAt) !== signature);
check('a different time signs differently',
  farm.signSource(file, expiresAt + 1) !== signature);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
