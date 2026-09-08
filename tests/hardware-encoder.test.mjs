import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { findHardwareEncoder } from '../services/hardwareEncoder.js';

function fakeSpawn(outcomes, attempts, killed = []) {
  return (_binary, args) => {
    const encoder = args[args.indexOf('-c:v') + 1];
    attempts.push(encoder);
    const child = new EventEmitter();
    child.kill = () => { killed.push(encoder); queueMicrotask(() => child.emit('close', null)); };
    const result = outcomes[encoder];
    if (result !== 'hang') queueMicrotask(() => {
      if (result === 'error') child.emit('error', new Error('spawn failed'));
      child.emit('close', typeof result === 'number' ? result : 1);
    });
    return child;
  };
}

let attempts = [];
assert.equal(await findHardwareEncoder('ffmpeg', {
  spawnProcess: fakeSpawn({ h264_nvenc: 1, h264_qsv: 0 }, attempts)
}), 'h264_qsv');
assert.deepEqual(attempts, ['h264_nvenc', 'h264_qsv']);

attempts = [];
assert.equal(await findHardwareEncoder('ffmpeg', {
  spawnProcess: fakeSpawn({ h264_nvenc: 'error' }, attempts)
}), null);
assert.equal(attempts.length, 3);

attempts = [];
const killed = [];
assert.equal(await findHardwareEncoder('ffmpeg', {
  spawnProcess: fakeSpawn({ h264_nvenc: 'hang', h264_amf: 0 }, attempts, killed), timeoutMs: 10
}), 'h264_amf');
assert.deepEqual(killed, ['h264_nvenc']);
console.log('Hardware selection: driver failure, spawn failure, timeout and fallback passed.');
