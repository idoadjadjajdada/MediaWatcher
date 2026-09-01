/**
 * Device store and authentication primitives.
 *
 * The device row is the credential, so these cover the properties that make
 * that safe: only hashes are persisted, revocation is immediate, and a token
 * that was never issued never resolves.
 *
 * Run: node tests/auth.test.mjs
 */
import { randomUUID } from 'node:crypto';
import {
  insertDevice, findDeviceByTokenHash, touchDevice, listDevices, revokeDevice
} from '../db/devices.js';
import {
  mintToken, hashToken, parseCookies, rememberSession, hasSession, dropSession,
  resolveToken, recordFailure, blockedForMs, clearFailures, COOKIE_NAME
} from '../services/auth.js';
import config from '../config/index.js';
import { isAdminRequest } from '../routes/devices.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const makeDevice = (over = {}) => ({
  id: randomUUID(),
  tokenHash: `hash-${randomUUID()}`,
  name: 'Test iPad',
  userAgent: 'Mozilla/5.0 (iPad)',
  ip: '100.101.102.103',
  origin: 'tailscale',
  ...over
});

console.log('\ndevice store');

const device = makeDevice();
insertDevice(device);

const found = findDeviceByTokenHash(device.tokenHash);
check('a stored device is found by its token hash', found?.id === device.id);
check('the name round-trips', found?.name === 'Test iPad');
check('origin round-trips', found?.origin === 'tailscale');
check('first_seen is populated', Number.isFinite(found?.first_seen) && found.first_seen > 0);
check('an unknown hash resolves to nothing', !findDeviceByTokenHash('nope'));

// last_seen must move or the launcher list is useless for spotting activity.
const before = found.last_seen;
touchDevice(device.id, { ip: '192.168.1.50', origin: 'lan' });
const touched = findDeviceByTokenHash(device.tokenHash);
check('touch updates last_ip', touched.last_ip === '192.168.1.50');
check('touch rewrites origin so a roaming device reports where it is now',
  touched.origin === 'lan');
check('touch never moves first_seen', touched.first_seen === found.first_seen);
check('touch does not move last_seen backwards', touched.last_seen >= before);

check('the device appears in the list',
  listDevices().some((row) => row.id === device.id));

check('revoking reports success', revokeDevice(device.id) === true);
check('a revoked device no longer resolves', !findDeviceByTokenHash(device.tokenHash));
check('revoking twice reports failure', revokeDevice(device.id) === false);

console.log('\ntokens');
const tokenA = mintToken();
const tokenB = mintToken();
check('a token is 64 hex characters', /^[0-9a-f]{64}$/.test(tokenA));
check('two tokens differ', tokenA !== tokenB);
check('hashing is stable', hashToken(tokenA) === hashToken(tokenA));
check('the hash is not the token', hashToken(tokenA) !== tokenA);
check('different tokens hash differently', hashToken(tokenA) !== hashToken(tokenB));

console.log('\ncookie parsing');
check('reads one cookie', parseCookies('mw_device=abc').mw_device === 'abc');
check('reads several', parseCookies('a=1; mw_device=xyz; b=2').mw_device === 'xyz');
check('tolerates no header', Object.keys(parseCookies(undefined)).length === 0);
check('tolerates an empty header', Object.keys(parseCookies('')).length === 0);
check('decodes percent-encoding', parseCookies('k=a%20b').k === 'a b');
check('ignores a malformed pair', parseCookies('novalue; k=1').k === '1');
check('the cookie name is exported', COOKIE_NAME === 'mw_device');

console.log('\nsessions');
const sessionToken = mintToken();
check('an unknown token has no session', hasSession(hashToken(sessionToken)) === false);
rememberSession(hashToken(sessionToken));
check('a remembered session is found', hasSession(hashToken(sessionToken)) === true);
check('resolveToken reports a session', resolveToken(sessionToken)?.kind === 'session');
dropSession(hashToken(sessionToken));
check('a dropped session is gone', hasSession(hashToken(sessionToken)) === false);
check('resolveToken rejects an unissued token', resolveToken(mintToken()) === null);

// A persistent device must win over the session path.
const persistentToken = mintToken();
const persistentDevice = makeDevice({ tokenHash: hashToken(persistentToken) });
insertDevice(persistentDevice);
const resolved = resolveToken(persistentToken);
check('resolveToken reports a device', resolved?.kind === 'device');
check('resolveToken hands back the row', resolved?.device?.name === 'Test iPad');
// This runs against the real database, and the device list is an audit
// surface: a test that leaves rows behind is a test that trains you to ignore
// unfamiliar entries, which is the one habit it exists to prevent.
revokeDevice(persistentDevice.id);
check('the test device is cleaned up',
  !findDeviceByTokenHash(persistentDevice.tokenHash));

console.log('\nfailed-attempt backoff');
const ip = '203.0.113.9';
clearFailures(ip);
check('a clean IP is not blocked', blockedForMs(ip) === 0);
recordFailure(ip);
recordFailure(ip);
check('two failures are still free', blockedForMs(ip) === 0);
recordFailure(ip);
check('the third failure starts the backoff', blockedForMs(ip) > 0);
const afterThree = blockedForMs(ip);
recordFailure(ip);
check('the backoff grows', blockedForMs(ip) > afterThree);
clearFailures(ip);
check('a success clears the record', blockedForMs(ip) === 0);

console.log('\nadmin key');
check('an admin key exists', /^[0-9a-f]{64}$/.test(config.auth.adminKey));
check('the correct key is accepted',
  isAdminRequest({ headers: { 'x-mediawatcher-key': config.auth.adminKey } }) === true);
check('a wrong key of the same length is rejected',
  isAdminRequest({ headers: { 'x-mediawatcher-key': 'a'.repeat(64) } }) === false);
check('a missing key is rejected', isAdminRequest({ headers: {} }) === false);
check('an empty key is rejected',
  isAdminRequest({ headers: { 'x-mediawatcher-key': '' } }) === false);
check('a short key is rejected without throwing',
  isAdminRequest({ headers: { 'x-mediawatcher-key': 'abc' } }) === false);
// A signed-in device must not be able to enumerate or revoke the others.
check('a device cookie is not admin',
  isAdminRequest({ headers: {}, device: { id: 'x', name: 'iPad' } }) === false);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
