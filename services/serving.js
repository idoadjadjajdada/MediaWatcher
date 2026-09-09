/**
 * One server per library.
 *
 * Two MediaWatchers over one data folder do not collide in any way that
 * announces itself. Both scan it, both sweep the caches, both reconcile the
 * same download queue — and each finds the other's in-flight HLS segment
 * directories and deletes them as orphans left by a process that died. The
 * symptom is somebody else's playback stopping halfway through an episode,
 * which nobody would trace back to a second terminal window.
 *
 * A port collision used to prevent this by accident, and that is no longer
 * enough: the desktop app deliberately opens beside servers it did not start,
 * and choosing a different PORT is the obvious way to run two of these on
 * purpose. So the folder itself is claimed, and the claim says where its holder
 * is answering so the refusal can point at it rather than just refusing.
 *
 * The claim is advisory and self-verifying rather than a lock. A file left
 * behind by a crash names a port that answers nothing, or answers as somebody
 * else's library, and is ignored — a stale file must never be the reason a
 * server will not start.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import config from '../config/index.js';
import { instanceFingerprint } from './auth.js';

/** Beside `admin-key`, which is what makes the claim verifiable at all. */
export const claimPath = (dataDir = config.dataDir) => path.join(dataDir, 'config', 'serving.json');

/**
 * What a server holding this folder would report as its instance.
 *
 * The running server has its own key in config already; any other folder's has
 * to be read from inside it, which is the same thing the desktop shell does
 * from the outside. The formula itself lives in one place, in auth.js.
 */
function fingerprintFor(dataDir) {
  if (!dataDir || path.resolve(dataDir) === path.resolve(config.dataDir)) return instanceFingerprint();
  try {
    return instanceFingerprint(dataDir, fs.readFileSync(path.join(dataDir, 'config', 'admin-key'), 'utf8').trim());
  } catch {
    return '';
  }
}

export function read(dataDir) {
  try {
    const held = JSON.parse(fs.readFileSync(claimPath(dataDir), 'utf8'));
    return Number.isInteger(held?.port) ? held : null;
  } catch {
    return null;
  }
}

export function claim(port, dataDir) {
  const file = claimPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Only where to look and who to ask about. Whether it really is this library
  // is settled live, against /api/health, not by anything written here.
  fs.writeFileSync(file, `${JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }, null, 2)}\n`);
}

/** Only ever our own claim: another process's is not ours to withdraw. */
export function release(dataDir) {
  const held = read(dataDir);
  if (held && held.pid !== process.pid) return false;
  try {
    fs.rmSync(claimPath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** What `/api/health` says, or null if nothing useful answers. */
export function health(port, timeout = 1500) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body = (body + chunk).slice(0, 4000); });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/**
 * The server already serving this folder, if there is one.
 *
 * Answering on the claimed port is not enough on its own — anything can be
 * listening there by the time we look — so the answer has to prove it is this
 * library before it counts.
 */
export async function holder(dataDir) {
  const held = read(dataDir);
  if (!held || held.pid === process.pid) return null;
  const mine = fingerprintFor(dataDir);
  if (!mine) return null;
  const answer = await health(held.port);
  return answer?.instance === mine ? held : null;
}

export default { claimPath, read, claim, release, health, holder };
