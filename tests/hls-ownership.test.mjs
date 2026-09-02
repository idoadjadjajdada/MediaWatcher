/**
 * An HLS session belongs to the viewer that opened it.
 *
 * Session ids are not secret — the player prints its own in the diagnostics
 * panel — so the touch and delete routes had to check more than "does this id
 * exist". Until they did, a signed-in phone could end the television's stream
 * by pasting an id at the API.
 *
 * No encoder is started here: openSession only creates the bookkeeping and its
 * directory, which is what the ownership rules act on.
 *
 * Run: node tests/hls-ownership.test.mjs
 */
import { openSession, touch, endSession, getSession, activeCount } from '../services/hls/manager.js';
import { viewerId } from '../services/hls/spec.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const spec = (viewer) => ({
  viewer,
  filePath: 'C:/library/movies/Test/Test.mkv',
  mtimeMs: 1700000000000,
  size: 1234,
  quality: 'high',
  audioIndex: 0,
  audioOffset: 0,
  caps: { hevc: false, ac3: false },
  duration: 600,
  tonemap: false,
  sourceHeight: 1080,
  maxHeight: 1080,
  maxrate: '12M'
});

/* -------------------------------------------------------------------------
 * viewerId
 * ---------------------------------------------------------------------- */
console.log('\nviewerId');

const remembered = viewerId({ device: { id: 'abc' }, headers: {} });
check('a remembered device is identified by its row', remembered === 'device:abc');

const cookieOnly = viewerId({ headers: { cookie: 'mw_device=sometoken' } });
check('an unremembered session is identified by its token', cookieOnly.startsWith('session:'));
check('and not by the token itself', !cookieOnly.includes('sometoken'));

check('anything holding the admin key shares one bucket',
  viewerId({ headers: {} }) === 'admin');

/* -------------------------------------------------------------------------
 * ownership
 * ---------------------------------------------------------------------- */
console.log('\nopenSession');

const before = activeCount();
const mine = await openSession(spec('device:mine'));
check('a session is created', activeCount() === before + 1);
check('and remembers who opened it', getSession(mine.id)?.viewer === 'device:mine');

const again = await openSession(spec('device:mine'));
check('an identical request reuses the same encoder', again.id === mine.id);

/*
 * The viewer is part of the session key, so a second device on the same file
 * gets its own encoder - otherwise a seek by either deletes the segments the
 * other is playing.
 */
const theirs = await openSession(spec('device:theirs'));
check('a different viewer gets a different session', theirs.id !== mine.id);

console.log('\ntouch');
check('the owner keeps their session alive', touch(mine.id, 'device:mine') === true);
check('someone else cannot', touch(mine.id, 'device:theirs') === false);
check('and an unknown id answers the same way', touch('nonexistent', 'device:theirs') === false);
check('the session is still there', getSession(mine.id) !== null);

console.log('\nendSession');
check('someone else cannot end it', endSession(mine.id, 'device:theirs') === false);
check('it survives that', getSession(mine.id) !== null);
check('the owner can end it', endSession(mine.id, 'device:mine') === true);
check('and it is gone', getSession(mine.id) === null);

// The sweeper and shutdown pass no viewer, and must still be able to reap.
check('an internal caller needs no viewer', endSession(theirs.id) === true);
check('every test session is cleaned up', activeCount() === before);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
