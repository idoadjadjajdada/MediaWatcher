const $ = id => document.getElementById(id);
const api = window.desktopUpdates;
let editing = false;
function render(state) {
  $('current').textContent = state.currentVersion;
  $('latest').textContent = state.latestVersion ? `Latest ${state.latestVersion}` : '';
  if (!editing) $('repository').value = state.repository;
  const labels = {
    unconfigured: ['Connect your updates', 'Save the GitHub repository below to start checking for releases.'],
    idle: ['Ready to check', 'Check GitHub for the latest version.'],
    checking: ['Checking for updates…', 'Looking for the latest published release.'],
    current: ['You’re up to date', 'You have the latest available version.'],
    available: ['A newer version is available', 'Download the update now, then restart when you’re ready.'],
    downloading: [`Downloading… ${state.percent}%`, 'You can keep using MediaWatcher while the update downloads.'],
    ready: ['Your update is ready', 'Restart & install closes MediaWatcher and opens the installer. Your library and settings are kept.'],
    installing: ['Starting the installer…', 'MediaWatcher will close to apply the update.'],
    error: ['Couldn’t complete the update', state.error],
    development: ['Running from source', 'Updates are available in the packaged app.'],
    // Installed by a package manager, or unpacked by hand. It can still say a
    // newer release exists; it must not pretend it can install one.
    unmanaged: [
      state.latestVersion ? `Version ${state.latestVersion} is available` : 'You’re up to date',
      [state.error, state.installHint].filter(Boolean).join(' ')
    ]
  };
  const [title, description] = labels[state.status] || labels.idle;
  $('status').textContent = title; $('description').textContent = description;
  $('download').hidden = state.status !== 'available';
  $('install').hidden = state.status !== 'ready';
  $('check').hidden = ['available', 'ready', 'installing', 'downloading'].includes(state.status);
  $('check').disabled = ['checking', 'unconfigured', 'development'].includes(state.status);
  $('progress').hidden = state.status !== 'downloading'; $('progress').value = state.percent;
  const busy = ['checking', 'downloading', 'installing', 'ready'].includes(state.status);
  $('save').disabled = busy; $('repository').disabled = busy;
  if (state.status === 'unconfigured') $('source').open = true;
}
async function action(name, value) {
  $('error').textContent = '';
  try { render(await api[name](value)); } catch (error) { $('error').textContent = error.message; }
}
$('repository').addEventListener('input', () => { editing = true; });
$('save').addEventListener('click', async () => { const value = $('repository').value; editing = false; await action('configure', value); });
$('repository').addEventListener('keydown', event => { if (event.key === 'Enter') $('save').click(); });
for (const name of ['check', 'download', 'install']) $(name).addEventListener('click', () => action(name));
api.onStatus(render);
action('status');
