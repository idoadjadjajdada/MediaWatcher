/**
 * The pooled segment store.
 *
 * Touches a real filesystem because that is the whole subject: whether a
 * finished segment can be handed to a second session without re-encoding it,
 * and whether the pool stays inside its budget. Everything is written under a
 * temporary directory that is removed at the end.
 *
 * Run: node tests/hls-pool.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-hls-pool-'));
// segmentStore reads config.hls.dir at call time, so pointing the cache at the
// scratch directory has to happen before config is imported.
process.env.HLS_CACHE_DIR = path.join(scratch, 'hls');

const config = (await import('../config/index.js')).default;
const store = await import('../services/hls/segmentStore.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const KEY = 'a'.repeat(32);
const sessionDir = path.join(scratch, 'session');
fs.mkdirSync(sessionDir, { recursive: true });

/** A segment-shaped file of a known size. */
function writeSegment(file, bytes = 1024) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

console.log(`\npool at ${store.storeDir()}`);
check('lives under the hls cache', store.storeDir().startsWith(config.hls.dir));

console.log('\npublish and borrow');

const source = writeSegment(path.join(sessionDir, '12.ts'), 2048);

check('a segment that was never published is a miss', store.has(KEY, 12) === false);
check('borrowing a miss reports it', store.borrow(KEY, 12, path.join(scratch, 'nope.ts')) === false);
check('publishing succeeds', store.publish(KEY, 12, source) === true);
check('and the segment is then in the pool', store.has(KEY, 12) === true);
check('publishing the same segment twice is fine', store.publish(KEY, 12, source) === true);

const borrowed = path.join(scratch, 'other-session', '12.ts');
check('a second session can borrow it', store.borrow(KEY, 12, borrowed) === true);
check('and gets the same bytes', fs.readFileSync(borrowed).equals(fs.readFileSync(source)));

/*
 * The property that makes this safe: a session pruning its own directory must
 * not reach into the pool. Each holds its own link to the same data.
 */
fs.unlinkSync(source);
check('the pool survives the session that published it', store.has(KEY, 12) === true);
check('and can still be borrowed afterwards',
  store.borrow(KEY, 12, path.join(scratch, 'third', '12.ts')) === true);

// A borrow into a path that already holds a segment leaves it alone rather
// than failing: the session already has what it asked for.
check('borrowing over an existing file is a no-op', store.borrow(KEY, 12, borrowed) === true);

console.log('\nsize');

const measured = store.size();
check('counts the pooled segment', measured.files === 1);
check('counts its bytes', measured.bytes === 2048);

console.log('\nsweeping');

// Six segments of 1 KB each, published oldest first.
const KEY2 = 'b'.repeat(32);
for (let index = 0; index < 6; index += 1) {
  store.publish(KEY2, index, writeSegment(path.join(sessionDir, `s${index}.ts`), 1024));
}
check('all six are pooled', store.size().files === 7);

// Nothing to do while the pool is inside its budget.
const noop = store.sweep(1024 * 1024);
check('a pool under budget is left alone', noop.removed === 0);

const trimmed = store.sweep(3 * 1024);
check('trims down to the budget', store.size().bytes <= 3 * 1024);
check('reports what it removed', trimmed.removed > 0 && trimmed.bytes > 0);

// A budget of nothing empties it, and the empty key directories go too.
store.sweep(0);
check('a zero budget empties the pool', store.size().files === 0);
check('and leaves no empty key directories behind',
  fs.readdirSync(store.storeDir()).length === 0);

console.log('\nfailure is never fatal');

check('publishing a file that does not exist reports failure',
  store.publish(KEY, 99, path.join(scratch, 'missing.ts')) === false);
check('publishing without a key reports failure', store.publish('', 1, source) === false);
check('borrowing without a key reports failure', store.borrow('', 1, borrowed) === false);

fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
