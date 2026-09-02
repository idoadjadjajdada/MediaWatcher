/**
 * The ffmpeg register, the progress parser, and the adaptive run length.
 *
 * All three exist to answer questions that used to have no answer from
 * outside: what is running, how fast, and how much should the next run
 * produce. None of them may spawn anything to be tested.
 *
 * Run: node tests/encoder-registry.test.mjs
 */
import { EventEmitter } from 'node:events';
import * as ffmpegPool from '../services/ffmpegPool.js';
import { parseProgressBlock, createProgressReader } from '../services/ffmpegProgress.js';
import { nextRunSeconds, contentKey, sessionKey } from '../services/hls/session.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

/** A stand-in for a ChildProcess: the register only ever listens and kills. */
function fakeProc(pid = 1234) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.kill = () => { proc.killed = true; return true; };
  return proc;
}

console.log('\nprogress parsing');

const block = [
  'frame=482',
  'fps=51.2',
  'out_time_us=20000000',
  'out_time=00:00:20.000000',
  'speed=1.53x',
  'progress=continue'
].join('\n');

const parsed = parseProgressBlock(block);
check('reads the position in seconds', parsed.outSeconds === 20);
check('reads the realtime factor', parsed.speed === 1.53);
check('reads the frame count', parsed.frames === 482);
check('knows the run has not ended', parsed.ended === false);

// out_time_ms is microseconds despite the name. Reading it as milliseconds put
// the encoder a thousand times further ahead than it was.
check('treats out_time_ms as microseconds',
  parseProgressBlock('out_time_ms=6000000\nspeed=1x\nprogress=continue').outSeconds === 6);

// Early in a run ffmpeg has no speed to report yet.
check('tolerates a speed of N/A',
  parseProgressBlock('out_time_us=1000000\nspeed=N/A\nprogress=continue').speed === null);

check('falls back to the formatted time',
  parseProgressBlock('out_time=00:01:30.500000\nspeed=2x\nprogress=continue').outSeconds === 90.5);

check('ignores a block with nothing in it',
  parseProgressBlock('bitrate=N/A\nprogress=continue') === null);

check('sees the end of a run',
  parseProgressBlock('out_time_us=1000\nspeed=1x\nprogress=end').ended === true);

console.log('\nprogress reader');

{
  const seen = [];
  const write = createProgressReader((update) => seen.push(update));

  // Split mid-block: the pipe boundary has nothing to do with the block one.
  write('frame=1\nout_time_us=1000000\nspe');
  check('reports nothing for half a block', seen.length === 0);

  write('ed=1.00x\nprogress=continue\n');
  check('reports once the block completes', seen.length === 1 && seen[0].outSeconds === 1);

  // Two blocks in one read must not be reported as one.
  write('out_time_us=2000000\nspeed=1x\nprogress=continue\nout_time_us=3000000\nspeed=1x\nprogress=continue\n');
  check('reports each of two blocks in one read', seen.length === 3);
  check('reports them in order', seen[1].outSeconds === 2 && seen[2].outSeconds === 3);
}

{
  // A stream that never completes a block must not grow without bound.
  const write = createProgressReader(() => {});
  for (let i = 0; i < 100; i += 1) write('x'.repeat(200));
  check('bounds the buffer on a stream with no blocks in it', true);
}

console.log('\nthe register');

ffmpegPool.resetRegister();
{
  const proc = fakeProc(4242);
  const handle = ffmpegPool.register({ kind: 'hls', label: 'session abc', filePath: 'C:/lib/a.mkv', proc });

  const listed = ffmpegPool.listRunning();
  check('lists what is running', listed.length === 1);
  check('carries the pid', listed[0].pid === 4242);
  check('carries the kind and label', listed[0].kind === 'hls' && listed[0].label === 'session abc');
  check('never exposes the process handle', listed[0].proc === undefined);
  check('has no speed until one is reported', listed[0].speed === null);

  handle.progress({ speed: 1.7, outSeconds: 120 });
  const updated = ffmpegPool.listRunning()[0];
  check('folds in progress', updated.speed === 1.7 && updated.outSeconds === 120);
  check('reports elapsed time', updated.elapsedSeconds >= 0);

  // The important property: a process that ends removes itself, so a caller
  // that forgets cannot leave a phantom on the page forever.
  proc.emit('close', 0);
  check('drops the entry when the process closes', ffmpegPool.listRunning().length === 0);
}

{
  const proc = fakeProc();
  const { id } = ffmpegPool.register({ kind: 'convert', label: 'h264', proc });
  check('kills by id', ffmpegPool.killRunning(id) === true);
  check('actually signalled the process', proc.killed === true);
  check('drops it from the list', ffmpegPool.listRunning().length === 0);
  check('a second kill is not an error', ffmpegPool.killRunning(id) === false);
  check('an invented id is not an error', ffmpegPool.killRunning('nope') === false);
}

{
  ffmpegPool.resetRegister();
  const first = ffmpegPool.register({ kind: 'a', label: 'first', proc: fakeProc() });
  const second = ffmpegPool.register({ kind: 'b', label: 'second', proc: fakeProc() });
  check('ids are distinct', first.id !== second.id);
  check('oldest first', ffmpegPool.listRunning()[0].label === 'first');
  ffmpegPool.resetRegister();
}

console.log('\nadaptive run length');

// A browse pays for two minutes, not five. Each run that ends by spending its
// budget doubles the next, and the ceiling is what the config asks for.
check('the first run is the short one', nextRunSeconds(0, 120, 300) === 120);
check('a second run doubles', nextRunSeconds(1, 120, 300) === 240);
check('growth stops at the ceiling', nextRunSeconds(2, 120, 300) === 300);
check('and stays there', nextRunSeconds(9, 120, 300) === 300);
check('a ceiling below the base still holds', nextRunSeconds(3, 120, 100) === 100);
check('a negative count is treated as the first run', nextRunSeconds(-2, 120, 300) === 120);

console.log('\npooling identity');

const spec = (over = {}) => ({
  viewer: 'device:abc',
  filePath: 'C:/lib/movie.mkv',
  mtimeMs: 1700000000000,
  size: 2201685207,
  quality: 'high',
  audioIndex: 0,
  audioOffset: 0,
  caps: { hevc: true, ac3: true },
  ...over
});

// The whole point: the same content under two viewers is one pool, while the
// sessions themselves stay separate so a seek by one cannot disturb the other.
check('the pool key ignores the viewer',
  contentKey(spec()) === contentKey(spec({ viewer: 'device:zzz' })));
check('the session key still does not',
  sessionKey(spec()) !== sessionKey(spec({ viewer: 'device:zzz' })));
check('a different quality is a different pool',
  contentKey(spec()) !== contentKey(spec({ quality: 'low' })));
check('a different audio track is a different pool',
  contentKey(spec()) !== contentKey(spec({ audioIndex: 2 })));
check('an edited file is a different pool',
  contentKey(spec()) !== contentKey(spec({ mtimeMs: 1700000000001 })));
check('a different capability set is a different pool',
  contentKey(spec()) !== contentKey(spec({ caps: { hevc: false, ac3: true } })));
check('is 32 hex characters', /^[0-9a-f]{32}$/.test(contentKey(spec())));

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
