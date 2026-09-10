const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeTheme, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { fork, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createUpdates, repositoryName } = require('./updater.cjs');
const { fingerprint, claim } = require('./instance.cjs');
const platform = require('./platform.cjs');

app.setName('MediaWatcher');
const sourceRoot = path.resolve(__dirname, '..');
const backendRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : sourceRoot;
const { parse } = require(path.join(backendRoot, 'node_modules', 'dotenv'));
if (process.env.MW_DESKTOP_PROFILE) app.setPath('userData', path.resolve(process.env.MW_DESKTOP_PROFILE));
const profile = app.getPath('userData');
const settingsPath = path.join(profile, 'desktop.json');
const setupUrl = pathToFileURL(path.join(__dirname, 'setup.html')).href;
const updatesUrl = pathToFileURL(path.join(__dirname, 'updates.html')).href;
/*
 * Windows takes the .ico for both the window and the tray, because one file
 * carries every size either asks for. Linux takes PNGs, and takes a different
 * one for each: panels scale whatever they are handed, and a 512px source
 * squeezed into a 22px slot comes out muddier than a 192px one does.
 */
const icon = path.join(sourceRoot, 'public', platform.target()?.windowIcon || 'icons/app.ico');
const trayIcon = path.join(sourceRoot, 'public', platform.target()?.trayIcon || 'icons/app.ico');
const titlebarCss = fs.readFileSync(path.join(__dirname, 'titlebar.css'), 'utf8');
const closeCss = fs.readFileSync(path.join(__dirname, 'close-prompt.css'), 'utf8');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* first launch */ }
let dataDir = path.resolve(process.env.MW_DATA_DIR || settings.dataDir
  || (app.isPackaged ? path.join(profile, 'data') : sourceRoot));
/**
 * Which title bar the windows get.
 *
 * The dark bar drawn inside the page, with Electron's own caption buttons
 * overlaid on it, is the design — and on Windows it is simply what happens.
 * Linux is less uniform: the overlay depends on the desktop drawing client-side
 * decorations, and on a tiling or minimal window manager a frameless window can
 * arrive with no way to move, resize or close it. That is an app nobody can
 * use, and it is not worth risking for a colour.
 *
 * So `native` exists, and asks the window manager for an ordinary frame. The
 * in-page bar stays either way: it carries the status light, which is the part
 * that had something to say. MW_TITLEBAR overrides it for one run; desktop.json
 * remembers it.
 */
const CHROME = ['overlay', 'native'];
const chrome = CHROME.includes(process.env.MW_TITLEBAR) ? process.env.MW_TITLEBAR
  : CHROME.includes(settings.titleBar) ? settings.titleBar : 'overlay';
const chromeOptions = chrome === 'overlay'
  ? {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090a0c', symbolColor: '#a5a7ad', height: 36 }
  }
  : {};
// With a real frame there are no caption buttons to keep clear of, so the bar
// stops reserving 150px of nothing on its right.
const chromeCss = chrome === 'overlay' ? ''
  : '\nhtml[data-mw-desktop] #mw-titlebar { padding-right: 18px; }\n';

let win, tray, child, origin, starting, stopPromise;
let attached = false;
let attachTimer;
let connected = true;
let statusTimer;
let updatesWin, updateTimer, trayUpdateStatus;
let quitting = false;
let failures = 0;
let restartTimer;
let logTail = '';

function saveSettings() {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(`${settingsPath}.tmp`, JSON.stringify({ ...settings, dataDir }, null, 2));
  fs.renameSync(`${settingsPath}.tmp`, settingsPath);
}

function configured(dir = dataDir) {
  try {
    const env = parse(fs.readFileSync(path.join(dir, '.env')));
    return Boolean(env.TMDB_API_KEY?.trim() && env.ALLDEBRID_API_KEY?.trim()
      && env.AUTH_PASSWORD?.trim().length >= 8);
  } catch { return false; }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isAppUrl(value) {
  try { return Boolean(origin && new URL(value).origin === origin); } catch { return false; }
}

function openExternal(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol)) shell.openExternal(url.href).catch(() => {});
  } catch { /* never pass arbitrary protocols to the operating system */ }
}

/**
 * Open the configuration in whatever this machine edits text with.
 *
 * A dotfile with no extension is the case desktops handle worst. Windows has no
 * association for it on a fresh installation, and a Linux desktop may hand it
 * to an archive manager, to nothing at all, or to xdg-open with no MIME match.
 * So the system gets first refusal and each platform has one fallback that is
 * always installed — after which the folder is opened instead, because a path
 * someone can see beats an error box naming a file they cannot reach.
 */
async function openConfiguration() {
  const file = path.join(dataDir, '.env');
  const error = await shell.openPath(file);
  if (!error) return;
  const fallback = process.platform === 'win32' ? ['notepad.exe', [file]]
    : process.platform === 'linux' ? ['xdg-open', [file]] : null;
  if (!fallback) { dialog.showErrorBox('Open configuration', error); return; }
  execFile(fallback[0], fallback[1], { windowsHide: true }, (failure) => {
    if (!failure) return;
    shell.showItemInFolder(file);
    dialog.showErrorBox('Open configuration',
      `MediaWatcher could not open an editor for:\n\n${file}\n\nIt has opened the folder instead.`);
  });
}

function appendLog(chunk) {
  // No raw credentials in persistent desktop logs or startup dialogs.
  const line = String(chunk).replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
  logTail = (logTail + line).slice(-6000);
  const file = path.join(profile, 'desktop.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.renameSync(file, `${file}.previous`);
    }
    fs.appendFileSync(file, line);
  } catch { /* logging must not bring down playback */ }
}

function updateMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open MediaWatcher', click: showWindow },
    { label: 'Open in browser (casting / web push)', enabled: Boolean(origin), click: () => openExternal(origin) },
    { label: origin ? `${attached ? 'Joined' : 'Serving'} ${origin}` : 'Starting…', enabled: false },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(dataDir) },
    { label: 'Edit configuration', click: openConfiguration },
    { label: 'Open desktop log', click: () => shell.openPath(path.join(profile, 'desktop.log')) },
    { label: updateLabel(), click: openUpdates },
    { type: 'separator' },
    { label: 'Quit MediaWatcher', click: () => app.quit() }
  ]));
}

/**
 * Where this window's server is.
 *
 * The old answer was "ours, on the configured port, or nowhere" — an occupied
 * port was a startup failure telling you to go and stop the other thing. But
 * the other thing is usually MediaWatcher itself, run from a terminal or by the
 * old launcher, and refusing to open next to it helps nobody.
 *
 * Two copies of one library is the case actually worth preventing: each would
 * scan, sweep and reconcile downloads over the same folder, and each would
 * treat the other's in-flight segments as orphans to delete. So a server that
 * proves it holds this data folder is joined rather than duplicated, and
 * anything else on the port is simply stepped around.
 */
function configuredPort() {
  const explicit = Number(process.env.PORT);
  // 0 is meaningful: it asks the operating system for any free port.
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 65535) return explicit;
  try { return Number(parse(fs.readFileSync(path.join(dataDir, '.env'))).PORT) || 3000; }
  catch { return 3000; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function health(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      // A reply this long is not our health endpoint, whatever else it is.
      response.on('data', (chunk) => { body = (body + chunk).slice(0, 4000); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

async function resolveBackend() {
  const ours = fingerprint(dataDir);
  const configured = configuredPort();

  /*
   * A running server leaves a claim naming the port it actually answers on,
   * which is not always the one this side is configured for — someone starting
   * the website with a different PORT is exactly the case worth finding, since
   * the alternative is two servers over one folder.
   */
  const claimed = ours ? claim(dataDir) : null;
  if (claimed && claimed.port !== configured) {
    const answer = await health(claimed.port);
    if (answer?.instance === ours) return { attach: `http://127.0.0.1:${claimed.port}` };
  }

  if (await portFree(configured)) return { port: configured };

  const answer = await health(configured);
  if (ours && answer?.instance === ours) return { attach: `http://127.0.0.1:${configured}` };

  // Someone else's port. Take the next free one so both can run, rather than
  // refusing to open or, worse, starting a second server over one library.
  for (let port = configured + 1; port <= configured + 9; port += 1) {
    if (await portFree(port)) return { port };
  }
  return { port: 0 };
}

/**
 * What the light in the title bar says.
 *
 * Green is "this is the current version, talking to its server", which is the
 * state nobody needs to think about. The other two are the ones worth showing
 * without being asked: an update waiting, and a server that has stopped
 * answering — the second is otherwise indistinguishable from the app being
 * slow, because every panel fails on its own and none of them says why.
 */
function statusNow() {
  const update = updates.snapshot();
  return {
    version: update.currentVersion,
    connected,
    origin: origin || null,
    attached,
    // 'available' and 'ready' are both "there is a newer one"; the difference
    // is only whether it has been fetched yet, which the button says.
    update: update.status,
    percent: update.percent,
    latestVersion: update.latestVersion
  };
}

function pushStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('status:update', statusNow());
}

/**
 * One poll for two jobs: whether anything is answering, and whether a server
 * we joined rather than started has gone away.
 */
function watchBackend() {
  clearInterval(attachTimer);
  clearInterval(statusTimer);
  let misses = 0;
  statusTimer = setInterval(async () => {
    if (quitting) return;
    const answering = origin ? Boolean(await health(Number(new URL(origin).port))) : false;
    if (answering !== connected) { connected = answering; pushStatus(); }
    if (answering) { misses = 0; return; }
    if ((misses += 1) < 2 || !attached || starting) return;
    // A joined server is not ours to restart, so take over with our own.
    misses = 0;
    attached = false;
    appendLog('the server this window joined has stopped; starting our own\n');
    startBackend().then((url) => { if (win && !win.isDestroyed()) return win.loadURL(url); })
      .catch(startupFailure);
  }, 5000);
}

async function stopBackend() {
  if (stopPromise) return stopPromise;
  const proc = child;
  if (!proc || proc.exitCode !== null) return;
  stopPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Only our own process tree. Never kill an unrelated server on PORT.
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      } else { proc.kill('SIGKILL'); resolve(); }
    }, 8000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    if (proc.connected) proc.send({ type: 'shutdown' }, () => {});
    else proc.kill();
  }).finally(() => { stopPromise = null; });
  return stopPromise;
}

function startBackend() {
  if (starting) return starting;
  starting = (async () => {
    const target = await resolveBackend();
    if (target.attach) {
      // Someone else's process, someone else's lifetime: it is not stopped when
      // this window closes, and it is not restarted when it exits.
      origin = target.attach;
      attached = true;
      appendLog(`joined the MediaWatcher already serving this library at ${origin}\n`);
      connected = true;
      updateMenu();
      watchBackend();
      pushStatus();
      return origin;
    }
    attached = false;
    return forkBackend(target.port);
  })().finally(() => { starting = null; });
  return starting;
}

function forkBackend(port) {
  return new Promise((resolve, reject) => {
    logTail = '';
    const env = { ...process.env, MW_DATA_DIR: dataDir, MW_SUPERVISED: '1', MW_DESKTOP: '1', PORT: String(port) };
    delete env.ELECTRON_RUN_AS_NODE;
    // Keep explicit .env executable overrides; default ffmpeg/ffprobe resolve
    // to the bundled copies, even on a machine without them on PATH.
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    if (app.isPackaged) env[pathKey] = `${path.join(process.resourcesPath, 'bin')}${path.delimiter}${env[pathKey] || ''}`;
    const node = app.isPackaged ? platform.bundledNode(process.resourcesPath)
      : (process.env.MW_NODE_PATH || 'node');
    const proc = fork(path.join(backendRoot, 'server.js'), [], {
      execPath: node, execArgv: [], cwd: dataDir, env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child = proc;
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error('The server did not become ready within 45 seconds.'));
      void stopBackend();
    }, 45000);
    proc.stdout.on('data', appendLog);
    proc.stderr.on('data', appendLog);
    proc.once('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('message', (message) => {
      if (message?.type !== 'ready' || ready) return;
      ready = true;
      clearTimeout(timer);
      const host = ['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(message.host)
        ? '127.0.0.1' : message.host;
      origin = `http://${host.includes(':') ? `[${host}]` : host}:${message.port}`;
      connected = true;
      updateMenu();
      watchBackend();
      pushStatus();
      resolve(origin);
    });
    const began = Date.now();
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (child === proc) child = null;
      if (!ready) { reject(new Error(`The server exited before startup (code ${code}).\n${logTail}`)); return; }
      if (quitting) return;
      if (Date.now() - began > 60000) failures = 0;
      if (code !== 75) failures += 1;
      if (failures > 5) { void startupFailure(new Error(`The server stopped repeatedly.\n${logTail}`)); return; }
      restartTimer = setTimeout(() => {
        startBackend().then(() => {
          // Keep the page on a normal settings restart; its polling and player
          // already reconnect. A changed port requires a new navigation.
          if (!isAppUrl(win.webContents.getURL())) return win.loadURL(origin);
        }).catch(startupFailure);
      }, code === 75 ? 100 : Math.min(1000 * 2 ** failures, 15000));
    });
  });
}

async function startupFailure(error) {
  if (quitting) return;
  appendLog(`${error.message}\n`);
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'error', title: 'MediaWatcher could not start',
    message: 'The local server could not start.',
    detail: `${error.message}\n\nYour library is unchanged.`,
    buttons: ['Retry', 'Open configuration', 'Quit'], defaultId: 0, cancelId: 2
  });
  if (response === 2) return app.quit();
  if (response === 1) {
    await openConfiguration();
    await dialog.showMessageBox(win, { message: 'Save your configuration, then retry.', buttons: ['Retry'] });
  }
  failures = 0;
  await stopBackend();
  startBackend().then((url) => win.loadURL(url)).catch(startupFailure);
}

function requireSetup(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame
      || event.senderFrame.url !== setupUrl) throw new Error('Setup is only available in the local setup window.');
}

ipcMain.handle('setup:info', (event) => { requireSetup(event); return { dataDir }; });
ipcMain.handle('setup:existing', async (event) => {
  requireSetup(event);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose your existing MediaWatcher folder (containing .env and db)', properties: ['openDirectory']
  });
  if (result.canceled) return { canceled: true };
  const selected = result.filePaths[0];
  if (!configured(selected)) return { error: 'This folder needs a .env with both API keys and a password of at least 8 characters.' };
  dataDir = selected;
  saveSettings();
  startBackend().then((url) => win.loadURL(url)).catch(startupFailure);
  return { ok: true };
});
ipcMain.handle('setup:create', async (event, values) => {
  requireSetup(event);
  const entries = { TMDB_API_KEY: values?.tmdb, ALLDEBRID_API_KEY: values?.debrid, AUTH_PASSWORD: values?.password };
  if (Object.values(entries).some((v) => typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v))
      || entries.AUTH_PASSWORD.trim().length < 8) return { error: 'Enter both API keys and a password of at least 8 characters.' };
  // Do not overwrite an existing configuration, including an incomplete one.
  if (fs.existsSync(path.join(dataDir, '.env'))) {
    await openConfiguration();
    return { error: 'A configuration already exists. Complete it in the editor, then use “Use existing library” and choose this folder.' };
  }
  let template = fs.readFileSync(path.join(backendRoot, '.env.example'), 'utf8');
  for (const [key, raw] of Object.entries(entries)) {
    const value = raw.trim();
    const quote = ["'", '"', '`'].find((candidate) => !value.includes(candidate));
    if (!quote) return { error: 'A value cannot contain all three quote characters.' };
    template = template.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${quote}${value}${quote}`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.env'), template, { flag: 'wx', mode: 0o600 });
  saveSettings();
  startBackend().then((url) => win.loadURL(url)).catch(startupFailure);
  return { ok: true };
});

/*
 * What closing the window does.
 *
 * Hiding to the tray is the right default — downloads, conversions and anyone
 * watching from another device all outlive the window — but it is the wrong
 * thing to do silently, because an app that ignores its own close button looks
 * broken. So the first close asks, in the app's own window, and remembers the
 * answer only when it was told to.
 */
const CLOSE_BEHAVIOURS = ['ask', 'tray', 'quit'];
const closeBehaviour = () =>
  (CLOSE_BEHAVIOURS.includes(settings.closeBehaviour) ? settings.closeBehaviour : 'ask');
let closeAsked = false;
let closeAskTimer;

function rememberWindow() {
  if (!win || win.isDestroyed()) return;
  settings.window = win.getNormalBounds();
  settings.maximized = win.isMaximized();
  saveSettings();
}

/**
 * How long to wait for the prompt to say it has appeared.
 *
 * Four seconds is a long time to leave a dialog nobody asked for on screen,
 * which matters to the tests more than to anyone else: the window they drive is
 * a real one on a real desktop, and a passing stranger clicking "Keep it
 * running" is indistinguishable from the app deciding to.
 */
const closeAskWait = () => {
  const override = Number(process.env.MW_CLOSE_ASK_MS);
  return Number.isFinite(override) && override >= 200 ? override : 4000;
};

function askAboutClosing() {
  if (closeAsked) { showWindow(); return; }
  closeAsked = true;
  win.webContents.send('window:close-request');
  // A page that cannot draw the prompt — mid-navigation, or a crashed renderer
  // — must not leave the window unclosable. The prompt says when it is up, and
  // then this stops running: an unanswered question is not a stuck window, and
  // hiding one out from under someone reading it is worse than waiting.
  closeAskTimer = setTimeout(() => {
    if (!closeAsked) return;
    closeAsked = false;
    win.hide();
  }, closeAskWait());
}

function applyClose(choice, remember) {
  clearTimeout(closeAskTimer);
  closeAsked = false;
  if (remember && choice !== 'cancel') {
    settings.closeBehaviour = choice;
    saveSettings();
  }
  if (choice === 'quit') app.quit();
  else if (choice === 'tray') win.hide();
  // 'cancel' leaves the window exactly where it was.
}

function requireWindow(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame
      || !(isAppUrl(event.senderFrame.url) || event.senderFrame.url === setupUrl)) {
    throw new Error('This is only available in the MediaWatcher window.');
  }
}

ipcMain.handle('window:close-asked', (event) => {
  requireWindow(event);
  if (closeAsked) clearTimeout(closeAskTimer);
});
ipcMain.handle('window:close-choice', (event, payload) => {
  requireWindow(event);
  if (!closeAsked) return closeBehaviour();
  const choice = ['tray', 'quit', 'cancel'].includes(payload?.choice) ? payload.choice : 'cancel';
  applyClose(choice, payload?.remember === true);
  return closeBehaviour();
});
ipcMain.handle('status:read', (event) => { requireWindow(event); return statusNow(); });
ipcMain.handle('status:act', async (event, action) => {
  requireWindow(event);
  if (action === 'update') await updates.download();
  else if (action === 'install') await updates.install();
  // Nothing to download here — this copy is replaced from outside — so the
  // button opens the window that names the release and says how.
  else if (action === 'updates') openUpdates();
  else if (action === 'reconnect') {
    /*
     * Ask the cheap question first. A server that is answering again needs
     * nothing started — and going looking would find our own child on its
     * port, join it as though it were somebody else's, and then leave it
     * running when the app quits.
     */
    const port = origin ? Number(new URL(origin).port) : null;
    if (port && await health(port)) connected = true;
    else {
      const previous = origin;
      origin = null;
      try {
        // A child that is alive but not answering is worse than none.
        await stopBackend();
        const url = await startBackend();
        connected = Boolean(await health(Number(new URL(url).port)));
      } catch (error) {
        origin = previous;
        connected = false;
        appendLog(`reconnect failed: ${error.message}\n`);
      }
    }
    if (connected && origin && win && !win.isDestroyed()) {
      if (win.webContents.getURL().startsWith(origin)) win.webContents.reload();
      else await win.loadURL(origin);
    }
    pushStatus();
  }
  return statusNow();
});
ipcMain.handle('window:show', (event) => { requireWindow(event); showWindow(); });
ipcMain.handle('window:close-behaviour', (event) => { requireWindow(event); return closeBehaviour(); });
ipcMain.handle('window:set-close-behaviour', (event, value) => {
  requireWindow(event);
  if (!CLOSE_BEHAVIOURS.includes(value)) throw new Error('Unknown close behaviour.');
  settings.closeBehaviour = value;
  saveSettings();
  return value;
});


// Updates live entirely in the main process. Like first-run setup, the updates
// window is a local page with a narrow bridge; it never sees an installer path.
function releaseRepository() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'release.json'), 'utf8')).repository || '');
  } catch { return ''; }
}
let savedRepository = '';
// A hand-edited desktop.json or release.json must not stop the app from opening.
try { savedRepository = repositoryName(settings.updateRepository ?? releaseRepository()); } catch { savedRepository = ''; }

// `electron desktop/main.cjs` reports Electron's own version rather than the
// app's, and a version nobody recognises makes the update notice meaningless.
function appVersion() {
  if (app.isPackaged) return app.getVersion();
  try { return JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version; }
  catch { return app.getVersion(); }
}

const updates = createUpdates({
  version: appVersion(),
  packaged: app.isPackaged,
  repository: savedRepository,
  // Which updater, and whether this copy is even allowed to replace itself,
  // are the same question asked of the platform: an NSIS installer and an
  // AppImage own their own files, a distribution package does not.
  selfUpdating: platform.selfUpdating({ packaged: app.isPackaged }),
  installHint: platform.updateHint(),
  makeUpdater: (options) => platform.makeUpdater(options),
  saveRepository: (repository) => { settings.updateRepository = repository; saveSettings(); },
  changed: (state) => {
    if (updatesWin && !updatesWin.isDestroyed()) updatesWin.webContents.send('updates:status', state);
    pushStatus();
    // Rebuilding the tray menu on every download percentage would be wasteful.
    if (state.status !== trayUpdateStatus) { trayUpdateStatus = state.status; updateMenu(); }
  },
  beforeInstall: async () => {
    // The installer replaces files the running server holds open, and the
    // backend owns downloads and conversions that deserve a clean shutdown.
    quitting = true;
    clearTimeout(restartTimer);
    clearInterval(updateTimer);
    await stopBackend();
  },
  installFailed: async () => {
    quitting = false;
    failures = 0;
    scheduleUpdateChecks();
    try {
      const url = await startBackend();
      if (win && !win.isDestroyed()) await win.loadURL(url);
    } catch (error) { await startupFailure(error); }
  }
});

function updateLabel() {
  const { status, latestVersion } = updates.snapshot();
  if (status === 'unmanaged') return latestVersion ? `Version ${latestVersion} is available` : 'Updates & version';
  if (status === 'available') return `Download update ${latestVersion}`;
  if (status === 'downloading') return 'Downloading update…';
  if (status === 'ready') return 'Restart & install update';
  return 'Check for updates';
}

function scheduleUpdateChecks() {
  clearInterval(updateTimer);
  // Checking from source has nothing to install, so only the packaged app polls.
  if (!app.isPackaged) return;
  updateTimer = setInterval(() => { void updates.check(); }, 6 * 60 * 60 * 1000);
  void updates.check();
}

function openUpdates() {
  if (updatesWin && !updatesWin.isDestroyed()) {
    if (updatesWin.isMinimized()) updatesWin.restore();
    updatesWin.show();
    updatesWin.focus();
    void updates.check();
    return;
  }
  updatesWin = new BrowserWindow({
    width: 560, height: 660, minWidth: 460, minHeight: 520,
    parent: win, backgroundColor: '#090a0c', title: 'MediaWatcher updates', icon,
    ...chromeOptions,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  updatesWin.webContents.on('did-finish-load', () => {
    updatesWin.webContents.send('window:chrome', chrome);
    updatesWin.webContents.insertCSS(titlebarCss + chromeCss).catch(appendLog);
    // The menu item says "Check for updates", so opening it checks rather than
    // waiting to be asked again. Nothing downloads either way.
    void updates.check();
  });
  updatesWin.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  updatesWin.webContents.on('will-navigate', (event, url) => {
    if (url !== updatesUrl) { event.preventDefault(); openExternal(url); }
  });
  updatesWin.webContents.on('will-attach-webview', (event) => event.preventDefault());
  updatesWin.on('closed', () => { updatesWin = null; });
  updatesWin.loadURL(updatesUrl).catch(appendLog);
}

function requireUpdates(event) {
  if (event.sender !== updatesWin?.webContents || event.senderFrame !== updatesWin.webContents.mainFrame
      || event.senderFrame.url !== updatesUrl) throw new Error('Updates are only available in the local updates window.');
}

ipcMain.handle('updates:status', (event) => { requireUpdates(event); return updates.snapshot(); });
ipcMain.handle('updates:check', (event) => { requireUpdates(event); return updates.check(); });
ipcMain.handle('updates:download', (event) => { requireUpdates(event); return updates.download(); });
ipcMain.handle('updates:install', (event) => { requireUpdates(event); return updates.install(); });
ipcMain.handle('updates:configure', (event, repository) => { requireUpdates(event); return updates.configure(repository); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.mediawatcher.desktop');
    nativeTheme.themeSource = 'dark';
    fs.mkdirSync(profile, { recursive: true });
    const bounds = settings.window || {};
    win = new BrowserWindow({
      width: bounds.width || 1440, height: bounds.height || 940,
      minWidth: 800, minHeight: 600, show: false,
      backgroundColor: '#0b0b0d', title: 'MediaWatcher', icon,
      ...chromeOptions,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false
      }
    });
    const syncWindowChrome = () => {
      if (!win.isDestroyed()) win.webContents.send('window:fullscreen', win.isFullScreen());
    };
    win.webContents.on('did-finish-load', () => {
      // The page has to know whether the caption buttons are its problem before
      // it decides what "fullscreen" means; see syncChrome in preload.cjs.
      win.webContents.send('window:chrome', chrome);
      // Kept in the desktop shell so browser/phone layouts never get a title bar.
      win.webContents.insertCSS(titlebarCss + chromeCss).catch(appendLog);
      win.webContents.insertCSS(closeCss).catch(appendLog);
      syncWindowChrome();
    });
    // During Windows' transition isFullScreen() can still report the previous
    // state. Use the event's state so the bar comes back after leaving video.
    win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
    win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));
    win.webContents.on('leave-html-full-screen', () => {
      win.webContents.send('window:fullscreen', false);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'MediaWatcher', submenu: [
        { label: 'Open in browser', click: () => origin && openExternal(origin) },
        { label: 'Check for updates…', click: openUpdates },
        { type: 'separator' },
        { label: 'Quit MediaWatcher', accelerator: 'Control+Q', click: () => app.quit() }
      ] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
    ]));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(contents === win.webContents && isAppUrl(contents.getURL())
        && ['fullscreen', 'notifications', 'clipboard-sanitized-write'].includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) =>
      contents === win.webContents && isAppUrl(contents.getURL())
      && ['fullscreen', 'notifications', 'clipboard-sanitized-write'].includes(permission));
    win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== setupUrl && !isAppUrl(url)) { event.preventDefault(); openExternal(url); }
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.once('ready-to-show', () => { if (settings.maximized) win.maximize(); showWindow(); });
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      rememberWindow();
      const behaviour = closeBehaviour();
      if (behaviour === 'quit') app.quit();
      else if (behaviour === 'tray') win.hide();
      else askAboutClosing();
    });
    tray = new Tray(trayIcon);
    tray.setToolTip('MediaWatcher — runs in the background; right-click to quit');
    tray.on('double-click', showWindow);
    // Linux panels deliver a single click and never a double one, and several
    // of them show only the menu — which is why "Open MediaWatcher" is the
    // first item in it rather than something the icon alone has to carry.
    if (process.platform === 'linux') tray.on('click', showWindow);
    updateMenu();
    if (configured()) {
      try { await win.loadURL(await startBackend()); } catch (error) { await startupFailure(error); }
    } else await win.loadURL(setupUrl);
    // Checked once the app is up, so a release notice never delays playback.
    scheduleUpdateChecks();
  }).catch((error) => { dialog.showErrorBox('MediaWatcher', error.message); app.quit(); });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearTimeout(restartTimer);
    clearInterval(updateTimer);
    clearInterval(attachTimer);
    clearInterval(statusTimer);
    clearTimeout(closeAskTimer);
    rememberWindow();
    stopBackend().finally(() => { tray?.destroy(); app.quit(); });
  });
  app.on('window-all-closed', () => { /* the tray owns background lifetime */ });
  app.on('activate', showWindow);
}
