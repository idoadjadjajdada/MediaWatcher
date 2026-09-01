/**
 * Remote detection and the quality ladder.
 *
 * Run: node tests/remote-quality.test.mjs
 */
import { isTailscaleAddress, classifyOrigin } from '../services/network.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ntailscale address detection');
// 100.64.0.0/10 spans 100.64.x.x through 100.127.x.x.
check('100.64.0.1 is tailscale', isTailscaleAddress('100.64.0.1') === true);
check('100.101.102.103 is tailscale', isTailscaleAddress('100.101.102.103') === true);
check('100.127.255.254 is the top of the range', isTailscaleAddress('100.127.255.254') === true);
check('100.63.255.255 is below the range', isTailscaleAddress('100.63.255.255') === false);
check('100.128.0.0 is above the range', isTailscaleAddress('100.128.0.0') === false);

check('a LAN address is not tailscale', isTailscaleAddress('192.168.1.20') === false);
check('loopback is not tailscale', isTailscaleAddress('127.0.0.1') === false);
check('a 10.x address is not tailscale', isTailscaleAddress('10.0.0.5') === false);
check('a public address is not tailscale', isTailscaleAddress('8.8.8.8') === false);

// Express reports loopback as ::ffff:127.0.0.1 on a dual-stack listener, and
// the same mapping applies to any forwarded v4 address.
check('an IPv4-mapped IPv6 tailscale address is detected',
  isTailscaleAddress('::ffff:100.90.1.1') === true);
check('an IPv4-mapped loopback is not tailscale',
  isTailscaleAddress('::ffff:127.0.0.1') === false);

check('null is not tailscale', isTailscaleAddress(null) === false);
check('undefined is not tailscale', isTailscaleAddress(undefined) === false);
check('nonsense is not tailscale', isTailscaleAddress('not-an-ip') === false);
check('a partial address is not tailscale', isTailscaleAddress('100.64') === false);
// Octet bounds must be enforced or 100.999.0.1 would parse as in-range.
check('an out-of-range octet is rejected', isTailscaleAddress('100.999.0.1') === false);

console.log('\norigin classification');
check('tailscale addresses classify as tailscale',
  classifyOrigin('100.100.1.1') === 'tailscale');
check('LAN addresses classify as lan', classifyOrigin('192.168.1.20') === 'lan');
check('loopback classifies as lan', classifyOrigin('127.0.0.1') === 'lan');
check('an unknown address classifies as lan', classifyOrigin(null) === 'lan');

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
