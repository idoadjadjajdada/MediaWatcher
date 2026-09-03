/**
 * Handing a conversion to another machine.
 *
 * The slow path in this app is always the CPU. A 4K HDR film tone-mapped to
 * H.264 runs at about 1.4x realtime on the machine measured here, which means
 * a two-hour film takes ninety minutes of the same processor that is also
 * meant to be serving playback. Meanwhile a second PC on the tailnet sits
 * idle.
 *
 * So: offer the job elsewhere. The worker is another MediaWatcher started in
 * worker mode; it pulls the source over HTTP, converts it, and holds the
 * result until this end fetches it.
 *
 * ## Why the worker pulls
 *
 * The obvious design has both machines seeing the same files over a share, and
 * it is the wrong one to require: it means a NAS, matching paths on both ends,
 * and credentials, none of which this app has anywhere else. Pulling over HTTP
 * needs nothing but a URL, and the transfer is not the expensive part — a
 * 25 GB source over a gigabit link is four minutes against ninety of encoding.
 *
 * ## Why it is always optional
 *
 * Every failure falls back to converting locally, silently. A worker that is
 * asleep, busy, unreachable or running a different version must cost a few
 * seconds of trying and nothing else, because the alternative to a remote
 * conversion is not "no conversion" — it is the conversion this machine was
 * going to do anyway.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import config, { createLogger } from '../config/index.js';

const log = createLogger('farm');

/** How long to wait for a worker to answer that it is alive. */
const HEALTH_TIMEOUT_MS = 4000;

/** How often to ask a running job how it is getting on. */
const POLL_INTERVAL_MS = 5000;

/**
 * Longest a remote conversion may take before it is abandoned.
 *
 * Generous, because the point of this is long jobs. The cost of the ceiling
 * being too high is a job nobody is waiting for taking a while to give up; the
 * cost of it being too low is abandoning work that was about to finish.
 */
const JOB_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/* --------------------------------------------------------------------------
 * Identity between the two ends
 * ----------------------------------------------------------------------- */

/**
 * A shared secret, not a device cookie.
 *
 * The two ends are servers rather than people: there is nobody to sign in, and
 * a worker that trusted whatever asked it to encode would be a machine anyone
 * on the network could spend. One secret in both `.env` files is the whole
 * arrangement.
 */
export const secret = () => config.encode.secret;

export const isConfigured = () => Boolean(secret() && config.encode.workers.length > 0);

/** Sign a source path so a worker can fetch it without being signed in. */
export function signSource(filePath, expiresAt) {
  return createHmac('sha256', secret()).update(`${filePath}|${expiresAt}`).digest('base64url');
}

/** Does this request carry a signature this pair of machines made? */
export function verifySource(filePath, expiresAt, supplied, { now = Date.now() } = {}) {
  if (!secret() || !supplied) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) <= now) return false;

  const expected = Buffer.from(signSource(filePath, expiresAt));
  const given = Buffer.from(String(supplied));
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Is this the shared secret? Constant time, because it is a secret. */
export function verifySecret(supplied) {
  const expected = Buffer.from(String(secret() || ''));
  const given = Buffer.from(String(supplied || ''));
  if (expected.length === 0 || given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/* --------------------------------------------------------------------------
 * Choosing a worker
 * ----------------------------------------------------------------------- */

const headers = () => ({ 'x-encode-secret': secret() });

async function ask(url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, headers: { ...headers(), ...options.headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which workers are alive and free, best first.
 *
 * "Best" is idle before busy and then faster hardware first, because a job
 * given to the machine with a GPU finishes in a third of the time. A worker
 * that does not answer is not an error worth reporting — it is a machine that
 * is switched off, which is the normal state of a spare PC.
 */
export async function available() {
  const results = await Promise.all(config.encode.workers.map(async (base) => {
    try {
      const response = await ask(`${base}/api/encode/health`);
      if (!response.ok) return null;
      const health = await response.json();
      return { base, ...health };
    } catch {
      return null;
    }
  }));

  return results
    .filter((worker) => worker && !worker.busy)
    .sort((a, b) => Number(Boolean(b.hardwareEncoder)) - Number(Boolean(a.hardwareEncoder)));
}

/* --------------------------------------------------------------------------
 * Running one job
 * ----------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert `filePath` somewhere else and write the result to `target`.
 *
 * Answers false rather than throwing for every ordinary failure: no worker
 * free, worker refused, transfer failed, conversion failed. The caller's next
 * line is "convert it here instead", and that is not an error path.
 *
 * `sourceUrl` is how the worker reaches this machine, which this machine
 * cannot work out for itself — behind a tunnel its own idea of its address is
 * usually wrong. It is configured.
 */
export async function convertRemotely(filePath, target, { variant, video }) {
  if (!isConfigured() || !config.encode.selfUrl) return false;

  const [worker] = await available();
  if (!worker) return false;

  const expiresAt = Date.now() + JOB_TIMEOUT_MS;
  const source = `${config.encode.selfUrl}/api/encode/source`
    + `?path=${encodeURIComponent(filePath)}&exp=${expiresAt}&sig=${encodeURIComponent(signSource(filePath, expiresAt))}`;

  let jobId = null;
  try {
    const offered = await ask(`${worker.base}/api/encode/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, variant, video })
    });
    if (!offered.ok) return false;
    ({ id: jobId } = await offered.json());
    if (!jobId) return false;

    log.info(`${variant} of ${filePath} handed to ${worker.base} as ${jobId}`);

    const deadline = Date.now() + JOB_TIMEOUT_MS;
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      if (Date.now() > deadline) throw new Error('the worker took too long');

      const response = await ask(`${worker.base}/api/encode/jobs/${jobId}`);
      if (!response.ok) throw new Error(`worker lost the job (${response.status})`);

      const status = await response.json();
      if (status.state === 'done') break;
      if (status.state === 'failed') throw new Error(status.error || 'the worker could not convert it');
    }

    /*
     * Into a .part file and renamed, exactly as a local conversion does: a
     * transfer that dies half way must not leave a truncated file sitting at
     * the name the player trusts.
     */
    const partial = `${target}.part`;
    const output = await ask(`${worker.base}/api/encode/jobs/${jobId}/output`, {}, JOB_TIMEOUT_MS);
    if (!output.ok || !output.body) throw new Error('the worker had no output');

    await fsp.mkdir(target.slice(0, target.lastIndexOf('/') + 1) || '.', { recursive: true }).catch(() => {});
    await pipeline(Readable.fromWeb(output.body), fs.createWriteStream(partial));
    await fsp.rename(partial, target);

    log.info(`${variant} of ${filePath} came back from ${worker.base}`);
    return true;
  } catch (error) {
    log.warn(`remote conversion failed, doing it here instead: ${error.message}`);
    try { await fsp.rm(`${target}.part`, { force: true }); } catch { /* nothing there */ }
    return false;
  } finally {
    // Always, including on failure: a worker holding a finished file nobody
    // collected would fill its disk with them.
    if (jobId) ask(`${worker.base}/api/encode/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
  }
}

export default {
  isConfigured, available, convertRemotely,
  signSource, verifySource, verifySecret, secret
};
