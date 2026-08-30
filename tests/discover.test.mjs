/**
 * Discovery rails. Integration test against live TMDB and the real database,
 * matching the approach in tests/search-resolution.test.mjs.
 *
 * Run: npm test
 */
import { readDiscover, writeDiscover } from '../db/index.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ndiscover_cache');

const key = `test:${Date.now()}`;
check('a missing key reads as undefined', readDiscover(key, 60000) === undefined);

writeDiscover(key, { rails: [1, 2, 3] });
const stored = readDiscover(key, 60000);
check('a written payload reads back', stored && stored.rails.length === 3);

check('an expired entry reads as undefined', readDiscover(key, -1) === undefined);
check('a zero TTL expires immediately', readDiscover(key, 0) === undefined);

writeDiscover(key, { rails: ['replaced'] });
check('writing the same key replaces it', readDiscover(key, 60000).rails[0] === 'replaced');

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
