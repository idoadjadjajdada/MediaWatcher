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

/*
 * An enrolment code carried in the URL, from a QR shown on a device that is
 * already signed in. It stands in for the password — which is the point, since
 * this page is most often reached on a television where typing one is
 * miserable.
 *
 * Read once and removed from the address bar immediately: it is single use and
 * about to be spent, and leaving it in the URL puts a credential in the
 * history, in a shared screen, and in anything that syncs tabs between
 * devices.
 */
const enrolCode = (() => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('enrol');
  if (!code) return null;
  window.history.replaceState({}, '', window.location.pathname);
  return code;
})();

if (enrolCode) {
  // The password field is not the way in on this visit, so it should not be
  // the thing asking to be filled.
  document.getElementById('password').required = false;
  document.getElementById('password').placeholder = 'Not needed — you scanned a code';
  submit.textContent = 'Add this device';
}

async function attempt() {
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
        remember: rememberEl.checked,
        enrol: enrolCode || undefined
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
    submit.textContent = enrolCode ? 'Add this device' : 'Unlock';
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  attempt();
});

/*
 * A scanned code signs the device in without anyone pressing anything.
 *
 * Not automatic when it is not remembered, though: an unremembered session
 * dies with the browser, and the whole reason for scanning a code onto a
 * television is not wanting to do it again. So the code arrives, the device
 * names itself from its user agent, and the tick is already on.
 */
if (enrolCode) {
  rememberEl.checked = true;
  syncNameState();
  if (nameEl.value) attempt();
}
