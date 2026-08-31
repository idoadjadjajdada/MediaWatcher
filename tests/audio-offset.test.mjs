/**
 * Audio delay, server side.
 *
 * The offset has to survive as a stream copy - a filter approach (adelay,
 * atrim) would force an audio re-encode and quietly cost losslessness on a
 * library that is mostly 4K HEVC remuxes. That is what the "stays a copy"
 * checks below are guarding.
 *
 * Run: npm test
 */
import { buildArgs, decide, clampAudioOffset, MAX_AUDIO_OFFSET } from '../services/transcoder.js';

let total = 0;
let failures = 0;
const check = (name, condition, detail) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) { failures += 1; if (detail !== undefined) console.log(`         ${detail}`); }
};

const FILE = 'C:\\media\\ep.mkv';

console.log('\nclampAudioOffset');
check('passes a normal value through', clampAudioOffset(0.5) === 0.5);
check('passes a negative value through', clampAudioOffset(-1.25) === -1.25);
check('clamps above the ceiling', clampAudioOffset(99) === MAX_AUDIO_OFFSET);
check('clamps below the floor', clampAudioOffset(-99) === -MAX_AUDIO_OFFSET);
check('ceiling is 30s', MAX_AUDIO_OFFSET === 30);
check('treats a string number as a number', clampAudioOffset('2.5') === 2.5);
check('treats nonsense as zero', clampAudioOffset('banana') === 0);
check('treats undefined as zero', clampAudioOffset(undefined) === 0);
check('treats NaN as zero', clampAudioOffset(NaN) === 0);
check('treats null as zero', clampAudioOffset(null) === 0);

console.log('\nbuildArgs at offset 0');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 0, audioIndex: 0, audioOffset: 0 });
  const inputs = args.filter((a) => a === '-i').length;
  check('uses a single input', inputs === 1, `inputs=${inputs}`);
  check('no -itsoffset', !args.includes('-itsoffset'));
  check('maps audio from input 0', args.includes('0:a:0?'));
  check('maps video from input 0', args.includes('0:v:0'));
}

console.log('\nbuildArgs with a positive offset');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 12, audioIndex: 1, audioOffset: 0.5 });
  const inputs = args.filter((a) => a === '-i').length;
  check('opens the file twice', inputs === 2, `inputs=${inputs}`);

  const off = args.indexOf('-itsoffset');
  check('-itsoffset is present', off !== -1);
  check('-itsoffset carries the value', args[off + 1] === '0.5', args[off + 1]);
  const secondInput = args.indexOf('-i', args.indexOf('-i') + 1);
  check('-itsoffset comes before the second -i', off !== -1 && off < secondInput, `${off} < ${secondInput}`);

  check('video comes from input 0', args.includes('0:v:0'));
  check('audio comes from input 1', args.includes('1:a:1?'));
  check('both inputs are seeked', args.filter((a) => a === '-ss').length === 2);

  const v = args.indexOf('-c:v');
  const a = args.indexOf('-c:a');
  check('video stays a copy', args[v + 1] === 'copy', args[v + 1]);
  check('audio stays a copy - remux must not become lossy', args[a + 1] === 'copy', args[a + 1]);
}

console.log('\nbuildArgs with a negative offset');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 0, audioIndex: 0, audioOffset: -1.5 });
  const off = args.indexOf('-itsoffset');
  check('carries the negative value', args[off + 1] === '-1.5', args[off + 1]);
  check('no -ss when starting at zero', !args.includes('-ss'));
}

console.log('\nbuildArgs transcode with an offset');
{
  const args = buildArgs(FILE, { mode: 'transcode', startSeconds: 0, audioIndex: 0, audioOffset: 1 });
  check('still two inputs', args.filter((a) => a === '-i').length === 2);
  check('video is re-encoded', args[args.indexOf('-c:v') + 1] === 'libx264');
  check('audio is re-encoded', args[args.indexOf('-c:a') + 1] === 'aac');
}

console.log('\ndecide');
{
  const playable = {
    container: '.mp4',
    video: { codec: 'h264' },
    audio: [{ index: 0, codec: 'aac', default: true }],
    duration: 1200,
    subtitles: []
  };
  check('plays direct with no offset', decide(playable, {}, { audioOffset: 0 }).mode === 'direct');
  check('becomes remux with an offset', decide(playable, {}, { audioOffset: 0.5 }).mode === 'remux',
    decide(playable, {}, { audioOffset: 0.5 }).mode);
  check('offset mode is still lossless', decide(playable, {}, { audioOffset: 0.5 }).lossless === true);
  check('offset mode is not range-seekable', decide(playable, {}, { audioOffset: 0.5 }).seekable === false);
  check('a negative offset also forces remux', decide(playable, {}, { audioOffset: -0.2 }).mode === 'remux');
  check('missing options behave as no offset', decide(playable, {}).mode === 'direct');
  check('the reason names the offset',
    decide(playable, {}, { audioOffset: 0.5 }).reasons.some((r) => /offset/i.test(r)),
    JSON.stringify(decide(playable, {}, { audioOffset: 0.5 }).reasons));
  check('null probe data still answers direct', decide(null, {}, { audioOffset: 0 }).mode === 'direct');
}

console.log('');
if (failures === 0) { console.log(`${total} checks, all passed\n`); process.exit(0); }
console.log(`${total} checks, ${failures} FAILED\n`); process.exit(1);
