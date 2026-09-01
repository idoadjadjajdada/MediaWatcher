# Remote access: Tailscale, device authentication, and remote quality

Date: 2026-09-01

## Problem

MediaWatcher binds to `127.0.0.1:3000` and has no authentication of any kind.
It is reachable only from the machine it runs on. The goal is to reach it from
an iPad (and any other personal device) from anywhere, without port forwarding,
without exposing the library to the public internet, and without saturating a
residential uplink when streaming a 4K remux over cellular.

Three pieces, built together because they interact:

1. **Transport** — Tailscale, so devices reach the server over a private mesh.
2. **Authentication** — a shared password plus remembered devices, so a leaked
   tunnel URL is not enough to watch anything.
3. **Remote quality** — bitrate and resolution caps applied when the request
   arrives over the tunnel rather than the LAN.

## Non-goals

- Per-person user accounts. One shared password; devices are named, not owned.
- Public internet exposure (Cloudflare Tunnel, Tailscale Funnel, reverse proxy).
- Per-quality MP4 caching. See "Accepted tradeoffs".
- Approval-before-access for new devices. The password admits; the launcher revokes.

## Transport: Tailscale

Tailscale is installed on the Windows host and on each client device, all signed
into the same tailnet. MagicDNS and HTTPS certificates must be enabled in the
tailnet admin console — without both there is no valid certificate, and iOS
Safari gates several video and secure-context behaviours behind one.

    tailscale serve --bg 3000

This publishes `https://<machine>.<tailnet>.ts.net` and proxies to
`127.0.0.1:3000`.

`config.host` stays `127.0.0.1`. The server never listens on the LAN or on a
public interface; Tailscale reaches it over loopback. This is deliberate — the
existing bind is the last line of defence if the auth layer ever regresses.

### Server changes forced by the proxy

- `app.set('trust proxy', 'loopback')` so `req.ip` resolves the real client from
  `X-Forwarded-For`. Without it every remote request reads as `127.0.0.1`.
- `LOCALHOST_ORIGIN` (`server.js:67`) rejects any non-localhost origin. It must
  also accept the tailnet hostname, supplied by config rather than hardcoded.
- Helmet CSP needs no change: every directive is already `'self'`, which follows
  the origin.

## Authentication

### Device identity: server-issued token, not browser fingerprint

A device is identified by an opaque 256-bit token the server mints, not by a
hash of its browser characteristics. Two reasons, both decisive:

**A fingerprint is not a secret.** It is a description of a device, and anything
describable is forgeable. An attacker who knows the shape of an authorized
device can present that shape. A random token is unguessable, so it is a real
credential.

**The `<video>` element cannot carry a header.** Playback in `routes/stream.js`
is driven by `<video src="/api/stream?path=...">`, which issues its own range
requests with no JavaScript in the loop. It cannot attach an `Authorization`
header and cannot compute a fingerprint. A cookie is attached automatically.
A cookie-borne token is therefore the only mechanism that authenticates the
stream path without restructuring playback.

Accepted cost: clearing website data on a device drops the cookie and requires
re-entering the password. This is correct behaviour and is rare.

### Schema

Appended to `db/schema.sql`, following the existing all-`IF NOT EXISTS`
convention so it doubles as the migration:

```sql
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,        -- uuid, the launcher's handle on the row
  token_hash   TEXT NOT NULL UNIQUE,    -- sha256 of the cookie value
  name         TEXT NOT NULL,           -- user-supplied, e.g. "Aaron iPad"
  user_agent   TEXT,
  last_ip      TEXT,
  origin       TEXT,                    -- 'lan' | 'tailscale', rewritten each request
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen DESC);
```

Only the hash is stored. A leaked database file yields no working credential.

### Password

`AUTH_PASSWORD` in `.env`, compared with `crypto.timingSafeEqual`.

Plaintext in `.env` is consistent with the existing security posture: that file
already holds `TMDB_API_KEY` and `ALLDEBRID_API_KEY`, which are comparably
sensitive, and it is gitignored. Storing a hash instead would add a
password-setting flow without changing who can read the file.

The server refuses to start if `AUTH_PASSWORD` is unset or shorter than 8
characters. Booting an unauthenticated server behind a tunnel is the worst
failure mode available here, so it fails loudly rather than defaulting open.

### Login flow

`POST /api/auth/login` with `{ password, deviceName, remember }`.

- Wrong password: 401, and the attempt is recorded against the client IP.
- Correct, `remember: true`: mint 32 random bytes, insert a `devices` row keyed
  by the SHA-256 of the token, set a persistent cookie.
- Correct, `remember: false`: same cookie, but session-scoped (no `Max-Age`) and
  recorded only in an in-memory set of token hashes rather than in `devices`.
  Closing the browser ends the session; so does restarting the server.

`requireAuth` therefore resolves a token against two stores: the `devices`
table first, then the in-memory session set. Unremembered devices deliberately
never reach the launcher list — they hold no persistent credential, so there is
nothing to audit or revoke.

Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` set
**per request** according to whether the connection arrived over TLS.
Hardcoding `Secure` would break plain `http://localhost:3000` on the host
machine, where the browser withholds secure cookies.

Failed attempts are rate limited per IP with in-memory exponential backoff. No
new dependency. A tunnel is long-lived and quiet, so an unthrottled password
endpoint is brute-forceable given time.

### Middleware

`requireAuth` mounts ahead of `express.static` and every `/api` router.
Allowlist: the login page and its assets, `POST /api/auth/login`, and
`GET /api/health`.

Each request hashes the cookie and resolves it against the device table, then
the session set. A resolved device row has its `last_seen`, `last_ip` and
`origin` refreshed, which is what keeps the launcher list current. A revoked row
means the next request from that device fails — revocation is immediate, with no
session cache to expire.

### The loopback trap

Loopback must **not** bypass authentication.

`tailscale serve` terminates TLS and proxies to `127.0.0.1:3000`, so every
remote request arrives at Express appearing to originate from loopback. A
"requests from 127.0.0.1 are trusted" shortcut would therefore disable
authentication for precisely the traffic this design exists to protect. It
would look correct in local testing and be wide open in production.

This gets an explicit regression test.

### Launcher access: local admin key

Because there is no loopback bypass, the launcher authenticates explicitly.

On first boot the server generates 32 random bytes into `config/admin-key`
(gitignored, never transmitted). `launcher/lib/ApiClient.ps1` reads the file and
sends it as `X-MediaWatcher-Key`.

`GET /api/devices` and `DELETE /api/devices/:id` require **the admin key
specifically** — a valid device cookie is not sufficient. A logged-in iPad
therefore cannot enumerate or revoke devices; only code running on the host can.

## Launcher: Devices tab

A fourth tab beside Log / Preflight / Downloads, reusing the existing
`TabButton` style and the `TabUnderline` animation in `MainWindow.xaml`.

One row per device: name, browser (parsed from user agent), last seen, last IP,
origin badge (LAN / Tailscale), and a Revoke button. Refreshes on tab
activation. Revoke confirms, calls `DELETE`, and reloads the list.

This is the audit surface: every row is a live credential and the list is
complete, so anything unfamiliar can be killed on sight.

## Remote quality

### Detecting remote

Tailscale assigns addresses in `100.64.0.0/10`. A request whose resolved
`req.ip` falls in that range is remote; anything else is LAN. This fills the
`origin` column and drives `Auto` quality.

### Ladder

Configurable via `.env` so it can be tuned to the actual uplink. Defaults:

| Level    | Height | Max bitrate |
|----------|--------|-------------|
| Original | source | uncapped    |
| High     | 1080p  | 8 Mbps      |
| Medium   | 720p   | 4 Mbps      |
| Low      | 480p   | 1.5 Mbps    |

`Auto` is the default and means Original on the LAN, Medium over Tailscale.

### Integration

`transcoder.decide()` takes a `quality` option. When a cap is active and the
source exceeds it, the decision is forced to `transcode` carrying a target
height and maxrate. This is the substantive behavioural change: a 4K remux
currently resolves to `direct` and would stream raw bytes at the source
bitrate.

`buildArgs` gains `maxHeight` and `maxrate` parameters feeding `-vf scale` and
`-maxrate` / `-bufsize`.

HDR composes without special handling: `tonemapChain(height, maxHeight)`
already accepts a height ceiling, so the active cap is passed in place of
`TONEMAP_MAX_HEIGHT`.

The player sends `?q=auto|original|high|medium|low`, persisted per device in
localStorage, surfaced as a control in the existing player chrome.

### Accepted tradeoffs

**A capped stream skips the MP4 cache.** Cached variants in `mp4cache.js` are
full quality; serving one to a capped client would silently ignore the cap. So
when a cap is active, playback goes through the ffmpeg pipe and seeking restarts
the encode at `?t=` rather than seeking natively — a path the player already
supports for transcode mode.

Caching a file per quality level was rejected: it multiplies disk usage across
the whole library to optimise the bandwidth-constrained case, which is the one
least able to benefit.

## Testing

Node tests under `tests/`, matching the existing `*.test.mjs` convention and
added to the `npm test` chain:

- `auth.test.mjs` — token hashing, cookie attribute selection by TLS, device
  insert/lookup/revoke, revocation taking effect immediately, middleware
  allowlist, rate-limit backoff.
- `auth-loopback.test.mjs` — a proxied request presenting as loopback is still
  challenged. Guards the trap described above.
- `remote-quality.test.mjs` — CGNAT range detection, `decide()` under each
  ladder level, a cap forcing `direct` to `transcode`, a cap composing with HDR
  tone mapping, capped requests bypassing the MP4 cache.

Pester tests under `launcher/tests/`, matching `ApiClient.Tests.ps1`: admin key
loading, device list parsing, revoke call shape.

## Rollout order

1. Schema, device store, auth middleware, login page — verified on the LAN with
   Tailscale not yet involved.
2. Admin key, devices API, launcher tab.
3. Tailscale install and `serve`, origin and trust-proxy config, end-to-end
   check from the iPad.
4. Quality ladder, `decide()` integration, player control.

Auth lands before the tunnel opens. At no point is a reachable server
unauthenticated.
