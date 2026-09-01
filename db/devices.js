/**
 * The `devices` table: one row per remembered device.
 *
 * Kept out of db/index.js because that file is already the whole media schema
 * and these statements have nothing to do with it. Same prepared-once pattern.
 */
import { db } from './index.js';

const stmt = {
  insert: db.prepare(`
    INSERT INTO devices (
      id, token_hash, name, user_agent, last_ip, origin, first_seen, last_seen
    ) VALUES (
      @id, @token_hash, @name, @user_agent, @last_ip, @origin, @first_seen, @last_seen
    )
  `),
  byTokenHash: db.prepare('SELECT * FROM devices WHERE token_hash = ?'),
  // origin is rewritten, not preserved: a device that first appeared on the
  // LAN and now connects from a hotel should say so, or the launcher list
  // cannot be used to spot where something is really coming from.
  touch: db.prepare(`
    UPDATE devices
       SET last_seen = @last_seen,
           last_ip   = COALESCE(@last_ip, last_ip),
           origin    = COALESCE(@origin, origin)
     WHERE id = @id
  `),
  list: db.prepare('SELECT * FROM devices ORDER BY last_seen DESC'),
  revoke: db.prepare('DELETE FROM devices WHERE id = ?')
};

export function insertDevice({ id, tokenHash, name, userAgent = null, ip = null, origin = null }) {
  const now = Date.now();
  stmt.insert.run({
    id,
    token_hash: tokenHash,
    name,
    user_agent: userAgent,
    last_ip: ip,
    origin,
    first_seen: now,
    last_seen: now
  });
}

export const findDeviceByTokenHash = (tokenHash) => stmt.byTokenHash.get(tokenHash) || null;

export function touchDevice(id, { ip = null, origin = null } = {}) {
  stmt.touch.run({ id, last_seen: Date.now(), last_ip: ip, origin });
}

export const listDevices = () => stmt.list.all();

/** True when a row was actually removed, so the API can 404 an unknown id. */
export const revokeDevice = (id) => stmt.revoke.run(id).changes > 0;

export default { insertDevice, findDeviceByTokenHash, touchDevice, listDevices, revokeDevice };
