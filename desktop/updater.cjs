/** Desktop-only update state. The renderer never supplies installer paths. */

/** Is `candidate` a later release than `current`? Dotted numbers, nothing else. */
function isNewer(candidate, current) {
  const parts = (value) => String(value || '').trim().replace(/^v/, '').split(/[.+-]/)
    .map((piece) => Number(piece)).filter((piece) => Number.isInteger(piece));
  const left = parts(candidate);
  const right = parts(current);
  if (!left.length) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** The tag of the newest published release, or null when there is not one. */
async function latestFromGitHub(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'MediaWatcher' }
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const body = await response.json();
  // Drafts and prereleases are not what an installed copy should be told about.
  if (body?.draft || body?.prerelease) return null;
  return String(body?.tag_name || '').trim().replace(/^v/, '') || null;
}

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

/**
 * @param selfUpdating Whether this copy owns the files it would have to replace.
 *   A Windows installer and a Linux AppImage do; a pacman, deb or rpm package
 *   does not, and an app that overwrites one leaves the package manager
 *   describing a version that is no longer on disk. Those copies still check —
 *   knowing a release exists is the useful half — and then say who to ask.
 * @param installHint What to tell someone whose copy is updated from outside.
 */
function createUpdates({ version, packaged, repository = '', makeUpdater, saveRepository, changed,
  beforeInstall, installFailed, selfUpdating = true, installHint = '', fetchLatest = latestFromGitHub }) {
  let updater, pending = false;
  let state = { currentVersion: version, latestVersion: null, repository: repositoryName(repository),
    status: repository ? 'idle' : 'unconfigured', percent: 0, checkedAt: null, error: null, packaged,
    selfUpdating, installHint };
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
    /*
     * A copy somebody else installed still gets a real answer.
     *
     * electron-updater is the wrong tool here — it would work out how to
     * replace an installation it does not own, and fail late and obscurely —
     * but "there is a 1.5.0" is the useful half of an update check, and it is
     * the half a pacman user can act on. So this asks GitHub what the newest
     * release is, says so, and says who to ask for it.
     */
    if (!selfUpdating) {
      pending = true;
      set({ status: 'checking', error: null });
      try {
        const latest = await fetchLatest(state.repository);
        set({ status: 'unmanaged', checkedAt: Date.now(), error: null,
          latestVersion: isNewer(latest, version) ? latest : null });
      } catch {
        set({ status: 'unmanaged', checkedAt: Date.now(), latestVersion: null,
          error: 'The latest release could not be looked up. Check your connection.' });
      } finally { pending = false; }
      return snapshot();
    }
    pending = true;
    set({ status: 'checking', error: null });
    try { await engine().checkForUpdates(); } catch { failure(); }
    finally { pending = false; }
    return snapshot();
  }
  async function download() {
    if (pending || !selfUpdating || state.status !== 'available') return snapshot();
    pending = true;
    set({ status: 'downloading', percent: 0, error: null });
    try { await engine().downloadUpdate(); } catch { failure(); }
    finally { pending = false; }
    return snapshot();
  }
  async function install() {
    if (pending || !selfUpdating || state.status !== 'ready') return snapshot();
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
module.exports = { createUpdates, repositoryName, isNewer, latestFromGitHub };
