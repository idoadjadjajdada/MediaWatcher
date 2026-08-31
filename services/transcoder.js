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

export const MAX_AUDIO_OFFSET = 30;

/**
 * Seconds to shift audio by. Positive delays it, negative advances it.
 * Anything unparseable is no offset at all rather than an error - this comes
 * straight off a query string.
 */
export function clampAudioOffset(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(-MAX_AUDIO_OFFSET, Math.min(MAX_AUDIO_OFFSET, seconds));
}

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
      fps: video.r_frame_rate || null,
      // Needed to spot HDR. Bit depth alone does not identify it - most of a
      // 4K library is 10-bit SDR - so the transfer curve is what matters.
      transfer: video.color_transfer || null,
      primaries: video.color_primaries || null,
      pixelFormat: video.pix_fmt || null
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
 * Hardware encoding
 * ----------------------------------------------------------------------- */

let hwEncoder;

/**
 * An H.264 encoder that runs on the GPU, or null for libx264.
 *
 * Only worth the lookup for tone mapping, where the CPU is already busy doing
 * the colour conversion. Measured over 20s of 4K HDR on this machine: libx264
 * at 1080p runs 1.18x realtime, NVENC 1.56x, and NVENC with CUDA decode 1.70x.
 * Probed once and cached, like isAvailable().
 */
export function hardwareEncoder() {
  if (hwEncoder !== undefined) return hwEncoder;
  if (!config.ffmpeg.hardwareEncode) {
    hwEncoder = Promise.resolve(null);
    return hwEncoder;
  }

  hwEncoder = new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.resume();
    child.on('error', () => resolve(null));
    child.on('close', () => {
      // Ordered by how well each handles a realtime pipe on typical hardware.
      const found = ['h264_nvenc', 'h264_qsv', 'h264_amf'].find((name) => out.includes(name));
      if (found) log.info(`hardware H.264 encoder available: ${found}`);
      resolve(found || null);
    });
  });

  return hwEncoder;
}

/* --------------------------------------------------------------------------
 * HDR tone mapping
 * ----------------------------------------------------------------------- */

/**
 * Height above which a tone-mapped stream is downscaled.
 *
 * Purely a throughput limit, not a quality preference. Measured on this machine
 * over 20s of 4K HDR: tone mapping at native 2160p runs at 0.60x realtime even
 * with CUDA decode and NVENC, so playback stalls. At 1080p the same chain runs
 * at 1.70x. Sources already at or below this keep every pixel they came with.
 */
export const TONEMAP_MAX_HEIGHT = 1080;

/** Transfer curves that mean HDR. Everything else is treated as SDR. */
const HDR_TRANSFERS = new Set(['smpte2084', 'smpte-st-2084', 'arib-std-b67', 'smpte428']);

/**
 * Is this video HDR?
 *
 * Keyed on the transfer curve alone. Bit depth is not a signal - most of a 4K
 * library is 10-bit SDR - and neither is BT.2020 primaries on their own.
 */
export function isHdr(video) {
  const transfer = video?.transfer;
  return Boolean(transfer) && HDR_TRANSFERS.has(String(transfer).toLowerCase());
}

/**
 * ffmpeg filter chain converting HDR to SDR.
 *
 * Without this, PQ code values reach the browser and get read as ordinary
 * gamma. Mid-tones sit far higher in PQ than in gamma 2.2, so the picture comes
 * out washed out and much too bright - the symptom that prompted this.
 *
 * The scale runs BEFORE the tone map, which is the whole reason this is fast
 * enough to watch: tone mapping is per-pixel, so doing it after a 4K->1080p
 * downscale costs a quarter as much. Measured at 2.7x faster that way round.
 * Scaling in PQ space rather than linear light is very slightly less correct,
 * and invisible next to being unwatchable.
 */
export function tonemapChain(height, maxHeight = TONEMAP_MAX_HEIGHT) {
  const steps = [];
  if (Number.isFinite(height) && height > maxHeight) steps.push(`scale=-2:${maxHeight}`);

  steps.push(
    'zscale=t=linear:npl=100',
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p'
  );
  return steps.join(',');
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
export function decide(info, caps = {}, options = {}) {
  const audioOffset = clampAudioOffset(options.audioOffset);
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

  // HDR has to be tone mapped, and tone mapping means touching every pixel, so
  // no path that copies the video stream can carry it. Browsers accept the PQ
  // stream happily and then render it as if it were ordinary gamma, which comes
  // out washed out and far too bright.
  const hdr = isHdr(info.video);
  if (hdr && mode !== 'transcode') {
    mode = 'transcode';
    reasons.push('HDR video is tone mapped to SDR for the browser');
  }

  // direct streams raw bytes with no ffmpeg in the path, so it cannot carry an
  // audio offset. Promote to remux: still a stream copy, still lossless.
  if (audioOffset !== 0 && mode === 'direct') {
    mode = 'remux';
    reasons.push(`audio offset ${audioOffset}s requires ffmpeg — remuxing instead of direct`);
  }

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
    lossless: mode !== 'transcode',
    hdr,
    // Told to the client so the badge can say "HDR → SDR" rather than the bare
    // "Transcode", which would look like an unexplained quality loss.
    tonemapped: hdr,
    tonemapHeight: hdr && Number.isFinite(info.video?.height) && info.video.height > TONEMAP_MAX_HEIGHT
      ? TONEMAP_MAX_HEIGHT
      : (info.video?.height ?? null)
  };
}

/* --------------------------------------------------------------------------
 * Streaming
 * ----------------------------------------------------------------------- */

export function buildArgs(filePath, {
  mode, startSeconds = 0, audioIndex = 0, audioOffset = 0,
  tonemap = false, height = null, encoder = null
}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  const offset = clampAudioOffset(audioOffset);

  // GPU decode feeds the tone map without a round trip through the CPU decoder.
  // Only for NVENC: the qsv and amf paths need their own filter plumbing, and
  // falling back to a plain CPU decode there is correct, just slower.
  if (tonemap && encoder === 'h264_nvenc') args.push('-hwaccel', 'cuda');

  // Seeking before -i is the fast path: ffmpeg jumps rather than decoding to
  // the timestamp. With -c copy it lands on the nearest keyframe.
  const seek = () => { if (startSeconds > 0) args.push('-ss', String(startSeconds)); };

  seek();
  args.push('-i', filePath);

  if (offset !== 0) {
    // A second, time-shifted view of the same file. Audio can still be copied
    // this way; an adelay/atrim filter would force a re-encode and cost the
    // losslessness that makes remux worth having.
    // -itsoffset must precede the -i it applies to.
    args.push('-itsoffset', String(offset));
    seek();
    args.push('-i', filePath);
    args.push('-map', '0:v:0', '-map', `1:a:${audioIndex}?`);
  } else {
    args.push('-map', '0:v:0', '-map', `0:a:${audioIndex}?`);
  }

  args.push('-sn', '-dn');

  if (mode === 'transcode') {
    if (tonemap) args.push('-vf', tonemapChain(height));

    if (encoder) {
      // Hardware encoders take a quality target rather than a CRF, and p4 is
      // NVENC's balanced preset - fast enough for a live pipe without the
      // blockiness of p1.
      args.push('-c:v', encoder);
      if (encoder === 'h264_nvenc') args.push('-preset', 'p4', '-cq', String(config.ffmpeg.videoCrf));
      else args.push('-global_quality', String(config.ffmpeg.videoCrf));
      args.push('-maxrate', config.ffmpeg.videoMaxrate, '-bufsize', '24M');
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', config.ffmpeg.videoPreset,
        '-crf', String(config.ffmpeg.videoCrf),
        '-maxrate', config.ffmpeg.videoMaxrate,
        '-bufsize', '24M'
      );
    }
    // The tone map chain already ends in yuv420p; setting it twice is harmless
    // but stating it here keeps the non-tonemapped path explicit.
    if (!tonemap) args.push('-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }

  if (mode === 'remux') {
    args.push('-c:a', 'copy');
  } else if (mode === 'remux-audio' || mode === 'transcode') {
    args.push('-c:a', 'aac', '-ac', String(config.ffmpeg.audioChannels), '-b:a', config.ffmpeg.audioBitrate);
  }

  // Fragmented MP4 so playback can start before the file is finished.
  //
  // Deliberately plain. Seek latency was measured at ~630ms median from click
  // to loadeddata, of which ffmpeg accounts for ~180ms to first bytes; the rest
  // is the browser tearing down and reopening the stream. -probesize,
  // -analyzeduration, -avoid_negative_ts, -muxdelay and -frag_duration were all
  // tried and A/B measured: none improved it and frag_duration made it worse
  // (751ms vs 633ms median). The lever is client-side, not here - see the seek
  // coalescing in player.js.
  // Deliberately plain, and delay_moov is deliberately NOT here.
  //
  // It looked like a free win: it removes a stray 83ms edit offset on the video
  // track and measured faster to first bytes (169ms vs 188ms). But it withholds
  // the moov init segment until the first fragment, and a browser cannot start
  // decoding without it - readyState stayed at HAVE_NOTHING indefinitely with
  // no error raised. The byte-throughput benchmark could not see that, because
  // the bytes did arrive; they were just unusable. The 83ms it would have fixed
  // shifts audio and video equally, so lip sync is unaffected either way.
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
