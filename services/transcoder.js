/**
 * Playback compatibility layer (ffmpeg).
 *
 * The point of this module is to do as little as possible. Quality is never
 * traded unless the browser physically cannot decode the codec:
 *
 *   direct        raw bytes, byte-for-byte, range requests — no ffmpeg at all
 *   remux         container swap only, -c copy on both streams — no quality loss
 *   remux-audio   video copied bit-for-bit, only the audio re-encoded (DTS/TrueHD)
 *   transcode     video re-encoded — last resort, the only lossy path
 *
 * ffmpeg is an external binary. If it is missing, every file falls back to
 * `direct` and the browser gets to try on its own, exactly as before.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import config, { createLogger } from '../config/index.js';

const log = createLogger('transcoder');

// What a browser decodes without help.
const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'opus', 'flac', 'mp3', 'vorbis']);
// Decodable only when the client says it can (HEVC needs a hardware path;
// AC3/E-AC3 support varies by browser and platform).
const OPTIONAL_VIDEO = new Set(['hevc']);
const OPTIONAL_AUDIO = new Set(['ac3', 'eac3']);
// ffprobe reports mkv and webm under one format name, so the extension decides.
const BROWSER_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm']);

/* --------------------------------------------------------------------------
 * Availability
 * ----------------------------------------------------------------------- */

let availability = null;

/** Is ffmpeg usable? Probed once, then cached for the process lifetime. */
export function isAvailable() {
  if (availability !== null) return availability;
  if (!config.ffmpeg.enabled) {
    availability = Promise.resolve(false);
    return availability;
  }

  availability = new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, ['-version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdout?.resume();
    child.stderr?.resume();
  });

  return availability;
}

/* --------------------------------------------------------------------------
 * Probe
 * ----------------------------------------------------------------------- */

// Keyed by path + mtime + size, so an edited file re-probes automatically.
// In memory only: a probe costs ~50ms and this avoids a schema change.
const probeCache = new Map();
const PROBE_CACHE_LIMIT = 2000;

function runProbe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpeg.ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffprobe timed out after ${config.ffmpeg.probeTimeoutMs}ms`));
    }, config.ffmpeg.probeTimeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`ffprobe returned unparseable JSON: ${error.message}`));
      }
    });
  });
}

/**
 * Inspect a media file. Returns null when ffprobe is unavailable or the file
 * cannot be read — callers treat null as "just serve the bytes".
 */
export async function probe(filePath) {
  if (!(await isAvailable())) return null;

  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }

  const key = `${filePath}:${stats.mtimeMs}:${stats.size}`;
  if (probeCache.has(key)) return probeCache.get(key);

  let raw;
  try {
    raw = await runProbe(filePath);
  } catch (error) {
    log.warn(`probe failed for ${path.basename(filePath)}: ${error.message}`);
    return null;
  }

  const streams = raw.streams || [];
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1) || null;
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle');

  const info = {
    duration: Number(raw.format?.duration) || null,
    size: Number(raw.format?.size) || stats.size,
    bitrate: Number(raw.format?.bit_rate) || null,
    container: path.extname(filePath).toLowerCase(),
    video: video && {
      codec: video.codec_name,
      profile: video.profile || null,
      width: video.width || null,
      height: video.height || null,
      fps: video.r_frame_rate || null
    },
    audio: audioStreams.map((stream, index) => ({
      index,
      codec: stream.codec_name,
      channels: stream.channels || null,
      language: stream.tags?.language || null,
      title: stream.tags?.title || null,
      default: stream.disposition?.default === 1
    })),
    subtitles: subtitleStreams.map((stream, index) => ({
      index,
      codec: stream.codec_name,
      language: stream.tags?.language || null,
      title: stream.tags?.title || null,
      forced: stream.disposition?.forced === 1,
      default: stream.disposition?.default === 1
    }))
  };

  if (probeCache.size >= PROBE_CACHE_LIMIT) probeCache.clear();
  probeCache.set(key, info);
  return info;
}

/* --------------------------------------------------------------------------
 * Decision
 * ----------------------------------------------------------------------- */

/**
 * Choose the cheapest playback path for a file.
 *
 * @param {object|null} info  probe() result
 * @param {object} caps       client capabilities, e.g. { hevc: true, ac3: true }
 */
export function decide(info, caps = {}) {
  if (!info) {
    return { mode: 'direct', reasons: ['no probe data — serving raw bytes'], seekable: true };
  }

  const videoCodec = info.video?.codec || null;
  const audio = info.audio.find((track) => track.default) || info.audio[0] || null;
  const audioCodec = audio?.codec || null;

  const containerOk = BROWSER_CONTAINERS.has(info.container);
  const videoOk = !videoCodec
    || BROWSER_VIDEO.has(videoCodec)
    || (Boolean(caps.hevc) && OPTIONAL_VIDEO.has(videoCodec));
  const audioOk = !audioCodec
    || BROWSER_AUDIO.has(audioCodec)
    || (Boolean(caps.ac3) && OPTIONAL_AUDIO.has(audioCodec));

  const reasons = [];
  if (!containerOk) reasons.push(`${info.container} is not a browser container`);
  if (!videoOk) reasons.push(`${videoCodec} video needs re-encoding for this client`);
  if (!audioOk) reasons.push(`${audioCodec} audio is not decodable in a browser`);

  let mode;
  if (containerOk && videoOk && audioOk) mode = 'direct';
  else if (videoOk && audioOk) mode = 'remux';
  else if (videoOk) mode = 'remux-audio';
  else mode = 'transcode';

  if (mode === 'direct') reasons.push('plays natively — streaming untouched bytes');

  return {
    mode,
    reasons,
    // Only raw byte streaming supports range-based seeking; ffmpeg output is a
    // pipe, so the player seeks by restarting it at a timestamp instead.
    seekable: mode === 'direct',
    video: info.video,
    audio,
    audioTracks: info.audio,
    duration: info.duration,
    lossless: mode !== 'transcode'
  };
}

/* --------------------------------------------------------------------------
 * Streaming
 * ----------------------------------------------------------------------- */

function buildArgs(filePath, { mode, startSeconds = 0, audioIndex = 0 }) {
  const args = ['-hide_banner', '-loglevel', 'error'];

  // Seeking before -i is the fast path: ffmpeg jumps rather than decoding to
  // the timestamp. With -c copy it lands on the nearest keyframe.
  if (startSeconds > 0) args.push('-ss', String(startSeconds));

  args.push('-i', filePath, '-map', '0:v:0', '-map', `0:a:${audioIndex}?`, '-sn', '-dn');

  if (mode === 'transcode') {
    args.push(
      '-c:v', 'libx264',
      '-preset', config.ffmpeg.videoPreset,
      '-crf', String(config.ffmpeg.videoCrf),
      '-maxrate', config.ffmpeg.videoMaxrate,
      '-bufsize', '24M',
      '-pix_fmt', 'yuv420p'
    );
  } else {
    args.push('-c:v', 'copy');
  }

  if (mode === 'remux') {
    args.push('-c:a', 'copy');
  } else if (mode === 'remux-audio' || mode === 'transcode') {
    args.push('-c:a', 'aac', '-ac', String(config.ffmpeg.audioChannels), '-b:a', config.ffmpeg.audioBitrate);
  }

  // Fragmented MP4 so playback can start before the file is finished.
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

/**
 * Spawn ffmpeg and hand back its stdout.
 * Callers MUST call kill() when the response closes or ffmpeg will linger.
 */
export function openStream(filePath, options) {
  const args = buildArgs(filePath, options);
  log.debug(`ffmpeg ${args.join(' ')}`);

  const child = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 4000) stderr = stderr.slice(-2000);
  });
  child.on('close', (code) => {
    // 255 / null are the normal result of killing the pipe when a viewer seeks away.
    if (code && code !== 255) log.warn(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`);
  });

  return {
    stream: child.stdout,
    kill: () => {
      if (!child.killed) child.kill('SIGKILL');
    }
  };
}

/**
 * Extract an embedded subtitle track as WebVTT.
 * MKV releases usually carry their subtitles inside the file rather than beside it.
 */
export function extractSubtitle(filePath, streamIndex) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', filePath,
    '-map', `0:s:${streamIndex}`,
    '-f', 'webvtt',
    'pipe:1'
  ];

  const child = spawn(config.ffmpeg.ffmpegPath, args, { windowsHide: true });
  child.stderr.resume();

  return {
    stream: child.stdout,
    kill: () => {
      if (!child.killed) child.kill('SIGKILL');
    }
  };
}

export default { isAvailable, probe, decide, openStream, extractSubtitle };
