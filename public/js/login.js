/**
 * The gate page.
 *
 * Standalone on purpose: nothing here imports api.js or app.js, so the
 * application shell never loads for a visitor who has not passed the gate.
 */
const form = document.getElementById('gate-form');
const errorEl = document.getElementById('gate-error');
const submit = form.querySelector('.gate__submit');
const rememberEl = document.getElementById('remember');
const nameEl = document.getElementById('device-name');

/*
 * A sensible default so the launcher's device list does not end up holding
 * three rows called "iPad". Only a starting point — the field stays editable.
 */
nameEl.value = (() => {
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return '';
})();

// The name is only recorded when the device is being remembered.
const syncNameState = () => { nameEl.disabled = !rememberEl.checked; };
rememberEl.addEventListener('change', syncNameState);
syncNameState();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: document.getElementById('password').value,
        deviceName: nameEl.value,
        remember: rememberEl.checked
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      errorEl.textContent = data.error || `Failed (${response.status})`;
      return;
    }

    // A full navigation rather than a route change: the shell has never been
    // loaded on this page, and the cookie has to be in place before it is.
    window.location.replace('/');
  } catch {
    errorEl.textContent = 'Cannot reach MediaWatcher.';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Unlock';
  }
});
