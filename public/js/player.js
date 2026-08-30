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
import { state, setState, locateFile, nextEpisode } from './state.js';
import { renderPlayer, toast, formatTime, esc, playIcon, pauseIcon, icon, episodeTag } from './views.js';

const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 2600;
/**
 * How close to the end the "up next" card appears, in seconds.
 *
 * This used to be a fraction of the running time (0.85), which is the wrong
 * unit: 15% of a 22-minute episode is 3m19s, so the card appeared — and ten
 * seconds later auto-advanced — while a fifth of the episode was still to
 * play, taking the ending and the post-credits scene with it. The same 15% on
 * a three-hour film would have been 27 minutes. Distance from the end behaves
 * the same whatever the runtime.
 */
export const NEXT_UP_LEAD_SECONDS = 45;
const SKIP_SECONDS = 10;
export const DOUBLE_TAP_MS = 300;

/** Nudge sizes for the audio delay control. Cumulative, not absolute. */
export const AUDIO_OFFSET_STEPS = [-5, -1, -0.5, -0.1, -0.05, 0.05, 0.1, 0.5, 1, 5];
const MAX_AUDIO_OFFSET = 30;

/**
 * Which zone of the video surface a tap landed in.
 * The outer zones seek; the centre toggles the chrome.
 *
 * Must stay in step with .player__ripple's width in player.css - the ripple is
 * the only feedback the viewer gets, so a hit zone wider than the flash would
 * seek from somewhere that never lights up.
 */
export const TAP_ZONE_RATIO = 0.3;

export function classifyTap(x, width) {
  if (!Number.isFinite(width) || width <= 0) return 'centre';
  const edge = width * TAP_ZONE_RATIO;
  if (x < edge) return 'left';
  if (x >= width - edge) return 'right';
  return 'centre';
}
const RESUME_MIN = 5;
const RESUME_MAX_RATIO = 0.95;

let ctx = null;

/* --------------------------------------------------------------------------
 * Next-episode timing (pure, so it can be tested without a DOM)
 * ----------------------------------------------------------------------- */

/** Is playback close enough to the end to offer the next episode? */
export function shouldOfferNext(total, current, lead = NEXT_UP_LEAD_SECONDS) {
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(current) || current < 0) return false;
  return (total - current) <= lead;
}

/** Whole seconds of playback left, never negative. */
export function secondsRemaining(total, current) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(current)) return 0;
  return Math.max(0, Math.ceil(total - current));
}

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
    nativeSeekable: seekable,
    duration: totalDuration,
    offset: 0,
    tracks: Array.isArray(tracks) ? tracks : [],
    // Subtitles load automatically when the file has any: external sidecars are
    // listed before embedded tracks, so [0] is the best available.
    activeTrack: (Array.isArray(tracks) && tracks[0]) || null,
    speed: 1,
    audioOffset: (saved && Number(saved.audio_offset)) || 0,
    advancing: false,
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

  // Dropping the src stops the server-side ffmpeg process straight away.
  ctx.video.removeAttribute('src');
  ctx.video.load();

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  root().innerHTML = '';
  ctx = null;

  setState({ player: { open: false, src: '', subs: null, resumeAt: 0, audioOffset: 0 } });
}

export const isOpen = () => ctx !== null;

/* --------------------------------------------------------------------------
 * Loading + seeking
 * ----------------------------------------------------------------------- */

function load(startAt = 0, { autoplay = true } = {}) {
  if (ctx.seekable) {
    // Byte-range mode: load once, then seek inside the element.
    if (!ctx.video.src) {
      ctx.video.src = api.streamUrl(ctx.filePath, { audioOffset: ctx.audioOffset });
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
    ctx.video.src = api.streamUrl(ctx.filePath, { start: ctx.offset, audioOffset: ctx.audioOffset });
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

  if (ctx.nextTarget && !shouldOfferNext(total, current)) withdrawNextOffer();
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
      <div class="player__menu-label">Audio delay</div>
      <div class="audiodelay__head">
        <span class="audiodelay__value t-num">${ctx.audioOffset > 0 ? '+' : ''}${ctx.audioOffset.toFixed(2)}s</span>
        <button class="audiodelay__reset" data-action="audio-reset">Reset</button>
      </div>
      <div class="audiodelay__hint">Positive delays the audio</div>
      <div class="audiodelay__grid">
        ${AUDIO_OFFSET_STEPS.map((step) => `
          <button class="audiodelay__step" data-action="audio-nudge" data-delta="${step}">${step > 0 ? '+' : ''}${step}s</button>`).join('')}
      </div>
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

/**
 * Nudge the audio offset and restart the stream where we are.
 *
 * Cumulative, not absolute: tapping +0.1s twice lands on +0.20s. Converging by
 * ear is the whole point, and it is how VLC and mpv behave.
 */
export function nudgeAudioOffset(delta) {
  if (!ctx) return;
  const next = Math.max(-MAX_AUDIO_OFFSET, Math.min(MAX_AUDIO_OFFSET,
    Number((ctx.audioOffset + Number(delta)).toFixed(2))));
  applyAudioOffset(next);
}

export function resetAudioOffset() {
  if (!ctx) return;
  applyAudioOffset(0);
}

function applyAudioOffset(value) {
  if (!ctx || value === ctx.audioOffset) return;
  ctx.audioOffset = value;

  // The offset lives in the ffmpeg command, so it can only change by restarting
  // the stream - the same mechanic as seeking in pipe mode. A non-zero offset
  // always forces ffmpeg, so this is never byte-range seekable while it is set.
  const at = position();
  const wasPlaying = !ctx.video.paused;
  ctx.seekable = value === 0 ? ctx.nativeSeekable : false;
  ctx.video.removeAttribute('src');
  load(at, { autoplay: wasPlaying });

  persist().catch(() => {});
  buildMenu();
  setState({ player: { ...state.player, audioOffset: value } });
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
      episode_number: located?.episode?.episode_number,
      audio_offset: ctx.audioOffset
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
  if (!ctx || ctx.nextDismissed) return;
  if (!ctx.located || ctx.located.type !== 'episode') return;
  if (!shouldOfferNext(total, current)) return;

  const box = el('next-up');
  if (!box) return;

  const next = ctx.nextTarget
    || nextEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);

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

  if (!ctx.nextTarget) {
    ctx.nextTarget = next;
    el('next-up-title').textContent =
      `${episodeTag(next.season, next.episode.episode_number)} — ${next.episode.title || 'Next episode'}`;
    box.hidden = false;
  }

  // The counter tracks real playback rather than wall-clock time, so pausing
  // pauses it and seeking backwards takes the card away again. The old version
  // ran a setInterval that advanced regardless of what the video was doing.
  const left = secondsRemaining(total, current);
  const counter = el('next-up-count');
  if (counter) counter.textContent = String(left);

  // Advance only once the episode has actually finished. `ended` handles the
  // usual case, but in ffmpeg pipe mode the element's duration is Infinity and
  // `ended` can fail to fire, so this is the backstop.
  if (left <= 0) playNext();
}

/** Hide the up-next card and forget the target, e.g. after seeking back. */
function withdrawNextOffer() {
  if (!ctx || !ctx.nextTarget) return;
  ctx.nextTarget = null;
  const box = el('next-up');
  if (box) box.hidden = true;
}

export function playNext() {
  if (!ctx?.nextTarget || ctx.advancing) return;
  const file = (ctx.nextTarget.episode.files || [])[0];
  if (!file) return;
  // `ended` and the tick backstop can both land on the same frame; open() is
  // async, so without this the next episode gets opened twice.
  ctx.advancing = true;
  open(file.file_path);
}

export function cancelNext() {
  if (!ctx) return;
  ctx.nextDismissed = true;
  ctx.nextTarget = null;
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
    // Clicking the video itself toggles playback; controls handle their own
    // clicks. Touch is handled by the gesture block below instead.
    if (event.target === video && event.pointerType !== 'touch') togglePlay();
  });

  /* ---- touch gestures ---- */
  let lastTapAt = 0;
  let lastTapZone = null;

  const flashRipple = (zone) => {
    const ripple = el(zone === 'left' ? 'ripple-l' : 'ripple-r');
    if (!ripple) return;
    ripple.classList.remove('is-on');
    void ripple.offsetWidth;   // restart the animation
    ripple.classList.add('is-on');
  };

  video.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;   // mouse keeps click-to-pause

    const rect = video.getBoundingClientRect();
    const zone = classifyTap(event.clientX - rect.left, rect.width);
    const now = Date.now();
    const isDouble = (now - lastTapAt) < DOUBLE_TAP_MS && lastTapZone === zone;

    if (isDouble && zone !== 'centre') {
      skip(zone === 'left' ? -SKIP_SECONDS : SKIP_SECONDS);
      flashRipple(zone);
      lastTapAt = 0;
      lastTapZone = null;
      return;
    }

    lastTapAt = now;
    lastTapZone = zone;

    // A single tap toggles the chrome, but only once the double-tap window has
    // closed - otherwise every seek also flickers the controls on and off.
    setTimeout(() => {
      if (lastTapAt !== now) return;
      if (node.classList.contains('is-idle')) markIdle();
      else node.classList.add('is-idle');
    }, DOUBLE_TAP_MS);
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
    case '[':
      event.preventDefault(); nudgeAudioOffset(-0.05); break;
    case ']':
      event.preventDefault(); nudgeAudioOffset(0.05); break;
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
  if (!ctx?.located || ctx.located.type !== 'episode' || ctx.advancing) return;
  const next = ctx.nextTarget
    || nextEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);
  if (!next) {
    toast('info', 'End of series', 'There is no next episode in your library.');
    return;
  }
  const file = (next.episode.files || [])[0];
  if (!file) return;
  // Same guard as playNext: open() is async, and pressing N on the final frame
  // could otherwise race the tick backstop into opening two players.
  ctx.advancing = true;
  open(file.file_path);
}

export default {
  open, close, isOpen, togglePlay, toggleMute, toggleFullscreen,
  skip, setSubtitle, setSpeed, toggleMenu, playNext, cancelNext
};
