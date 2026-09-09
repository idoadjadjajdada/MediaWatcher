/**
 * Which MediaWatcher is that on the port.
 *
 * The desktop app has to tell three cases apart before it starts anything: its
 * own server already running (attach to it, and leave two copies of one library
 * from ever existing), a different MediaWatcher or an unrelated service (start
 * beside it on another port), and nothing at all (start where the
 * configuration says).
 *
 * "Its own" means the same data folder, and the answer has to survive being
 * shouted down a public endpoint. So `/api/health` returns this: the data
 * folder keyed by the admin key sitting inside it. Only something that can read
 * `config/admin-key` can compute it, which means something already on this
 * machine with this library — a stranger reading the endpoint learns a hex
 * string and nothing else, not even the path it is derived from.
 *
 * The server computes the same value in services/auth.js, in ESM, from its own
 * config. tests/instance.test.mjs runs both and fails if they ever disagree.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');

/** The value `/api/health` reports, or '' when there is no key to derive it from. */
function fingerprint(dataDir) {
  // Never fall back to the working directory: "no folder" is not a library.
  if (!String(dataDir || '').trim()) return '';
  const resolved = path.resolve(String(dataDir));
  let key;
  try {
    key = fs.readFileSync(path.join(resolved, 'config', 'admin-key'), 'utf8').trim();
  } catch {
    // No key yet means no library here yet, so nothing can match this.
    return '';
  }
  if (key.length !== 64) return '';
  return createHmac('sha256', key).update(resolved).digest('hex').slice(0, 32);
}

module.exports = { fingerprint };
