/**
 * The log of who tried to get in.
 *
 * Append-only and deliberately separate from `devices`. A device row is a live
 * credential: revoking it deletes it, which is precisely the moment you want
 * to see what it did. These rows outlive the device they created.
 *
 * Failures are recorded too, and they are the more interesting half - a run of
 * them from an address you do not recognise is the thing worth noticing on a
 * server that is reachable from outside the house.
 */
import { db } from './index.js';

/*
 * A cap rather than a sweep on a timer. The table is written once per login
 * attempt, so it grows slowly in normal use and explosively under a guessing
 * attack - which is the case where an unbounded log is a disk problem rather
 * than an audit trail. Trimming on write keeps the bound without a scheduler.
 */
export const MAX_EVENTS = 500;

const stmt = {
  insert: db.prepare(`
    INSERT INTO login_events (at, ok, ip, origin, user_agent, device_name, remembered)
    VALUES (@at, @ok, @ip, @origin, @user_agent, @device_name, @remembered)
  `),
  recent: db.prepare('SELECT * FROM login_events ORDER BY at DESC, id DESC LIMIT ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM login_events'),
  trim: db.prepare(`
    DELETE FROM login_events WHERE id NOT IN (
      SELECT id FROM login_events ORDER BY at DESC, id DESC LIMIT ?
    )
  `),
  failuresSince: db.prepare('SELECT COUNT(*) AS n FROM login_events WHERE ok = 0 AND at >= ?'),
  clear: db.prepare('DELETE FROM login_events')
};

const shape = (row) => ({
  id: row.id,
  at: row.at,
  ok: row.ok === 1,
  ip: row.ip || null,
  origin: row.origin || null,
  userAgent: row.user_agent || null,
  deviceName: row.device_name || null,
  remembered: row.remembered === 1
});

export function recordLogin({ ok, ip, origin, userAgent, deviceName, remembered } = {}) {
  stmt.insert.run({
    at: Date.now(),
    ok: ok ? 1 : 0,
    ip: ip || null,
    origin: origin || null,
    // Bounded on the way in: a user agent is attacker-controlled and there is
    // no reason for the log to store an arbitrarily long one.
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    device_name: deviceName ? String(deviceName).slice(0, 60) : null,
    remembered: remembered ? 1 : 0
  });

  if (stmt.count.get().n > MAX_EVENTS) stmt.trim.run(MAX_EVENTS);
}

export function listLogins(limit = 100) {
  const capped = Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 100));
  return stmt.recent.all(capped).map(shape);
}

/** How many failures since a moment — what "someone is guessing" looks like. */
export function failuresSince(since) {
  return stmt.failuresSince.get(Number(since) || 0).n;
}

export function clearLogins() {
  stmt.clear.run();
}

export default { recordLogin, listLogins, failuresSince, clearLogins, MAX_EVENTS };
