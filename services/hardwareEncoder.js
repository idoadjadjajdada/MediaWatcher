import { spawn } from 'node:child_process';

/** Test the driver as well as the FFmpeg build, without touching library files. */
export async function findHardwareEncoder(ffmpegPath, { spawnProcess = spawn, timeoutMs = 5000 } = {}) {
  for (const encoder of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const usable = await new Promise((resolve) => {
      let child;
      try {
        child = spawnProcess(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          // Some GPUs reject tiny frame sizes even though normal video works.
          '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=30',
          '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', encoder,
          '-f', 'null', '-'
        ], { windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(false);
      }, timeoutMs);
      const finish = (ok) => { clearTimeout(timer); resolve(ok); };
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      child.stdout?.resume();
      child.stderr?.resume();
    });
    if (usable) return encoder;
  }
  return null;
}
