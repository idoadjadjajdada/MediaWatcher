/**
 * GET    /api/devices      — every remembered device
 * DELETE /api/devices/:id  — revoke one
 *
 * Gated on the local admin key, NOT on a device cookie. A phone that is signed
 * in is still just a viewer: it must not be able to enumerate the other
 * devices on the tailnet, and it certainly must not be able to revoke them.
 * Only something that can read config/admin-key gets in, which means something
 * running on this machine.
 */
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import config, { createLogger } from '../config/index.js';
import { listDevices, revokeDevice } from '../db/devices.js';

const log = createLogger('api:devices');
const router = express.Router();

export function isAdminRequest(req) {
  const supplied = String(req.headers?.['x-mediawatcher-key'] || '');
  const expected = config.auth.adminKey;
  // timingSafeEqual throws on a length mismatch, so screen for that first.
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

const requireAdmin = (req, res, next) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });
  return next();
};

router.use(requireAdmin);

router.get('/', (_req, res) => {
  res.json({
    devices: listDevices().map((row) => ({
      id: row.id,
      name: row.name,
      user_agent: row.user_agent,
      last_ip: row.last_ip,
      origin: row.origin,
      first_seen: row.first_seen,
      last_seen: row.last_seen
    }))
  });
});

router.delete('/:id', (req, res) => {
  if (!revokeDevice(req.params.id)) {
    return res.status(404).json({ error: 'No such device' });
  }
  log.info(`device revoked: ${req.params.id}`);
  return res.json({ ok: true });
});

export default router;
