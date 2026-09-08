const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('button')];
async function run(action) {
  buttons.forEach((button) => { button.disabled = true; });
  status.textContent = 'Preparing MediaWatcher…';
  try {
    const result = await action();
    status.textContent = result.error || (result.canceled ? '' : 'Starting your library…');
  } catch (error) { status.textContent = error.message; }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}
document.querySelector('#existing').addEventListener('click', () => run(() => window.desktopSetup.useExisting()));
document.querySelector('#setup').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  void run(() => window.desktopSetup.create(values));
});
window.desktopSetup.info().then(({ dataDir }) => {
  document.querySelector('#location').textContent = `New library data: ${dataDir}. You can change the media folder later in Settings.`;
});
