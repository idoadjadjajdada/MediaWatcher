/**
 * The end of a file, where the playlist and the encode disagree.
 *
 * The playlist is arithmetic on the duration ffprobe reported. A real encode
 * can finish short of that, and those trailing segments then do not exist —
 * so the player spent its whole retry budget on 404s and stalled a second from
 * the end. On an episode the up-next countdown covered for it; on a film
 * nothing did.
 *
 * This runs a real encoder against a real file, because the rule being tested
 * is "ffmpeg exited cleanly having written nothing", and nothing short of an
 * encoder produces that honestly. The file is eight seconds of test pattern,
 * generated here and deleted afterwards.
 *
 * Run: node tests/hls-tail.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config from '../config/index.js';
import {
  openSession, requestSegment, endSession, getSession, isEndOfSource
} from '../services/hls/manager.js';
import { segmentCount, SEGMENT_SECONDS } from '../services/hls/playlist.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/* -------------------------------------------------------------------------
 * when a short run means the file ended
 *
 * This is the rule that decides whether the rest of an episode is reachable,
 * so it is checked on its own before any encoder is involved.
 * ---------------------------------------------------------------------- */
console.log('\nisEndOfSource');

const BUDGET = Math.ceil(config.hls.encodeAheadSeconds / SEGMENT_SECONDS);

/*
 * The dangerous case. A run in the middle of a long film always stops early —
 * that is what encodeAheadSeconds is for — so reading its short output as the
 * end of the file would refuse every remaining segment and cut the episode off
 * where the viewer happened to be.
 */
check('a bounded run mid-film says nothing about the end',
  isEndOfSource({ startSegment: 0, count: 400 }, BUDGET - 1) === false);
check('nor does one starting further in',
  isEndOfSource({ startSegment: 100, count: 400 }, 100 + BUDGET - 1) === false);
check('not even if it produced far less than its budget',
  isEndOfSource({ startSegment: 0, count: 400 }, 3) === false);

// A run with the budget to finish the playlist, that did not finish it, is the
// only one whose short output is evidence of anything.
check('a run that could have finished and did not marks the end',
  isEndOfSource({ startSegment: 0, count: 5 }, 0) === true);
check('a run near the end that stops short marks the end',
  isEndOfSource({ startSegment: 360, count: 400 }, 394) === true);
check('a run that reached the last segment does not',
  isEndOfSource({ startSegment: 360, count: 400 }, 399) === false);
check('a whole file encoded in one run does not',
  isEndOfSource({ startSegment: 0, count: 5 }, 4) === false);

/* -------------------------------------------------------------------------
 * against a real encoder
 * ---------------------------------------------------------------------- */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-tail-'));
const source = path.join(scratch, 'tail.mkv');

/** Eight seconds of test pattern — two segments of real content. */
function makeSource() {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
      source
    ], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(source)));
  });
}

if (!(await makeSource())) {
  // Same convention as the network suites: say why, do not pretend to pass.
  console.log('\n  ffmpeg is not available, so the tail rule cannot be exercised here.');
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

/*
 * The session is told the file is 30 seconds long when it is 8. That is the
 * drift being reproduced, in the direction it actually happens: the playlist
 * promises five segments and the encoder can only produce two.
 */
const CLAIMED_DURATION = 30;

const session = await openSession({
  viewer: 'test:tail',
  filePath: source,
  mtimeMs: fs.statSync(source).mtimeMs,
  size: fs.statSync(source).size,
  quality: 'original',
  audioIndex: 0,
  audioOffset: 0,
  caps: { hevc: false, ac3: false },
  duration: CLAIMED_DURATION,
  tonemap: false,
  sourceHeight: 240,
  maxHeight: null,
  maxrate: null
});

console.log('\nthe playlist overruns the file');
check('the playlist promises more than the file holds',
  session.count === segmentCount(CLAIMED_DURATION) && session.count > 2);

console.log('\nsegments that exist');
const first = await requestSegment(session.id, 0, undefined, 'test:tail');
check('the opening segment is served', typeof first === 'string' && fs.existsSync(first));

console.log('\nsegments past the end of the file');

const startedAt = Date.now();
const beyond = await requestSegment(session.id, session.count - 1, undefined, 'test:tail');
const waited = Date.now() - startedAt;

check('a segment past the real end is not served', beyond === null);
/*
 * The number that matters. It used to spend the full segment timeout plus three
 * restarts getting here, and the player spent its retry budget on top of that.
 */
check(`it gives up in ${(waited / 1000).toFixed(1)}s rather than the ${config.hls.segmentTimeoutMs / 1000}s timeout`,
  waited < config.hls.segmentTimeoutMs);

const after = getSession(session.id);
check('the real end of the file is recorded', Number.isInteger(after?.endOfStream));
check('and it is short of what the playlist claimed', after.endOfStream < session.count - 1);
check('the recorded end is about where the content stops',
  after.endOfStream * SEGMENT_SECONDS <= 8 + SEGMENT_SECONDS);

// Once known, every later request for the tail is answered from that, with no
// encoder involved at all.
const secondAsk = Date.now();
const againBeyond = await requestSegment(session.id, session.count - 1, undefined, 'test:tail');
check('asking again is refused immediately',
  againBeyond === null && Date.now() - secondAsk < 500);

/*
 * The other half of the rule, and the one that would hurt if it were wrong:
 * everything up to the recorded end is still served. Cutting real content off
 * the end of every file would be a worse bug than the stall being fixed.
 */
const atTheEnd = await requestSegment(session.id, after.endOfStream, undefined, 'test:tail');
check('the last segment that does exist is still served',
  typeof atTheEnd === 'string' && fs.existsSync(atTheEnd));
check('and it holds the content', Boolean(atTheEnd) && fs.statSync(atTheEnd).size > 0);

endSession(session.id);
check('the session is cleaned up', getSession(session.id) === null);
fs.rmSync(scratch, { recursive: true, force: true });

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
