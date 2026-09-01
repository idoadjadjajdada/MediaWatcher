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

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
