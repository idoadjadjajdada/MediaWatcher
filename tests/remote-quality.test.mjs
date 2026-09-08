/**
 * Remote detection and the quality ladder.
 *
 * Run: node tests/remote-quality.test.mjs
 */
import { isTailscaleAddress, classifyOrigin } from '../services/network.js';
import { parseBitrate, resolveQuality, LEVELS } from '../services/quality.js';
import { decide, buildArgs } from '../services/transcoder.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ntailscale address detection');
// 100.64.0.0/10 spans 100.64.x.x through 100.127.x.x.
check('100.64.0.1 is tailscale', isTailscaleAddress('100.64.0.1') === true);
check('100.101.102.103 is tailscale', isTailscaleAddress('100.101.102.103') === true);
check('100.127.255.254 is the top of the range', isTailscaleAddress('100.127.255.254') === true);
check('100.63.255.255 is below the range', isTailscaleAddress('100.63.255.255') === false);
check('100.128.0.0 is above the range', isTailscaleAddress('100.128.0.0') === false);

check('a LAN address is not tailscale', isTailscaleAddress('192.168.1.20') === false);
check('loopback is not tailscale', isTailscaleAddress('127.0.0.1') === false);
check('a 10.x address is not tailscale', isTailscaleAddress('10.0.0.5') === false);
check('a public address is not tailscale', isTailscaleAddress('8.8.8.8') === false);

// Express reports loopback as ::ffff:127.0.0.1 on a dual-stack listener, and
// the same mapping applies to any forwarded v4 address.
check('an IPv4-mapped IPv6 tailscale address is detected',
  isTailscaleAddress('::ffff:100.90.1.1') === true);
check('an IPv4-mapped loopback is not tailscale',
  isTailscaleAddress('::ffff:127.0.0.1') === false);

check('null is not tailscale', isTailscaleAddress(null) === false);
check('undefined is not tailscale', isTailscaleAddress(undefined) === false);
check('nonsense is not tailscale', isTailscaleAddress('not-an-ip') === false);
check('a partial address is not tailscale', isTailscaleAddress('100.64') === false);
// Octet bounds must be enforced or 100.999.0.1 would parse as in-range.
check('an out-of-range octet is rejected', isTailscaleAddress('100.999.0.1') === false);

console.log('\norigin classification');
check('tailscale addresses classify as tailscale',
  classifyOrigin('100.100.1.1') === 'tailscale');
check('LAN addresses classify as lan', classifyOrigin('192.168.1.20') === 'lan');
check('loopback classifies as lan', classifyOrigin('127.0.0.1') === 'lan');
check('an unknown address classifies as lan', classifyOrigin(null) === 'lan');

console.log('\nbitrate parsing');
check('plain digits are bits per second', parseBitrate('800000') === 800000);
check('M means megabits', parseBitrate('12M') === 12000000);
check('a fractional M works', parseBitrate('1.5M') === 1500000);
check('K means kilobits', parseBitrate('800K') === 800000);
check('lowercase is accepted', parseBitrate('12m') === 12000000);
check('null parses to null', parseBitrate(null) === null);
check('nonsense parses to null', parseBitrate('fast') === null);

console.log('\nquality resolution');
check('auto on the LAN is original', resolveQuality('auto', 'lan').level === 'original');
// The host can serve more than any client will pull, so the remote default is
// High rather than a defensive Medium.
check('auto over tailscale is high', resolveQuality('auto', 'tailscale').level === 'high');
check('an explicit level wins over auto',
  resolveQuality('low', 'tailscale').level === 'low');
check('an explicit level wins on the LAN too',
  resolveQuality('medium', 'lan').level === 'medium');
check('original explicitly over tailscale is honoured',
  resolveQuality('original', 'tailscale').level === 'original');
check('an unknown level falls back to auto behaviour',
  resolveQuality('ludicrous', 'tailscale').level === 'high');
check('a missing level falls back to auto behaviour',
  resolveQuality(undefined, 'lan').level === 'original');
check('original carries no height cap', resolveQuality('original', 'lan').height === null);
check('high caps at 1080', resolveQuality('high', 'tailscale').height === 1080);
check('low caps at 480', LEVELS.low.height === 480);

console.log('\ncapped decisions');
const mp4_1080 = {
  container: '.mp4', duration: 100, bitrate: 5_000_000,
  video: { codec: 'h264', width: 1920, height: 1080, transfer: 'bt709' },
  audio: [{ index: 0, codec: 'aac', default: true }],
  subtitles: []
};
const mkv_4k_hdr = {
  container: '.mkv', duration: 100, bitrate: 80_000_000,
  video: { codec: 'hevc', width: 3840, height: 2160, transfer: 'smpte2084' },
  audio: [{ index: 0, codec: 'eac3', default: true }],
  subtitles: []
};

const uncapped = decide(mp4_1080, {}, {});
check('an untouched 1080p mp4 still plays direct', uncapped.mode === 'direct');

const capped = decide(mp4_1080, {}, { quality: resolveQuality('low', 'tailscale') });
check('a cap forces a direct file to transcode', capped.mode === 'transcode');
check('the cap sets the target height', capped.targetHeight === 480);
check('the cap sets a maxrate', capped.maxrate === '1.5M');
check('a capped stream is not lossless', capped.lossless === false);
check('a capped stream is not seekable', capped.seekable === false);
check('the cap explains itself',
  capped.reasons.some((r) => /capped/i.test(r)));

// Under the cap there is nothing to gain by re-encoding.
const underCap = decide(mp4_1080, {}, { quality: resolveQuality('high', 'tailscale') });
check('a source already under the cap is left direct', underCap.mode === 'direct');

// Bitrate alone must trigger the cap: a 720p file at 40 Mbps is under the
// height limit and still far too fat for a hotel connection.
const fat720 = {
  ...mp4_1080,
  bitrate: 40_000_000,
  video: { codec: 'h264', width: 1280, height: 720, transfer: 'bt709' }
};
const fatCapped = decide(fat720, {}, { quality: resolveQuality('high', 'tailscale') });
check('an over-bitrate source is capped even when short enough',
  fatCapped.mode === 'transcode');
check('a bitrate-only cap never enlarges a 720p source', fatCapped.targetHeight === null);
check('the bitrate limit is still applied', fatCapped.maxrate === '12M');
check('a 720p source with a 1080p ceiling needs no resize',
  !buildArgs('movie.mkv', { mode: 'transcode', height: 720, maxHeight: 1080 }).includes('-vf'));

// HDR already forces a transcode; the cap must tighten the height, not fight it.
const hdrCapped = decide(mkv_4k_hdr, {}, { quality: resolveQuality('medium', 'tailscale') });
check('HDR under a cap still transcodes', hdrCapped.mode === 'transcode');
check('HDR is still tone mapped under a cap', hdrCapped.tonemapped === true);
check('the cap wins over the default tonemap height', hdrCapped.tonemapHeight === 720);

console.log('\ncapped ffmpeg arguments');
const args = buildArgs('C:\\lib\\movie.mkv', {
  mode: 'transcode', maxHeight: 720, maxrate: '5M'
});
check('a scale filter is applied', args.join(' ').includes('scale=-2:720'));
check('the maxrate is passed to the encoder', args.includes('5M'));
check('bufsize accompanies maxrate', args.includes('-bufsize'));

const tonemapArgs = buildArgs('C:\\lib\\movie.mkv', {
  mode: 'transcode', tonemap: true, height: 2160, maxHeight: 720, maxrate: '5M'
});
const chain = tonemapArgs[tonemapArgs.indexOf('-vf') + 1];
check('the tone map chain scales to the cap, not to 1080',
  chain.includes('scale=-2:720'));
// Anchored to a filter boundary so the three zscale colour steps in the tone
// map chain are not miscounted as resizes.
check('only one resize step is emitted',
  (chain.match(/(^|,)scale=/g) || []).length === 1);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
