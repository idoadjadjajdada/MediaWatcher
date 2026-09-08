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
