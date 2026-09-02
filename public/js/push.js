/**
 * Asking to be told when something happens.
 *
 * Three separate things have to be true before a notification can arrive, and
 * they fail in different ways, so they are reported separately rather than as
 * one "notifications: on/off":
 *
 *   supported    the browser has Push at all. Safari on iOS only does inside
 *                an installed PWA, which is a real state to explain rather
 *                than a bug to hide.
 *   permitted    the person said yes. Saying no is sticky and cannot be asked
 *                again from script — only reset in browser settings.
 *   subscribed   this browser has a live subscription with this server.
 */
import * as api from './api.js';

/** Base64url from the server to the Uint8Array pushManager wants. */
function decodeKey(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export const isSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** What the settings page needs to say. Never throws. */
export async function status() {
  if (!isSupported()) {
    return {
      supported: false,
      permission: 'unsupported',
      subscribed: false,
      // The one case worth explaining rather than just refusing: on iOS this
      // works, but only once the app has been added to the home screen.
      needsInstall: /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: Boolean(subscription),
      needsInstall: false
    };
  } catch {
    return { supported: true, permission: Notification.permission, subscribed: false, needsInstall: false };
  }
}

/**
 * Subscribe this browser.
 *
 * `userVisibleOnly` is not optional in any current browser: a push that shows
 * nothing is a background wake-up, and none of them will grant one.
 */
export async function subscribe() {
  if (!isSupported()) throw new Error('This browser cannot receive notifications.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for this site. That has to be undone in your browser settings.'
      : 'Notifications were not allowed.');
  }

  const { key } = await api.getPushKey();
  const registration = await navigator.serviceWorker.ready;

  // An existing subscription is reused rather than replaced: re-subscribing
  // mints a new endpoint and orphans the row the server already has.
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(key)
  });

  await api.subscribePush(subscription.endpoint);
  return true;
}

/** Stop. Both ends, because either alone leaves something knocking or listening. */
export async function unsubscribe() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;

  await api.unsubscribePush(subscription.endpoint).catch(() => { /* the row can go stale */ });
  await subscription.unsubscribe();
  return true;
}

export default { isSupported, status, subscribe, unsubscribe };
