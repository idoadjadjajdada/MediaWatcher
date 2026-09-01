/**
 * The loopback trap.
 *
 * tailscale serve terminates TLS and proxies to 127.0.0.1, so every remote
 * request reaches Express looking like it came from the local machine. Any
 * "trust loopback" shortcut therefore disables authentication for exactly the
 * traffic the gate exists to stop — and would look perfectly correct in local
 * testing. This file exists to make that regression impossible to land.
 *
 * Run: node tests/auth-loopback.test.mjs
 */
import { isAllowlisted } from '../middleware/requireAuth.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nallowlist');
check('the login page is reachable unauthenticated', isAllowlisted('GET', '/login.html') === true);
check('the login script is reachable', isAllowlisted('GET', '/js/login.js') === true);
check('the login stylesheet is reachable', isAllowlisted('GET', '/css/login.css') === true);
check('the login endpoint is reachable', isAllowlisted('POST', '/api/auth/login') === true);
check('health is reachable so the launcher can poll it',
  isAllowlisted('GET', '/api/health') === true);

check('the library is NOT reachable', isAllowlisted('GET', '/api/media/library') === false);
check('streaming is NOT reachable', isAllowlisted('GET', '/api/stream') === false);
check('the app shell is NOT reachable', isAllowlisted('GET', '/') === false);
check('the app script is NOT reachable', isAllowlisted('GET', '/js/app.js') === false);
check('the device list is NOT reachable', isAllowlisted('GET', '/api/devices') === false);

// A path that merely starts with an allowlisted prefix must not slip through.
check('a lookalike path is NOT reachable',
  isAllowlisted('GET', '/js/login.js.map') === false);
check('a traversal dressed as the login page is NOT reachable',
  isAllowlisted('GET', '/login.html/../js/app.js') === false);

// Method matters: the login path must not become a GET-able hole.
check('GET on the login endpoint is NOT allowlisted',
  isAllowlisted('GET', '/api/auth/login') === false);

console.log('\nloopback is not a credential');
// The gate takes no IP argument at all. If someone adds one, this fails to
// compile the intent: there is no code path where an address grants access.
check('isAllowlisted decides on method and path alone', isAllowlisted.length === 2);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
