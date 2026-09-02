/**
 * Telling a phone that something happened.
 *
 * The launcher raises a toast on the machine the server runs on, which is the
 * one place you are not when a download finishes. This is the other half: the
 * subscriptions to knock on, the events worth knocking about, and the small
 * ring of recent events a woken service worker reads to find out what it is
 * meant to say.
 *
 * The ring is why nothing sensitive reaches the push service. A push carries
 * no payload; the worker wakes, asks this server what happened, and only then
 * does the title of anything exist outside the house.
 */
import { createLogger } from '../config/index.js';
import {
  listPushSubscriptions, insertPushSubscription, deletePushSubscription, touchPushSubscription
} from '../db/index.js';
import * as webpush from './webpush.js';

const log = createLogger('notify');

/**
 * How long an event stays readable.
 *
 * A woken worker asks immediately, so this only has to cover the gap between
 * the push being sent and the device being reachable. Long enough for a phone
 * that was asleep, short enough that reopening the app tomorrow does not
 * produce yesterday's notification.
 */
const EVENT_TTL_MS = 10 * 60 * 1000;

/** Recent events, newest last. Memory only: a missed notification is missed. */
const events = [];
let nextId = 1;

/** Drop what has aged out. Called on every read and write. */
function prune(now = Date.now()) {
  while (events.length > 0 && now - events[0].at > EVENT_TTL_MS) events.shift();
}

/**
 * Record something worth telling someone about, and knock on every device.
 *
 * Fire and forget by design: a download completing must not wait on Google,
 * and a push service being slow is not a reason for anything here to be slow.
 */
export function notify({ title, body = '', tag = 'mediawatcher', urgency = 'normal' }) {
  prune();
  const event = { id: nextId, at: Date.now(), title, body, tag };
  nextId += 1;
  events.push(event);

  const subscriptions = listPushSubscriptions();
  if (subscriptions.length === 0) return event;

  log.debug(`notifying ${subscriptions.length} device(s): ${title}`);
  for (const row of subscriptions) {
    webpush.send(row.endpoint, { urgency })
      .then((result) => {
        if (result.ok) return touchPushSubscription(row.endpoint);
        /*
         * A push service saying 404 or 410 means the browser threw the
         * subscription away — the app was uninstalled, or permission was
         * revoked. Keeping the row would mean knocking on that door forever.
         */
        if (result.gone) {
          log.info(`subscription gone, forgetting it: ${webpush.audienceFor(row.endpoint)}`);
          return deletePushSubscription(row.endpoint);
        }
        return undefined;
      })
      .catch((error) => log.debug(`push failed: ${error.message}`));
  }

  return event;
}

/** Events a woken worker has not shown yet. */
export function pending(since = 0) {
  prune();
  return events.filter((event) => event.id > Number(since || 0));
}

/** Register a device. Idempotent — a browser re-subscribes on its own schedule. */
export function subscribe(endpoint, deviceId = null) {
  insertPushSubscription({ endpoint, deviceId });
  log.info(`push subscription added for ${webpush.audienceFor(endpoint)}`);
  return { subscribed: true };
}

export function unsubscribe(endpoint) {
  return { removed: deletePushSubscription(endpoint) };
}

export const count = () => listPushSubscriptions().length;

export default { notify, pending, subscribe, unsubscribe, count, EVENT_TTL_MS };
