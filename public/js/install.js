/**
 * The browser's install prompt.
 *
 * Its own module rather than living in app.js, because the settings page needs
 * to know whether an install is on offer and app.js already imports the
 * settings page — putting it there makes a cycle, and a cycle around a `const`
 * export is the kind that fails only in whichever module happens to evaluate
 * first.
 *
 * Chrome fires `beforeinstallprompt` instead of showing its own UI, and that
 * event is the only handle on the prompt. Using it is one-shot: once shown,
 * the browser will not hand over another, so the reference is cleared before
 * the prompt is awaited rather than after.
 *
 * Safari on iOS never fires it and expects Share -> Add to Home Screen, which
 * is why callers have to cope with there being no offer at all.
 */

let deferred = null;
let onChange = () => {};

/** Is the browser currently offering an install? */
export const canInstall = () => deferred !== null;

/** Is the app already running as an installed window rather than a tab? */
export function isInstalled() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      // iOS predates display-mode and reports this instead.
      || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

/**
 * Start listening.
 *
 * `notify` is called whenever the answer to `canInstall()` changes, so a page
 * already on screen can redraw rather than waiting for the next navigation.
 */
export function watch(notify = () => {}) {
  onChange = notify;

  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own bar, and the event is consumed.
    event.preventDefault();
    deferred = event;
    onChange();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    onChange();
  });
}

/**
 * Show the prompt. Answers 'accepted', 'dismissed', or 'unavailable'.
 *
 * The reference is dropped before awaiting the choice: the event cannot be
 * used twice, and leaving it in place would leave a button on screen that
 * silently does nothing on the second press.
 */
export async function prompt() {
  if (!deferred) return 'unavailable';

  const event = deferred;
  deferred = null;
  onChange();

  try {
    event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return 'dismissed';
  }
}

export default { canInstall, isInstalled, watch, prompt };
