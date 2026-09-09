/**
 * One server per library.
 *
 * The claim is advisory, so the property that matters is not "it locks" but
 * "it is never wrong in the direction that stops you working": a file left by
 * a crash, or one naming a port something else has since taken, has to read as
 * nobody holding the folder.
 *
 * Run: node tests/serving.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { claimPath, read, claim, release, holder } from '../services/serving.js';
import { instanceFingerprint } from '../services/auth.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mediawatcher-serving-'));
const key = 'c'.repeat(64);
const library = (name) => {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'admin-key'), key);
  return dir;
};

/** A server that answers /api/health as `instance`, on a port of its own. */
async function pretend(instance) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', instance }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

try {
  const dir = library('one');

  assert.equal(read(dir), null, 'nothing is claimed to begin with');
  assert.equal(await holder(dir), null);

  claim(4242, dir);
  const held = read(dir);
  assert.equal(held.port, 4242);
  assert.equal(held.pid, process.pid);
  assert.ok(held.startedAt > 0);
  assert.equal(held.instance, undefined, 'nothing is trusted from the file itself');
  assert.ok(fs.existsSync(claimPath(dir)));
  console.log('PASS: a claim names the port and the process holding the folder');

  // Our own claim is not something to refuse to start over: this is the
  // process that wrote it.
  assert.equal(await holder(dir), null, 'a server does not block itself');

  // The claim of a process that is gone, naming a port nothing answers on.
  claim(4242, dir);
  const file = JSON.parse(fs.readFileSync(claimPath(dir), 'utf8'));
  fs.writeFileSync(claimPath(dir), JSON.stringify({ ...file, pid: file.pid + 1 }));
  assert.equal(await holder(dir), null, 'a stale claim never stops a server');
  console.log('PASS: a claim left behind by a crash is ignored');

  const mine = await pretend(instanceFingerprint(dir, key));
  const stranger = await pretend('somebody-elses-library');
  try {
    fs.writeFileSync(claimPath(dir), JSON.stringify({ port: mine.port, pid: process.pid + 1, instance: 'stale' }));
    const found = await holder(dir);
    assert.equal(found?.port, mine.port, 'a server answering as this library holds it');

    fs.writeFileSync(claimPath(dir), JSON.stringify({ port: stranger.port, pid: process.pid + 1 }));
    assert.equal(await holder(dir), null, 'something else on that port is not this library');
  } finally {
    await mine.close();
    await stranger.close();
  }
  console.log('PASS: holding the folder means answering as this library, not merely answering');

  // Withdrawing is limited to the claim this process wrote.
  fs.writeFileSync(claimPath(dir), JSON.stringify({ port: 1, pid: process.pid + 1 }));
  assert.equal(release(dir), false);
  assert.ok(fs.existsSync(claimPath(dir)), "another server's claim is left alone");
  claim(5, dir);
  assert.equal(release(dir), true);
  assert.equal(fs.existsSync(claimPath(dir)), false);
  assert.equal(release(dir), true, 'releasing nothing is not an error');

  // Two folders, one key: still two libraries, and neither claims the other.
  const other = library('two');
  claim(4242, dir);
  assert.equal(read(other), null);
  console.log('PASS: a claim is withdrawn only by the server that made it');

  // Garbage in the file is not a reason to refuse to start.
  fs.writeFileSync(claimPath(dir), 'not json at all');
  assert.equal(read(dir), null);
  fs.writeFileSync(claimPath(dir), JSON.stringify({ port: 'three thousand' }));
  assert.equal(read(dir), null);
  assert.equal(await holder(dir), null);
  console.log('PASS: an unreadable claim reads as nobody holding the folder');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
