/**
 * Web Push, without a payload and without a dependency.
 *
 * The launcher's notifications only exist on the machine the server runs on,
 * which is the one place you are not when a download finishes. The phone
 * already has the app installed as a PWA, so it can be told directly.
 *
 * Two decisions shape this file.
 *
 * **No payload.** A push may carry encrypted content, which needs the whole of
 * RFC 8291 — ECDH against the subscription's key, HKDF, AES-128-GCM, record
 * padding — and that is a library's worth of cryptography to get subtly wrong.
 * A push with no body is just a signed POST, and the service worker fetches
 * what happened from this server when it wakes. That is less code, and it also
 * means Google and Mozilla never see the name of anything in your library:
 * they carry a knock at the door, not the message.
 *
 * **Keys in the database.** VAPID identifies this server to the push service,
 * and every existing subscription is bound to the public half — regenerating
 * it silently invalidates every device. So it is minted once and kept.
 */
import { generateKeyPairSync, createSign, createPublicKey } from 'node:crypto';
import config, { createLogger } from '../config/index.js';
import { readState, writeState } from '../db/index.js';

const log = createLogger('push');

const STATE_KEY = 'push.vapid';

/** How long a push may wait at the service for a device that is offline. */
const TTL_SECONDS = 24 * 60 * 60;

/** JWT lifetime. The spec caps this at 24 hours; twelve is comfortably inside. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

/* --------------------------------------------------------------------------
 * Identity
 * ----------------------------------------------------------------------- */

/**
 * The raw public point a browser wants as `applicationServerKey`.
 *
 * A P-256 SPKI DER ends with the uncompressed point: 0x04 followed by the two
 * 32-byte coordinates. The browser wants exactly those 65 bytes, not the DER
 * wrapper around them.
 */
function rawPublicKey(publicPem) {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) throw new Error('unexpected public key encoding');
  return point;
}

/** Mint the keypair, once, and keep it. */
export function keys() {
  const stored = readState(STATE_KEY);
  if (stored?.publicPem && stored?.privatePem) return stored;

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pair = {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: Date.now()
  };
  writeState(STATE_KEY, pair);
  log.info('minted a VAPID keypair — existing subscriptions, if any, are now stale');
  return pair;
}

/** What the browser passes to pushManager.subscribe. */
export function applicationServerKey() {
  return b64url(rawPublicKey(keys().publicPem));
}

/* --------------------------------------------------------------------------
 * Signing
 * ----------------------------------------------------------------------- */

/**
 * Who to contact about this server, for the push service's own logs.
 *
 * Deliberately not the user's email address. Nothing about this feature needs
 * one, and quietly sending a personal address to Google and Mozilla on every
 * push is not a reasonable default. `.invalid` is reserved for exactly this.
 */
const contact = () => config.push?.contact || 'mailto:mediawatcher@example.invalid';

/** The origin a push endpoint lives at — the JWT's audience. */
export function audienceFor(endpoint) {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * A VAPID JWT for one push service.
 *
 * ES256 signatures must be the raw r‖s pair, 64 bytes. Node produces DER by
 * default, which every push service rejects as malformed — `ieee-p1363` is the
 * encoding the JOSE spec actually asks for.
 */
export function signJwt(audience, { now = Date.now(), privatePem = keys().privatePem } = {}) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS,
    sub: contact()
  }));

  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key: privatePem, dsaEncoding: 'ieee-p1363' });

  return `${header}.${payload}.${b64url(signature)}`;
}

/* --------------------------------------------------------------------------
 * Sending
 * ----------------------------------------------------------------------- */

/**
 * Knock on one subscription's door.
 *
 * Returns `{ ok }` and, when the push service says the subscription is dead,
 * `gone: true`. That distinction is the whole error handling here: a network
 * blip is worth retrying later, and a 404 or 410 means the browser threw the
 * subscription away and the row should go with it.
 */
export async function send(endpoint, { urgency = 'normal' } = {}) {
  const jwt = signJwt(audienceFor(endpoint));

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        TTL: String(TTL_SECONDS),
        Urgency: urgency,
        Authorization: `vapid t=${jwt}, k=${applicationServerKey()}`,
        // Explicit: a POST with neither a body nor a length is rejected by
        // some services as malformed rather than read as an empty push.
        'Content-Length': '0'
      }
    });
  } catch (error) {
    return { ok: false, gone: false, error: error.message };
  }

  if (response.ok) return { ok: true, gone: false, status: response.status };

  const gone = response.status === 404 || response.status === 410;
  if (!gone) log.warn(`push to ${audienceFor(endpoint)} failed: ${response.status}`);
  return { ok: false, gone, status: response.status };
}

export default { keys, applicationServerKey, signJwt, audienceFor, send };
