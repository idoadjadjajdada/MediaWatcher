/**
 * Tone mapping on the GPU, and the fallback that must survive it.
 *
 * The measurement that motivated this: a 4K HDR file tone mapped on the CPU
 * encodes at 1.05x realtime — slower than watching it — so the stream stalls
 * every few seconds and never recovers. On the GPU the same file measured at
 * 3.57x. What is tested here is the part that can silently go wrong: that the
 * CPU chain is still emitted for machines that cannot do it, that the two are
 * never mixed, and that a probe which produces no video is not mistaken for
 * success.
 *
 * Run: node tests/gpu-tonemap.test.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gpuTonemapChain, gpuTonemapInputArgs, probeGpuTonemap } from '../services/gpuTonemap.js';
import { buildSegmentArgs, buildArgs, tonemapChain } from '../services/transcoder.js';

const chain = gpuTonemapChain(2160, 1080);
assert.match(chain, /^libplacebo=w=-2:h=1080:/, 'a 4K source is scaled by the same filter that tone maps it');
assert.match(chain, /tonemapping=bt\.2390/);
assert.match(chain, /colorspace=bt709/);
assert.match(chain, /color_primaries=bt709/);
assert.match(chain, /color_trc=bt709/);
assert.ok(chain.endsWith('hwdownload,format=yuv420p'), 'frames come back for the encoder');
// Below the cap there is nothing to scale, and asking for it would upscale.
assert.equal(gpuTonemapChain(720, 1080).startsWith('libplacebo=tonemapping='), true);
assert.equal(gpuTonemapChain(null, 1080).includes('w=-2'), false, 'an unknown height is not scaled');
console.log('PASS: the GPU chain scales only when it must, and lands on bt709');

const input = gpuTonemapInputArgs();
assert.ok(input.indexOf('-init_hw_device') < input.indexOf('-hwaccel'), 'the device exists before it is used');
assert.ok(input.includes('vulkan=vk') && input.includes('-filter_hw_device'));
assert.equal(input.at(-1), 'vulkan', 'frames stay on the GPU rather than being copied back to be filtered');
console.log('PASS: the input arguments hand decoded frames straight to the filter');

/** An ffmpeg that exits how it is told, having written what it is told. */
const fakeFfmpeg = ({ code = 0, bytes = 0 }) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  setImmediate(() => {
    if (bytes) child.stdout.emit('data', Buffer.alloc(bytes));
    child.emit('close', code);
  });
  return child;
};

assert.equal(await probeGpuTonemap('ffmpeg', { spawnProcess: fakeFfmpeg({ code: 0, bytes: 4096 }) }), true);
// The failure this exists for: several of these pipelines exit 0 having
// written nothing at all, and one of them did exactly that here.
assert.equal(await probeGpuTonemap('ffmpeg', { spawnProcess: fakeFfmpeg({ code: 0, bytes: 0 }) }), false);
assert.equal(await probeGpuTonemap('ffmpeg', { spawnProcess: fakeFfmpeg({ code: 1, bytes: 4096 }) }), false);
assert.equal(await probeGpuTonemap('ffmpeg', {
  spawnProcess: () => { throw new Error('no such file'); }
}), false);
assert.equal(await probeGpuTonemap('ffmpeg', {
  spawnProcess: () => Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { resume() {} }),
    stderr: Object.assign(new EventEmitter(), { resume() {} }),
    kill() {}
  }),
  timeoutMs: 50
}), false, 'a probe that hangs is not a working pipeline');
console.log('PASS: only a probe that produces video counts as success');

const options = { outputPattern: 'out/%d.ts', tonemap: true, height: 2160, encoder: 'h264_nvenc' };
const onGpu = buildSegmentArgs('film.mkv', { ...options, gpu: true });
const onCpu = buildSegmentArgs('film.mkv', { ...options, gpu: false });

assert.ok(onGpu.join(' ').includes(gpuTonemapChain(2160, 1080)));
assert.ok(onCpu.join(' ').includes(tonemapChain(2160, 1080)));
assert.equal(onCpu.join(' ').includes('libplacebo'), false, 'the fallback is the whole CPU chain');
// Vulkan and CUDA cannot both own the frames.
assert.equal(onGpu.includes('cuda'), false, 'the CUDA decode hint is dropped when Vulkan carries the frames');
assert.ok(onCpu.includes('cuda'), 'and kept when it is the only acceleration available');
assert.ok(onGpu.indexOf('-init_hw_device') < onGpu.indexOf('-i'), 'the device is set up before the input');
assert.ok(onGpu.indexOf('-i') < onGpu.indexOf('-vf'), 'and the filter after it');

// An SDR file never reaches any of this, whatever the machine can do.
const sdr = buildSegmentArgs('film.mkv', { ...options, tonemap: false, gpu: true });
assert.equal(sdr.join(' ').includes('libplacebo'), false);
assert.equal(sdr.includes('-init_hw_device'), false);

// The same choice, made the same way, on the streaming path.
const streamGpu = buildArgs('film.mkv', { mode: 'transcode', tonemap: true, height: 2160, encoder: 'h264_nvenc', gpu: true });
assert.ok(streamGpu.join(' ').includes('libplacebo'));
console.log('PASS: the GPU chain replaces the CPU one entirely, and only for HDR');
