# Remote Access, Device Auth and Remote Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MediaWatcher reachable from any personal device anywhere, over a Tailscale tunnel, behind a shared-password gate with per-device remembered credentials that can be audited and revoked from the launcher, and with resolution/bitrate caps applied to tunnelled playback.

**Architecture:** The server keeps its existing `127.0.0.1` bind; `tailscale serve` terminates TLS and proxies to it. A `requireAuth` middleware mounts ahead of all static and API routes and resolves an `HttpOnly` cookie token against a `devices` table (persistent, "remember me") or an in-memory session set (not remembered). Because the tunnel makes every remote request appear to come from loopback, loopback is explicitly **not** trusted; the launcher instead authenticates with a local admin key file. Quality capping hooks into the single existing decision point, `transcoder.decide()`.

**Tech Stack:** Node 20+, Express 4, better-sqlite3, helmet, vanilla ES modules on the frontend, WPF/PowerShell 5.1 launcher, ffmpeg, Tailscale.

## Global Constraints

- Node `>=20.0.0`. ES modules (`"type": "module"`) throughout.
- **No new npm dependencies.** Cookie parsing, token minting, hashing and rate limiting all use `node:crypto` and hand-rolled helpers. `res.cookie()` is built into Express 4 and needs no `cookie-parser`.
- `config.host` stays `'127.0.0.1'`. Never change the bind address.
- Every schema statement is `IF NOT EXISTS`; `db/schema.sql` doubles as the migration path and runs on every boot.
- Node tests are plain scripts run as `node tests/<name>.test.mjs`, using the existing hand-rolled `check(name, condition)` helper and `process.exit(failures > 0 ? 1 : 0)`. Do **not** introduce `node:test`.
- Every new test file is appended to the `npm test` chain in `package.json`.
- Launcher tests are Pester, run via `launcher/tests/run-tests.ps1`.
- PowerShell 5.1: no `&&`, no ternary, no null-coalescing. Use `;` and `if`.
- Comments explain *why*, matching the density and voice of the surrounding code. No comment restates what the line does.
- Quality ladder defaults: Original = uncapped; High = 1080p / `12M`; Medium = 720p / `5M`; Low = 480p / `1.5M`. `Auto` resolves to Original on LAN and **High** over Tailscale.
- Tailscale CGNAT range for remote detection: `100.64.0.0/10`.
- Cookie name: `mw_device`. Attributes `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` **only when the request arrived over TLS**.

---

## File Structure

**Created:**
- `db/devices.js` — device row CRUD. Owns every `devices` statement; imports `db` from `db/index.js`.
- `services/auth.js` — token minting/hashing, cookie parsing, the non-remembered session set, failed-attempt backoff. No Express types; pure functions plus two in-memory maps so it is testable without a server.
- `services/network.js` — client IP resolution and LAN/Tailscale classification.
- `services/quality.js` — the ladder, `Auto` resolution, and bitrate string parsing.
- `middleware/requireAuth.js` — the Express gate. Thin; all logic lives in `services/auth.js`.
- `routes/auth.js` — `POST /api/auth/login`, `POST /api/auth/logout`.
- `routes/devices.js` — `GET /api/devices`, `DELETE /api/devices/:id`, admin-key gated.
- `public/login.html`, `public/js/login.js`, `public/css/login.css` — the gate page.
- `tests/auth.test.mjs`, `tests/auth-loopback.test.mjs`, `tests/remote-quality.test.mjs`
- `launcher/tests/Devices.Tests.ps1`

**Modified:**
- `db/schema.sql` — add the `devices` table and index.
- `config/index.js` — `AUTH_PASSWORD` validation, admin key generation, `auth`/`remote` config blocks.
- `server.js` — trust proxy, CORS origin, mount auth ahead of static and routes.
- `services/transcoder.js` — `decide()` quality option, `buildArgs` `maxHeight`/`maxrate`.
- `routes/stream.js` — resolve quality per request, bypass MP4 cache when capped.
- `public/js/api.js` — `q` param on `streamUrl`/`getStreamInfo`, 401 handling.
- `public/js/player.js` — quality picker control.
- `launcher/MainWindow.xaml`, `launcher/MediaWatcher.ps1`, `launcher/lib/ApiClient.ps1` — Devices tab.
- `.gitignore` — `config/admin-key`.
- `.env.example`, `README.md`.

---

### Task 1: Device store

**Files:**
- Modify: `db/schema.sql`
- Create: `db/devices.js`
- Create: `tests/auth.test.mjs`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: `db` exported from `db/index.js`.
- Produces: `insertDevice({ id, tokenHash, name, userAgent, ip, origin })`, `findDeviceByTokenHash(tokenHash)`, `touchDevice(id, { ip, origin })`, `listDevices()`, `revokeDevice(id) -> boolean`. Rows are returned with snake_case columns exactly as SQLite stores them.

- [ ] **Step 1: Add the table to the schema**

Append to `db/schema.sql`:

```sql
-- Remembered devices. One row per "remember me" login; the row IS the
-- credential, so revoking it locks that device out on its very next request.
-- Only the hash is stored: a leaked database file yields nothing usable.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  user_agent   TEXT,
  last_ip      TEXT,
  origin       TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen
  ON devices(last_seen DESC);
```

- [ ] **Step 2: Write the failing test**

Create `tests/auth.test.mjs`:

```js
/**
 * Device store and authentication primitives.
 *
 * The device row is the credential, so these cover the properties that make
 * that safe: only hashes are persisted, revocation is immediate, and a token
 * that was never issued never resolves.
 *
 * Run: node tests/auth.test.mjs
 */
import { randomUUID } from 'node:crypto';
import {
  insertDevice, findDeviceByTokenHash, touchDevice, listDevices, revokeDevice
} from '../db/devices.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const makeDevice = (over = {}) => ({
  id: randomUUID(),
  tokenHash: `hash-${randomUUID()}`,
  name: 'Test iPad',
  userAgent: 'Mozilla/5.0 (iPad)',
  ip: '100.101.102.103',
  origin: 'tailscale',
  ...over
});

console.log('\ndevice store');

const device = makeDevice();
insertDevice(device);

const found = findDeviceByTokenHash(device.tokenHash);
check('a stored device is found by its token hash', found?.id === device.id);
check('the name round-trips', found?.name === 'Test iPad');
check('origin round-trips', found?.origin === 'tailscale');
check('first_seen is populated', Number.isFinite(found?.first_seen) && found.first_seen > 0);
check('an unknown hash resolves to nothing', !findDeviceByTokenHash('nope'));

// last_seen must move or the launcher list is useless for spotting activity.
const before = found.last_seen;
touchDevice(device.id, { ip: '192.168.1.50', origin: 'lan' });
const touched = findDeviceByTokenHash(device.tokenHash);
check('touch updates last_ip', touched.last_ip === '192.168.1.50');
check('touch rewrites origin so a roaming device reports where it is now',
  touched.origin === 'lan');
check('touch never moves first_seen', touched.first_seen === found.first_seen);
check('touch does not move last_seen backwards', touched.last_seen >= before);

check('the device appears in the list',
  listDevices().some((row) => row.id === device.id));

check('revoking reports success', revokeDevice(device.id) === true);
check('a revoked device no longer resolves', !findDeviceByTokenHash(device.tokenHash));
check('revoking twice reports failure', revokeDevice(device.id) === false);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node tests/auth.test.mjs`
Expected: FAIL — `Cannot find module '.../db/devices.js'`

- [ ] **Step 4: Implement the device store**

Create `db/devices.js`:

```js
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/auth.test.mjs`
Expected: PASS, `14/14 passed`

- [ ] **Step 6: Add to the test chain**

In `package.json`, append ` && node tests/auth.test.mjs` to the `test` script.

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql db/devices.js tests/auth.test.mjs package.json
git commit -m "feat(auth): devices table and store"
```

---

### Task 2: Auth primitives

**Files:**
- Create: `services/auth.js`
- Modify: `tests/auth.test.mjs`

**Interfaces:**
- Consumes: `db/devices.js` from Task 1.
- Produces: `mintToken() -> string` (64 hex chars), `hashToken(token) -> string`, `parseCookies(header) -> object`, `verifyPassword(supplied) -> boolean`, `rememberSession(tokenHash)`, `hasSession(tokenHash) -> boolean`, `dropSession(tokenHash)`, `resolveToken(token) -> { kind: 'device'|'session', device? } | null`, `recordFailure(ip) -> void`, `blockedForMs(ip) -> number`, `clearFailures(ip)`, `COOKIE_NAME`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth.test.mjs`, before the summary lines:

```js
import {
  mintToken, hashToken, parseCookies, rememberSession, hasSession, dropSession,
  resolveToken, recordFailure, blockedForMs, clearFailures, COOKIE_NAME
} from '../services/auth.js';

console.log('\ntokens');
const tokenA = mintToken();
const tokenB = mintToken();
check('a token is 64 hex characters', /^[0-9a-f]{64}$/.test(tokenA));
check('two tokens differ', tokenA !== tokenB);
check('hashing is stable', hashToken(tokenA) === hashToken(tokenA));
check('the hash is not the token', hashToken(tokenA) !== tokenA);
check('different tokens hash differently', hashToken(tokenA) !== hashToken(tokenB));

console.log('\ncookie parsing');
check('reads one cookie', parseCookies('mw_device=abc').mw_device === 'abc');
check('reads several', parseCookies('a=1; mw_device=xyz; b=2').mw_device === 'xyz');
check('tolerates no header', Object.keys(parseCookies(undefined)).length === 0);
check('tolerates an empty header', Object.keys(parseCookies('')).length === 0);
check('decodes percent-encoding', parseCookies('k=a%20b').k === 'a b');
check('ignores a malformed pair', parseCookies('novalue; k=1').k === '1');
check('the cookie name is exported', COOKIE_NAME === 'mw_device');

console.log('\nsessions');
const sessionToken = mintToken();
check('an unknown token has no session', hasSession(hashToken(sessionToken)) === false);
rememberSession(hashToken(sessionToken));
check('a remembered session is found', hasSession(hashToken(sessionToken)) === true);
check('resolveToken reports a session', resolveToken(sessionToken)?.kind === 'session');
dropSession(hashToken(sessionToken));
check('a dropped session is gone', hasSession(hashToken(sessionToken)) === false);
check('resolveToken rejects an unissued token', resolveToken(mintToken()) === null);

// A persistent device must win over the session path.
const persistentToken = mintToken();
insertDevice(makeDevice({ tokenHash: hashToken(persistentToken) }));
const resolved = resolveToken(persistentToken);
check('resolveToken reports a device', resolved?.kind === 'device');
check('resolveToken hands back the row', resolved?.device?.name === 'Test iPad');

console.log('\nfailed-attempt backoff');
const ip = '203.0.113.9';
clearFailures(ip);
check('a clean IP is not blocked', blockedForMs(ip) === 0);
recordFailure(ip);
recordFailure(ip);
check('two failures are still free', blockedForMs(ip) === 0);
recordFailure(ip);
check('the third failure starts the backoff', blockedForMs(ip) > 0);
const afterThree = blockedForMs(ip);
recordFailure(ip);
check('the backoff grows', blockedForMs(ip) > afterThree);
clearFailures(ip);
check('a success clears the record', blockedForMs(ip) === 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/auth.test.mjs`
Expected: FAIL — `Cannot find module '.../services/auth.js'`

- [ ] **Step 3: Implement**

Create `services/auth.js`:

```js
/**
 * Authentication primitives.
 *
 * Deliberately free of Express types so the whole surface is testable without
 * standing a server up. The middleware in middleware/requireAuth.js is the
 * only thing that knows about requests.
 *
 * A device is identified by a token this server minted, never by a browser
 * fingerprint. A fingerprint describes a device, and a description can be
 * forged by anyone who knows the shape of an authorised one; a random token
 * cannot be guessed. It also has to be a cookie rather than a header, because
 * <video src="/api/stream?..."> issues its own range requests with no
 * JavaScript in the loop to attach anything.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import { findDeviceByTokenHash } from '../db/devices.js';

export const COOKIE_NAME = 'mw_device';

export const mintToken = () => randomBytes(32).toString('hex');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * Express has no built-in cookie reader (res.cookie exists, req.cookies does
 * not), and this is the whole of what we need from cookie-parser.
 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

/**
 * Constant-time comparison. Lengths are hashed first so that comparing a
 * 4-character guess against a 40-character password does not leak the length
 * through an early return.
 */
export function verifyPassword(supplied) {
  const expected = createHash('sha256').update(config.auth.password).digest();
  const actual = createHash('sha256').update(String(supplied ?? '')).digest();
  return timingSafeEqual(expected, actual);
}

/* --------------------------------------------------------------------------
 * Non-remembered sessions
 *
 * "Remember me" unchecked means no database row: nothing to audit and nothing
 * to revoke, because the credential dies with the browser or the process.
 * ----------------------------------------------------------------------- */

const sessions = new Set();

export const rememberSession = (tokenHash) => { sessions.add(tokenHash); };
export const hasSession = (tokenHash) => sessions.has(tokenHash);
export const dropSession = (tokenHash) => { sessions.delete(tokenHash); };

/**
 * Resolve a raw cookie token to whatever issued it, or null.
 * Devices are checked first: they are the persistent, revocable credential.
 */
export function resolveToken(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const device = findDeviceByTokenHash(tokenHash);
  if (device) return { kind: 'device', device };

  if (sessions.has(tokenHash)) return { kind: 'session' };
  return null;
}

/* --------------------------------------------------------------------------
 * Failed-attempt backoff
 *
 * A tunnel is long-lived and quiet, so an unthrottled password endpoint is
 * brute-forceable given enough time. In-memory on purpose: a restart clearing
 * the counters is not a weakness worth a table, since restarting the server is
 * not something an attacker can do.
 * ----------------------------------------------------------------------- */

const FREE_ATTEMPTS = 2;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;

const failures = new Map();   // ip -> { count, until }

export function recordFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count > FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (entry.count - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
    entry.until = Date.now() + delay;
  }
  failures.set(ip, entry);
}

/** Milliseconds this IP must wait, or 0. */
export function blockedForMs(ip) {
  const entry = failures.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.until - Date.now());
}

export const clearFailures = (ip) => { failures.delete(ip); };

export default {
  COOKIE_NAME, mintToken, hashToken, parseCookies, verifyPassword,
  rememberSession, hasSession, dropSession, resolveToken,
  recordFailure, blockedForMs, clearFailures
};
```

- [ ] **Step 4: Add the config block**

In `config/index.js`, inside the `config` object after the `logLevel` line:

```js
  auth: {
    password: str('AUTH_PASSWORD'),
    // The tailnet hostname tailscale serve publishes, e.g.
    // "mediapc.tail1a2b3c.ts.net". Needed so CORS accepts that origin.
    tailnetHost: str('TAILNET_HOST')
  },
```

And after the existing REQUIRED-key validation block, add:

```js
/*
 * The password gate is the only thing between a tunnelled server and the
 * internet-facing world, so a missing or trivial password is fatal rather than
 * a warning. Booting open behind a tunnel is the worst failure available here.
 */
const authPassword = str('AUTH_PASSWORD');
if (authPassword.length < 8) {
  console.error([
    '',
    'MediaWatcher cannot start: AUTH_PASSWORD is missing or too short.',
    '',
    '  Set AUTH_PASSWORD in .env to at least 8 characters. Every device must',
    '  enter it once before it can browse or play anything.',
    ''
  ].join('\n'));
  process.exit(1);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node tests/auth.test.mjs`
Expected: PASS. If it exits complaining about `AUTH_PASSWORD`, set one in `.env` first — the test imports config transitively.

- [ ] **Step 6: Add AUTH_PASSWORD to .env and .env.example**

In `.env`, add `AUTH_PASSWORD=` with a real password of 8+ characters. In `.env.example`:

```
# Password every device must enter once before it can browse or play.
# Required; the server refuses to start without at least 8 characters.
AUTH_PASSWORD=

# Hostname tailscale serve publishes, e.g. mediapc.tail1a2b3c.ts.net.
# Leave blank until Tailscale is set up.
TAILNET_HOST=
```

- [ ] **Step 7: Commit**

```bash
git add services/auth.js config/index.js tests/auth.test.mjs .env.example
git commit -m "feat(auth): tokens, sessions, password check and attempt backoff"
```

---

### Task 3: The gate

**Files:**
- Create: `middleware/requireAuth.js`, `routes/auth.js`
- Create: `tests/auth-loopback.test.mjs`
- Modify: `server.js`, `package.json`

**Interfaces:**
- Consumes: everything from `services/auth.js` (Task 2), `insertDevice`/`touchDevice` from `db/devices.js` (Task 1).
- Produces: default-exported `requireAuth` middleware; `isAllowlisted(method, urlPath) -> boolean` named export from the same file; router from `routes/auth.js`. `req.device` is set to the resolved row (or `null` for a session) for downstream handlers.

- [ ] **Step 1: Write the failing test**

Create `tests/auth-loopback.test.mjs`:

```js
/**
 * The loopback trap.
 *
 * tailscale serve terminates TLS and proxies to 127.0.0.1, so every remote
 * request reaches Express looking like it came from the local machine. Any
 * "trust loopback" shortcut therefore disables authentication for exactly the
 * traffic the gate exists to stop — and would look perfectly correct in local
 * testing. This file exists to make that regression impossible to land.
 *
 * Run: node tests/auth-loopback.test.mjs
 */
import { isAllowlisted } from '../middleware/requireAuth.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nallowlist');
check('the login page is reachable unauthenticated', isAllowlisted('GET', '/login.html') === true);
check('the login script is reachable', isAllowlisted('GET', '/js/login.js') === true);
check('the login stylesheet is reachable', isAllowlisted('GET', '/css/login.css') === true);
check('the login endpoint is reachable', isAllowlisted('POST', '/api/auth/login') === true);
check('health is reachable so the launcher can poll it',
  isAllowlisted('GET', '/api/health') === true);

check('the library is NOT reachable', isAllowlisted('GET', '/api/media/library') === false);
check('streaming is NOT reachable', isAllowlisted('GET', '/api/stream') === false);
check('the app shell is NOT reachable', isAllowlisted('GET', '/') === false);
check('the app script is NOT reachable', isAllowlisted('GET', '/js/app.js') === false);
check('the device list is NOT reachable', isAllowlisted('GET', '/api/devices') === false);

// A path that merely starts with an allowlisted prefix must not slip through.
check('a lookalike path is NOT reachable',
  isAllowlisted('GET', '/js/login.js.map') === false);
check('a traversal dressed as the login page is NOT reachable',
  isAllowlisted('GET', '/login.html/../js/app.js') === false);

// Method matters: the login path must not become a GET-able hole.
check('GET on the login endpoint is NOT allowlisted',
  isAllowlisted('GET', '/api/auth/login') === false);

console.log('\nloopback is not a credential');
// The gate takes no IP argument at all. If someone adds one, this fails to
// compile the intent: there is no code path where an address grants access.
check('isAllowlisted decides on method and path alone', isAllowlisted.length === 2);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/auth-loopback.test.mjs`
Expected: FAIL — `Cannot find module '.../middleware/requireAuth.js'`

- [ ] **Step 3: Implement the middleware**

Create `middleware/requireAuth.js`:

```js
/**
 * The gate. Mounts ahead of the static handler and every API router.
 *
 * Note what this function does NOT take: a client address. tailscale serve
 * proxies from 127.0.0.1, so a loopback bypass would wave through every remote
 * request while looking correct on the desk it was written at. Access is
 * decided by the cookie and nothing else.
 */
import { COOKIE_NAME, parseCookies, resolveToken } from '../services/auth.js';
import { touchDevice } from '../db/devices.js';
import { classifyOrigin } from '../services/network.js';

/** Exact matches only — a prefix test would let /js/login.js.map through. */
const PUBLIC_GET = new Set([
  '/login.html',
  '/js/login.js',
  '/css/login.css',
  '/api/health'
]);

const PUBLIC_POST = new Set([
  '/api/auth/login'
]);

export function isAllowlisted(method, urlPath) {
  if (method === 'GET' || method === 'HEAD') return PUBLIC_GET.has(urlPath);
  if (method === 'POST') return PUBLIC_POST.has(urlPath);
  return false;
}

export default function requireAuth(req, res, next) {
  // Strip the query string; the allowlist is about paths.
  const urlPath = req.path;

  if (isAllowlisted(req.method, urlPath)) return next();

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const resolved = resolveToken(token);

  if (!resolved) {
    req.device = null;
    // An API caller wants a status it can branch on; a browser navigating
    // wants the login page. Sending HTML to fetch() would surface as a JSON
    // parse error and tell the user nothing.
    if (urlPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect(302, '/login.html');
  }

  if (resolved.kind === 'device') {
    req.device = resolved.device;
    // Keeps the launcher list honest about where each device is right now.
    touchDevice(resolved.device.id, {
      ip: req.ip,
      origin: classifyOrigin(req.ip)
    });
  } else {
    req.device = null;
  }

  return next();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/auth-loopback.test.mjs`
Expected: PASS, `14/14 passed`. This imports `services/network.js`, which Task 7 creates — if it is not yet present, create it now with just `classifyOrigin` from Task 7 Step 3 and leave the rest of that task alone.

- [ ] **Step 5: Implement the login routes**

Create `routes/auth.js`:

```js
/**
 * POST /api/auth/login  — password in, device cookie out
 * POST /api/auth/logout — drop this device
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createLogger } from '../config/index.js';
import {
  COOKIE_NAME, mintToken, hashToken, parseCookies, verifyPassword,
  rememberSession, dropSession, resolveToken,
  recordFailure, blockedForMs, clearFailures
} from '../services/auth.js';
import { insertDevice, revokeDevice } from '../db/devices.js';
import { classifyOrigin } from '../services/network.js';

const log = createLogger('api:auth');
const router = express.Router();

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Secure is decided per request rather than hardcoded: over the tunnel the
 * origin is HTTPS and the flag is required, but on plain http://localhost the
 * browser would refuse to send a Secure cookie at all and the host machine
 * could never stay logged in.
 */
const cookieOptions = (req, persistent) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/',
  ...(persistent ? { maxAge: ONE_YEAR_MS } : {})
});

router.post('/login', (req, res) => {
  const wait = blockedForMs(req.ip);
  if (wait > 0) {
    return res.status(429).json({
      error: 'Too many attempts. Try again shortly.',
      retry_after_ms: wait
    });
  }

  const { password, deviceName, remember } = req.body || {};

  if (!verifyPassword(password)) {
    recordFailure(req.ip);
    log.warn(`failed login from ${req.ip}`);
    return res.status(401).json({ error: 'Wrong password' });
  }

  clearFailures(req.ip);

  const name = String(deviceName || '').trim().slice(0, 60);
  if (remember && !name) {
    return res.status(400).json({ error: 'Name this device so you can recognise it later' });
  }

  const token = mintToken();

  if (remember) {
    insertDevice({
      id: randomUUID(),
      tokenHash: hashToken(token),
      name,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      ip: req.ip,
      origin: classifyOrigin(req.ip)
    });
    log.info(`device remembered: ${name} (${req.ip})`);
  } else {
    rememberSession(hashToken(token));
  }

  res.cookie(COOKIE_NAME, token, cookieOptions(req, Boolean(remember)));
  return res.json({ ok: true, remembered: Boolean(remember) });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const resolved = resolveToken(token);

  if (resolved?.kind === 'device') revokeDevice(resolved.device.id);
  else if (token) dropSession(hashToken(token));

  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

export default router;
```

- [ ] **Step 6: Wire into server.js**

In `server.js`, add the imports:

```js
import requireAuth from './middleware/requireAuth.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
```

Immediately after `app.set('etag', 'strong');` add:

```js
/*
 * X-Forwarded-For is only meaningful because the sole thing allowed to reach
 * this port is tailscale serve on loopback. Without this every tunnelled
 * request reports req.ip as 127.0.0.1 and remote clients become invisible.
 */
app.set('trust proxy', 'loopback');
```

Replace the `LOCALHOST_ORIGIN` constant and the `cors` block with:

```js
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** The tailnet origin tailscale serve publishes, when one is configured. */
const tailnetOrigin = config.auth.tailnetHost
  ? `https://${config.auth.tailnetHost.toLowerCase()}`
  : null;

app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin navigation, curl, or the <video> element.
    if (!origin) return callback(null, true);
    if (LOCALHOST_ORIGIN.test(origin)) return callback(null, true);
    if (tailnetOrigin && origin.toLowerCase() === tailnetOrigin) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true
}));
```

Then mount the gate. `express.json` must come first so `req.body` exists for the login route, and `requireAuth` must come **before** `express.static` or the whole frontend is served unauthenticated:

```js
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth', authRouter);
app.use(requireAuth);
```

Place those two lines directly above the existing `app.use(express.static(PUBLIC_DIR, ...))` block, and add `app.use('/api/devices', devicesRouter);` alongside the other API mounts.

- [ ] **Step 7: Verify the gate by hand**

Run: `npm start` in one terminal, then:

```bash
curl -si http://127.0.0.1:3000/api/media/library | head -1
```
Expected: `HTTP/1.1 401 Unauthorized`

```bash
curl -si http://127.0.0.1:3000/ | head -1
```
Expected: `HTTP/1.1 302 Found` with `Location: /login.html`

```bash
curl -si http://127.0.0.1:3000/api/health | head -1
```
Expected: `HTTP/1.1 200 OK`

- [ ] **Step 8: Add to the test chain and commit**

Append ` && node tests/auth-loopback.test.mjs` to the `test` script, then:

```bash
git add middleware/requireAuth.js routes/auth.js server.js tests/auth-loopback.test.mjs package.json
git commit -m "feat(auth): password gate ahead of static and API routes"
```

---

### Task 4: Login page

**Files:**
- Create: `public/login.html`, `public/js/login.js`, `public/css/login.css`
- Modify: `public/js/api.js`

**Interfaces:**
- Consumes: `POST /api/auth/login` from Task 3.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the page**

Create `public/login.html`. It deliberately does not load `app.js` — the shell must not boot behind the gate:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>MediaWatcher</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%23a855f7'/><stop offset='1' stop-color='%23ec4899'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='url(%23g)'/><path d='M13 10.5v11l9-5.5z' fill='%23fff'/></svg>">
  <link rel="stylesheet" href="/css/login.css">
</head>
<body>
  <main class="gate">
    <h1 class="gate__title">MediaWatcher</h1>
    <p class="gate__sub">Enter the password to continue.</p>

    <form id="gate-form" class="gate__form" autocomplete="on">
      <label class="gate__label" for="password">Password</label>
      <input class="gate__input" id="password" name="password" type="password"
             autocomplete="current-password" required autofocus>

      <label class="gate__label" for="device-name">Device name</label>
      <input class="gate__input" id="device-name" name="deviceName" type="text"
             placeholder="iPad" autocomplete="off" maxlength="60">

      <label class="gate__remember">
        <input id="remember" type="checkbox" checked>
        <span>Remember this device</span>
      </label>

      <button class="gate__submit" type="submit">Unlock</button>
      <p class="gate__error" id="gate-error" role="alert"></p>
    </form>
  </main>
  <script type="module" src="/js/login.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the script**

Create `public/js/login.js`:

```js
/**
 * The gate page. Standalone on purpose: nothing here imports api.js or app.js,
 * so the application shell never loads for an unauthenticated visitor.
 */
const form = document.getElementById('gate-form');
const errorEl = document.getElementById('gate-error');
const submit = form.querySelector('.gate__submit');
const rememberEl = document.getElementById('remember');
const nameEl = document.getElementById('device-name');

/*
 * A sensible default so the device list does not fill up with "iPad" three
 * times over. Only a hint - the field stays editable.
 */
nameEl.value = (() => {
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  return '';
})();

// The name only matters when the device is being remembered.
const syncNameState = () => { nameEl.disabled = !rememberEl.checked; };
rememberEl.addEventListener('change', syncNameState);
syncNameState();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submit.disabled = true;
  submit.textContent = 'Checking…';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: document.getElementById('password').value,
        deviceName: nameEl.value,
        remember: rememberEl.checked
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      errorEl.textContent = data.error || `Failed (${response.status})`;
      return;
    }

    // Full navigation rather than a route change: the shell has never been
    // loaded on this page, and the cookie needs to be in place before it is.
    window.location.replace('/');
  } catch {
    errorEl.textContent = 'Cannot reach MediaWatcher.';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Unlock';
  }
});
```

- [ ] **Step 3: Write the stylesheet**

Create `public/css/login.css`:

```css
/* Standalone: the gate must render without the app's stylesheet. */
:root {
  --bg: #0b0b0d;
  --panel: #141418;
  --border: #26262c;
  --text: #f4f4f5;
  --dim: #8a8a94;
  --accent: #a855f7;
  --danger: #ef4444;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px;
}

.gate {
  width: 100%;
  max-width: 360px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px 24px;
}

.gate__title {
  margin: 0 0 4px;
  font-size: 22px;
  background: linear-gradient(135deg, #a855f7, #ec4899);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.gate__sub { margin: 0 0 22px; color: var(--dim); font-size: 13px; }

.gate__label {
  display: block;
  margin: 14px 0 6px;
  font-size: 12px;
  color: var(--dim);
}

.gate__input {
  width: 100%;
  padding: 11px 12px;
  background: #0e0e11;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  /* 16px or iOS Safari zooms the page on focus. */
  font-size: 16px;
}

.gate__input:focus { outline: none; border-color: var(--accent); }
.gate__input:disabled { opacity: 0.45; }

.gate__remember {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 18px 0 22px;
  font-size: 13px;
  color: var(--dim);
  cursor: pointer;
}

.gate__submit {
  width: 100%;
  padding: 12px;
  border: 0;
  border-radius: 8px;
  background: linear-gradient(135deg, #a855f7, #ec4899);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.gate__submit:disabled { opacity: 0.6; cursor: default; }

.gate__error {
  margin: 14px 0 0;
  min-height: 18px;
  color: var(--danger);
  font-size: 13px;
}
```

- [ ] **Step 4: Handle expiry in the app's fetch wrapper**

In `public/js/api.js`, inside `request()`, immediately before the existing `if (!response.ok)` block:

```js
  // A revoked or expired device gets bounced to the gate rather than seeing
  // every panel on the page fail with its own error toast.
  if (response.status === 401) {
    window.location.replace('/login.html');
    throw new ApiError(401, 'Authentication required');
  }
```

- [ ] **Step 5: Verify in a browser**

Run `npm start`, open `http://127.0.0.1:3000/`.
Expected: redirected to the gate. A wrong password shows "Wrong password". The correct one with "Remember this device" checked lands on the library, and a reload goes straight in.

Then check the cookie in DevTools → Application → Cookies.
Expected: `mw_device`, `HttpOnly` ✓, `SameSite=Lax`, `Secure` **unchecked** (this is plain HTTP on localhost — over the tunnel it will be set).

- [ ] **Step 6: Commit**

```bash
git add public/login.html public/js/login.js public/css/login.css public/js/api.js
git commit -m "feat(auth): login page and 401 handling"
```

---

### Task 5: Admin key and devices API

**Files:**
- Modify: `config/index.js`, `.gitignore`
- Create: `routes/devices.js`
- Modify: `tests/auth.test.mjs`

**Interfaces:**
- Consumes: `listDevices`/`revokeDevice` from Task 1.
- Produces: `config.auth.adminKey` (32-byte hex string, generated on first boot); `GET /api/devices` returning `{ devices: [...] }`; `DELETE /api/devices/:id`.

- [ ] **Step 1: Generate the key at boot**

In `config/index.js`, add `import { randomBytes } from 'node:crypto';` at the top, and after the `AUTH_PASSWORD` validation:

```js
/*
 * A key only something on this machine can read. The launcher needs to list
 * and revoke devices, and it cannot be waved through on the basis of coming
 * from loopback — tailscale serve makes every remote request look local. So it
 * proves itself with a file instead.
 */
const ADMIN_KEY_PATH = path.join(ROOT_DIR, 'config', 'admin-key');

function loadOrCreateAdminKey() {
  try {
    const existing = fs.readFileSync(ADMIN_KEY_PATH, 'utf8').trim();
    if (existing.length === 64) return existing;
  } catch {
    // Absent or unreadable: fall through and mint a new one.
  }
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(ADMIN_KEY_PATH, key, { mode: 0o600 });
  return key;
}
```

Then inside the `auth` config block add `adminKey: loadOrCreateAdminKey(),`.

- [ ] **Step 2: Keep the key out of git**

Append to `.gitignore` under the `# Secrets` heading:

```
config/admin-key
```

- [ ] **Step 3: Write the failing test**

Append to `tests/auth.test.mjs` before the summary lines:

```js
import config from '../config/index.js';
import { isAdminRequest } from '../routes/devices.js';

console.log('\nadmin key');
check('an admin key exists', /^[0-9a-f]{64}$/.test(config.auth.adminKey));
check('the correct key is accepted',
  isAdminRequest({ headers: { 'x-mediawatcher-key': config.auth.adminKey } }) === true);
check('a wrong key is rejected',
  isAdminRequest({ headers: { 'x-mediawatcher-key': 'a'.repeat(64) } }) === false);
check('a missing key is rejected', isAdminRequest({ headers: {} }) === false);
check('an empty key is rejected',
  isAdminRequest({ headers: { 'x-mediawatcher-key': '' } }) === false);
// A logged-in device must not be able to enumerate or revoke other devices.
check('a device cookie is not admin',
  isAdminRequest({ headers: {}, device: { id: 'x', name: 'iPad' } }) === false);
```

- [ ] **Step 4: Run to verify it fails**

Run: `node tests/auth.test.mjs`
Expected: FAIL — `Cannot find module '.../routes/devices.js'`

- [ ] **Step 5: Implement the route**

Create `routes/devices.js`:

```js
/**
 * GET    /api/devices      — every remembered device
 * DELETE /api/devices/:id  — revoke one
 *
 * Gated on the local admin key, NOT on a device cookie. A phone that is signed
 * in is still just a viewer: it must not be able to enumerate the other
 * devices on the tailnet, and it certainly must not be able to revoke them.
 * Only something that can read config/admin-key gets in, which means something
 * running on the host.
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
```

- [ ] **Step 6: Run to verify it passes**

Run: `node tests/auth.test.mjs`
Expected: PASS

- [ ] **Step 7: Verify by hand**

With the server running:

```bash
curl -si http://127.0.0.1:3000/api/devices | head -1
```
Expected: `HTTP/1.1 403 Forbidden`

```bash
curl -s -H "X-MediaWatcher-Key: $(cat config/admin-key)" http://127.0.0.1:3000/api/devices
```
Expected: JSON listing the device you remembered in Task 4.

- [ ] **Step 8: Commit**

```bash
git add config/index.js routes/devices.js .gitignore tests/auth.test.mjs
git commit -m "feat(auth): admin-key-gated devices API"
```

---

### Task 6: Launcher Devices tab

**Files:**
- Modify: `launcher/MainWindow.xaml`, `launcher/MediaWatcher.ps1`, `launcher/lib/ApiClient.ps1`
- Create: `launcher/tests/Devices.Tests.ps1`

**Interfaces:**
- Consumes: `GET /api/devices`, `DELETE /api/devices/:id` from Task 5.
- Produces: `Get-MwAdminKey($RootDir)`, `ConvertTo-MwDeviceSummary($Payload)`, `Get-MwDeviceList($Config)`, `Remove-MwDevice($Config, $Id)`, and a `Select-Tab 'devices'` case.

- [ ] **Step 1: Write the failing Pester test**

Create `launcher/tests/Devices.Tests.ps1`:

```powershell
BeforeAll {
  . (Join-Path $PSScriptRoot '..' 'lib' 'ApiClient.ps1')
}

Describe 'Get-MwAdminKey' {
  It 'reads the key file' {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
    New-Item -ItemType Directory -Path (Join-Path $dir 'config') -Force | Out-Null
    Set-Content -Path (Join-Path $dir 'config\admin-key') -Value ('b' * 64) -Encoding utf8 -NoNewline

    Get-MwAdminKey $dir | Should -Be ('b' * 64)
  }

  It 'returns empty when the file is absent rather than throwing' {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid())
    Get-MwAdminKey $dir | Should -Be ''
  }
}

Describe 'ConvertTo-MwDeviceSummary' {
  It 'projects rows for display' {
    $payload = [pscustomobject]@{
      devices = @(
        [pscustomobject]@{
          id = 'abc'; name = 'Aaron iPad'
          user_agent = 'Mozilla/5.0 (iPad; CPU OS 17_0) Safari/605.1'
          last_ip = '100.64.1.2'; origin = 'tailscale'
          first_seen = 1756000000000; last_seen = 1756600000000
        }
      )
    }

    $rows = ConvertTo-MwDeviceSummary $payload
    $rows.Count | Should -Be 1
    $rows[0].Name | Should -Be 'Aaron iPad'
    $rows[0].Id | Should -Be 'abc'
    $rows[0].Origin | Should -Be 'tailscale'
    $rows[0].Browser | Should -Be 'Safari'
    $rows[0].LastSeen | Should -BeOfType [datetime]
  }

  It 'returns an empty array for a null payload' {
    (ConvertTo-MwDeviceSummary $null).Count | Should -Be 0
  }

  It 'returns an empty array when no devices are remembered' {
    $payload = [pscustomobject]@{ devices = @() }
    (ConvertTo-MwDeviceSummary $payload).Count | Should -Be 0
  }

  It 'falls back to Unknown for an unrecognised user agent' {
    $payload = [pscustomobject]@{
      devices = @([pscustomobject]@{
        id = 'x'; name = 'Thing'; user_agent = 'curl/8.4.0'
        last_ip = '127.0.0.1'; origin = 'lan'
        first_seen = 1756000000000; last_seen = 1756000000000
      })
    }
    (ConvertTo-MwDeviceSummary $payload)[0].Browser | Should -Be 'Unknown'
  }

  It 'identifies Chrome before Safari, since Chrome sends both' {
    $payload = [pscustomobject]@{
      devices = @([pscustomobject]@{
        id = 'y'; name = 'PC'
        user_agent = 'Mozilla/5.0 Chrome/120.0 Safari/537.36'
        last_ip = '192.168.1.5'; origin = 'lan'
        first_seen = 1756000000000; last_seen = 1756000000000
      })
    }
    (ConvertTo-MwDeviceSummary $payload)[0].Browser | Should -Be 'Chrome'
  }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `powershell -File launcher/tests/run-tests.ps1`
Expected: FAIL — `Get-MwAdminKey` is not recognised.

- [ ] **Step 3: Implement the client functions**

Append to `launcher/lib/ApiClient.ps1`:

```powershell
function Get-MwAdminKey {
  <#
    The key the server writes on first boot. Absent means the server has not
    started yet, which is a normal state for the launcher to be in - so this
    returns empty rather than throwing and taking the window down.
  #>
  param([Parameter(Mandatory)][string]$RootDir)

  $path = Join-Path $RootDir 'config\admin-key'
  if (-not (Test-Path $path)) { return '' }
  try {
    return (Get-Content -Path $path -Raw -ErrorAction Stop).Trim()
  } catch {
    return ''
  }
}

function ConvertTo-MwDeviceSummary {
  param($Payload)

  if ($null -eq $Payload) { return ,@() }

  $rows = @()
  foreach ($row in @($Payload.devices)) {
    $ua = [string]$row.user_agent

    # Order matters: Chrome and Edge both carry "Safari" in their user agent,
    # and Edge carries "Chrome", so the most specific match has to win.
    $browser = 'Unknown'
    if ($ua -match 'Edg/') { $browser = 'Edge' }
    elseif ($ua -match 'Chrome/') { $browser = 'Chrome' }
    elseif ($ua -match 'Firefox/') { $browser = 'Firefox' }
    elseif ($ua -match 'Safari/') { $browser = 'Safari' }

    $rows += @{
      Id        = [string]$row.id
      Name      = [string]$row.name
      Browser   = $browser
      LastIp    = [string]$row.last_ip
      Origin    = [string]$row.origin
      FirstSeen = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$row.first_seen).LocalDateTime
      LastSeen  = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$row.last_seen).LocalDateTime
    }
  }
  return ,$rows
}

function Get-MwDeviceList {
  <#
    Synchronous, unlike the polling loop. The device list is only fetched on an
    explicit tab open or refresh, so a short timeout on loopback will not hang
    the window the way a background poll would.
  #>
  param([Parameter(Mandatory)][hashtable]$Config)

  $key = Get-MwAdminKey $Config.RootDir
  if (-not $key) { throw 'admin key not found - start the server once first' }

  $uri = "http://127.0.0.1:$($Config.Port)/api/devices"
  $payload = Invoke-RestMethod -Uri $uri -Method GET -TimeoutSec 5 `
    -Headers @{ 'X-MediaWatcher-Key' = $key } -UseBasicParsing -ErrorAction Stop
  return ConvertTo-MwDeviceSummary $payload
}

function Remove-MwDevice {
  param(
    [Parameter(Mandatory)][hashtable]$Config,
    [Parameter(Mandatory)][string]$Id
  )

  $key = Get-MwAdminKey $Config.RootDir
  if (-not $key) { throw 'admin key not found - start the server once first' }

  $uri = "http://127.0.0.1:$($Config.Port)/api/devices/$Id"
  Invoke-RestMethod -Uri $uri -Method DELETE -TimeoutSec 5 `
    -Headers @{ 'X-MediaWatcher-Key' = $key } -UseBasicParsing -ErrorAction Stop | Out-Null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `powershell -File launcher/tests/run-tests.ps1`
Expected: PASS, all Devices tests green.

- [ ] **Step 5: Add the tab button to the XAML**

In `launcher/MainWindow.xaml`, after the `TabDownloads` button and inside `TabStrip`:

```xml
            <Button x:Name="TabDevices" Style="{StaticResource TabButton}" Content="Devices"/>
```

- [ ] **Step 6: Add the pane to the XAML**

After the `PaneDownloads` border, still inside the same `Grid`:

```xml
        <Border x:Name="PaneDevices" Grid.Row="1" Margin="0,12,0,0" CornerRadius="8"
                Background="{StaticResource Panel}" BorderBrush="{StaticResource Border}"
                BorderThickness="1" Visibility="Collapsed">
          <Grid>
            <Grid.RowDefinitions>
              <RowDefinition Height="*"/><RowDefinition Height="Auto"/>
            </Grid.RowDefinitions>
            <TextBlock x:Name="DevicesEmpty" Grid.Row="0" Text="No devices remembered yet"
                       Foreground="#888888" FontSize="12"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
            <ScrollViewer Grid.Row="0" VerticalScrollBarVisibility="Auto" Padding="14,12">
              <StackPanel x:Name="DeviceItems"/>
            </ScrollViewer>
            <Border Grid.Row="1" BorderBrush="{StaticResource Border}" BorderThickness="0,1,0,0" Padding="14,10">
              <Button x:Name="BtnRefreshDevices" Style="{StaticResource SecondaryButton}"
                      Content="Refresh" HorizontalAlignment="Left" Padding="16,6"/>
            </Border>
          </Grid>
        </Border>
```

- [ ] **Step 7: Wire the tab**

In `launcher/MediaWatcher.ps1`, update `Select-Tab`. Change the comment on the `param` line to `# log | preflight | downloads | devices`, add `$PaneDevices.Visibility = 'Collapsed'` beside the other three, add `$TabDevices.Foreground = $dim` beside the others, and add this case to the `switch` before `default`:

```powershell
    'devices' {
      $PaneDevices.Visibility = 'Visible'
      $TabDevices.Foreground = $bright
      $TabUnderline.Width = $TabDevices.ActualWidth
      $TabUnderline.Margin = New-Object System.Windows.Thickness ($TabLog.ActualWidth + $TabPreflight.ActualWidth + $TabDownloads.ActualWidth), 0, 0, 0
      Start-PaneEntrance $PaneDevices
      Update-DeviceList
    }
```

- [ ] **Step 8: Render the rows**

Add to `launcher/MediaWatcher.ps1`, above `Select-Tab`:

```powershell
# --- devices ---------------------------------------------------------------
function New-DeviceRow {
  param([hashtable]$Device)

  $row = New-Object System.Windows.Controls.Grid
  $row.Margin = New-Object System.Windows.Thickness 0, 0, 0, 10

  $colBody = New-Object System.Windows.Controls.ColumnDefinition
  $colBody.Width = New-Object System.Windows.GridLength 1, ([System.Windows.GridUnitType]::Star)
  $colAction = New-Object System.Windows.Controls.ColumnDefinition
  $colAction.Width = New-Object System.Windows.GridLength 80
  $row.ColumnDefinitions.Add($colBody)
  $row.ColumnDefinitions.Add($colAction)

  $body = New-Object System.Windows.Controls.StackPanel
  [System.Windows.Controls.Grid]::SetColumn($body, 0)

  $name = New-Object System.Windows.Controls.TextBlock
  $name.Text = $Device.Name
  $name.Foreground = $script:LogBrushes['plain']
  $name.FontSize = 13
  $body.Children.Add($name) | Out-Null

  $where = 'LAN'
  if ($Device.Origin -eq 'tailscale') { $where = 'Tailscale' }

  $detail = New-Object System.Windows.Controls.TextBlock
  $detail.Text = "$($Device.Browser) · $where · $($Device.LastIp) · last seen $($Device.LastSeen.ToString('d MMM HH:mm'))"
  $detail.Foreground = $script:LogBrushes['debug']
  $detail.FontSize = 11
  $detail.Margin = New-Object System.Windows.Thickness 0, 2, 0, 0
  $body.Children.Add($detail) | Out-Null

  $row.Children.Add($body) | Out-Null

  $revoke = New-Object System.Windows.Controls.Button
  $revoke.Content = 'Revoke'
  $revoke.Style = $Window.FindResource('SecondaryButton')
  $revoke.FontSize = 11
  $revoke.Padding = New-Object System.Windows.Thickness 10, 4, 10, 4
  $revoke.VerticalAlignment = 'Center'
  [System.Windows.Controls.Grid]::SetColumn($revoke, 1)

  # Captured rather than read off the control, so the handler cannot be
  # confused by the list being rebuilt underneath it.
  $deviceId = $Device.Id
  $deviceName = $Device.Name
  $revoke.Add_Click({
    $answer = [System.Windows.MessageBox]::Show(
      "Revoke $deviceName? It will have to enter the password again.",
      'Revoke device', 'YesNo', 'Warning')
    if ($answer -ne 'Yes') { return }
    try {
      Remove-MwDevice $script:Config $deviceId
      Write-MwQueueNotice $script:OutputQueue "revoked device: $deviceName"
      Update-DeviceList
    } catch {
      Write-MwQueueNotice $script:OutputQueue "revoke failed: $($_.Exception.Message)"
    }
  }.GetNewClosure())

  $row.Children.Add($revoke) | Out-Null
  return $row
}

function Update-DeviceList {
  $DeviceItems.Children.Clear()

  $devices = @()
  try {
    $devices = @(Get-MwDeviceList $script:Config)
  } catch {
    Write-MwQueueNotice $script:OutputQueue "device list unavailable: $($_.Exception.Message)"
  }

  if ($devices.Count -eq 0) {
    $DevicesEmpty.Visibility = 'Visible'
    return
  }

  $DevicesEmpty.Visibility = 'Collapsed'
  foreach ($device in $devices) {
    $DeviceItems.Children.Add((New-DeviceRow $device)) | Out-Null
  }
}
```

Then register the handlers beside the existing tab clicks:

```powershell
$TabDevices.Add_Click({ Select-Tab 'devices' })
$BtnRefreshDevices.Add_Click({ Update-DeviceList })
```

- [ ] **Step 9: Verify by hand**

Run `launcher/MediaWatcher.ps1`, start the server, open the Devices tab.
Expected: the device you remembered in Task 4 is listed with its name, browser, LAN origin and last-seen time. Click Revoke, confirm, and the row disappears. Reload the browser tab.
Expected: bounced back to the gate.

- [ ] **Step 10: Commit**

```bash
git add launcher/ 
git commit -m "feat(launcher): devices tab to audit and revoke remembered devices"
```

---

### Task 7: Network origin detection

**Files:**
- Create: `services/network.js`
- Create: `tests/remote-quality.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `isTailscaleAddress(ip) -> boolean`, `classifyOrigin(ip) -> 'lan' | 'tailscale'`.

> If `services/network.js` was already stubbed during Task 3, replace it wholesale with the version below and keep the tests.

- [ ] **Step 1: Write the failing test**

Create `tests/remote-quality.test.mjs`:

```js
/**
 * Remote detection and the quality ladder.
 *
 * Run: node tests/remote-quality.test.mjs
 */
import { isTailscaleAddress, classifyOrigin } from '../services/network.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ntailscale address detection');
// 100.64.0.0/10 spans 100.64.x.x through 100.127.x.x.
check('100.64.0.1 is tailscale', isTailscaleAddress('100.64.0.1') === true);
check('100.101.102.103 is tailscale', isTailscaleAddress('100.101.102.103') === true);
check('100.127.255.254 is the top of the range', isTailscaleAddress('100.127.255.254') === true);
check('100.63.255.255 is below the range', isTailscaleAddress('100.63.255.255') === false);
check('100.128.0.0 is above the range', isTailscaleAddress('100.128.0.0') === false);

check('a LAN address is not tailscale', isTailscaleAddress('192.168.1.20') === false);
check('loopback is not tailscale', isTailscaleAddress('127.0.0.1') === false);
check('a 10.x address is not tailscale', isTailscaleAddress('10.0.0.5') === false);
check('a public address is not tailscale', isTailscaleAddress('8.8.8.8') === false);

// Express reports loopback as ::ffff:127.0.0.1 on a dual-stack listener, and
// the same mapping applies to any forwarded v4 address.
check('an IPv4-mapped IPv6 tailscale address is detected',
  isTailscaleAddress('::ffff:100.90.1.1') === true);
check('an IPv4-mapped loopback is not tailscale',
  isTailscaleAddress('::ffff:127.0.0.1') === false);

check('null is not tailscale', isTailscaleAddress(null) === false);
check('undefined is not tailscale', isTailscaleAddress(undefined) === false);
check('nonsense is not tailscale', isTailscaleAddress('not-an-ip') === false);
check('a partial address is not tailscale', isTailscaleAddress('100.64') === false);
// Octet bounds must be enforced or 100.999.0.1 would parse as in-range.
check('an out-of-range octet is rejected', isTailscaleAddress('100.999.0.1') === false);

console.log('\norigin classification');
check('tailscale addresses classify as tailscale',
  classifyOrigin('100.100.1.1') === 'tailscale');
check('LAN addresses classify as lan', classifyOrigin('192.168.1.20') === 'lan');
check('loopback classifies as lan', classifyOrigin('127.0.0.1') === 'lan');
check('an unknown address classifies as lan', classifyOrigin(null) === 'lan');

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/remote-quality.test.mjs`
Expected: FAIL — `Cannot find module '.../services/network.js'`

- [ ] **Step 3: Implement**

Create `services/network.js`:

```js
/**
 * Where a request came from.
 *
 * Tailscale hands every node an address in 100.64.0.0/10 (the CGNAT range), so
 * that is what separates "on the sofa" from "in a hotel". This is only reliable
 * because server.js sets trust proxy to loopback: without it every tunnelled
 * request reports as 127.0.0.1 and everything below answers 'lan'.
 */

/** 100.64.0.0/10 == 100.64.0.0 through 100.127.255.255. */
const TAILSCALE_SECOND_OCTET_MIN = 64;
const TAILSCALE_SECOND_OCTET_MAX = 127;

export function isTailscaleAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false;

  // Express reports IPv4 over a dual-stack listener as ::ffff:a.b.c.d.
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  const octets = bare.split('.');
  if (octets.length !== 4) return false;

  const parsed = octets.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;

  return parsed[0] === 100
    && parsed[1] >= TAILSCALE_SECOND_OCTET_MIN
    && parsed[1] <= TAILSCALE_SECOND_OCTET_MAX;
}

/**
 * Anything not on the tailnet is treated as local. Erring towards 'lan' means
 * an unrecognised address gets full quality rather than being throttled, which
 * is the harmless direction to be wrong in on a home network.
 */
export const classifyOrigin = (ip) => (isTailscaleAddress(ip) ? 'tailscale' : 'lan');

export default { isTailscaleAddress, classifyOrigin };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/remote-quality.test.mjs`
Expected: PASS, `20/20 passed`

- [ ] **Step 5: Add to the test chain and commit**

Append ` && node tests/remote-quality.test.mjs` to the `test` script.

```bash
git add services/network.js tests/remote-quality.test.mjs package.json
git commit -m "feat(stream): detect tailnet clients by CGNAT range"
```

---

### Task 8: Quality ladder

**Files:**
- Create: `services/quality.js`
- Modify: `config/index.js`, `services/transcoder.js`, `tests/remote-quality.test.mjs`, `.env.example`

**Interfaces:**
- Consumes: `classifyOrigin` from Task 7.
- Produces: `parseBitrate(str) -> number|null` (bits per second), `LEVELS` (object keyed by level name), `resolveQuality(requested, origin) -> { level, height, maxrate }`, and `decide(info, caps, { audioOffset, quality })` gaining cap behaviour; `buildArgs(filePath, { ..., maxHeight, maxrate })`.

- [ ] **Step 1: Add the config block**

In `config/index.js`, inside the `config` object after the `ffmpeg` block:

```js
  // Remote playback caps. The host serves at ~800 Mbps symmetric, so none of
  // this protects the server - it protects a client on hotel wifi or cellular,
  // and it is why Auto never picks Original over the tunnel.
  remote: {
    defaultLevel: str('REMOTE_DEFAULT_QUALITY', 'high'),
    levels: {
      original: { height: null, maxrate: null },
      high: { height: int('QUALITY_HIGH_HEIGHT', 1080), maxrate: str('QUALITY_HIGH_MAXRATE', '12M') },
      medium: { height: int('QUALITY_MEDIUM_HEIGHT', 720), maxrate: str('QUALITY_MEDIUM_MAXRATE', '5M') },
      low: { height: int('QUALITY_LOW_HEIGHT', 480), maxrate: str('QUALITY_LOW_MAXRATE', '1.5M') }
    }
  },
```

Add to `.env.example`:

```
# Quality applied when a device connects over Tailscale rather than the LAN.
# original | high | medium | low
REMOTE_DEFAULT_QUALITY=high
QUALITY_HIGH_HEIGHT=1080
QUALITY_HIGH_MAXRATE=12M
QUALITY_MEDIUM_HEIGHT=720
QUALITY_MEDIUM_MAXRATE=5M
QUALITY_LOW_HEIGHT=480
QUALITY_LOW_MAXRATE=1.5M
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/remote-quality.test.mjs` before the summary:

```js
import { parseBitrate, resolveQuality, LEVELS } from '../services/quality.js';
import { decide, buildArgs } from '../services/transcoder.js';

console.log('\nbitrate parsing');
check('plain digits are bits per second', parseBitrate('800000') === 800000);
check('M means megabits', parseBitrate('12M') === 12000000);
check('a fractional M works', parseBitrate('1.5M') === 1500000);
check('K means kilobits', parseBitrate('800K') === 800000);
check('lowercase is accepted', parseBitrate('12m') === 12000000);
check('null parses to null', parseBitrate(null) === null);
check('nonsense parses to null', parseBitrate('fast') === null);

console.log('\nquality resolution');
check('auto on the LAN is original', resolveQuality('auto', 'lan').level === 'original');
// The host can serve more than any client will pull, so the remote default is
// High rather than a defensive Medium.
check('auto over tailscale is high', resolveQuality('auto', 'tailscale').level === 'high');
check('an explicit level wins over auto',
  resolveQuality('low', 'tailscale').level === 'low');
check('an explicit level wins on the LAN too',
  resolveQuality('medium', 'lan').level === 'medium');
check('original explicitly over tailscale is honoured',
  resolveQuality('original', 'tailscale').level === 'original');
check('an unknown level falls back to auto behaviour',
  resolveQuality('ludicrous', 'tailscale').level === 'high');
check('a missing level falls back to auto behaviour',
  resolveQuality(undefined, 'lan').level === 'original');
check('original carries no height cap', resolveQuality('original', 'lan').height === null);
check('high caps at 1080', resolveQuality('high', 'tailscale').height === 1080);
check('low caps at 480', LEVELS.low.height === 480);

console.log('\ncapped decisions');
const mp4_1080 = {
  container: '.mp4', duration: 100, bitrate: 5_000_000,
  video: { codec: 'h264', width: 1920, height: 1080, transfer: 'bt709' },
  audio: [{ index: 0, codec: 'aac', default: true }],
  subtitles: []
};
const mkv_4k_hdr = {
  container: '.mkv', duration: 100, bitrate: 80_000_000,
  video: { codec: 'hevc', width: 3840, height: 2160, transfer: 'smpte2084' },
  audio: [{ index: 0, codec: 'eac3', default: true }],
  subtitles: []
};

const uncapped = decide(mp4_1080, {}, {});
check('an untouched 1080p mp4 still plays direct', uncapped.mode === 'direct');

const capped = decide(mp4_1080, {}, { quality: resolveQuality('low', 'tailscale') });
check('a cap forces a direct file to transcode', capped.mode === 'transcode');
check('the cap sets the target height', capped.targetHeight === 480);
check('the cap sets a maxrate', capped.maxrate === '1.5M');
check('a capped stream is not lossless', capped.lossless === false);
check('a capped stream is not seekable', capped.seekable === false);
check('the cap explains itself',
  capped.reasons.some((r) => /quality|cap/i.test(r)));

// Under the cap there is nothing to gain by re-encoding.
const underCap = decide(mp4_1080, {}, { quality: resolveQuality('high', 'tailscale') });
check('a source already under the cap is left direct', underCap.mode === 'direct');

// Bitrate alone must trigger the cap: a 720p file at 40 Mbps is under the
// height limit and still far too fat for a hotel connection.
const fat720 = { ...mp4_1080, bitrate: 40_000_000,
  video: { codec: 'h264', width: 1280, height: 720, transfer: 'bt709' } };
const fatCapped = decide(fat720, {}, { quality: resolveQuality('high', 'tailscale') });
check('an over-bitrate source is capped even when short enough',
  fatCapped.mode === 'transcode');

// HDR already forces a transcode; the cap must tighten the height, not fight it.
const hdrCapped = decide(mkv_4k_hdr, {}, { quality: resolveQuality('medium', 'tailscale') });
check('HDR under a cap still transcodes', hdrCapped.mode === 'transcode');
check('HDR is still tone mapped under a cap', hdrCapped.tonemapped === true);
check('the cap wins over the default tonemap height', hdrCapped.targetHeight === 720);

console.log('\ncapped ffmpeg arguments');
const args = buildArgs('C:\\lib\\movie.mkv', {
  mode: 'transcode', maxHeight: 720, maxrate: '5M'
});
check('a scale filter is applied', args.join(' ').includes('scale=-2:720'));
check('the maxrate is passed to the encoder', args.includes('5M'));
check('bufsize accompanies maxrate', args.includes('-bufsize'));

const tonemapArgs = buildArgs('C:\\lib\\movie.mkv', {
  mode: 'transcode', tonemap: true, height: 2160, maxHeight: 720, maxrate: '5M'
});
const chain = tonemapArgs[tonemapArgs.indexOf('-vf') + 1];
check('the tone map chain scales to the cap, not to 1080',
  chain.includes('scale=-2:720'));
check('only one scale step is emitted',
  (chain.match(/scale=/g) || []).length === 1);
```

- [ ] **Step 3: Run to verify it fails**

Run: `node tests/remote-quality.test.mjs`
Expected: FAIL — `Cannot find module '.../services/quality.js'`

- [ ] **Step 4: Implement the ladder**

Create `services/quality.js`:

```js
/**
 * The remote quality ladder.
 *
 * The host uplink is not the constraint here - it is symmetric and fast. What
 * this protects is the far end: hotel wifi, cellular, and Tailscale's DERP
 * relay fallback when a direct peer-to-peer connection cannot be established.
 */
import config from '../config/index.js';

export const LEVELS = config.remote.levels;

/** "12M" -> 12000000. Returns null for anything unparseable. */
export function parseBitrate(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(String(value).trim());
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2].toLowerCase();
  if (unit === 'm') return Math.round(amount * 1_000_000);
  if (unit === 'k') return Math.round(amount * 1_000);
  return Math.round(amount);
}

/**
 * Turn a requested level and a connection origin into a concrete cap.
 *
 * Auto deliberately never resolves to Original over the tunnel even though the
 * host could serve it: a 4K remux runs 60-100 Mbps, past most client links,
 * and shipping tens of gigabytes over a possibly-metered connection is not
 * something to do without being asked. Original stays available by request.
 */
export function resolveQuality(requested, origin) {
  const asked = String(requested || 'auto').toLowerCase();

  const level = Object.prototype.hasOwnProperty.call(LEVELS, asked)
    ? asked
    : (origin === 'tailscale' ? config.remote.defaultLevel : 'original');

  const resolved = LEVELS[level] || LEVELS.original;
  return { level, height: resolved.height, maxrate: resolved.maxrate };
}

export default { LEVELS, parseBitrate, resolveQuality };
```

- [ ] **Step 5: Teach decide() about caps**

In `services/transcoder.js`, add the import:

```js
import { parseBitrate } from './quality.js';
```

In `decide()`, immediately before the `if (mode === 'direct') reasons.push(...)` line:

```js
  /*
   * A quality cap has to be able to overrule every cheaper path. direct and
   * remux both copy the video stream untouched, so neither can shrink a 4K
   * remux down to something a hotel connection will carry - only a re-encode
   * can. This is the one place that decision belongs, which is why it sits
   * here rather than in the stream route.
   */
  const cap = options.quality || null;
  let targetHeight = null;
  let maxrate = null;

  if (cap && (cap.height || cap.maxrate)) {
    const sourceHeight = info.video?.height ?? null;
    const capBits = parseBitrate(cap.maxrate);

    const tooTall = Boolean(cap.height) && Number.isFinite(sourceHeight) && sourceHeight > cap.height;
    // Container bitrate, so it counts audio too - which is the right number,
    // since that is what actually has to cross the link.
    const tooFat = Boolean(capBits) && Number.isFinite(info.bitrate) && info.bitrate > capBits;

    if (tooTall || tooFat) {
      mode = 'transcode';
      targetHeight = cap.height;
      maxrate = cap.maxrate;
      reasons.push(tooTall
        ? `capped to ${cap.height}p for this connection (source is ${sourceHeight}p)`
        : `capped to ${cap.maxrate} for this connection`);
    }
  }
```

Then extend the returned object. Replace the existing `tonemapHeight` property and add the two new ones:

```js
    lossless: mode !== 'transcode',
    hdr,
    tonemapped: hdr,
    // The active cap wins over the default tone map ceiling: both are height
    // limits, and the tighter one is the one that has to apply.
    tonemapHeight: targetHeight
      ?? (hdr && Number.isFinite(info.video?.height) && info.video.height > TONEMAP_MAX_HEIGHT
        ? TONEMAP_MAX_HEIGHT
        : (info.video?.height ?? null)),
    targetHeight,
    maxrate
```

- [ ] **Step 6: Teach buildArgs about caps**

In `services/transcoder.js`, change the `buildArgs` signature:

```js
export function buildArgs(filePath, {
  mode, startSeconds = 0, audioIndex = 0, audioOffset = 0,
  tonemap = false, height = null, encoder = null,
  maxHeight = null, maxrate = null
}) {
```

Inside the `if (mode === 'transcode')` branch, replace the filter line and both `-maxrate` uses:

```js
    if (tonemap) {
      // tonemapChain already emits a scale step, so the cap is handed to it
      // rather than added separately - two scale filters would be wasteful and
      // the second would fight the first.
      args.push('-vf', tonemapChain(height, maxHeight ?? TONEMAP_MAX_HEIGHT));
    } else if (maxHeight) {
      // -2 keeps the width even, which H.264 requires.
      args.push('-vf', `scale=-2:${maxHeight}`);
    }

    const rate = maxrate || config.ffmpeg.videoMaxrate;

    if (encoder) {
      args.push('-c:v', encoder);
      if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf));
      else args.push('-global_quality', String(config.ffmpeg.videoCrf));
      args.push('-maxrate', rate, '-bufsize', '24M');
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', config.ffmpeg.videoPreset,
        '-crf', String(config.ffmpeg.videoCrf),
        '-maxrate', rate,
        '-bufsize', '24M'
      );
    }
```

- [ ] **Step 7: Run to verify it passes**

Run: `node tests/remote-quality.test.mjs`
Expected: PASS

- [ ] **Step 8: Run the whole suite for regressions**

Run: `npm test`
Expected: every suite passes. `tonemap.test.mjs` exercises `tonemapChain` directly and must be unaffected.

- [ ] **Step 9: Commit**

```bash
git add services/quality.js services/transcoder.js config/index.js tests/remote-quality.test.mjs .env.example
git commit -m "feat(stream): quality ladder and capped transcode decisions"
```

---

### Task 9: Apply quality in the stream route

**Files:**
- Modify: `routes/stream.js`

**Interfaces:**
- Consumes: `resolveQuality` (Task 8), `classifyOrigin` (Task 7).
- Produces: `?q=` handling on both `/api/stream` and `/api/stream/info`; `quality` and `origin` added to the `/info` JSON response.

- [ ] **Step 1: Add the imports**

In `routes/stream.js`:

```js
import { resolveQuality } from '../services/quality.js';
import { classifyOrigin } from '../services/network.js';
```

- [ ] **Step 2: Add a per-request resolver**

Beside the existing `capsFrom` helper:

```js
/** The cap this request should play under, from ?q= and where it came from. */
const qualityFrom = (req) => resolveQuality(req.query.q, classifyOrigin(req.ip));
```

- [ ] **Step 3: Apply it in /info**

In the `/info` handler, replace the `decision` line and guard the cache:

```js
    const quality = qualityFrom(req);
    const info = await transcoder.probe(resolved.filePath);
    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    /*
     * A cached MP4 is full quality, so it cannot answer a capped request - it
     * would silently serve the 4K file to a phone on cellular. Capped playback
     * goes through the pipe instead, and gives up native seeking to do it.
     */
    const capped = decision.mode === 'transcode' && Boolean(decision.targetHeight || decision.maxrate);
    const variant = mp4cache.pickVariant(info?.video, caps);
    const cached = (audioOffset === 0 && !capped)
      ? mp4cache.readyVariant(resolved.filePath, variant)
      : null;
```

And change the `else if` that warms the cache so it does not warm on capped requests:

```js
    } else if (audioOffset === 0 && !capped) {
      mp4cache.ensureVariant(resolved.filePath, variant).catch(() => {});
    }
```

Add to the `res.json({...})` payload:

```js
      quality: decision.targetHeight || decision.maxrate ? quality.level : 'original',
      origin: classifyOrigin(req.ip),
```

- [ ] **Step 4: Apply it in the stream handler**

In the `router.get('/')` handler, replace the body from the `?mode=direct` escape hatch down to the ffmpeg call:

```js
    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
    const quality = qualityFrom(req);

    // ?mode=direct serves raw bytes - but it must not be a way around the cap,
    // and an audio offset needs ffmpeg, so neither can be honoured alongside it.
    const uncapped = !quality.height && !quality.maxrate;
    if (req.query.mode === 'direct' && audioOffset === 0 && uncapped) {
      return streamBytes(req, res, filePath, stats.size);
    }

    const info = await transcoder.probe(filePath);
    const caps = capsFrom(req);
    const decision = transcoder.decide(info, caps, { audioOffset, quality });

    if (decision.mode === 'direct') {
      return streamBytes(req, res, filePath, stats.size);
    }

    const capped = Boolean(decision.targetHeight || decision.maxrate);

    if (audioOffset === 0 && !capped) {
      const variant = mp4cache.pickVariant(info?.video, caps);
      const cachedPath = mp4cache.readyVariant(filePath, variant);
      if (cachedPath) {
        const cachedStats = fs.statSync(cachedPath);
        return streamBytes(req, res, cachedPath, cachedStats.size, `cached-${variant}`);
      }
      mp4cache.ensureVariant(filePath, variant).catch(() => {});
    }

    log.info(`${decision.mode}: ${path.basename(filePath)} — ${decision.reasons.join('; ')}`);
    return await streamViaFfmpeg(req, res, filePath, decision);
```

- [ ] **Step 5: Pass the cap through to ffmpeg**

In `streamViaFfmpeg`, change the encoder line and the `openStream` options:

```js
  // Capped streams re-encode every frame, exactly like tone mapping does, so
  // the same argument for spending a GPU on it applies.
  const needsEncoder = decision.tonemapped || Boolean(decision.targetHeight || decision.maxrate);
  const encoder = needsEncoder ? await transcoder.hardwareEncoder() : null;
```

```js
  const { stream, kill } = transcoder.openStream(filePath, {
    mode: decision.mode,
    startSeconds,
    audioIndex,
    audioOffset,
    tonemap: Boolean(decision.tonemapped),
    height: decision.video?.height ?? null,
    maxHeight: decision.targetHeight,
    maxrate: decision.maxrate,
    encoder
  });
```

- [ ] **Step 6: Verify by hand**

With the server running and a 1080p+ file in the library:

```bash
curl -s "http://127.0.0.1:3000/api/stream/info?path=<abs-path>&q=low" \
  -H "Cookie: mw_device=<token from DevTools>" | head -20
```
Expected: `"mode":"transcode"` and `"quality":"low"`.

Same call with `q=original`.
Expected: `"mode":"direct"` (or `cached-*`), `"quality":"original"`.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test` — expected: all pass.

```bash
git add routes/stream.js
git commit -m "feat(stream): apply the quality cap per request and bypass the MP4 cache when capped"
```

---

### Task 10: Player quality picker

**Files:**
- Modify: `public/js/api.js`, `public/js/player.js`

**Interfaces:**
- Consumes: `?q=` from Task 9.
- Produces: `api.getQuality()`, `api.setQuality(level)`; `q` on `streamUrl` and `getStreamInfo`.

- [ ] **Step 1: Store and send the level**

In `public/js/api.js`, above `getStreamInfo`:

```js
/*
 * Per device, not per account: the right quality is a property of the
 * connection you are on, and this is the same reason it is remembered in
 * localStorage rather than the database.
 */
const QUALITY_KEY = 'mw.quality';
const QUALITY_LEVELS = ['auto', 'original', 'high', 'medium', 'low'];

export function getQuality() {
  try {
    const stored = localStorage.getItem(QUALITY_KEY);
    return QUALITY_LEVELS.includes(stored) ? stored : 'auto';
  } catch {
    // Private mode and some embedded webviews throw on access.
    return 'auto';
  }
}

export function setQuality(level) {
  if (!QUALITY_LEVELS.includes(level)) return;
  try { localStorage.setItem(QUALITY_KEY, level); } catch { /* not fatal */ }
}
```

Then add `q: getQuality()` to the query object in both `getStreamInfo` and `streamUrl`, and add `getQuality, setQuality, QUALITY_LEVELS` to the default export.

- [ ] **Step 2: Add the control**

In `public/js/player.js`, find where the settings/controls row is built and add a select. Match the surrounding construction style rather than copying this verbatim if the file builds elements differently:

```js
function buildQualityPicker(ctx) {
  const wrap = document.createElement('label');
  wrap.className = 'player__setting';

  const label = document.createElement('span');
  label.textContent = 'Quality';
  wrap.appendChild(label);

  const select = document.createElement('select');
  select.className = 'player__select';
  for (const [value, text] of [
    ['auto', 'Auto'],
    ['original', 'Original'],
    ['high', 'High (1080p)'],
    ['medium', 'Medium (720p)'],
    ['low', 'Low (480p)']
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  select.value = api.getQuality();

  select.addEventListener('change', () => {
    api.setQuality(select.value);
    // The cap lives in the ffmpeg command, so a change only takes effect on a
    // new stream. Reopening at the current position is the least surprising
    // way to apply it.
    const at = ctx.video.currentTime + (ctx.offset || 0);
    ctx.offset = at;
    ctx.video.src = api.streamUrl(ctx.filePath, { start: at, audioOffset: ctx.audioOffset });
    ctx.video.play().catch(() => {});
  });

  wrap.appendChild(select);
  return wrap;
}
```

- [ ] **Step 3: Verify by hand**

Play a 4K or high-bitrate file on the LAN, open the quality picker, choose Low.
Expected: playback restarts at the same position, visibly softer, and the server log shows `transcode: ... capped to 480p`.

Switch back to Auto on the LAN.
Expected: the log shows `direct` or `cached-*` again.

- [ ] **Step 4: Commit**

```bash
git add public/js/api.js public/js/player.js
git commit -m "feat(player): quality picker remembered per device"
```

---

### Task 11: Tailscale and end-to-end verification

**Files:**
- Modify: `README.md`, `.env`

**Interfaces:** none — this task sets up the tunnel and proves the whole thing works.

- [ ] **Step 1: Install Tailscale on the host**

Download from https://tailscale.com/download/windows, install, sign in. Then confirm:

```powershell
tailscale ip -4
```
Expected: an address in `100.64.x.x`–`100.127.x.x`.

- [ ] **Step 2: Enable MagicDNS and HTTPS**

In the admin console at https://login.tailscale.com/admin/dns, enable **MagicDNS** and **HTTPS Certificates**. Both are required — without them `tailscale serve` has no certificate and iOS Safari will not treat the origin as secure.

- [ ] **Step 3: Publish the server**

```powershell
tailscale serve --bg 3000
tailscale serve status
```
Expected: a mapping from `https://<machine>.<tailnet>.ts.net` to `http://127.0.0.1:3000`.

- [ ] **Step 4: Record the hostname**

Put the hostname from the previous step into `.env`:

```
TAILNET_HOST=<machine>.<tailnet>.ts.net
```

Restart the server so CORS accepts that origin.

- [ ] **Step 5: Verify the gate over the tunnel**

Install Tailscale on the iPad from the App Store, sign into the same account, then open `https://<machine>.<tailnet>.ts.net`.

Expected, in order:
1. The gate appears — not the library.
2. A wrong password is rejected.
3. The correct password with "Remember this device" checked lands on the library.
4. In the launcher's Devices tab the new row shows origin **Tailscale** and a `100.x` address. This is the proof that `trust proxy` is working; if it says LAN with `127.0.0.1`, that setting is wrong.

- [ ] **Step 6: Verify the cap over the tunnel**

Play a 4K or high-bitrate file on the iPad with quality on Auto.
Expected: the server log reports `transcode: ... capped to 1080p`, not `direct`.

Set the picker to Original.
Expected: the log reports `direct` or `cached-*`.

- [ ] **Step 7: Verify revocation over the tunnel**

Revoke the iPad from the launcher, then interact with the iPad.
Expected: the next request bounces to the gate.

- [ ] **Step 8: Confirm the server is still not exposed**

From another machine on the LAN that is **not** on the tailnet:

```bash
curl -m 5 -si http://<host-lan-ip>:3000/
```
Expected: connection refused or timeout. The bind is still loopback-only and Tailscale is the only way in.

- [ ] **Step 9: Document it**

Add a "Remote access" section to `README.md` covering: the three `.env` keys (`AUTH_PASSWORD`, `TAILNET_HOST`, `REMOTE_DEFAULT_QUALITY`), the `tailscale serve --bg 3000` command, the fact that `tailscale serve` must be re-run after a Tailscale upgrade resets it, where the device list lives in the launcher, and that `config/admin-key` is machine-local and must never be committed.

- [ ] **Step 10: Commit**

```bash
git add README.md
git commit -m "docs: remote access setup"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Tailscale install, MagicDNS, `serve` | 11 |
| `trust proxy`, tailnet CORS origin | 3 (config), 11 (value) |
| `devices` schema | 1 |
| Token not fingerprint | 2 |
| `AUTH_PASSWORD`, startup refusal | 2 |
| Login flow, remember vs session | 2 (primitives), 3 (route), 4 (page) |
| Per-request `Secure` cookie | 3 |
| Rate limiting | 2 |
| `requireAuth` + allowlist | 3 |
| Loopback trap + regression test | 3 |
| Admin key | 5 |
| Devices API, admin-key gated | 5 |
| Launcher Devices tab | 6 |
| CGNAT detection | 7 |
| Quality ladder + Auto | 8 |
| `decide()` / `buildArgs` integration | 8 |
| HDR composes with the cap | 8 |
| MP4 cache bypass when capped | 9 |
| Hardware encoder for capped streams | 9 |
| Player picker, localStorage | 10 |
| Test files named in the spec | 1, 3, 7, 8 (all three created) |
| Rollout order (auth before tunnel) | Tasks 1–6 precede 11 |

No gaps.

**Naming consistency check:** `tokenHash` is camelCase in every JS signature and `token_hash` only as a SQLite column; `classifyOrigin` returns the same `'lan'`/`'tailscale'` strings consumed by `resolveQuality` and rendered by the launcher; `decision.targetHeight`/`decision.maxrate` are produced in Task 8 and consumed under those exact names in Task 9; `buildArgs` takes `maxHeight`/`maxrate` in both. `COOKIE_NAME` is `'mw_device'` in `services/auth.js` and in the Task 3 test.

**Ordering note:** `middleware/requireAuth.js` (Task 3) imports `services/network.js` (Task 7). Task 3 Step 4 says to create that file early if it is not yet present. Executing tasks in order is fine; executing Task 3 in isolation needs that stub.
