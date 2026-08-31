/**
 * Browser-native MP4 cache — variant choice and conversion arguments.
 *
 * Playing straight from a cached MP4 makes the file byte-range seekable, which
 * is the only way to get instant seeking: an ffmpeg pipe has no byte offsets,
 * so every seek there means restarting the encoder.
 *
 * Run: node tests/mp4cache.test.mjs
 */
import {
  pickVariant, variantArgs, VARIANT_COPY, VARIANT_H264, H264_MAX_HEIGHT
} from '../services/mp4cache.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const hevc = { codec: 'hevc', height: 2160, transfer: 'bt709' };
const h264 = { codec: 'h264', height: 1080, transfer: 'bt709' };
const hdr = { codec: 'hevc', height: 2160, transfer: 'smpte2084' };

console.log('\npickVariant');
check('an HEVC-capable browser gets the lossless copy',
  pickVariant(hevc, { hevc: true }) === VARIANT_COPY);
check('a browser without HEVC gets H.264',
  pickVariant(hevc, { hevc: false }) === VARIANT_H264);
check('missing capabilities are treated as no HEVC',
  pickVariant(hevc, {}) === VARIANT_H264);

// H.264 source plays everywhere, so the copy is right for every client.
check('an H.264 source is always copied', pickVariant(h264, { hevc: false }) === VARIANT_COPY);
check('an H.264 source is copied for HEVC clients too',
  pickVariant(h264, { hevc: true }) === VARIANT_COPY);

// HDR has to be tone mapped, and tone mapping means re-encoding.
check('HDR always needs H.264 even with HEVC support',
  pickVariant(hdr, { hevc: true }) === VARIANT_H264);
check('HDR without HEVC support is H.264 too',
  pickVariant(hdr, { hevc: false }) === VARIANT_H264);

check('no video info falls back to H.264', pickVariant(null, { hevc: true }) === VARIANT_H264);

console.log('\nvariantArgs — lossless copy');
const copy = variantArgs('/in.mkv', '/out.mp4', VARIANT_COPY, { video: hevc, audioIndex: 0 });
check('copies the video stream', copy.includes('-c:v') && copy[copy.indexOf('-c:v') + 1] === 'copy');
check('never re-encodes video in the copy variant', !copy.includes('libx264'));
// MKV audio is usually EAC3 or TrueHD; neither plays in a browser and neither
// is legal in MP4, so audio is always AAC even in the "lossless" variant.
check('re-encodes audio to aac', copy.includes('-c:a') && copy[copy.indexOf('-c:a') + 1] === 'aac');
check('does not tone map', !copy.some((a) => String(a).includes('tonemap')));
check('does not scale', !copy.some((a) => String(a).includes('scale=')));
check('writes a faststart mp4', copy.includes('+faststart'));
check('names the output last', copy[copy.length - 1] === '/out.mp4');
// Conversions write to a .part file, and ffmpeg cannot infer a muxer from that
// extension - without an explicit -f mp4 the run dies opening the output.
check('states the muxer explicitly',
  copy.includes('-f') && copy[copy.indexOf('-f') + 1] === 'mp4');
check('reads the input', copy.includes('-i') && copy[copy.indexOf('-i') + 1] === '/in.mkv');

console.log('\nvariantArgs — H.264');
const enc = variantArgs('/in.mkv', '/out.mp4', VARIANT_H264, { video: hevc, audioIndex: 0 });
check('encodes to H.264', enc.some((a) => String(a).includes('h264') || a === 'libx264'));
check('caps the height', enc.some((a) => String(a).includes(`scale=-2:${H264_MAX_HEIGHT}`)));
check('still writes faststart', enc.includes('+faststart'));

const small = variantArgs('/in.mkv', '/out.mp4', VARIANT_H264,
  { video: { codec: 'hevc', height: 720, transfer: 'bt709' }, audioIndex: 0 });
check('a source under the cap is not upscaled',
  !small.some((a) => String(a).includes('scale=-2:')));

const tone = variantArgs('/in.mkv', '/out.mp4', VARIANT_H264, { video: hdr, audioIndex: 0 });
check('an HDR source is tone mapped', tone.some((a) => String(a).includes('tonemap')));
check('a non-HDR source is not tone mapped', !enc.some((a) => String(a).includes('tonemap')));

console.log('\nvariantArgs — hardware encoder');
const hw = variantArgs('/in.mkv', '/out.mp4', VARIANT_H264,
  { video: hevc, audioIndex: 0, encoder: 'h264_nvenc' });
check('uses the hardware encoder when given one', hw.includes('h264_nvenc'));
check('does not also invoke libx264', !hw.includes('libx264'));

console.log('\nvariantArgs — audio track');
const track = variantArgs('/in.mkv', '/out.mp4', VARIANT_COPY, { video: hevc, audioIndex: 2 });
check('maps the requested audio track', track.includes('0:a:2?'));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
