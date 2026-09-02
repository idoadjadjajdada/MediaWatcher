/**
 * HDR tone mapping.
 *
 * PQ-encoded video handed to a browser renders washed out and far too bright,
 * because the browser treats the transfer curve as ordinary gamma. These cover
 * the detection and the filter chain that fixes it.
 *
 * Run: node tests/tonemap.test.mjs
 */
import { isHdr, tonemapChain, decide, TONEMAP_MAX_HEIGHT } from '../services/transcoder.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const video = (over) => ({ codec: 'hevc', width: 3840, height: 2160, ...over });

console.log('\nisHdr');
check('detects PQ (smpte2084)', isHdr(video({ transfer: 'smpte2084' })) === true);
check('detects HLG (arib-std-b67)', isHdr(video({ transfer: 'arib-std-b67' })) === true);
check('detects PQ by its alias', isHdr(video({ transfer: 'smpte-st-2084' })) === true);
check('is case insensitive', isHdr(video({ transfer: 'SMPTE2084' })) === true);
check('bt709 is not HDR', isHdr(video({ transfer: 'bt709' })) === false);
check('unknown transfer is not HDR', isHdr(video({ transfer: 'unknown' })) === false);
check('missing transfer is not HDR', isHdr(video({})) === false);
check('null video is not HDR', isHdr(null) === false);
check('undefined is not HDR', isHdr(undefined) === false);
// 10-bit alone is not HDR: most of this library is 10-bit SDR.
check('10-bit SDR is not HDR',
  isHdr(video({ transfer: 'unknown', pixelFormat: 'yuv420p10le' })) === false);

console.log('\ntonemapChain');
const chain4k = tonemapChain(2160);
const chain720 = tonemapChain(720);
check('converts to linear light before tone mapping',
  chain4k.includes('zscale=t=linear')
  && chain4k.indexOf('zscale=t=linear') < chain4k.indexOf('tonemap='));
check('a source needing no downscale starts with the linear conversion',
  chain720.startsWith('zscale=t=linear'));
check('tone maps with hable', chain4k.includes('tonemap=tonemap=hable'));
check('lands on bt709 primaries', chain4k.includes('zscale=p=bt709'));
check('lands on bt709 transfer and matrix', chain4k.includes('zscale=t=bt709:m=bt709:r=tv'));
check('ends in a browser-safe pixel format', chain4k.endsWith('format=yuv420p'));

// Downscaling is a performance measure, not a quality preference: tone mapping
// 4K runs at 0.6x realtime and stutters, 1080p at 1.7x. Anything already at or
// under the cap keeps every pixel it came with.
check('4K is downscaled to the cap', chain4k.includes(`scale=-2:${TONEMAP_MAX_HEIGHT}`));
check('the downscale happens BEFORE tone mapping',
  chain4k.indexOf('scale=-2:') < chain4k.indexOf('zscale=t=linear'));

const chain1080 = tonemapChain(1080);
check('exactly at the cap is not downscaled', !chain1080.includes('scale=-2:'));
check('below the cap is not downscaled', !chain720.includes('scale=-2:'));
check('below the cap still tone maps', chain720.includes('tonemap=tonemap=hable'));
check('an unknown height is not downscaled', !tonemapChain(null).includes('scale=-2:'));
check('an unknown height still tone maps', tonemapChain(null).includes('tonemap'));
check('a custom cap is honoured', tonemapChain(2160, 720).includes('scale=-2:720'));
check('a custom cap leaves smaller sources alone', !tonemapChain(700, 720).includes('scale=-2:'));

console.log('');

console.log('\nHDR passthrough');
/*
 * Tone mapping exists because a browser renders a PQ stream as if it were
 * ordinary gamma. A display that can actually show HDR does not have that
 * problem, and tone mapping for it throws away the range the file was made
 * for — at the cost of a full re-encode.
 *
 * The trap is that passthrough is only possible on a path that COPIES the
 * video. If the client cannot decode the codec the video is being re-encoded
 * regardless, and "preserving HDR" there would mean emitting HEVC HDR to a
 * client that just said it cannot decode HEVC.
 */
const hdrFile = {
  container: '.mkv',
  duration: 1200,
  video: { codec: 'hevc', width: 3840, height: 2160, transfer: 'smpte2084' },
  audio: [{ index: 0, codec: 'aac', default: true }]
};
const sdrFile = {
  container: '.mp4',
  duration: 1200,
  video: { codec: 'h264', width: 1920, height: 1080, transfer: 'bt709' },
  audio: [{ index: 0, codec: 'aac', default: true }]
};

const sdrScreen = decide(hdrFile, { hevc: true, ac3: true, hdr: false });
check('an SDR display still gets a tone map', sdrScreen.mode === 'transcode');
check('and is told so', sdrScreen.tonemapped === true);
check('and it is not reported as passthrough', sdrScreen.hdrPassthrough === false);
check('and it is a lossy path', sdrScreen.lossless === false);

const hdrScreen = decide(hdrFile, { hevc: true, ac3: true, hdr: true });
// .mkv is not a browser container, so the best available path is a remux —
// which copies both streams and therefore carries HDR intact.
check('an HDR display avoids the re-encode', hdrScreen.mode === 'remux');
check('the stream is not tone mapped', hdrScreen.tonemapped === false);
check('it is reported as passthrough', hdrScreen.hdrPassthrough === true);
check('and stays lossless', hdrScreen.lossless === true);
check('the reason says why', hdrScreen.reasons.some((r) => /passed through/i.test(r)));

// The important negative: an HDR screen that cannot decode HEVC.
const hdrNoHevc = decide(hdrFile, { hevc: false, ac3: true, hdr: true });
check('no HEVC decoding means no passthrough, however good the screen',
  hdrNoHevc.hdrPassthrough === false);
check('and it is tone mapped, because it is being re-encoded anyway',
  hdrNoHevc.mode === 'transcode' && hdrNoHevc.tonemapped === true);

// A client that never sends the capability must behave exactly as before.
const legacy = decide(hdrFile, { hevc: true, ac3: true });
check('a client that does not report a display range is treated as SDR',
  legacy.tonemapped === true && legacy.mode === 'transcode');

const sdrOnHdrScreen = decide(sdrFile, { hevc: true, hdr: true });
check('SDR video is unaffected by an HDR display', sdrOnHdrScreen.mode === 'direct');
check('and reports neither tone mapping nor passthrough',
  sdrOnHdrScreen.tonemapped === false && sdrOnHdrScreen.hdrPassthrough === false);

// The tone-map height cap is a property of tone mapping, so it must not clamp
// a stream that was passed through untouched.
check('passthrough is not clamped to the tone-map ceiling',
  hdrScreen.tonemapHeight === 2160);
check('but a tone-mapped 4K stream still is',
  sdrScreen.tonemapHeight === TONEMAP_MAX_HEIGHT);

if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
