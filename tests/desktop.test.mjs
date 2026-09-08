/** Exercise the actual backend with isolated desktop data and Windows IPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mediawatcher-desktop-'));
const children = new Set();
const password = 'desktop-test-password';
fs.writeFileSync(path.join(scratch, '.env'), `TMDB_API_KEY=test\nALLDEBRID_API_KEY=test\nAUTH_PASSWORD=${password}\nPORT=0\nFFMPEG_ENABLED=0\n`);
const env = { ...process.env, MW_DATA_DIR: scratch, MW_DESKTOP: '1', MW_SUPERVISED: '1' };
// Avoid inherited live configuration affecting this isolated test.
for (const key of ['PORT', 'LIBRARY_PATH', 'TEMP_PATH', 'BIND_HOST', 'TMDB_API_KEY', 'ALLDEBRID_API_KEY', 'AUTH_PASSWORD']) delete env[key];

async function start(extra = {}) {
  const proc = fork(path.join(root, 'server.js'), [], {
    env: { ...env, ...extra }, execArgv: [], silent: true, windowsHide: true
  });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  proc.stdout.resume(); proc.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 15000);
    proc.on('message', (message) => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
    proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Backend exited early: ${code}`)); });
    proc.once('error', reject);
  });
  return { proc, url: `http://127.0.0.1:${ready.port}`, port: ready.port };
}
async function login(url) {
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, remember: true, deviceName: 'Desktop test' })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
try {
  let { proc, url } = await start();
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
  assert.equal((await fetch(`${url}/api/media/library`)).status, 401);
  const cookie = await login(url);
  const page = await fetch(url, { headers: { cookie } });
  assert.equal(await page.text(), fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'));
  assert.equal(fs.existsSync(path.join(scratch, 'db/mediawatcher.db')), true);
  assert.equal(fs.existsSync(path.join(scratch, 'config/admin-key')), true);
  assert.equal(fs.existsSync(path.join(scratch, 'library/movies')), true);
  console.log('PASS: isolated writable data, authenticated API and byte-identical frontend');

  const headers = { cookie, 'content-type': 'application/json' };
  const configResponse = await fetch(`${url}/api/admin/env`, { headers });
  assert.equal(configResponse.status, 200);
  const configBody = await configResponse.json();
  assert.equal(JSON.stringify(configBody).includes(password), false);
  const saved = await fetch(`${url}/api/admin/env`, {
    method: 'PUT', headers, body: JSON.stringify({ password, changes: { LOG_LEVEL: 'warn' } })
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).restartRequired, true);
  assert.match(fs.readFileSync(path.join(scratch, '.env'), 'utf8'), /LOG_LEVEL=warn/);
  assert.ok(fs.existsSync(path.join(scratch, '.env.bak')));
  console.log('PASS: Settings writes and backs up the selected data configuration');
  const exit = once(proc, 'exit');
  proc.send({ type: 'shutdown' });
  assert.equal((await exit)[0], 0);
  ({ proc, url } = await start());
  assert.equal((await fetch(`${url}/api/media/library`, { headers: { cookie } })).status, 200);
  console.log('PASS: IPC shutdown and remembered login survive backend relaunch');

  const restarted = once(proc, 'exit');
  const response = await fetch(`${url}/api/admin/restart`, {
    method: 'POST', headers, body: JSON.stringify({ password })
  });
  assert.equal(response.status, 200);
  assert.equal((await restarted)[0], 75);
  console.log('PASS: existing Settings restart requests supervisor restart code 75');

  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(start({ PORT: String(occupied.address().port) }), /exited early/);
    assert.equal(occupied.listening, true);
  } finally { await new Promise((resolve) => occupied.close(resolve)); }
  console.log('PASS: occupied port fails without attaching to or stopping another server');
} finally {
  for (const proc of children) {
    const exited = once(proc, 'exit');
    if (proc.connected) proc.send({ type: 'shutdown' }); else proc.kill();
    await exited;
  }
  // Scratch is created by mkdtemp; never touches a user's library.
  fs.rmSync(scratch, { recursive: true, force: true });
}
