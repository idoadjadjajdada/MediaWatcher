/** Desktop-only update state. The renderer never supplies installer paths. */
function repositoryName(value) {
  let name = String(value || '').trim();
  if (!name) return '';
  if (name.startsWith('https://github.com/')) {
    const url = new URL(name);
    if (url.username || url.password || url.search || url.hash) throw new Error('Use a GitHub repository link or owner/repository.');
    name = url.pathname.replace(/^\/|\/$/g, '').replace(/\/releases(?:\/latest)?$/, '');
  }
  name = name.replace(/\.git$/, '');
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(name)
    || ['.', '..'].includes(name.split('/')[1])) throw new Error('Enter a GitHub repository as owner/repository.');
  return name;
}

function createUpdates({ version, packaged, repository = '', makeUpdater, saveRepository, changed, beforeInstall, installFailed }) {
  let updater, pending = false;
  let state = { currentVersion: version, latestVersion: null, repository: repositoryName(repository),
    status: repository ? 'idle' : 'unconfigured', percent: 0, checkedAt: null, error: null, packaged };
  const snapshot = () => ({ ...state });
  const set = patch => { state = { ...state, ...patch }; changed(snapshot()); };
  const failure = () => set({ status: 'error', error: 'The update could not be completed. Check your connection and that the public GitHub release includes latest.yml and the installer, then try again.' });
  function engine() {
    if (updater) return updater;
    const [owner, repo] = state.repository.split('/');
    const instance = makeUpdater({ provider: 'github', owner, repo, private: false, releaseType: 'release' });
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = false;
    instance.allowPrerelease = false;
    instance.allowDowngrade = false;
    instance.disableDifferentialDownload = true;
    instance.logger = null;
    updater = instance;
    const listen = (event, fn) => instance.on(event, value => { if (instance === updater) fn(value); });
    listen('error', failure);
    listen('update-available', info => set({ status: 'available', latestVersion: info.version, checkedAt: Date.now(), error: null }));
    listen('update-not-available', () => set({ status: 'current', latestVersion: null, checkedAt: Date.now(), error: null }));
    listen('download-progress', progress => set({ status: 'downloading', percent: Math.min(100, Math.max(0, Math.round(progress.percent || 0))) }));
    listen('update-downloaded', info => set({ status: 'ready', latestVersion: info.version, percent: 100, error: null }));
    return instance;
  }
  async function check() {
    if (pending || ['ready', 'installing'].includes(state.status)) return snapshot();
    if (!state.repository) { set({ status: 'unconfigured', error: null }); return snapshot(); }
    if (!packaged) { set({ status: 'development', error: null }); return snapshot(); }
    pending = true;
    set({ status: 'checking', error: null });
    try { await engine().checkForUpdates(); } catch { failure(); }
    finally { pending = false; }
    return snapshot();
  }
  async function download() {
    if (pending || state.status !== 'available') return snapshot();
    pending = true;
    set({ status: 'downloading', percent: 0, error: null });
    try { await engine().downloadUpdate(); } catch { failure(); }
    finally { pending = false; }
    return snapshot();
  }
  async function install() {
    if (pending || state.status !== 'ready') return snapshot();
    pending = true;
    set({ status: 'installing', error: null });
    try {
      await beforeInstall();
      updater.quitAndInstall(false, true);
      if (state.status === 'error') await installFailed();
    } catch { failure(); await installFailed(); }
    finally { pending = false; }
    return snapshot();
  }
  async function configure(value) {
    if (pending || ['ready', 'installing'].includes(state.status)) throw new Error('Finish the current update before changing its repository.');
    const repository = repositoryName(value);
    await saveRepository(repository);
    updater = null;
    set({ repository, status: repository ? 'idle' : 'unconfigured', latestVersion: null, error: null, checkedAt: null, percent: 0 });
    return check();
  }
  return { snapshot, check, download, install, configure };
}
module.exports = { createUpdates, repositoryName };
