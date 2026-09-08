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
// Only first-run setup gets a bridge. The normal website has no desktop API.
if (location.protocol === 'file:' && location.pathname.endsWith('/setup.html')) {
  contextBridge.exposeInMainWorld('desktopSetup', {
    info: () => ipcRenderer.invoke('setup:info'),
    useExisting: () => ipcRenderer.invoke('setup:existing'),
    create: (values) => ipcRenderer.invoke('setup:create', values)
  });
}
