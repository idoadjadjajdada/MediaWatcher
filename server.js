/**
 * MediaWatcher HTTP server.
 *
 * Binds to 127.0.0.1 only — this app holds API keys and streams local files,
 * so it is not meant to be reachable from the network without a deliberate
 * reverse proxy in front of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import config, { ensureRuntimeDirs, log } from './config/index.js';
import { closeDatabase } from './db/index.js';
import requireAuth from './middleware/requireAuth.js';
import errorHandler from './middleware/errorHandler.js';
import { instanceFingerprint } from './services/auth.js';
import * as serving from './services/serving.js';
import authRouter from './routes/auth.js';
import devicesRouter from './routes/devices.js';
import hlsRouter from './routes/hls.js';
import introRouter from './routes/intro.js';
import trackPrefsRouter from './routes/trackPrefs.js';
import diagnosticsRouter from './routes/diagnostics.js';
import libraryRouter from './routes/library.js';
import offlineRouter from './routes/offline.js';
import adminRouter from './routes/admin.js';
import notificationsRouter from './routes/notifications.js';
import castRouter from './routes/cast.js';
import encodeRouter from './routes/encode.js';
import { onShutdown } from './services/lifecycle.js';
import mediaRouter from './routes/media.js';
import discoverRouter from './routes/discover.js';
import torrentsRouter from './routes/torrents.js';
import progressRouter from './routes/progress.js';
import streamRouter from './routes/stream.js';
import subsRouter from './routes/subs.js';
import thumbsRouter from './routes/thumbs.js';
import * as scanner from './services/scanner.js';
import * as downloader from './services/downloader.js';
import * as transcoder from './services/transcoder.js';
import * as watcher from './services/watcher.js';
import * as hls from './services/hls/manager.js';
import * as cacheSweeper from './services/cacheSweeper.js';
import * as warmup from './services/warmup.js';
import * as ffmpegPool from './services/ffmpegPool.js';
import { events as downloadEvents } from './services/downloader.js';

ensureRuntimeDirs();

const app = express();
const PUBLIC_DIR = path.join(config.rootDir, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

app.disable('x-powered-by');
app.set('etag', 'strong');

/*
 * X-Forwarded-For is only meaningful because the sole thing allowed to reach
 * this port is tailscale serve on loopback. Without this every tunnelled
 * request reports req.ip as 127.0.0.1 and remote clients become invisible —
 * both to the device list and to the quality cap.
 *
 * It is off unless a tunnel is actually configured, because any local process
 * can send an X-Forwarded-For header and claim to be a tailnet address. The
 * consequence is only a wrong quality cap and a wrong label in the device list
 * — it grants no access, the gate never looks at an address — but there is no
 * reason to believe the header on a machine that is not behind a tunnel.
 */
app.set('trust proxy', config.auth.tailnetHost ? 'loopback' : false);

/* --------------------------------------------------------------------------
 * Security + middleware
 * ----------------------------------------------------------------------- */

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      /*
       * The Cast sender SDK is served from gstatic and cannot be bundled — it
       * is the only way to talk to a Chromecast from a page, and Google does
       * not publish it for self-hosting. Allowed only when casting is actually
       * switched on, so an install that does not cast keeps a CSP with no
       * third-party script origin in it at all.
       */
      scriptSrc: config.cast.enabled
        ? ["'self'", 'https://www.gstatic.com']
        : ["'self'"],
      // Inline styles carry backdrop images and progress-bar widths.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://image.tmdb.org'],
      mediaSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  // COEP/CORP break <video> playback of same-origin range responses in some
  // browsers; the app is localhost-only so the tradeoff is fine.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // Range requests need referrer-free, cache-friendly behaviour.
  referrerPolicy: { policy: 'no-referrer' }
}));

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
    /*
     * Without a status this surfaced as a 500, which reads as "the server broke"
     * rather than "that origin is not on the list". The origin itself is logged
     * rather than returned: it is attacker-controlled text and belongs in the
     * log, not in a response body.
     */
    log.warn(`refused cross-origin request from ${origin}`);
    const rejected = new Error('Origin not allowed');
    rejected.status = 403;
    return callback(rejected);
  },
  // The device cookie has to ride along, so the browser needs permission to
  // send it.
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

if (config.logLevel === 'debug') {
  app.use((req, _res, next) => {
    log.debug(`${req.method} ${req.originalUrl}`);
    next();
  });
}

/* --------------------------------------------------------------------------
 * Authentication
 *
 * The gate mounts here, ahead of the static handler: below this line nothing
 * is served to a client that has not passed it. The login route itself is
 * mounted first, because it is what hands out the cookie the gate looks for.
 * ----------------------------------------------------------------------- */

app.use('/api/auth', authRouter);

/*
 * Above the gate, not below it: device management authenticates with the local
 * admin key instead of a device cookie, and that is a strictly stronger claim.
 * Mounting it below would mean the launcher — which holds the key but has no
 * cookie — was turned away by requireAuth before its own check ever ran.
 */
app.use('/api/devices', devicesRouter);

/*
 * Also above the gate, and for the same reason. The two ends of a remote
 * conversion are servers: neither holds a device cookie, neither can be given
 * one, and both prove themselves with a shared secret instead. Every route in
 * there checks it for itself.
 */
app.use('/api/encode', encodeRouter);

app.use(requireAuth);

/* --------------------------------------------------------------------------
 * Static frontend
 * ----------------------------------------------------------------------- */

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  extensions: ['html'],
  maxAge: 0
}));

/* --------------------------------------------------------------------------
 * API routes
 * ----------------------------------------------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: Date.now(),
    uptime: process.uptime(),
    // Says which library this is to anything that can already read its admin
    // key, and nothing at all to anyone else. The desktop app uses it to tell
    // "my server is already up" from "something else has that port".
    instance: instanceFingerprint()
  });
});

app.use('/api/media', mediaRouter);
app.use('/api/discover', discoverRouter);
app.use('/api', torrentsRouter);          // /api/search + /api/torrents/*
app.use('/api/progress', progressRouter);
app.use('/api/stream', streamRouter);
app.use('/api/subs', subsRouter);
app.use('/api/thumbs', thumbsRouter);
app.use('/api/hls', hlsRouter);
app.use('/api/intro', introRouter);
app.use('/api/track-prefs', trackPrefsRouter);
app.use('/api/diagnostics', diagnosticsRouter);
app.use('/api/library', libraryRouter);
app.use('/api/offline', offlineRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/cast', castRouter);

/* --------------------------------------------------------------------------
 * Fallbacks
 * ----------------------------------------------------------------------- */

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Single-page app: any non-API GET falls through to index.html.
app.get('*', (_req, res, next) => {
  if (!fs.existsSync(INDEX_HTML)) {
    return res.status(404).type('text/plain').send('MediaWatcher API is running. The frontend is not built yet.');
  }
  res.sendFile(INDEX_HTML, (error) => (error ? next(error) : undefined));
});

// 4xx messages are written for the caller and pass through; a 5xx says nothing
// but its status. See middleware/errorHandler.js for why.
app.use(errorHandler(log));

/* --------------------------------------------------------------------------
 * Boot
 * ----------------------------------------------------------------------- */

/*
 * One server per library, whatever port each was asked for. Two over the same
 * folder would scan, sweep and reconcile each other's work, and each would
 * delete the other's in-flight segments as orphans — see services/serving.js.
 */
const alreadyServing = await serving.holder();
if (alreadyServing) {
  log.error(`this library is already being served at http://127.0.0.1:${alreadyServing.port}`
    + ` (process ${alreadyServing.pid}). Open that, or point MW_DATA_DIR at another folder.`);
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  // Only the parent that started this server receives readiness. A different
  // service already using the port can never be mistaken for our backend.
  // Written after the port is known, so the claim can name where to look.
  serving.claim(server.address().port);
  if (process.connected) process.send({ type: 'ready', port: server.address().port, host: config.host });
  log.info(`MediaWatcher listening on http://${config.host}:${config.port}`);
  if (config.host !== '127.0.0.1') {
    /*
     * Worth saying out loud every time. The gate is what makes this safe, and
     * a server on the LAN is reachable by everything on the LAN — which is the
     * point when casting, and a surprise otherwise.
     */
    log.warn(`listening on ${config.host}, not just loopback — every device on this network can reach the gate`);
  }
  log.info(`library: ${config.libraryPath}`);
  log.info(`temp:    ${config.tempPath}`);

  // Warm the library so the first page load is instant rather than blocking on
  // a scan, and pick up any downloads the previous process left mid-flight.
  scanner.scanLibrary().catch((error) => log.error(`initial scan failed: ${error.message}`));
  downloader.reconcileOnBoot().catch((error) => log.error(`job reconcile failed: ${error.message}`));

  // Files dropped into the library are picked up without pressing Rescan.
  watcher.start();

  // Segment directories from a previous run are orphaned: the encoders that
  // owned them died with that process.
  hls.clearOrphans();
  hls.startSweeper();

  // cache/mp4 and cache/thumbs are trimmed to their budgets here and on an
  // interval; nothing used to remove an entry from either.
  cacheSweeper.start();
  // A finished download is the ideal moment to pay for the conversion and the
  // seek thumbnails, rather than making the first viewer wait for both.
  warmup.watchDownloads(downloadEvents);

  transcoder.isAvailable().then((available) => {
    log.info(available
      ? 'ffmpeg found — incompatible files will be remuxed on the fly'
      : 'ffmpeg NOT found — files will be served as raw bytes only, so MKV/HEVC/DTS may not play. Install ffmpeg or set FFMPEG_PATH.');
    if (!available) return;
    /*
     * Ask what this machine can do now, rather than while somebody waits.
     *
     * Both answers are cached for the life of the process and both cost a real
     * ffmpeg run to establish — seconds, spent on the first play, in front of a
     * black player. They are wanted by then, and nobody is waiting for them
     * here.
     */
    transcoder.hardwareEncoder().catch(() => {});
    transcoder.gpuTonemap().catch(() => {});
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`port ${config.port} is already in use. Set PORT in .env or stop the other process.`);
    process.exit(1);
  }
  log.error(error.stack || error.message);
  process.exit(1);
});

let shuttingDown = false;

/*
 * `code` is how a deliberate restart is told apart from a crash.
 *
 * The launcher restarts the server whenever it dies, backing off each time and
 * giving up after five failures - correct for a server that cannot stay up,
 * and exactly wrong for one that was asked to restart. Exiting with
 * RESTART_EXIT_CODE says which of the two this is.
 */
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  serving.release();
  watcher.stop().catch(() => {});
  cacheSweeper.stop();
  warmup.stop();
  // No ffmpeg should outlive the server.
  hls.shutdownAll();
  for (const encoder of ffmpegPool.listRunning()) ffmpegPool.killRunning(encoder.id);
  server.close(() => {
    closeDatabase();
    process.exit(code);
  });
  // Don't hang forever on a stuck video stream.
  setTimeout(() => {
    closeDatabase();
    process.exit(code);
  }, 5000).unref();
}

// A route can now ask for this, which is what makes a restart from a phone
// possible at all.
onShutdown(shutdown);

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Windows has no graceful POSIX termination; the desktop parent uses IPC.
if (process.send && process.env.MW_DESKTOP === '1') {
  process.on('message', (message) => {
    if (message?.type === 'shutdown') shutdown('desktop quit');
  });
  process.on('disconnect', () => shutdown('desktop disconnected'));
}
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

export default app;
