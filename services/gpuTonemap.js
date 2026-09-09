/**
 * Tone mapping on the GPU.
 *
 * HDR is the expensive case and it is not close. The CPU chain converts every
 * frame to 32-bit float per channel to tone map it, and on a 4K source that
 * measured at 1.05x realtime on this hardware — the encoder producing barely
 * more video than the person is watching, so any hiccup at all becomes a stall
 * it never recovers from. That is the stutter, and it is worst on the biggest
 * files, which is exactly where HDR lives.
 *
 * Decoding into Vulkan memory and letting libplacebo scale and tone map there
 * measured at 3.57x on the same file: the frames never leave the GPU until
 * they are ready to encode. Nothing else about the output changes — same
 * height cap, same bt709 target, same encoder afterwards.
 *
 * It is probed rather than assumed, the same way the hardware encoder is: a
 * build can list libplacebo and still fail on a machine whose driver cannot do
 * it, and half of these pipelines report success while writing nothing at all.
 * So the probe encodes a real frame and insists on bytes coming out the far
 * end. Anything short of that falls back to the CPU chain, which is slow but
 * works everywhere.
 */
import { spawn } from 'node:child_process';

/**
 * Input-side arguments: decode straight into Vulkan memory.
 *
 * These have to precede -i, which is why they are separate from the filter.
 */
export const gpuTonemapInputArgs = () => [
  '-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk',
  '-hwaccel', 'vulkan', '-hwaccel_output_format', 'vulkan'
];

/**
 * The filter chain that replaces `tonemapChain`.
 *
 * bt.2390 is the ITU's own tone mapping curve and libplacebo's default for
 * this direction; the CPU chain uses hable because that is what the `tonemap`
 * filter offers. The difference is a matter of taste in the highlights, not of
 * correctness.
 */
export function gpuTonemapChain(height, maxHeight) {
  const scaling = Number.isFinite(height) && Number.isFinite(maxHeight) && height > maxHeight
    ? `w=-2:h=${maxHeight}:`
    : '';
  return `libplacebo=${scaling}tonemapping=bt.2390:colorspace=bt709:color_primaries=bt709`
    + ':color_trc=bt709:format=yuv420p,hwdownload,format=yuv420p';
}

/**
 * Can this machine actually do it?
 *
 * The test is deliberately end to end — decode, tone map, encode, and produce
 * bytes — because every part of it has been observed to fail on its own. A
 * pipeline that errors while ffmpeg still reports a healthy speed is the
 * reason this checks the output rather than the exit code alone.
 */
export async function probeGpuTonemap(ffmpegPath, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...gpuTonemapInputArgs(),
    // A small HDR-shaped source: bt2020 primaries, PQ transfer, 10-bit.
    '-f', 'lavfi', '-i', 'color=c=gray:size=640x360:rate=25:duration=0.4',
    '-vf', `format=yuv420p10,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,hwupload,${gpuTonemapChain(360, 240)}`,
    '-frames:v', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts', '-'
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(ffmpegPath, args, { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let bytes = 0;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(false);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { bytes += chunk.length; });
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    // Bytes are the test: several of these pipelines exit 0 having written none.
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 && bytes > 0); });
  });
}

export default { gpuTonemapInputArgs, gpuTonemapChain, probeGpuTonemap };
