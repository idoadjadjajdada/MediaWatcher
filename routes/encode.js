/**
 * /api/encode — the worker end of handing a conversion to another machine.
 *
 * Same codebase, different job. A server started with ENCODE_WORKER=1 will
 * accept an encode from another MediaWatcher on the network: it pulls the
 * source over HTTP, converts it, and holds the result until the other end
 * collects it.
 *
 * Everything here authenticates with the shared secret rather than with the
 * password gate, because there is nobody signing in — the two ends are
 * servers. Without that secret a worker would be a machine anyone on the
 * network could spend an afternoon of CPU on.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import express from 'express';
import config, { createLogger } from '../config/index.js';
import { variantArgs } from '../services/mp4cache.js';
import { hardwareEncoder, isAvailable } from '../services/transcoder.js';
import * as ffmpegPool from '../services/ffmpegPool.js';
import { createProgressReader } from '../services/ffmpegProgress.js';
import * as encodeFarm from '../services/encodeFarm.js';

const log = createLogger('worker');
const router = express.Router();

/** Where a worker keeps what it is working on. Cleared as jobs are collected. */
const workDir = () => path.join(config.cachePath, 'encode');

/** Jobs this worker knows about, by id. Memory only — a restart loses them. */
const jobs = new Map();

/**
 * One at a time.
 *
 * A worker exists because a machine has spare capacity; running four
 * conversions on it means four that are each four times slower, and the
 * coordinator asking "are you busy" gets a useful answer only if the answer
 * can be no.
 */
const busy = () => Array.from(jobs.values()).some((job) => job.state === 'running');

const authorised = (req, res, next) => {
  if (encodeFarm.verifySecret(req.get('x-encode-secret'))) return next();
  log.warn(`refused an encode request from ${req.ip}`);
  return res.status(403).json({ error: 'not for you' });
};

/* --------------------------------------------------------------------------
 * The source, from the coordinator's side
 * ----------------------------------------------------------------------- */

/**
 * GET /api/encode/source?path=&exp=&sig= — hand a worker the raw file.
 *
 * This runs on the *coordinator*, not the worker: it is how the machine that
 * owns the library lets the machine doing the work read one file. Signed
 * rather than gated, because a worker has no cookie, and restricted to the one
 * path in the signature.
 *
 * Deliberately not /api/stream: that endpoint decides whether to remux or
 * transcode for a client, and a worker wants the bytes exactly as they are.
 */
router.get('/source', async (req, res) => {
  const filePath = String(req.query.path || '');
  if (!encodeFarm.verifySource(filePath, req.query.exp, req.query.sig)) {
    log.warn(`refused an unsigned source request from ${req.ip}`);
    return res.status(403).json({ error: 'not signed' });
  }

  try {
    const stat = await fsp.stat(filePath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(stat.size));
    return fs.createReadStream(filePath).pipe(res);
  } catch {
    return res.status(404).json({ error: 'no such file' });
  }
});

/* --------------------------------------------------------------------------
 * The worker
 * ----------------------------------------------------------------------- */

/** GET /api/encode/health — alive, and worth giving work to? */
router.get('/health', authorised, async (_req, res) => {
  res.json({
    worker: config.encode.worker,
    busy: busy(),
    // What the coordinator sorts on: a machine with a GPU finishes a job in a
    // third of the time, so it should be asked first.
    hardwareEncoder: config.encode.worker ? await hardwareEncoder() : null,
    ffmpeg: await isAvailable(),
    cpus: os.cpus().length,
    jobs: jobs.size
  });
});

/**
 * POST /api/encode/jobs — take a conversion.
 *
 * Answers immediately with an id. The work is long and the coordinator polls,
 * because a request held open for ninety minutes is a request that dies to the
 * first network hiccup.
 */
router.post('/jobs', authorised, async (req, res) => {
  if (!config.encode.worker) return res.status(503).json({ error: 'not a worker' });
  if (busy()) return res.status(409).json({ error: 'busy' });
  if (!(await isAvailable())) return res.status(503).json({ error: 'no ffmpeg here' });

  const { source, variant, video } = req.body || {};
  if (!source || !/^https?:\/\//.test(String(source))) {
    return res.status(400).json({ error: 'a source url is required' });
  }

  const id = randomUUID();
  const job = {
    id,
    state: 'running',
    startedAt: Date.now(),
    speed: null,
    outSeconds: null,
    error: null,
    input: path.join(workDir(), `${id}.src`),
    output: path.join(workDir(), `${id}.mp4`)
  };
  jobs.set(id, job);

  // Not awaited: the answer is the id, and the work outlives this request.
  run(job, String(source), variant, video).catch((error) => {
    job.state = 'failed';
    job.error = error.message;
  });

  return res.status(202).json({ id });
});

/** GET /api/encode/jobs/:id — how it is getting on. */
router.get('/jobs/:id', authorised, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'no such job' });
  const { input, output, ...visible } = job;
  return res.json(visible);
});

/** GET /api/encode/jobs/:id/output — the converted file. */
router.get('/jobs/:id/output', authorised, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'no such job' });
  if (job.state !== 'done') return res.status(409).json({ error: `job is ${job.state}` });

  res.setHeader('Content-Type', 'video/mp4');
  return fs.createReadStream(job.output).pipe(res);
});

/**
 * DELETE /api/encode/jobs/:id — collected, or abandoned.
 *
 * The coordinator calls this however the job ended, including on failure: a
 * worker holding finished files nobody collected would fill its own disk with
 * copies of someone else's library.
 */
router.delete('/jobs/:id', authorised, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.json({ removed: false });

  try { job.proc?.kill('SIGKILL'); } catch { /* already gone */ }
  await fsp.rm(job.input, { force: true }).catch(() => {});
  await fsp.rm(job.output, { force: true }).catch(() => {});
  jobs.delete(job.id);
  return res.json({ removed: true });
});

/* --------------------------------------------------------------------------
 * Doing the work
 * ----------------------------------------------------------------------- */

async function run(job, source, variant, video) {
  await fsp.mkdir(workDir(), { recursive: true });

  // Pull first. Converting from a URL directly would mean ffmpeg re-reading
  // over the network on every seek it makes internally, which is far slower
  // than one sequential download.
  const response = await fetch(source, { headers: { 'x-encode-secret': encodeFarm.secret() } });
  if (!response.ok || !response.body) throw new Error(`could not fetch the source (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(job.input));

  const encoder = variant === 'h264' ? await hardwareEncoder() : null;
  const args = variantArgs(job.input, job.output, variant, { video, encoder });

  const release = await ffmpegPool.acquire(`remote:${variant}`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
      job.proc = child;

      ffmpegPool.register({ kind: 'convert', label: `${variant} for another machine`, filePath: job.input, proc: child });
      child.stdout?.on('data', createProgressReader(({ speed, outSeconds }) => {
        job.speed = speed;
        job.outSeconds = outSeconds;
      }));

      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-400); });
      child.on('error', reject);
      child.on('close', (code) => {
        job.proc = null;
        if (code === 0 && fs.existsSync(job.output)) return resolve();
        return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      });
    });
  } finally {
    release();
    // The source is the big one and is of no further use the moment the
    // conversion ends, however it ended.
    await fsp.rm(job.input, { force: true }).catch(() => {});
  }

  job.state = 'done';
  job.finishedAt = Date.now();
  log.info(`finished ${variant} in ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`);
}

export default router;
