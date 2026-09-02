/**
 * /api/notifications — telling a phone that something happened.
 *
 * The endpoint a browser hands over is a capability: anything holding it can
 * push to that browser. So it goes in, and never comes back out — every answer
 * here is a count or a boolean, never the list.
 */
import express from 'express';
import { createLogger } from '../config/index.js';
import * as notifications from '../services/notifications.js';
import * as webpush from '../services/webpush.js';

const log = createLogger('api:notify');
const router = express.Router();

/**
 * GET /api/notifications/key — what a browser needs to subscribe.
 *
 * Public by design: it is the server's identity to the push service, not a
 * secret. Every subscription is bound to it, which is also why it is minted
 * once and kept rather than regenerated.
 */
router.get('/key', (_req, res) => {
  res.json({ key: webpush.applicationServerKey(), subscribers: notifications.count() });
});

/** POST /api/notifications/subscribe — body: { endpoint } */
router.post('/subscribe', (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  // A push endpoint is always an https URL at the push service; anything else
  // is either a mistake or an attempt to make this server post somewhere.
  if (!/^https:\/\//.test(endpoint)) {
    return res.status(400).json({ error: 'a push endpoint is required' });
  }

  notifications.subscribe(endpoint, req.device?.id || null);
  return res.json({ subscribed: true, subscribers: notifications.count() });
});

/** POST /api/notifications/unsubscribe — body: { endpoint } */
router.post('/unsubscribe', (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  res.json({ ...notifications.unsubscribe(endpoint), subscribers: notifications.count() });
});

/**
 * GET /api/notifications/pending?since=
 *
 * What a woken service worker should say. This is the reason a push can carry
 * no payload: the knock arrives empty and the details are fetched from here,
 * so nothing about the library passes through Google or Mozilla.
 */
router.get('/pending', (req, res) => {
  res.json({ events: notifications.pending(req.query.since) });
});

/**
 * POST /api/notifications/test — prove the whole chain works.
 *
 * Worth having as its own button: a setup that silently does not work is found
 * on the night it matters otherwise, and there are four places it can break —
 * permission, the subscription, the push service, and the worker.
 */
router.post('/test', (req, res) => {
  const event = notifications.notify({
    title: 'MediaWatcher',
    body: 'Notifications are working.',
    tag: 'test'
  });
  log.info(`test notification sent to ${notifications.count()} device(s)`);
  res.json({ sent: notifications.count(), event: event.id });
});

export default router;
