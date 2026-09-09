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
// The website gets one bridge, and it carries a single enum: what the X does.
// No paths, no process control, nothing the page can turn into a capability.
if (['http:', 'https:'].includes(location.protocol)) {
  contextBridge.exposeInMainWorld('desktopWindow', {
    closeBehaviour: () => ipcRenderer.invoke('window:close-behaviour'),
    setCloseBehaviour: (value) => ipcRenderer.invoke('window:set-close-behaviour', value)
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
