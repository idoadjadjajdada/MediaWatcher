/**
 * Being told a download finished, in the desktop app.
 *
 * The website does this with web push: a subscription held by Google or
 * Mozilla, an empty knock delivered to the service worker, and the page then
 * asks this server what it was about. That machinery exists for the case where
 * nothing of the app is open — a phone in a pocket — and it is worth the
 * complication there.
 *
 * Electron has no push service. Subscribing inside the desktop app fails with
 * "push service not available", so the settings page was offering a switch
 * that could only ever produce an error. It also does not need one: the app is
 * running, its window is already asking this server about jobs every few
 * seconds, and Windows shows a notification raised from a hidden window
 * perfectly well. Same feature, delivered the short way.
 *
 * What is still browser-only is being told while the app is not running at
 * all, which is what the settings page says rather than pretending otherwise.
 */
import { loadDevicePrefs } from './device-prefs.js';

/** Inside the desktop shell, rather than a browser tab. */
export const inDesktopApp = () => Boolean(globalThis.window?.desktopWindow);

/** Statuses a job does not come back from, and what to call each one. */
const FINISHED = {
  complete: 'Download finished',
  error: 'Download failed'
};

export function enabled() {
  return inDesktopApp()
    && typeof Notification !== 'undefined'
    && Notification.permission === 'granted'
    && loadDevicePrefs().desktopNotifications === true;
}

/**
 * What finished between one poll and the next.
 *
 * A job has to have been seen unfinished for its ending to be news: the first
 * poll after opening the app would otherwise announce every download that ever
 * completed, and a restarted window would announce them all again.
 */
export function finishedBetween(before = [], after = []) {
  const previous = new Map(before.map((job) => [job.id, job.status]));
  return after.filter((job) => FINISHED[job.status]
    && previous.has(job.id)
    && previous.get(job.id) !== job.status);
}

/** Raise one notification per job that just ended. Returns what it announced. */
export function announce(before, after) {
  const finished = finishedBetween(before, after);
  if (!finished.length || !enabled()) return [];

  for (const job of finished) {
    const notification = new Notification(FINISHED[job.status], {
      body: job.title || 'MediaWatcher',
      // One notification per job, so a slow poll cannot stack duplicates.
      tag: `mw-job-${job.id}`
    });
    // The window is usually behind the tray by the time this matters.
    notification.onclick = () => { globalThis.window?.desktopWindow?.show?.(); };
  }
  return finished;
}
