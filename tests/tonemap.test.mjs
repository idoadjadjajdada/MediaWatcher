/**
 * HDR tone mapping.
 *
 * PQ-encoded video handed to a browser renders washed out and far too bright,
 * because the browser treats the transfer curve as ordinary gamma. These cover
 * the detection and the filter chain that fixes it.
 *
 * Run: node tests/tonemap.test.mjs
 */
import { isHdr, tonemapChain, TONEMAP_MAX_HEIGHT } from '../services/transcoder.js';

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
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
