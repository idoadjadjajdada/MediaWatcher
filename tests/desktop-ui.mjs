/** Real Electron smoke test; supports both development and packaged executables. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = createRequire(import.meta.url)(path.join(root, 'desktop', 'platform.cjs'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mediawatcher-desktop-ui-'));
const data = path.join(scratch, 'data');
const profile = path.join(scratch, 'profile');
const executablePath = process.env.MW_TEST_EXE;
let desktop;
const launchOptions = {
  ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root, 'desktop/main.cjs')] }),
  // A shorter fallback than the app's own, so the prompt is on screen for a
  // second rather than four: it is a real window on a real desktop, and a
  // stray click answering it looks exactly like a failure.
  env: { ...process.env, MW_DESKTOP_PROFILE: profile, MW_DATA_DIR: data, PORT: '0', MW_CLOSE_ASK_MS: '1200' },
  timeout: 30000
};
try {
  desktop = await electron.launch(launchOptions);
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'Your library. Your screen.' }).waitFor();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('summary').click();
  await page.locator('[name=tmdb]').fill('desktop-test-key');
  await page.locator('[name=debrid]').fill('desktop-test-key');
  await page.locator('[name=password]').fill('desktop-test-password');
  await page.getByRole('button', { name: 'Create library and open MediaWatcher' }).click();
  await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\/login.html/, { timeout: 30000 });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.desktopSetup), 'undefined');
  const origin = new URL(page.url()).origin;
  await page.locator('#password').fill('desktop-test-password');
  await page.locator('#remember').check();
  await page.locator('#device-name').fill('Desktop smoke');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForURL(`${origin}/`);
  await page.waitForSelector('#navrail');
  await page.waitForFunction(() => document.querySelector('#mw-titlebar')?.getBoundingClientRect().height > 20);
  // The overlay is what the app asks for by default. A run told to use a real
  // window frame instead — the Linux escape hatch — has no overlay to check,
  // and the title bar is still there because the status light lives in it.
  if ((process.env.MW_TITLEBAR || 'overlay') === 'overlay') {
    assert.equal(await page.evaluate(() => navigator.windowControlsOverlay.visible), true);
  }
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#mw-titlebar')).webkitAppRegion), 'drag');
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results', executablePath ? 'desktop-packaged.png' : 'desktop-development.png') });
  assert.equal(await page.evaluate(() => document.querySelector('link[href="/css/styles.css"]') !== null), true);
  assert.equal(await page.evaluate(() => {
    const video = document.createElement('video');
    return Boolean(video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
  }), true);
  assert.equal((await page.request.get(`${origin}/api/media/library`)).status(), 200);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: setup → authenticated original UI, isolated renderer, H.264/AAC support');
  /*
   * The FFmpeg the app itself would reach for. A packaged build bundles one on
   * Windows, and on Linux usually does not — there the package depends on the
   * system copy, which is what the app puts on PATH's far end anyway. So use
   * the bundled one when it is there and the system one when it is not, rather
   * than assuming either.
   */
  const bundled = executablePath
    && path.join(path.dirname(executablePath), 'resources', 'bin', platform.executableName('ffmpeg'));
  const ffmpeg = bundled && fs.existsSync(bundled) ? bundled : 'ffmpeg';
  const clip = path.join(data, 'library/movies/desktop-smoke.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', '-y', clip], { windowsHide: true });
  for (const mode of ['direct', 'hls']) {
    const result = await page.evaluate(async ({ clip, mode }) => {
      const video = document.createElement('video');
      video.muted = true;
      document.body.append(video);
      let detach;
      try {
        if (mode === 'hls') {
          const { attachHls } = await import('/js/hls-player.js');
          detach = await attachHls(video, `/api/hls/playlist.m3u8?path=${encodeURIComponent(clip)}&q=medium`);
        } else video.src = `/api/stream?path=${encodeURIComponent(clip)}`;
        await video.play();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${mode} did not advance`)), 20000);
          video.addEventListener('timeupdate', () => {
            if (video.currentTime > 0.3) { clearTimeout(timer); resolve(); }
          });
        });
        return { time: video.currentTime, width: video.videoWidth };
      } finally { video.pause(); detach?.(); video.removeAttribute('src'); video.load(); video.remove(); }
    }, { clip, mode });
    assert.ok(result.time > 0.3 && result.width === 320);
    console.log(`PASS: actual ${mode} video playback in Electron with bundled backend`);
  }
  await page.evaluate(async (file) => { await (await import('/js/player.js')).open(file); }, clip);
  await page.waitForSelector('#player');
  await page.waitForFunction(() => document.querySelector('.player__video')?.readyState >= 2);
  await page.evaluate(() => { const video = document.querySelector('.player__video'); video.pause(); video.currentTime = 1; });
  const layout = await page.evaluate(() => {
    const player = document.querySelector('#player');
    const controls = document.querySelector('.player__controls');
    const bar = document.querySelector('#mw-titlebar').getBoundingClientRect();
    return {
      playerTop: player.getBoundingClientRect().top, barBottom: bar.bottom,
      border: getComputedStyle(controls).borderTopWidth,
      fade: getComputedStyle(controls, '::before').backgroundImage,
      fadeHitTest: getComputedStyle(controls, '::before').pointerEvents
    };
  });
  assert.ok(layout.playerTop >= layout.barBottom);
  assert.equal(layout.border, '0px');
  assert.ok(layout.fade.includes('linear-gradient'));
  assert.equal(layout.fadeHitTest, 'none');
  await page.screenshot({ path: path.join(root, 'test-results', executablePath ? 'player-packaged.png' : 'player-development.png') });
  await page.evaluate(() => document.querySelector('#player').requestFullscreen());
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#mw-titlebar')).display === 'none');
  assert.equal(await page.evaluate(() => document.querySelector('#player').getBoundingClientRect().top), 0);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => document.querySelector('#mw-titlebar').getBoundingClientRect().height > 20, null, { timeout: 8000 });
  await page.evaluate(async () => { await (await import('/js/player.js')).close(); });
  console.log('PASS: custom draggable title bar, floating player fade and edge-to-edge fullscreen');
  const preferences = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  const closeWindow = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const windowVisible = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  const showWindow = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  // The first close asks, inside the app, and does nothing until it is answered.
  await closeWindow();
  await page.locator('.mw-close__card').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.choice), 'tray');
  assert.equal(await windowVisible(), true);
  // Let it finish arriving, or the screenshot catches it mid-fade.
  await page.locator('.mw-close__card').evaluate((card) => Promise.all(card.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: path.join(root, 'test-results', executablePath ? 'close-packaged.png' : 'close-development.png') });
  // The shell hides the window on its own if the prompt never draws. It has,
  // so that must not fire out from under someone still reading it.
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(await windowVisible(), true, 'an unanswered prompt is not a stuck window');
  assert.equal(await page.locator('.mw-close__card').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('.mw-close__card').waitFor({ state: 'detached' });
  assert.equal(await windowVisible(), true, 'Escape leaves the window open');

  // Keeping it running hides the window and leaves the server serving.
  await closeWindow();
  await page.locator('[data-choice="tray"]').click();
  await page.waitForFunction(() => !document.querySelector('.mw-close__card'));
  assert.equal(await windowVisible(), false);
  assert.equal((await page.request.get(`${origin}/api/health`)).status(), 200);
  await showWindow();
  assert.equal(await page.evaluate(() => window.desktopWindow.closeBehaviour()), 'ask',
    'an unremembered answer is not saved');

  // Remembered, it stops asking — and the answer is the installation's, so it
  // is in desktop.json rather than in this device's browser storage.
  await closeWindow();
  await page.locator('.mw-close__remember input').check();
  await page.locator('[data-choice="tray"]').click();
  await page.waitForFunction(() => !document.querySelector('.mw-close__card'));
  await showWindow();
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'desktop.json'), 'utf8')).closeBehaviour, 'tray');
  await closeWindow();
  assert.equal(await page.locator('.mw-close__card').count(), 0, 'a remembered answer is not asked again');
  assert.equal(await windowVisible(), false);
  await showWindow();

  // Settings shows the same answer and can put it back to asking.
  await page.evaluate(async () => { (await import('/js/state.js')).setState({ currentPage: 'settings' }); });
  const closeSetting = page.locator('[data-field="closeBehaviour"]');
  await closeSetting.first().waitFor();
  assert.equal(await page.locator('[data-field="closeBehaviour"].is-active').innerText(), 'Keep running');
  // The page's own top padding clears the caption bar; scrolled anywhere else,
  // the first row of the first section sits under it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-field="closeBehaviour"][data-value="ask"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-field="closeBehaviour"].is-active')?.textContent.trim() === 'Ask');
  assert.equal(await page.evaluate(() => window.desktopWindow.closeBehaviour()), 'ask');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'desktop.json'), 'utf8')).closeBehaviour, 'ask');
  await page.evaluate(async () => { (await import('/js/state.js')).setState({ currentPage: 'home' }); });
  console.log('PASS: the close prompt asks once, remembers when told to, and Settings agrees with it');

  /*
   * Notifications. Electron has no push service, so the app raises them from
   * the job poll instead — the same news by a shorter route. The Notification
   * constructor is stubbed because a real one would land in the Windows action
   * centre and could not be read back.
   */
  const notified = await page.evaluate(async () => {
    const notify = await import('/js/notify.js');
    const raised = [];
    const real = window.Notification;
    let clicked = false;
    window.Notification = class {
      static permission = 'granted';
      constructor(title, options) { raised.push({ title, ...options }); }
    };
    const shown = notify.announce(
      [{ id: '1', status: 'downloading', title: 'The Fixture' }, { id: '2', status: 'queued', title: 'Another' }],
      [{ id: '1', status: 'complete', title: 'The Fixture' }, { id: '2', status: 'queued', title: 'Another' }]
    );
    const withoutPermission = (() => {
      window.Notification = class { static permission = 'denied'; constructor() { raised.push('denied'); } };
      return notify.announce([{ id: '3', status: 'downloading' }], [{ id: '3', status: 'error' }]).length;
    })();
    window.Notification = real;
    void clicked;
    return {
      inApp: notify.inDesktopApp(), announced: shown.length, raised, withoutPermission,
      canShowWindow: typeof window.desktopWindow.show
    };
  });
  assert.equal(notified.inApp, true, 'the page knows it is inside the shell');
  assert.equal(notified.announced, 1, 'only the job that changed');
  assert.deepEqual(notified.raised, [{ title: 'Download finished', body: 'The Fixture', tag: 'mw-job-1' }]);
  assert.equal(notified.withoutPermission, 0, 'nothing is raised without permission');
  assert.equal(notified.canShowWindow, 'function', 'a notification can ask for the window back');

  // And the settings page offers that rather than a push switch that cannot work.
  await page.evaluate(async () => { (await import('/js/state.js')).setState({ currentPage: 'settings' }); });
  await page.locator('[data-field="desktopNotifications"]').waitFor();
  assert.equal(await page.locator('[data-action^="settings-push"]').count(), 0,
    'the browser push switch is not offered where it cannot work');
  await page.evaluate(async () => { (await import('/js/state.js')).setState({ currentPage: 'home' }); });
  console.log('PASS: the app raises its own download notifications, and says what only a browser can do');

  /*
   * The light in the title bar. Green is real here — a running server and the
   * version this was built from — and the other two are driven from the main
   * process, because neither an outdated build nor a dead server is something
   * to arrange for real halfway through a test.
   */
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const light = page.locator('#mw-status');
  const lightAction = page.locator('.mw-status__action');
  await light.waitFor();
  await page.waitForFunction(() => document.getElementById('mw-status')?.dataset.state !== 'unknown');
  assert.equal(await light.getAttribute('data-state'), 'green', 'connected, on the current version');
  assert.equal(await page.locator('.mw-status__version').textContent(), `v${appVersion}`);
  assert.equal(await lightAction.isHidden(), true, 'nothing to do when it is green');
  assert.equal(await page.locator('.mw-status__dot').evaluate((dot) => getComputedStyle(dot).animationName),
    'none', 'green does not flash');
  // The bar is dragged to move the window; the controls inside it must not be.
  assert.equal(await light.evaluate((el) => getComputedStyle(el).webkitAppRegion), 'no-drag');

  const say = (state) => desktop.evaluate(({ BrowserWindow }, payload) =>
    BrowserWindow.getAllWindows()[0].webContents.send('status:update', payload), state);

  await say({ version: appVersion, connected: true, update: 'available', latestVersion: '9.9.9', percent: 0 });
  await page.waitForFunction(() => document.getElementById('mw-status')?.dataset.state === 'yellow');
  assert.match(await lightAction.textContent(), /Update to 9\.9\.9/);
  assert.equal(await lightAction.isEnabled(), true);
  assert.equal(await page.locator('.mw-status__dot').evaluate((dot) => getComputedStyle(dot).animationName),
    'mw-status-flash', 'an update waiting flashes');

  await say({ version: appVersion, connected: true, update: 'downloading', percent: 42 });
  await page.waitForFunction(() => /42%/.test(document.querySelector('.mw-status__action')?.textContent || ''));
  assert.equal(await lightAction.isDisabled(), true, 'nothing to press while it downloads');

  await say({ version: appVersion, connected: true, update: 'ready', latestVersion: '9.9.9', percent: 100 });
  await page.waitForFunction(() => document.querySelector('.mw-status__action')?.textContent === 'Restart & install');
  assert.equal(await light.getAttribute('data-state'), 'yellow', 'still not the current version');

  await say({ version: appVersion, connected: false, update: 'current' });
  await page.waitForFunction(() => document.getElementById('mw-status')?.dataset.state === 'red');
  assert.equal(await lightAction.textContent(), 'Reconnect');
  assert.equal(await page.locator('.mw-status__dot').evaluate((dot) => getComputedStyle(dot).animationName),
    'none', 'a dead server is a steady light, not a flashing one');

  // The server is actually up, so reconnecting finds it and says so again.
  await lightAction.click();
  await page.waitForFunction(() => document.getElementById('mw-status')?.dataset.state === 'green', null, { timeout: 20000 });
  await page.waitForSelector('#navrail');
  assert.equal((await page.request.get(`${origin}/api/health`)).status(), 200);
  assert.equal(await lightAction.isHidden(), true);
  console.log('PASS: the title bar light is green, flashes for an update, and reconnects from red');

  // Native menus cannot be clicked from the outside, so invoke the item itself.
  const [updates] = await Promise.all([
    desktop.waitForEvent('window'),
    desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items
      .find((item) => item.label.startsWith('Check for updates')).click())
  ]);
  await updates.getByRole('heading', { name: 'App updates' }).waitFor();
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(await updates.locator('#current').textContent(), version);
  assert.equal(await updates.locator('#repository').inputValue(),
    JSON.parse(fs.readFileSync(path.join(root, 'desktop/release.json'), 'utf8')).repository);
  assert.equal(await updates.evaluate(() => typeof window.desktopUpdates), 'object');
  assert.equal(await updates.evaluate(() => typeof window.desktopSetup), 'undefined');
  assert.equal(await updates.evaluate(() => typeof window.require), 'undefined');
  // A source checkout has no installer to replace, so it never reaches GitHub.
  if (!executablePath) {
    await updates.waitForFunction(() => document.getElementById('status').textContent === 'Running from source');
    assert.equal(await updates.locator('#check').isDisabled(), true);
  }
  await updates.screenshot({ path: path.join(root, 'test-results', executablePath ? 'updates-packaged.png' : 'updates-development.png') });
  await updates.close();
  console.log('PASS: the updates window opens from the menu, isolated, showing this version');
  await desktop.close();
  desktop = null;
  await assert.rejects(fetch(`${origin}/api/health`));
  console.log('PASS: quitting Electron shuts down its backend');

  desktop = await electron.launch(launchOptions);
  const restored = await desktop.firstWindow();
  await restored.waitForSelector('#navrail');
  const restartOrigin = new URL(restored.url()).origin;
  const restart = await restored.request.post(`${restartOrigin}/api/admin/restart`, {
    data: { password: 'desktop-test-password' }
  });
  assert.equal(restart.status(), 200);
  // PORT=0 deliberately changes the port to test the desktop's reconnect path.
  await restored.waitForURL((url) => url.origin !== restartOrigin && url.protocol === 'http:', { timeout: 20000 });
  await restored.waitForSelector('#navrail');
  console.log('PASS: desktop relaunch remembers login and supervises Settings restart');
  await desktop.close();
  desktop = null;

  const before = fs.readFileSync(path.join(data, '.env'), 'utf8');
  desktop = await electron.launch({
    ...launchOptions, env: { ...launchOptions.env, MW_DESKTOP_PROFILE: path.join(scratch, 'import-profile'), MW_DATA_DIR: path.join(scratch, 'unused-data') }
  });
  const importer = await desktop.firstWindow();
  await importer.getByRole('heading', { name: 'Your library. Your screen.' }).waitFor();
  // Supply a deterministic folder choice to the native dialog without UI automation.
  await desktop.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, data);
  await importer.getByRole('button', { name: 'Use existing library' }).click();
  await importer.waitForURL(/http:\/\/127\.0\.0\.1:\d+\/login.html/, { timeout: 30000 });
  assert.equal(fs.readFileSync(path.join(data, '.env'), 'utf8'), before);
  const imported = JSON.parse(fs.readFileSync(path.join(scratch, 'import-profile/desktop.json'), 'utf8'));
  assert.equal(imported.dataDir, data);
  console.log('PASS: existing library setup reuses its configuration in place');
  await desktop.close();
  desktop = null;

  /*
   * Sharing the machine. The website and the app are the same server, so the
   * question is never "can both run" but "which one is serving": one already
   * holding this library is joined, and anything else on the port is stepped
   * around. Two servers over one folder is the case worth preventing — each
   * would scan and sweep the other's work.
   */
  const freePort = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const standalone = fork(path.join(root, 'server.js'), [], {
    env: { ...process.env, MW_DATA_DIR: data, PORT: String(freePort), MW_SUPERVISED: '1' },
    execArgv: [], silent: true, windowsHide: true
  });
  standalone.stdout.resume();
  standalone.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('standalone server startup timed out')), 30000);
    standalone.on('message', (message) => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    standalone.once('exit', (code) => { clearTimeout(timer); reject(new Error(`standalone exited: ${code}`)); });
  });
  try {
    desktop = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, PORT: String(freePort) } });
    const joined = await desktop.firstWindow();
    await joined.waitForSelector('#navrail');
    assert.equal(new URL(joined.url()).port, String(freePort), 'the app joined the running server');
    assert.equal(standalone.exitCode, null, 'and did not stop it');
    await desktop.close();
    desktop = null;
    // Closing the app must not take a server it never started with it.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(standalone.exitCode, null, 'the server outlives the window that joined it');
    assert.equal((await fetch(`http://127.0.0.1:${freePort}/api/health`)).status, 200);
    console.log('PASS: the app joins a MediaWatcher already serving this library');
  } finally {
    // Not a desktop child, so it has no IPC shutdown listener to speak to.
    if (standalone.exitCode === null) {
      const exited = new Promise((resolve) => standalone.once('exit', resolve));
      standalone.kill();
      await exited;
    }
  }

  // A port held by something that is not MediaWatcher: start beside it.
  const squatter = net.createServer((socket) => socket.end());
  await new Promise((resolve) => squatter.listen(freePort, '127.0.0.1', resolve));
  try {
    desktop = await electron.launch({ ...launchOptions, env: { ...launchOptions.env, PORT: String(freePort) } });
    const beside = await desktop.firstWindow();
    await beside.waitForSelector('#navrail', { timeout: 45000 });
    const port = Number(new URL(beside.url()).port);
    assert.notEqual(port, freePort, 'it did not take the occupied port');
    assert.equal((await beside.request.get(`http://127.0.0.1:${port}/api/health`)).status(), 200);
    assert.equal(squatter.listening, true, 'and did not evict what was already there');
    console.log('PASS: an occupied port moves the app aside instead of stopping it');
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
} finally {
  if (desktop) await desktop.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
