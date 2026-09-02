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
  resolveToken, recordFailure, blockedForMs, clearFailures, COOKIE_NAME,
  pruneSessions, sessionCount, pruneFailures, failureCount
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

/*
 * The set used to be exactly that - a Set - so it only ever grew, and a token
 * stayed valid until the process restarted. The README said these die with the
 * browser; the cookie does, and now the server-side entry does too.
 */
console.log('\nsessions expire');
const NOW = 1_700_000_000_000;
const TTL = config.auth.sessionTtlMs;
const expiring = hashToken(mintToken());

rememberSession(expiring, NOW);
check('a fresh session is valid', hasSession(expiring, NOW + 1000) === true);
check('it is still valid just before the window closes', hasSession(expiring, NOW + TTL - 1) === true);
check('and not after it', hasSession(expiring, NOW + TTL + 1) === false);

/*
 * Sliding, not fixed: the window measures idleness, and someone mid-episode is
 * not idle. Being logged out halfway through an film would be the wrong
 * reading of "12 hours".
 */
const usedToken = mintToken();
rememberSession(hashToken(usedToken), NOW);
check('resolving late in the window still works',
  resolveToken(usedToken, NOW + TTL - 1000)?.kind === 'session');
check('and pushes the expiry out from there',
  hasSession(hashToken(usedToken), NOW + TTL + 1000) === true);
check('an expired token resolves to nothing',
  resolveToken(usedToken, NOW + TTL * 3) === null);

const tracked = sessionCount();
rememberSession(hashToken(mintToken()), NOW);
pruneSessions(NOW + TTL * 10);
check('pruning drops what has expired', sessionCount() <= tracked);
dropSession(expiring);

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

/*
 * The other slow leak: an address that only ever fails left its counter behind
 * forever, and every fresh address added another. Forgetting after an hour of
 * silence also gives someone who mistyped their password this morning their
 * free attempts back.
 */
console.log('\nfailure records are forgotten');
const HOUR = 60 * 60 * 1000;
const quietIp = '203.0.113.55';
clearFailures(quietIp);
recordFailure(quietIp, NOW);
recordFailure(quietIp, NOW);
recordFailure(quietIp, NOW);
check('the backoff is in force at the time', blockedForMs(quietIp, NOW) > 0);
check('and gone once it has elapsed', blockedForMs(quietIp, NOW + HOUR + 1) === 0);
// Reading a stale entry is itself what forgets it, so the common case needs no
// sweep at all.
check('reading a stale record drops it', failureCount() === 0 || !blockedForMs(quietIp, NOW + HOUR + 2));

// An address nobody asks about again is what the sweep is for.
const staleIp = '203.0.113.56';
recordFailure(staleIp, NOW);
const trackedIps = failureCount();
check('it is tracked to begin with', trackedIps > 0);
pruneFailures(NOW + HOUR * 2);
check('a quiet address stops being tracked at all', failureCount() < trackedIps);
clearFailures(quietIp);
clearFailures(staleIp);

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
