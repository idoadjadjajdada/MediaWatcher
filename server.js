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
import mediaRouter from './routes/media.js';
import torrentsRouter from './routes/torrents.js';
import progressRouter from './routes/progress.js';
import streamRouter from './routes/stream.js';
import subsRouter from './routes/subs.js';
import * as scanner from './services/scanner.js';
import * as downloader from './services/downloader.js';
import * as transcoder from './services/transcoder.js';
import * as watcher from './services/watcher.js';

ensureRuntimeDirs();

const app = express();
const PUBLIC_DIR = path.join(config.rootDir, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

app.disable('x-powered-by');
app.set('etag', 'strong');

/* --------------------------------------------------------------------------
 * Security + middleware
 * ----------------------------------------------------------------------- */

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
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

app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin navigation, curl, or the <video> element.
    if (!origin || LOCALHOST_ORIGIN.test(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: false
}));

app.use(express.json({ limit: '1mb' }));

if (config.logLevel === 'debug') {
  app.use((req, _res, next) => {
    log.debug(`${req.method} ${req.originalUrl}`);
    next();
  });
}

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
    uptime: process.uptime()
  });
});

app.use('/api/media', mediaRouter);
app.use('/api', torrentsRouter);          // /api/search + /api/torrents/*
app.use('/api/progress', progressRouter);
app.use('/api/stream', streamRouter);
app.use('/api/subs', subsRouter);

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

app.use((error, _req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  if (status >= 500) log.error(error.stack || error.message);
  else log.warn(error.message);
  res.status(status).json({ error: error.message || 'Internal server error' });
});

/* --------------------------------------------------------------------------
 * Boot
 * ----------------------------------------------------------------------- */

const server = app.listen(config.port, config.host, () => {
  log.info(`MediaWatcher listening on http://${config.host}:${config.port}`);
  log.info(`library: ${config.libraryPath}`);
  log.info(`temp:    ${config.tempPath}`);

  // Warm the library so the first page load is instant rather than blocking on
  // a scan, and pick up any downloads the previous process left mid-flight.
  scanner.scanLibrary().catch((error) => log.error(`initial scan failed: ${error.message}`));
  downloader.reconcileOnBoot().catch((error) => log.error(`job reconcile failed: ${error.message}`));

  // Files dropped into the library are picked up without pressing Rescan.
  watcher.start();

  transcoder.isAvailable().then((available) => {
    log.info(available
      ? 'ffmpeg found — incompatible files will be remuxed on the fly'
      : 'ffmpeg NOT found — files will be served as raw bytes only, so MKV/HEVC/DTS may not play. Install ffmpeg or set FFMPEG_PATH.');
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

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  watcher.stop().catch(() => {});
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  // Don't hang forever on a stuck video stream.
  setTimeout(() => {
    closeDatabase();
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

export default app;
