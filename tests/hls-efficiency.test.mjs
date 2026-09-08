import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-hls-efficiency-'));
process.env.HLS_CACHE_DIR = path.join(scratch, 'hls');
process.env.FFMPEG_HARDWARE_ENCODE = '0';
const config = (await import('../config/index.js')).default;
const manager = await import('../services/hls/manager.js');
const store = await import('../services/hls/segmentStore.js');
const pool = await import('../services/ffmpegPool.js');
const source = path.join(scratch, 'source.mkv');
const spec = (viewer) => ({
  viewer, filePath: source, mtimeMs: 1, size: 1, quality: 'original',
  audioIndex: 0, audioOffset: 0, caps: {}, duration: 18,
  tonemap: false, sourceHeight: 90, maxHeight: null, maxrate: null
});

try {
  // Closing during the first async step must prevent a late encoder spawn.
  const cancelled = await manager.openSession(spec('cancelled'));
  const pending = manager.requestSegment(cancelled.id, 0);
  manager.endSession(cancelled.id);
  assert.equal(await pending, null);
  assert.equal(cancelled.proc, null);
  assert.equal(pool.stats().interactive, 0);

  // Reopening while an old encoder closes must use a different directory.
  const closing = await manager.openSession(spec('reopen'));
  closing.started = true;
  closing.startSegment = 2;
  closing.proc = new EventEmitter();
  const oldProc = closing.proc;
  oldProc.kill = () => setTimeout(() => oldProc.emit('close', null), 20);
  const seeking = manager.requestSegment(closing.id, 0);
  manager.endSession(closing.id);
  const reopened = await manager.openSession(spec('reopen'));
  assert.notEqual(reopened.dir, closing.dir);
  assert.equal(await seeking, null);
  assert.equal(closing.proc, null);
  assert.equal(fs.existsSync(closing.dir), false);
  assert.equal(fs.existsSync(reopened.dir), true);
  manager.endSession(reopened.id);

  const partial = await manager.openSession(spec('partial'));
  partial.started = true;
  partial.exited = true;
  partial.exitCode = 1;
  fs.writeFileSync(path.join(partial.dir, '0.ts'), 'complete');
  fs.writeFileSync(path.join(partial.dir, '1.ts'), 'truncated');
  manager.endSession(partial.id);
  assert.equal(store.has(partial.contentKey, 0), true);
  assert.equal(store.has(partial.contentKey, 1), false);

  // Another viewer's completed copy must beat our own incomplete local file.
  const borrower = await manager.openSession(spec('borrower'));
  fs.writeFileSync(path.join(borrower.dir, '0.ts'), 'still writing');
  const borrowed = await manager.requestSegment(borrower.id, 0);
  assert.equal(fs.readFileSync(borrowed, 'utf8'), 'complete');
  assert.equal(fs.readFileSync(path.join(borrower.dir, '0.ts'), 'utf8'), 'still writing');
  assert.equal(borrower.started, false);
  manager.endSession(borrower.id);
  store.sweep(0);

  const generated = spawnSync(config.ffmpeg.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=duration=18:size=160x90:rate=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', source
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (generated.error?.code === 'ENOENT') {
    console.log('SKIP real encode: FFmpeg unavailable; lifecycle and cache checks passed.');
  } else {
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
    const first = await manager.openSession(spec('first'));
    assert.ok(await manager.requestSegment(first.id, 0));
    if (first.proc) await once(first.proc, 'close');
    assert.equal(first.exitCode, 0);
    // Only segment 0 was requested; all three should have been preserved.
    for (const index of [0, 1, 2]) assert.equal(store.has(first.contentKey, index), true);
    manager.endSession(first.id);

    const second = await manager.openSession(spec('second'));
    for (const index of [0, 1, 2]) assert.ok(await manager.requestSegment(second.id, index));
    assert.equal(second.started, false, 'replaying buffered segments must not start FFmpeg');
    assert.equal(pool.stats().interactive, 0);
    manager.endSession(second.id);
    console.log('Real HLS encode: all buffered segments reused with zero replay encoders.');
  }
  console.log('HLS startup cancellation, failed tail and concurrent cache checks passed.');
} finally {
  manager.shutdownAll();
  fs.rmSync(scratch, { recursive: true, force: true });
}
