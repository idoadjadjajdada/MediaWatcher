/**
 * Video player.
 *
 * Two playback shapes have to be handled, and they differ in how seeking works:
 *
 *   direct  the server sends raw bytes with range support, so video.currentTime
 *           works normally and video.duration is real.
 *   ffmpeg  the server pipes fragmented MP4, which has no byte offsets and an
 *           infinite duration. Seeking means reloading the source at ?t=SEC and
 *           tracking that offset ourselves; duration comes from /api/stream/info.
 *
 * `position()` is the single source of truth for "where are we in the file",
 * and everything — the seek bar, progress saving, the next-episode trigger —
 * reads from it, so neither mode needs special-casing anywhere else.
 */
import * as api from './api.js';
import { setState, locateFile, nextEpisode } from './state.js';
import { renderPlayer, toast, formatTime, esc, playIcon, pauseIcon, icon, episodeTag } from './views.js';

const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 2600;
const NEXT_UP_AT = 0.85;
const COUNTDOWN_SECONDS = 10;
const SKIP_SECONDS = 10;
const RESUME_MIN = 5;
const RESUME_MAX_RATIO = 0.95;

let ctx = null;

const root = () => document.getElementById('player-root');
const el = (id) => document.getElementById(id);

/* --------------------------------------------------------------------------
 * Position helpers
 * ----------------------------------------------------------------------- */

/** Absolute position in the file, whichever mode we are in. */
function position() {
  if (!ctx?.video) return 0;
  return ctx.offset + (ctx.video.currentTime || 0);
}

function duration() {
  if (!ctx) return 0;
  if (ctx.seekable && Number.isFinite(ctx.video?.duration) && ctx.video.duration > 0) {
    return ctx.video.duration;
  }
  return ctx.duration || 0;
}

/* --------------------------------------------------------------------------
 * Open / close
 * ----------------------------------------------------------------------- */

export async function open(filePath) {
  if (ctx) await close({ save: true });

  const located = locateFile(filePath);
  const title = located
    ? (located.type === 'episode' ? located.item.title : located.item.title)
    : filePath.split(/[\\/]/).pop();
  const subtitle = located && located.type === 'episode'
    ? `${episodeTag(located.season, located.episode.episode_number)}${located.episode.title ? ` · ${located.episode.title}` : ''}`
    : (located?.item?.year ? String(located.item.year) : '');

  // Probe, saved position and subtitle list in parallel — none depend on each other.
  const [info, saved, tracks] = await Promise.all([
    api.getStreamInfo(filePath).catch(() => null),
    api.getProgressFor(filePath).catch(() => null),
    api.listSubtitles(filePath).catch(() => [])
  ]);

  const seekable = info ? info.seekable !== false : true;
  const totalDuration = info?.duration || 0;

  let resumeAt = 0;
  if (saved && saved.position > RESUME_MIN) {
    const limit = (saved.duration || totalDuration) * RESUME_MAX_RATIO;
    if (!limit || saved.position < limit) resumeAt = saved.position;
  }

  const modeLabel = info && info.mode !== 'direct'
    ? `${info.mode === 'remux' ? 'Remux' : info.mode === 'remux-audio' ? 'Audio remux' : 'Transcode'}${info.lossless ? ' · lossless' : ''}`
    : null;

  root().innerHTML = renderPlayer({ title, subtitle, modeLabel, lossless: info?.lossless !== false });

  ctx = {
    filePath,
    located,
    info,
    seekable,
    duration: totalDuration,
    offset: 0,
    tracks: Array.isArray(tracks) ? tracks : [],
    // Subtitles load automatically when the file has any: external sidecars are
    // listed before embedded tracks, so [0] is the best available.
    activeTrack: (Array.isArray(tracks) && tracks[0]) || null,
    speed: 1,
    countdown: null,
    nextTarget: null,
    video: el('player-video'),
    node: el('player')
  };

  setState({ player: { open: true, src: filePath, subs: ctx.tracks, resumeAt } });

  buildMenu();
  attach();
  load(resumeAt, { autoplay: true });

  ctx.node.focus();
  document.addEventListener('keydown', onKeyDown);
}

export async function close({ save = true } = {}) {
  if (!ctx) return;

  if (save) await persist(true);

  document.removeEventListener('keydown', onKeyDown);
  clearInterval(ctx.saveTimer);
  clearTimeout(ctx.idleTimer);
  clearInterval(ctx.countdown);

  // Dropping the src stops the server-side ffmpeg process straight away.
  ctx.video.removeAttribute('src');
  ctx.video.load();

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  root().innerHTML = '';
  ctx = null;

  setState({ player: { open: false, src: '', subs: null, resumeAt: 0 } });
}

export const isOpen = () => ctx !== null;

/* --------------------------------------------------------------------------
 * Loading + seeking
 * ----------------------------------------------------------------------- */

function load(startAt = 0, { autoplay = true } = {}) {
  if (ctx.seekable) {
    // Byte-range mode: load once, then seek inside the element.
    if (!ctx.video.src) {
      ctx.video.src = api.streamUrl(ctx.filePath);
      ctx.offset = 0;
      if (startAt > 0) {
        ctx.video.addEventListener('loadedmetadata', () => { ctx.video.currentTime = startAt; }, { once: true });
      }
    } else if (startAt >= 0) {
      ctx.video.currentTime = startAt;
    }
  } else {
    // Pipe mode: the only way to seek is to restart ffmpeg at a timestamp.
    ctx.offset = Math.max(0, startAt);
    ctx.video.src = api.streamUrl(ctx.filePath, { start: ctx.offset });
    ctx.video.load();
  }

  if (autoplay) {
    ctx.video.play().catch(() => {
      // Autoplay can be refused; the user presses play and nothing is broken.
    });
  }
  applyTrack(ctx.activeTrack);
  tick();
}

function seekTo(seconds) {
  const total = duration();
  const target = Math.max(0, Math.min(total ? total - 1 : seconds, seconds));

  if (ctx.seekable) {
    ctx.video.currentTime = target;
  } else {
    const wasPlaying = !ctx.video.paused;
    load(target, { autoplay: wasPlaying });
  }
  tick();
}

export function skip(seconds) {
  if (!ctx) return;
  seekTo(position() + seconds);
}

/* --------------------------------------------------------------------------
 * UI sync
 * ----------------------------------------------------------------------- */

function tick() {
  if (!ctx) return;

  const total = duration();
  const current = position();

  el('time-current').textContent = formatTime(current);
  el('time-total').textContent = total ? formatTime(total) : '--:--';

  const seek = el('seek');
  const fraction = total > 0 ? Math.min(1, current / total) : 0;
  if (document.activeElement !== seek) seek.value = String(Math.round(fraction * 1000));
  seek.style.setProperty('--fill', (fraction * 100).toFixed(2));

  const playBtn = el('play-btn');
  playBtn.innerHTML = ctx.video.paused ? playIcon() : pauseIcon();
  playBtn.setAttribute('aria-label', ctx.video.paused ? 'Play' : 'Pause');

  maybeOfferNext(total, current);
}

function setVolumeUi() {
  const slider = el('volume');
  const value = ctx.video.muted ? 0 : ctx.video.volume * 100;
  slider.value = String(Math.round(value));
  slider.style.setProperty('--fill', value.toFixed(0));
  el('mute-btn').innerHTML = icon(ctx.video.muted || ctx.video.volume === 0 ? 'mute' : 'volume');
}

function markIdle() {
  if (!ctx) return;
  clearTimeout(ctx.idleTimer);
  ctx.node.classList.remove('is-idle');
  ctx.idleTimer = setTimeout(() => {
    if (ctx && !ctx.video.paused) ctx.node.classList.add('is-idle');
  }, IDLE_MS);
}

/* --------------------------------------------------------------------------
 * Subtitles + settings menu
 * ----------------------------------------------------------------------- */

function buildMenu() {
  const speeds = [0.75, 1, 1.25, 1.5, 2];
  el('menu-panel').innerHTML = `
    <div class="player__menu-group">
      <div class="player__menu-label">Subtitles</div>
      <button class="player__menu-item${ctx.activeTrack ? '' : ' is-active'}" data-action="set-subtitle" data-track="off">Off</button>
      ${ctx.tracks.map((track, index) => `
        <button class="player__menu-item${ctx.activeTrack === track ? ' is-active' : ''}" data-action="set-subtitle" data-track="${index}">
          ${esc(track.label || track.lang || 'Track')}${track.source === 'embedded' ? ' (embedded)' : ''}
        </button>`).join('')}
      ${ctx.tracks.length === 0 ? '<div class="player__menu-label">None found</div>' : ''}
    </div>
    <div class="player__menu-group">
      <div class="player__menu-label">Playback speed</div>
      ${speeds.map((speed) => `
        <button class="player__menu-item${ctx.speed === speed ? ' is-active' : ''}" data-action="set-speed" data-speed="${speed}">${speed}×</button>`).join('')}
    </div>`;
}

function applyTrack(track) {
  if (!ctx) return;

  for (const node of Array.from(ctx.video.querySelectorAll('track'))) node.remove();
  ctx.activeTrack = track || null;
  if (!track) return;

  const node = document.createElement('track');
  node.kind = 'subtitles';
  node.label = track.label || track.lang || 'Subtitles';
  if (track.lang) node.srclang = track.lang;
  node.src = api.subsUrl(ctx.filePath, track);
  node.default = true;
  ctx.video.appendChild(node);

  // The text track only exists once the element is attached.
  requestAnimationFrame(() => {
    const textTracks = ctx.video.textTracks;
    if (textTracks.length > 0) textTracks[textTracks.length - 1].mode = 'showing';
  });
}

export function setSubtitle(value) {
  if (!ctx) return;
  applyTrack(value === 'off' ? null : ctx.tracks[Number(value)]);
  buildMenu();
}

export function setSpeed(speed) {
  if (!ctx) return;
  ctx.speed = Number(speed);
  ctx.video.playbackRate = ctx.speed;
  buildMenu();
}

export function toggleMenu() {
  el('player-menu')?.classList.toggle('is-open');
}

/* --------------------------------------------------------------------------
 * Progress persistence
 * ----------------------------------------------------------------------- */

async function persist(final = false) {
  if (!ctx) return;
  const total = duration();
  const current = position();
  if (current < 1) return;

  const located = ctx.located;
  try {
    await api.saveProgress({
      file_path: ctx.filePath,
      position: current,
      duration: total,
      title: located?.item?.title,
      type: located?.type === 'episode' ? 'episode' : 'movie',
      tmdb_id: located?.item?.tmdb_id,
      parent_tmdb_id: located?.item?.tmdb_id,
      season_number: located?.season,
      episode_number: located?.episode?.episode_number
    });
    if (final) {
      const rows = await api.getContinueWatching().catch(() => null);
      if (rows) setState({ progress: rows });
    }
  } catch {
    // A dropped heartbeat is not worth interrupting playback for.
  }
}

/* --------------------------------------------------------------------------
 * Next episode
 * ----------------------------------------------------------------------- */

function maybeOfferNext(total, current) {
  if (!ctx || ctx.countdown || ctx.nextDismissed) return;
  if (!total || current / total < NEXT_UP_AT) return;
  if (!ctx.located || ctx.located.type !== 'episode') return;

  const next = nextEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);
  const box = el('next-up');

  if (!next) {
    if (!ctx.endShown) {
      ctx.endShown = true;
      el('next-up-title').textContent = 'End of series';
      box.querySelector('.next-up__label').textContent = 'Nothing else to play';
      box.querySelector('.next-up__actions').innerHTML =
        '<button class="btn btn--ghost" data-action="cancel-next">Dismiss</button>';
      box.hidden = false;
    }
    return;
  }

  ctx.nextTarget = next;
  el('next-up-title').textContent =
    `${episodeTag(next.season, next.episode.episode_number)} — ${next.episode.title || 'Next episode'}`;
  box.hidden = false;

  let remaining = COUNTDOWN_SECONDS;
  el('next-up-count').textContent = String(remaining);
  ctx.countdown = setInterval(() => {
    remaining -= 1;
    const counter = el('next-up-count');
    if (counter) counter.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) playNext();
  }, 1000);
}

export function playNext() {
  if (!ctx?.nextTarget) return;
  const file = (ctx.nextTarget.episode.files || [])[0];
  if (!file) return;
  const target = file.file_path;
  clearInterval(ctx.countdown);
  ctx.countdown = null;
  open(target);
}

export function cancelNext() {
  if (!ctx) return;
  clearInterval(ctx.countdown);
  ctx.countdown = null;
  ctx.nextDismissed = true;
  const box = el('next-up');
  if (box) box.hidden = true;
}

/* --------------------------------------------------------------------------
 * Events
 * ----------------------------------------------------------------------- */

function attach() {
  const { video, node } = ctx;

  video.addEventListener('timeupdate', tick);
  video.addEventListener('durationchange', tick);
  video.addEventListener('play', () => { tick(); markIdle(); });
  video.addEventListener('pause', () => { tick(); node.classList.remove('is-idle'); });
  video.addEventListener('volumechange', setVolumeUi);
  video.addEventListener('waiting', () => node.classList.add('is-buffering'));
  video.addEventListener('playing', () => node.classList.remove('is-buffering'));
  video.addEventListener('canplay', () => node.classList.remove('is-buffering'));
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);

  el('seek').addEventListener('input', (event) => {
    const total = duration();
    if (!total) return;
    const fraction = Number(event.target.value) / 1000;
    event.target.style.setProperty('--fill', (fraction * 100).toFixed(2));
    if (ctx.seekable) seekTo(fraction * total);
  });
  // In pipe mode, restarting ffmpeg on every drag frame would be brutal, so the
  // seek is applied once the user lets go.
  el('seek').addEventListener('change', (event) => {
    const total = duration();
    if (!total || ctx.seekable) return;
    seekTo((Number(event.target.value) / 1000) * total);
  });

  el('volume').addEventListener('input', (event) => {
    const value = Number(event.target.value) / 100;
    ctx.video.volume = value;
    ctx.video.muted = value === 0;
  });

  node.addEventListener('mousemove', markIdle);
  node.addEventListener('click', (event) => {
    // Clicking the video itself toggles playback; controls handle their own clicks.
    if (event.target === video) togglePlay();
  });

  ctx.saveTimer = setInterval(persist, SAVE_INTERVAL_MS);
  setVolumeUi();
  markIdle();
}

function onEnded() {
  if (ctx?.nextTarget) {
    playNext();
    return;
  }
  persist(true);
}

function onError() {
  if (!ctx) return;
  const mode = ctx.info?.mode || 'direct';
  const detail = mode === 'direct'
    ? 'Your browser could not decode this file. ffmpeg may not be installed.'
    : 'Playback failed while streaming.';
  toast('error', 'Cannot play this file', detail);
  ctx.node.classList.remove('is-buffering');
}

export function togglePlay() {
  if (!ctx) return;
  if (ctx.video.paused) ctx.video.play().catch(() => {});
  else ctx.video.pause();
}

export function toggleMute() {
  if (!ctx) return;
  ctx.video.muted = !ctx.video.muted;
}

export function toggleFullscreen() {
  if (!ctx) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else ctx.node.requestFullscreen?.().catch(() => {});
}

function adjustVolume(delta) {
  if (!ctx) return;
  ctx.video.muted = false;
  ctx.video.volume = Math.max(0, Math.min(1, ctx.video.volume + delta));
}

function onKeyDown(event) {
  if (!ctx) return;
  // Never hijack typing.
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (event.key === 'Escape') event.target.blur();
    return;
  }

  switch (event.key) {
    case ' ':
    case 'k': case 'K':
      event.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':
      event.preventDefault(); skip(-SKIP_SECONDS); break;
    case 'ArrowRight':
      event.preventDefault(); skip(SKIP_SECONDS); break;
    case 'ArrowUp':
      event.preventDefault(); adjustVolume(0.1); break;
    case 'ArrowDown':
      event.preventDefault(); adjustVolume(-0.1); break;
    case 'm': case 'M':
      toggleMute(); break;
    case 'f': case 'F':
      toggleFullscreen(); break;
    case 'n': case 'N':
      if (ctx.located?.type === 'episode') playNextImmediate(); break;
    case 'Escape':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else close({ save: true });
      break;
    default:
      break;
  }
  markIdle();
}

/** "N" should jump ahead even before the countdown has appeared. */
function playNextImmediate() {
  if (!ctx?.located || ctx.located.type !== 'episode') return;
  const next = ctx.nextTarget
    || nextEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);
  if (!next) {
    toast('info', 'End of series', 'There is no next episode in your library.');
    return;
  }
  const file = (next.episode.files || [])[0];
  if (file) open(file.file_path);
}

export default {
  open, close, isOpen, togglePlay, toggleMute, toggleFullscreen,
  skip, setSubtitle, setSpeed, toggleMenu, playNext, cancelNext
};
