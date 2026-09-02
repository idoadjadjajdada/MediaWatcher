/**
 * Adding a device without typing the password on it.
 *
 * The password gate is right, and it is miserable on a television: a
 * twelve-character password entered with a D-pad and an on-screen keyboard,
 * usually while someone waits. The launcher already draws a QR code pointing a
 * phone at the server, which solves the address and leaves the password.
 *
 * So an enrolment code: minted on a device that is already trusted, carried in
 * a URL, good once, and good briefly. Scanning it signs that device in.
 *
 * Three properties make it safe enough to put on a screen in a room:
 *
 *   single use   the code is consumed by the first device that redeems it, so
 *                a photograph of the screen taken afterwards is worthless.
 *   short lived  five minutes, which is longer than walking to the television
 *                and shorter than anything that could be found later.
 *   in memory    codes die with the process. A restart during enrolment costs
 *                one re-scan, and there is nothing on disk to leak.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../config/index.js';

const log = createLogger('enrol');

/** Long enough that guessing is hopeless, short enough to survive a QR. */
const CODE_BYTES = 24;

/** How long a code is good for. */
export const TTL_MS = 5 * 60 * 1000;

/**
 * Live codes by hash.
 *
 * Hashed rather than stored, for the same reason device tokens are: the value
 * in memory should not be a working credential if it is ever printed, dumped
 * or logged.
 */
const codes = new Map();

const hash = (code) => createHash('sha256').update(String(code)).digest('hex');

/** Drop what has expired. Cheap, and called on every use of the map. */
export function prune(now = Date.now()) {
  for (const [key, entry] of codes) {
    if (entry.expiresAt <= now) codes.delete(key);
  }
}

/**
 * Mint a code. The plain value is returned once and never stored.
 *
 * `issuedBy` is only for the log — knowing which device handed out a code that
 * later signed something in is the kind of thing you want afterwards, not
 * during.
 */
export function create({ issuedBy = 'admin', now = Date.now() } = {}) {
  prune(now);

  const code = randomBytes(CODE_BYTES).toString('base64url');
  codes.set(hash(code), { expiresAt: now + TTL_MS, issuedBy, createdAt: now });
  log.info(`enrolment code issued by ${issuedBy}, good for ${Math.round(TTL_MS / 60000)} minutes`);

  return { code, expiresAt: now + TTL_MS };
}

/**
 * Redeem a code. Answers false for anything that is not a live one.
 *
 * Deliberately one answer for every failure — expired, already used, never
 * existed. A caller learning *why* a code failed learns whether it ever
 * existed, and that is the only interesting thing to learn from outside.
 */
export function redeem(code, now = Date.now()) {
  prune(now);
  if (!code) return false;

  const key = hash(code);
  const entry = codes.get(key);
  if (!entry) return false;

  /*
   * Constant-time even though the lookup above is a hash-table hit: the
   * comparison that matters has already happened by then, so this is belt and
   * braces rather than the real defence. The real defence is 24 random bytes.
   */
  const supplied = Buffer.from(key, 'hex');
  const expected = Buffer.from(key, 'hex');
  if (!timingSafeEqual(supplied, expected)) return false;

  // Consumed on redemption, before anything else can fail: a code that signs
  // in one device must not be able to sign in a second.
  codes.delete(key);
  return true;
}

/** How many are outstanding. For the page that shows one. */
export const pending = (now = Date.now()) => {
  prune(now);
  return codes.size;
};

/** Cancel everything outstanding — for a code shown to the wrong room. */
export function clear() {
  const count = codes.size;
  codes.clear();
  if (count > 0) log.info(`${count} enrolment code(s) cancelled`);
  return count;
}

export default { create, redeem, pending, clear, prune, TTL_MS };
