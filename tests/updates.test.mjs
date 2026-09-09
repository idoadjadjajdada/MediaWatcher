/**
 * The desktop update flow, without Electron.
 *
 * `createUpdates` takes its updater, its persistence and its shutdown hook as
 * arguments precisely so the state machine can be driven here: a fake updater
 * emits the events electron-updater emits, and the assertions cover what the
 * updates window shows and what the main process is asked to do.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createUpdates, repositoryName } = require(path.join(root, 'desktop/updater.cjs'));

const repository = 'owner/repository';
assert.equal(repositoryName(repository), repository);
assert.equal(repositoryName('  https://github.com/owner/repository  '), repository);
assert.equal(repositoryName('https://github.com/owner/repository.git'), repository);
assert.equal(repositoryName('https://github.com/owner/repository/releases/latest'), repository);
assert.equal(repositoryName(''), '');
for (const bad of ['owner', 'owner/repo/extra', 'owner/..', 'https://gh.example/owner/repo',
  'https://user:token@github.com/owner/repository', 'https://github.com/owner/repository?token=1',
  'owner/repo space', '-owner/repo']) {
  assert.throws(() => repositoryName(bad), /GitHub repository/, `accepted ${bad}`);
}
console.log('PASS: repository names accept links and owner/repository, and reject the rest');

function harness({ packaged = true, repository: configured = repository } = {}) {
  const calls = { saved: [], installs: 0, before: 0, failed: 0, made: [] };
  const states = [];
  let fake;
  const updates = createUpdates({
    version: '1.0.2', packaged, repository: configured,
    makeUpdater: (options) => {
      calls.made.push(options);
      const handlers = new Map();
      fake = {
        on: (event, fn) => { handlers.set(event, fn); },
        emit: (event, value) => handlers.get(event)?.(value),
        checkForUpdates: async () => fake.onCheck?.(),
        downloadUpdate: async () => fake.onDownload?.(),
        quitAndInstall: (...args) => { calls.installs += 1; calls.install = args; fake.onInstall?.(); }
      };
      return fake;
    },
    saveRepository: (value) => { calls.saved.push(value); },
    changed: (state) => states.push(state),
    beforeInstall: async () => { calls.before += 1; assert.equal(calls.installs, 0, 'the installer ran before shutdown'); },
    installFailed: async () => { calls.failed += 1; }
  });
  return { updates, calls, states, updater: () => fake };
}

{
  const { updates } = harness({ repository: '' });
  assert.equal(updates.snapshot().status, 'unconfigured');
  assert.equal((await updates.check()).status, 'unconfigured');
  assert.equal((await updates.download()).status, 'unconfigured');
}
{
  const { updates, calls } = harness({ packaged: false });
  assert.equal((await updates.check()).status, 'development');
  assert.equal(calls.made.length, 0, 'a source checkout must not reach GitHub');
}
console.log('PASS: no repository and no installer each stop before any network call');

{
  const h = harness();
  // The updater is created synchronously, so its events can be emitted while
  // the call is still in flight, exactly as electron-updater emits them.
  const checking = h.updates.check();
  h.updater().emit('update-available', { version: '1.1.0' });
  const available = await checking;
  assert.equal(available.status, 'available');
  assert.equal(available.latestVersion, '1.1.0');
  assert.equal(available.currentVersion, '1.0.2');
  assert.deepEqual(h.calls.made[0],
    { provider: 'github', owner: 'owner', repo: 'repository', private: false, releaseType: 'release' });

  const downloading = h.updates.download();
  h.updater().emit('download-progress', { percent: 42.6 });
  assert.equal(h.updates.snapshot().percent, 43);
  h.updater().emit('update-downloaded', { version: '1.1.0' });
  assert.equal((await downloading).status, 'ready');
  assert.equal(h.updates.snapshot().percent, 100);

  await h.updates.install();
  assert.equal(h.calls.before, 1);
  assert.equal(h.calls.installs, 1);
  assert.deepEqual(h.calls.install, [false, true]);
  assert.equal(h.calls.failed, 0);
  assert.ok(h.states.some((state) => state.status === 'downloading'), 'the window is told about progress');
}
console.log('PASS: available, downloaded and installed, with the backend stopped first');

{
  const h = harness();
  await h.updates.check();
  h.updater().emit('update-not-available', {});
  assert.equal(h.updates.snapshot().status, 'current');
  assert.ok(h.updates.snapshot().checkedAt > 0);

  h.updater().emit('error', new Error('release feed unreachable'));
  const failed = h.updates.snapshot();
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /latest\.yml/);
  assert.equal(failed.error.includes('release feed unreachable'), false, 'raw updater errors are not shown');
}
{
  const h = harness();
  const checking = h.updates.check();
  h.updater().emit('update-available', { version: '1.1.0' });
  await checking;
  const downloading = h.updates.download();
  h.updater().emit('update-downloaded', { version: '1.1.0' });
  await downloading;
  h.updater().onInstall = () => { throw new Error('the installer would not start'); };
  await h.updates.install();
  assert.equal(h.updates.snapshot().status, 'error');
  assert.equal(h.calls.failed, 1, 'a failed install restarts the backend');
}
console.log('PASS: a failed check or install reports plainly and restores the app');

{
  const h = harness();
  const checking = h.updates.check();
  const stale = h.updater();
  stale.emit('update-available', { version: '1.1.0' });
  await checking;
  await h.updates.configure('https://github.com/other/repo');
  assert.deepEqual(h.calls.saved, ['other/repo']);
  assert.equal(h.updates.snapshot().repository, 'other/repo');
  assert.equal(h.updates.snapshot().latestVersion, null);
  stale.emit('update-downloaded', { version: '1.1.0' });
  assert.notEqual(h.updates.snapshot().status, 'ready', 'the replaced updater still had a listener');
  await assert.rejects(() => h.updates.configure('nonsense'), /GitHub repository/);

  const rechecking = h.updates.check();
  h.updater().emit('update-available', { version: '1.1.0' });
  await rechecking;
  const finishing = h.updates.download();
  h.updater().emit('update-downloaded', { version: '1.1.0' });
  await finishing;
  await assert.rejects(() => h.updates.configure('third/repo'), /Finish the current update/);
}
console.log('PASS: changing the repository rechecks, drops the old updater and is refused mid-update');

// The wiring the state machine cannot see: the window, its bridge and the build.
const release = JSON.parse(fs.readFileSync(path.join(root, 'desktop/release.json'), 'utf8'));
assert.equal(repositoryName(release.repository), release.repository);
const [owner, repo] = release.repository.split('/');
const builder = require(path.join(root, 'electron-builder.cjs'));
assert.deepEqual(builder.publish, [{ provider: 'github', owner, repo, releaseType: 'release' }]);
assert.ok(builder.files.includes('node_modules/**/*'), 'the updater has to ship inside the app');
assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['electron-updater'],
  'electron-updater is a runtime dependency');
assert.equal(fs.existsSync(path.join(root, 'desktop/app-update.yml')), false,
  'app-update.yml belongs in resources, where electron-builder generates it');

const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop/preload.cjs'), 'utf8');
const window = fs.readFileSync(path.join(root, 'desktop/updates.js'), 'utf8');
for (const channel of ['status', 'check', 'download', 'install', 'configure']) {
  assert.ok(main.includes(`ipcMain.handle('updates:${channel}'`), `main.cjs handles updates:${channel}`);
  assert.ok(preload.includes(`ipcRenderer.invoke('updates:${channel}'`), `preload bridges updates:${channel}`);
}
assert.ok(main.includes('requireUpdates(event)'), 'every updates channel checks its sender');
// Every bridge is a hole in the sandbox, so the list of them is the test.
assert.deepEqual([...preload.matchAll(/exposeInMainWorld\('(\w+)'/g)].map(([, name]) => name).sort(),
  ['desktopSetup', 'desktopUpdates', 'desktopWindow']);
assert.ok(window.includes('window.desktopUpdates'), 'the updates window uses the bridge');
console.log('PASS: the window, its bridge, the sender check and the published release source line up');
