const { app, BrowserWindow, Menu, Tray, dialog, shell, nativeTheme, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createUpdates, repositoryName } = require('./updater.cjs');

app.setName('MediaWatcher');
const sourceRoot = path.resolve(__dirname, '..');
const backendRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : sourceRoot;
const { parse } = require(path.join(backendRoot, 'node_modules', 'dotenv'));
if (process.env.MW_DESKTOP_PROFILE) app.setPath('userData', path.resolve(process.env.MW_DESKTOP_PROFILE));
const profile = app.getPath('userData');
const settingsPath = path.join(profile, 'desktop.json');
const setupUrl = pathToFileURL(path.join(__dirname, 'setup.html')).href;
const updatesUrl = pathToFileURL(path.join(__dirname, 'updates.html')).href;
const icon = path.join(sourceRoot, 'public', 'icons', 'app.ico');
const titlebarCss = fs.readFileSync(path.join(__dirname, 'titlebar.css'), 'utf8');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* first launch */ }
let dataDir = path.resolve(process.env.MW_DATA_DIR || settings.dataDir
  || (app.isPackaged ? path.join(profile, 'data') : sourceRoot));
let win, tray, child, origin, starting, stopPromise;
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

async function openConfiguration() {
  const file = path.join(dataDir, '.env');
  const error = await shell.openPath(file);
  // .env usually has no Windows file association on a fresh installation.
  if (error && process.platform === 'win32') {
    execFile('notepad.exe', [file], { windowsHide: true }, (failure) => {
      if (failure) dialog.showErrorBox('Open configuration', failure.message);
    });
  }
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
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(dataDir) },
    { label: 'Edit configuration', click: openConfiguration },
    { label: 'Open desktop log', click: () => shell.openPath(path.join(profile, 'desktop.log')) },
    { label: updateLabel(), click: openUpdates },
    { type: 'separator' },
    { label: 'Quit MediaWatcher', click: () => app.quit() }
  ]));
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
  starting = new Promise((resolve, reject) => {
    logTail = '';
    const env = { ...process.env, MW_DATA_DIR: dataDir, MW_SUPERVISED: '1', MW_DESKTOP: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    // Keep explicit .env executable overrides; default ffmpeg/ffprobe resolve
    // to the bundled copies, even on a machine without them on PATH.
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    if (app.isPackaged) env[pathKey] = `${path.join(process.resourcesPath, 'bin')}${path.delimiter}${env[pathKey] || ''}`;
    const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe')
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
      updateMenu();
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
  }).finally(() => { starting = null; });
  return starting;
}

async function startupFailure(error) {
  if (quitting) return;
  appendLog(`${error.message}\n`);
  showWindow();
  const { response } = await dialog.showMessageBox(win, {
    type: 'error', title: 'MediaWatcher could not start',
    message: 'The local server could not start.',
    detail: `${error.message}\n\nIf the old launcher is running, stop its server first. Your library is unchanged.`,
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
  makeUpdater: (options) => new (require('electron-updater').NsisUpdater)(options),
  saveRepository: (repository) => { settings.updateRepository = repository; saveSettings(); },
  changed: (state) => {
    if (updatesWin && !updatesWin.isDestroyed()) updatesWin.webContents.send('updates:status', state);
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
    return;
  }
  updatesWin = new BrowserWindow({
    width: 560, height: 660, minWidth: 460, minHeight: 520,
    parent: win, backgroundColor: '#090a0c', title: 'MediaWatcher updates', icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#090a0c', symbolColor: '#a5a7ad', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true
    }
  });
  updatesWin.webContents.on('did-finish-load', () => {
    updatesWin.webContents.insertCSS(titlebarCss).catch(appendLog);
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
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#090a0c', symbolColor: '#a5a7ad', height: 36 },
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
      // Kept in the desktop shell so browser/phone layouts never get a title bar.
      win.webContents.insertCSS(titlebarCss).catch(appendLog);
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
      settings.window = win.getNormalBounds();
      settings.maximized = win.isMaximized();
      saveSettings();
      win.hide();
    });
    tray = new Tray(icon);
    tray.setToolTip('MediaWatcher — runs in the background; right-click to quit');
    tray.on('double-click', showWindow);
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
    if (win && !win.isDestroyed()) {
      settings.window = win.getNormalBounds();
      settings.maximized = win.isMaximized();
      saveSettings();
    }
    stopBackend().finally(() => { tray?.destroy(); app.quit(); });
  });
  app.on('window-all-closed', () => { /* the tray owns background lifetime */ });
  app.on('activate', showWindow);
}
