/**
 * GET /api/diagnostics — is this install actually healthy, and what is it using?
 *
 * /api/health answers "the process is up", which is the only question a
 * uptime check needs and none of the questions you have when something is
 * wrong. This answers those: is ffmpeg where the config says, does the library
 * path exist, how much of the disk have the caches taken, and how big is what
 * has been scanned.
 *
 * Everything is returned as raw numbers. Formatting bytes and durations is the
 * client's job, and an API that returns "1.4 GB" cannot be summed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import config, { createLogger } from '../config/index.js';
import * as scanner from '../services/scanner.js';
import { listLogins, failuresSince } from '../db/loginEvents.js';
import { listDevices } from '../db/devices.js';
import * as cacheSweeper from '../services/cacheSweeper.js';
import * as warmup from '../services/warmup.js';
import { encode as qrEncode, toSvg as qrSvg } from '../services/qr.js';

const log = createLogger('api:diagnostics');
const router = express.Router();
const run = promisify(execFile);

/*
 * Derived from this file's own location rather than from config, so the two
 * cache directories are found the same way whether or not a given install
 * declares them in its configuration.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIRS = {
  mp4: path.join(ROOT, 'cache', 'mp4'),
  thumbs: path.join(ROOT, 'cache', 'thumbs')
};

/**
 * Total bytes under a directory.
 *
 * Depth-limited and error-tolerant on purpose: this walks the cache
 * directories, which are being written to while it reads, so a file that
 * vanishes mid-walk is normal rather than a failure. A missing directory
 * reports zero, because "the cache has nothing in it yet" and "the cache
 * folder has not been created yet" are the same answer to the question asked.
 */
export async function directorySize(dir, depth = 6) {
  let total = 0;
  let files = 0;

  async function walk(current, remaining) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (remaining > 0) await walk(full, remaining - 1);
        continue;
      }
      try {
        const stat = await fsp.stat(full);
        total += stat.size;
        files += 1;
      } catch {
        // Swept out from under us between readdir and stat.
      }
    }
  }

  await walk(dir, depth);
  return { bytes: total, files };
}

/** ffmpeg's version line, or null when it is not runnable. */
async function toolVersion(binary) {
  try {
    const { stdout } = await run(binary, ['-version'], { timeout: 5000, windowsHide: true });
    // The first line carries everything worth reporting; the rest is build flags.
    return String(stdout).split('\n')[0].trim().slice(0, 160);
  } catch {
    return null;
  }
}

const exists = (target) => {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
};

router.get('/', async (_req, res, next) => {
  try {
    const library = scanner.getLibrary();

    // Cache sizes are the slow part and independent of each other.
    const [ffmpegVersion, ffprobeVersion, mp4Cache, thumbCache] = await Promise.all([
      toolVersion(config.ffmpeg.ffmpegPath),
      toolVersion(config.ffmpeg.ffprobePath),
      directorySize(CACHE_DIRS.mp4),
      directorySize(CACHE_DIRS.thumbs)
    ]);

    let libraryBytes = 0;
    let libraryFiles = 0;
    const countFiles = (files) => {
      for (const file of files || []) {
        libraryFiles += 1;
        libraryBytes += Number(file.size) || 0;
      }
    };
    for (const movie of library.movies || []) countFiles(movie.files);
    for (const show of library.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) countFiles(episode.files);
      }
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

    res.json({
      server: {
        time: Date.now(),
        uptimeSeconds: process.uptime(),
        node: process.version,
        platform: `${os.type()} ${os.release()}`,
        memoryBytes: process.memoryUsage().rss,
        cpus: os.cpus().length
      },
      ffmpeg: {
        // Configured vs. runnable are different failures with the same
        // symptom, so both are reported rather than one boolean.
        ffmpegPath: config.ffmpeg.ffmpegPath,
        ffprobePath: config.ffmpeg.ffprobePath,
        ffmpegVersion,
        ffprobeVersion,
        available: Boolean(ffmpegVersion && ffprobeVersion)
      },
      library: {
        path: config.libraryPath,
        exists: exists(config.libraryPath),
        movies: (library.movies || []).length,
        shows: (library.shows || []).length,
        unknown: (library.unknown || []).length,
        files: libraryFiles,
        bytes: libraryBytes,
        lastScanAt: library.last_scan_at || null,
        scanning: Boolean(library.scanning)
      },
      caches: {
        mp4: { path: CACHE_DIRS.mp4, ...mp4Cache },
        thumbs: { path: CACHE_DIRS.thumbs, ...thumbCache }
      },
      integrations: {
        tmdb: Boolean(config.tmdb.apiKey),
        alldebrid: Boolean(config.alldebrid.apiKey),
        jackett: Boolean(config.jackett.url && config.jackett.apiKey),
        opensubtitles: {
          search: Boolean(config.opensubtitles.apiKey),
          download: Boolean(config.opensubtitles.apiKey
            && config.opensubtitles.username
            && config.opensubtitles.password)
        },
        tailnetHost: config.auth?.tailnetHost || null
      },
      access: {
        devices: listDevices().length,
        failedLogins24h: failuresSince(dayAgo)
      }
    });
  } catch (error) {
    log.error(`diagnostics failed: ${error.message}`);
    next(error);
  }
});

/** GET /api/diagnostics/logins — the gate's history, newest first. */
router.get('/logins', (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10);
  res.json(listLogins(Number.isInteger(limit) ? limit : 100));
});

/**
 * POST /api/diagnostics/cache/sweep — evict now, rather than on the timer.
 *
 * The sweeper already runs periodically. This is for the case where the disk
 * is full right now and waiting half an hour for the next pass is not an
 * answer.
 */
router.post('/cache/sweep', async (_req, res, next) => {
  try {
    const result = await cacheSweeper.sweep();
    log.info(`manual sweep: ${JSON.stringify(result)}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/diagnostics/cache/:which — throw a whole cache away.
 *
 * Both are rebuildable by definition: mp4 holds converted copies of files that
 * still exist, thumbs holds frames grabbed from them. Deleting either costs
 * time to regenerate and nothing else, which is why this needs no confirmation
 * beyond the button that calls it.
 */
router.delete('/cache/:which', async (req, res, next) => {
  const { which } = req.params;
  if (!Object.prototype.hasOwnProperty.call(CACHE_DIRS, which)) {
    return res.status(400).json({ error: 'cache must be mp4 or thumbs' });
  }

  try {
    const before = await directorySize(CACHE_DIRS[which]);
    await fsp.rm(CACHE_DIRS[which], { recursive: true, force: true });
    // Recreated empty: the writers assume the directory exists and would
    // otherwise fail on the next conversion rather than simply rebuilding.
    await fsp.mkdir(CACHE_DIRS[which], { recursive: true });

    log.info(`cleared the ${which} cache: ${before.files} files, ${before.bytes} bytes`);
    return res.json({ cleared: which, files: before.files, bytes: before.bytes });
  } catch (error) {
    return next(error);
  }
});

/** GET /api/diagnostics/warm — what the ahead-of-time conversion is doing. */
router.get('/warm', (_req, res) => {
  res.json(warmup.getStats());
});

/**
 * GET /api/diagnostics/qr?text=…&format=svg|json
 *
 * For pointing a phone at the launcher. SVG for anything that can render it;
 * JSON — a matrix of 0/1 — for the WPF launcher, which cannot render SVG and
 * would otherwise need an image decoder to draw a grid of squares.
 */
router.get('/qr', (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  // Version 10 at level M is the ceiling; a URL that long is not a URL.
  if (text.length > 400) return res.status(400).json({ error: 'text is too long to encode' });

  if (req.query.format === 'json') {
    const encoded = qrEncode(text);
    if (!encoded) return res.status(400).json({ error: 'text is too long to encode' });
    return res.json({ size: encoded.size, version: encoded.version, matrix: encoded.matrix });
  }

  const svg = qrSvg(text);
  if (!svg) return res.status(400).json({ error: 'text is too long to encode' });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(svg);
});

export default router;
