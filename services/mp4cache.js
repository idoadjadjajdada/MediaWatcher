/**
 * Browser-native MP4 cache.
 *
 * The library is MKV/HEVC/EAC3, none of which a browser opens directly, so
 * every play went through ffmpeg as a pipe. A pipe has no byte offsets, so
 * seeking meant killing ffmpeg and restarting it at a timestamp - the delay you
 * feel on every skip. Converting once to MP4 on disk makes playback `direct`:
 * the browser gets HTTP range requests and seeks natively and instantly.
 *
 * Two variants, chosen per client:
 *
 *   copy   video stream copied byte for byte, audio re-encoded to AAC. Lossless
 *          picture, roughly source size, but only playable where HEVC is.
 *   h264   re-encoded to H.264, capped at 1080p, tone mapped if the source is
 *          HDR. Plays in every browser with nothing installed.
 *
 * Neither replaces the source file. Conversion runs in the background and the
 * live ffmpeg pipe keeps serving until a variant is ready, so nothing ever
 * waits on this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import config, { createLogger } from '../config/index.js';
import { probe, isAvailable, hardwareEncoder, isHdr, tonemapChain } from './transcoder.js';
import { cacheKey } from './thumbnails.js';
import * as ffmpegPool from './ffmpegPool.js';
import { createProgressReader } from './ffmpegProgress.js';
import * as encodeFarm from './encodeFarm.js';
import * as cacheSweeper from './cacheSweeper.js';
import { hasRoomFor, formatBytes } from './diskspace.js';

const log = createLogger('mp4cache');

export const VARIANT_COPY = 'copy';
export const VARIANT_H264 = 'h264';

/** Height cap for the universal variant. Above this it is re-encoded down. */
export const H264_MAX_HEIGHT = 1080;

const CACHE_DIR = config.mp4Cache.dir;

/**
 * Conversions run one at a time.
 *
 * They are background work with no viewer waiting on them — the live pipe keeps
 * serving until one lands — so there is nothing to gain from running several,
 * and plenty to lose: each is a full-length encode competing with playback.
 */
const MAX_CONCURRENT = 1;

/** Codecs a browser opens without help. Anything else has to be re-encoded. */
const NATIVE_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);

/**
 * Which variant this client needs.
 *
 * A copy is preferred wherever it will actually play, because it is lossless
 * and costs no encoding. HDR forces H.264 regardless of client support: tone
 * mapping is a per-pixel operation, so no stream copy can carry it.
 */
export function pickVariant(video, caps = {}) {
  if (!video) return VARIANT_H264;
  if (isHdr(video)) return VARIANT_H264;
  if (NATIVE_VIDEO.has(String(video.codec || '').toLowerCase())) return VARIANT_COPY;
  return caps.hevc ? VARIANT_COPY : VARIANT_H264;
}

/**
 * ffmpeg arguments converting one source into one variant.
 *
 * `+faststart` moves the index to the front so the browser can start playing
 * and seeking without fetching the tail first. It costs a second pass over the
 * output, which is why this is a background job rather than something done in
 * the request path.
 */
export function variantArgs(input, output, variant, { video, audioIndex = 0, encoder = null } = {}) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', `0:a:${audioIndex}?`,
    '-sn', '-dn'
  ];

  if (variant === VARIANT_COPY) {
    args.push('-c:v', 'copy');
  } else {
    const height = Number(video?.height) || null;
    if (isHdr(video)) {
      args.push('-vf', tonemapChain(height, H264_MAX_HEIGHT));
    } else if (height && height > H264_MAX_HEIGHT) {
      args.push('-vf', `scale=-2:${H264_MAX_HEIGHT}`);
    }

    if (encoder) {
      args.push('-c:v', encoder);
      if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf));
      else args.push('-global_quality', String(config.ffmpeg.videoCrf));
    } else {
      args.push('-c:v', 'libx264', '-preset', config.ffmpeg.videoPreset, '-crf', String(config.ffmpeg.videoCrf));
    }
    args.push('-pix_fmt', 'yuv420p');
  }

  // Always AAC. EAC3 and TrueHD are neither browser-decodable nor legal in MP4,
  // so even the "lossless" variant is lossless in picture only.
  args.push('-c:a', 'aac', '-ac', String(config.ffmpeg.audioChannels), '-b:a', config.ffmpeg.audioBitrate);
  // Progress on stdout, which a file output leaves free. This is a background
  // conversion of a whole film; without it the only sign of how it is going is
  // that the file has not appeared yet.
  args.push('-progress', 'pipe:1');
  // -f mp4 is required, not decorative: conversions write to a .part file
  // first, and ffmpeg cannot infer a muxer from that extension. Without it the
  // run dies with "Error opening output files: Invalid argument".
  args.push('-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/* --------------------------------------------------------------------------
 * Cache
 * ----------------------------------------------------------------------- */

/** In-flight conversions, keyed by cache path, so two plays cannot both start one. */
const running = new Map();

function keyFor(filePath) {
  const stat = fs.statSync(filePath);
  return cacheKey(filePath, stat.size, stat.mtimeMs);
}

/** Where a given variant of a given file lives, whether or not it exists yet. */
export function variantPath(filePath, variant) {
  return path.join(CACHE_DIR, keyFor(filePath), `${variant}.mp4`);
}

/** The finished variant for this client, or null if it is not ready. */
export function readyVariant(filePath, variant) {
  try {
    const candidate = variantPath(filePath, variant);
    // A conversion in progress writes to a .part file, so anything at the final
    // name is complete by construction.
    if (!fs.existsSync(candidate)) return null;
    // Eviction is least-recently-used, and "used" is this stamp. Without it a
    // file played every evening looks exactly as cold as one played once.
    cacheSweeper.markUsed(path.dirname(candidate));
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Start converting if it is not already cached or running.
 *
 * Returns immediately. Nothing waits on the result: the caller falls back to
 * the live pipe, and the next play picks up the finished file.
 */
export async function ensureVariant(filePath, variant) {
  if (!config.mp4Cache.enabled) return null;
  if (!(await isAvailable())) return null;

  const done = readyVariant(filePath, variant);
  if (done) return done;

  const target = variantPath(filePath, variant);
  if (running.has(target)) return null;
  if (running.size >= MAX_CONCURRENT) return null;

  /*
   * The slot is claimed here, synchronously, before the first await.
   *
   * Two plays of the same file land in the same tick often enough to matter -
   * the info request and the stream request, for one - and every guard above
   * this line reads state that a second caller would still see as free.
   */
  const job = convert(filePath, target, variant)
    .catch((error) => {
      log.warn(`${variant} conversion failed: ${error.message}`);
      return null;
    })
    .finally(() => {
      running.delete(target);
      // A finished conversion is exactly when the cache is at its largest.
      cacheSweeper.sweep().catch(() => { /* logged there */ });
    });

  running.set(target, job);
  return null;
}

/** The conversion itself. Resolves the finished path, or null on any failure. */
async function convert(filePath, target, variant) {
  const info = await probe(filePath);
  if (!info) return null;

  /*
   * A copy is roughly the size of the source and an H.264 re-encode is smaller,
   * so the source size is a safe over-estimate. Starting a conversion that
   * cannot fit fills the disk and fails at the very end, having spent the whole
   * encode getting there.
   */
  try {
    const room = await hasRoomFor(CACHE_DIR, fs.statSync(filePath).size, config.downloads.minFreeBytes);
    if (!room.ok) {
      log.warn(`skipping ${variant} for ${path.basename(filePath)}: only ${formatBytes(room.free)} free`);
      return null;
    }
  } catch { /* unmeasurable: proceed, see services/diskspace.js */ }

  const encoder = variant === VARIANT_H264 ? await hardwareEncoder() : null;
  const partial = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const args = variantArgs(filePath, partial, variant, { video: info.video, encoder });

  /*
   * Somewhere else first, if there is a somewhere else.
   *
   * Tried before taking a local slot rather than after failing: the whole
   * point is not to spend this machine's processor, and holding a slot while
   * asking would block the background work this is meant to unblock. Every
   * failure inside falls back to here, silently, because the alternative to a
   * remote conversion is the conversion this machine was going to do anyway.
   */
  if (await encodeFarm.convertRemotely(filePath, target, { variant, video: info.video })) {
    return target;
  }

  // Taken before the spawn and released however the run ends, so a background
  // conversion draws on the same budget live playback does.
  const release = await ffmpegPool.acquire(`mp4:${variant}`);
  log.info(`converting ${path.basename(filePath)} → ${variant}`);

  try {
    return await new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });

      const tracked = ffmpegPool.register({
        kind: 'convert',
        label: variant,
        filePath,
        proc: child
      });
      // stdout carries -progress and must be read either way: an unread pipe
      // that fills would block the conversion.
      child.stdout?.on('data', createProgressReader(({ speed, outSeconds }) => {
        tracked.progress({ speed, outSeconds });
      }));

      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.slice(-2000);
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(partial)) {
          // Rename only on success, so a killed or failed run never leaves a
          // truncated file sitting at the name the player trusts.
          try {
            fs.renameSync(partial, target);
            const mb = (fs.statSync(target).size / 1048576).toFixed(0);
            log.info(`${variant} ready for ${path.basename(filePath)} — ${mb}MB in ${Math.round((Date.now() - started) / 1000)}s`);
            return resolve(target);
          } catch (error) {
            log.warn(`could not finalise ${variant}: ${error.message}`);
          }
        } else if (code) {
          log.warn(`${variant} conversion failed (${code}): ${stderr.trim().split('\n').slice(-1)[0] || ''}`);
        }
        try { fs.rmSync(partial, { force: true }); } catch { /* already gone */ }
        resolve(null);
      });
    });
  } finally {
    release();
  }
}

/** Is a conversion running for this file right now? */
export function isConverting(filePath, variant) {
  try {
    return running.has(variantPath(filePath, variant));
  } catch {
    return false;
  }
}

export default { pickVariant, variantArgs, variantPath, readyVariant, ensureVariant, isConverting };
