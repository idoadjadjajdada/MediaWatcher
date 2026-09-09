const { contextBridge, ipcRenderer } = require('electron');
// Render desktop chrome without exposing window-management APIs to the page.
// The caption buttons and drag/snap behavior belong to Windows via Electron's
// controls overlay; the website stays sandboxed.
let nativeFullscreen = false;
function syncChrome() {
  const overlay = navigator.windowControlsOverlay;
  document.documentElement?.setAttribute('data-mw-fullscreen',
    String(Boolean(document.fullscreenElement) || (overlay ? !overlay.visible : nativeFullscreen)));
}
ipcRenderer.on('window:fullscreen', (_event, value) => {
  nativeFullscreen = value === true;
  syncChrome();
});
document.addEventListener('fullscreenchange', syncChrome);
navigator.windowControlsOverlay?.addEventListener('geometrychange', syncChrome);
/**
 * The light in the title bar.
 *
 * Green is "current version, talking to its server" — the state nobody needs
 * to think about, so it says so quietly and gets out of the way. The other two
 * earn the interruption: an update waiting, and a server that has stopped
 * answering. The second is the one worth showing without being asked, because
 * otherwise it looks like the app being slow — every panel fails separately
 * and none of them says why.
 *
 * All of it is decided in the main process; this renders what it is handed and
 * asks for one of three things back.
 */
function buildStatus(bar) {
  const status = document.createElement('div');
  status.id = 'mw-status';
  status.dataset.state = 'unknown';

  const dot = document.createElement('span');
  dot.className = 'mw-status__dot';
  dot.setAttribute('role', 'status');

  const version = document.createElement('span');
  version.className = 'mw-status__version';

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'mw-status__action';
  action.hidden = true;

  status.append(dot, version, action);
  bar.append(status);

  const render = (state) => {
    if (!state) return;
    const newer = ['available', 'downloading', 'ready'].includes(state.update);
    const light = !state.connected ? 'red' : newer ? 'yellow' : 'green';
    status.dataset.state = light;
    version.textContent = state.version ? `v${state.version}` : '';

    const button = light === 'red' ? { act: 'reconnect', label: 'Reconnect' }
      : state.update === 'available' ? { act: 'update', label: `Update to ${state.latestVersion || 'the latest'}` }
        : state.update === 'downloading' ? { act: '', label: `Downloading ${state.percent || 0}%` }
          : state.update === 'ready' ? { act: 'install', label: 'Restart & install' }
            : null;

    action.hidden = !button;
    action.dataset.act = button?.act || '';
    action.disabled = !button?.act;
    if (button) action.textContent = button.label;

    const green = {
      error: 'connected — the last update check failed',
      unconfigured: 'connected — no update source is set',
      development: 'connected — running from source, so there is nothing to update',
      checking: 'connected — checking for updates'
    }[state.update] || 'up to date, and connected';
    const words = light === 'red' ? 'not connected to the server'
      : light === 'yellow' ? `version ${state.latestVersion || 'newer'} is available`
        : green;
    dot.setAttribute('aria-label', words[0].toUpperCase() + words.slice(1));
    status.title = state.version ? `MediaWatcher ${state.version} — ${words}` : words;
  };

  action.addEventListener('click', async () => {
    const act = action.dataset.act;
    if (!act) return;
    action.disabled = true;
    try { render(await ipcRenderer.invoke('status:act', act)); } catch { action.disabled = false; }
  });

  ipcRenderer.on('status:update', (_event, state) => render(state));
  ipcRenderer.invoke('status:read').then(render).catch(() => { /* not the app page */ });
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.setAttribute('data-mw-desktop', '');
  const bar = document.createElement('header');
  bar.id = 'mw-titlebar';
  bar.setAttribute('aria-label', 'MediaWatcher window title');
  const mark = document.createElement('img');
  mark.src = location.protocol === 'file:' ? '../public/icons/mark.png' : '/icons/mark.png';
  mark.alt = '';
  mark.draggable = false;
  const label = document.createElement('span');
  label.textContent = 'MediaWatcher';
  bar.append(mark, label);
  // Only the app itself: the first-run page has no server to be connected to,
  // and the updates window is already a larger version of this.
  if (['http:', 'https:'].includes(location.protocol)) buildStatus(bar);
  document.body.prepend(bar);
  syncChrome();
});
/*
 * What the window's X should do, asked inside the app.
 *
 * The main process owns the decision and only ever hears one of three words
 * back. This builds the prompt, because a system message box would look like
 * an error where this is a preference, and the shell has no other way to draw
 * inside the page.
 */
let closePrompt = null;

function askAboutClosing() {
  if (closePrompt) { closePrompt.primary.focus(); return; }

  const root = document.createElement('div');
  root.className = 'mw-close';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'mw-close-title');
  root.innerHTML = `
    <div class="mw-close__card">
      <h2 class="mw-close__title" id="mw-close-title">Leave MediaWatcher running?</h2>
      <p class="mw-close__text">Kept running, the window closes but the server does not: downloads and
        conversions finish, and anyone watching from another device is undisturbed. Quitting stops all of it.</p>
      <label class="mw-close__remember"><input type="checkbox"> Do this every time I close the window</label>
      <div class="mw-close__actions">
        <button type="button" class="mw-close__btn mw-close__btn--quiet" data-choice="quit">Quit MediaWatcher</button>
        <button type="button" class="mw-close__btn mw-close__btn--primary" data-choice="tray">Keep it running</button>
      </div>
      <p class="mw-close__hint">Escape leaves the window open. You can change this later in Settings.</p>
    </div>`;

  const remember = root.querySelector('input');
  const primary = root.querySelector('.mw-close__btn--primary');
  const buttons = [...root.querySelectorAll('.mw-close__btn')];

  const answer = (choice) => {
    if (!closePrompt) return;
    closePrompt = null;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    ipcRenderer.invoke('window:close-choice', { choice, remember: choice !== 'cancel' && remember.checked })
      .catch(() => { /* the window is going away; nothing to report to */ });
  };

  // Tab stays inside the prompt: it is modal, and the page behind it is about
  // to be hidden or quit either way.
  const focusable = [remember, ...buttons];
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); answer('cancel'); return; }
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const at = focusable.indexOf(document.activeElement);
    const next = at < 0 ? 0 : (at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    focusable[next].focus();
  }

  root.addEventListener('click', (event) => {
    const choice = event.target.closest?.('[data-choice]')?.dataset.choice;
    if (choice) answer(choice);
    else if (event.target === root) answer('cancel');
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(root);
  closePrompt = { root, remember, primary };
  primary.focus();
  // The shell hides the window on its own if this never appears.
  ipcRenderer.invoke('window:close-asked').catch(() => { /* it will fall back */ });
}

ipcRenderer.on('window:close-request', askAboutClosing);

// Only the local desktop pages get a bridge. The normal website has no desktop API.
const localPage = (name) => location.protocol === 'file:' && location.pathname.endsWith(`/${name}`);
if (localPage('setup.html')) {
  contextBridge.exposeInMainWorld('desktopSetup', {
    info: () => ipcRenderer.invoke('setup:info'),
    useExisting: () => ipcRenderer.invoke('setup:existing'),
    create: (values) => ipcRenderer.invoke('setup:create', values)
  });
}
// Checking, downloading and installing stay in the main process. The updates
// window only asks for them and renders the state it is handed back.
// The website's one bridge: what the X does, and asking for the window back
// when someone clicks a notification this app raised. No paths, no process
// control, nothing a page could turn into a capability of its own — showing a
// window is what the tray icon does for free.
if (['http:', 'https:'].includes(location.protocol)) {
  contextBridge.exposeInMainWorld('desktopWindow', {
    closeBehaviour: () => ipcRenderer.invoke('window:close-behaviour'),
    setCloseBehaviour: (value) => ipcRenderer.invoke('window:set-close-behaviour', value),
    show: () => ipcRenderer.invoke('window:show')
  });
}
if (localPage('updates.html')) {
  contextBridge.exposeInMainWorld('desktopUpdates', {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    configure: (repository) => ipcRenderer.invoke('updates:configure', repository),
    onStatus: (fn) => ipcRenderer.on('updates:status', (_event, state) => fn(state))
  });
}
