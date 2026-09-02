/**
 * VAPID signing.
 *
 * This is the part of Web Push that is hand-rolled here, so it is the part
 * that has to be right. Two things break silently if they are wrong and both
 * are checked: the signature has to be the raw r‖s pair rather than the DER
 * Node produces by default — every push service rejects DER as malformed — and
 * the application server key has to be the 65-byte uncompressed point, not the
 * SPKI wrapper around it.
 *
 * The signature is verified with Node's own verifier rather than being
 * compared against a fixture: a fixture would only prove the output has not
 * changed, and the question is whether it is valid.
 *
 * Run: node tests/webpush.test.mjs
 */
import { createVerify, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { signJwt, audienceFor } from '../services/webpush.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

// A keypair of this test's own, so nothing here touches the database or the
// server's real identity.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString());

console.log('\naudience');

check('is the origin of the endpoint',
  audienceFor('https://fcm.googleapis.com/fcm/send/abc123') === 'https://fcm.googleapis.com');
check('ignores the path entirely',
  audienceFor('https://updates.push.services.mozilla.com/wpush/v2/gAAA') === 'https://updates.push.services.mozilla.com');
check('keeps a port when there is one',
  audienceFor('https://push.example.com:8443/x') === 'https://push.example.com:8443');

console.log('\nthe token');

const now = Date.UTC(2026, 0, 1);
const jwt = signJwt('https://fcm.googleapis.com', { now, privatePem });
const [header, payload, signature] = jwt.split('.');

check('has three segments', jwt.split('.').length === 3);
check('declares ES256', decode(header).alg === 'ES256');
check('declares JWT', decode(header).typ === 'JWT');
check('carries the audience', decode(payload).aud === 'https://fcm.googleapis.com');
check('carries a contact', /^(mailto:|https:)/.test(decode(payload).sub));

// The spec caps a VAPID token at 24 hours and services reject longer ones.
const lifetime = decode(payload).exp - Math.floor(now / 1000);
check('expires in the future', lifetime > 0);
check('and within 24 hours', lifetime <= 24 * 60 * 60);

// Nothing may be base64 with padding or plus signs: these travel in a header.
check('is url-safe throughout', !/[+/=]/.test(jwt));

console.log('\nthe signature');

const raw = Buffer.from(signature, 'base64url');
/*
 * 64 bytes exactly. A DER signature is 70-72 bytes and starts with 0x30, and
 * it is what Node produces unless asked otherwise — this is the single easiest
 * thing to get wrong here, and it fails at the push service rather than at
 * home.
 */
check('is 64 bytes', raw.length === 64);
check('is not DER', raw[0] !== 0x30);

const verifier = createVerify('SHA256');
verifier.update(`${header}.${payload}`);
check('verifies against the public key',
  verifier.verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, raw));

{
  // Tampering has to fail, or the signature is decoration.
  const forged = decode(payload);
  forged.aud = 'https://somewhere.else';
  const swapped = Buffer.from(JSON.stringify(forged)).toString('base64url');
  const check2 = createVerify('SHA256');
  check2.update(`${header}.${swapped}`);
  check('does not verify a changed audience',
    !check2.verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, raw));
}

check('a different audience produces a different token',
  signJwt('https://updates.push.services.mozilla.com', { now, privatePem }) !== jwt);

console.log('\nthe application server key');

/*
 * The browser wants the raw uncompressed point: 0x04 and two 32-byte
 * coordinates. Handing it the SPKI DER instead is accepted by pushManager and
 * then produces subscriptions no push signed by this key can reach.
 */
const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
const point = der.subarray(der.length - 65);
check('is 65 bytes', point.length === 65);
check('starts with the uncompressed marker', point[0] === 0x04);
check('is shorter than the DER it came from', der.length > point.length);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
