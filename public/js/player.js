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
import {
  state, setState, locateFile, nextEpisode, previousEpisode, episodeRows, seasonNumbers
} from './state.js';
import { renderPlayer, toast, formatTime, esc, playIcon, pauseIcon, icon, episodeTag } from './views.js';
import { clampPicture, pictureFilter, loadPicture, savePicture, PICTURE_MIN, PICTURE_MAX } from './picture.js';
import { previewFraction, cardLeft, frameIndex } from './preview.js';

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
export const NEXT_UP_LEAD_SECONDS = 60;

/**
 * How long before the end the number starts ticking.
 *
 * The card itself appears a minute out so there is time to reach for Cancel,
 * but a number counting down from 60 is just noise. It runs in the last ten
 * seconds and reaches zero at the actual end of the episode - the advance is
 * NOT ten seconds after the card appears. Firing early is the bug fixed in
 * 45227d8 and it takes the ending, and any post-credits scene, with it.
 */
export const COUNTDOWN_WINDOW_SECONDS = 10;
const SKIP_SECONDS = 10;
export const DOUBLE_TAP_MS = 300;

/** Nudge sizes for the audio delay control. Cumulative, not absolute. */
/**
 * Nudge sizes for the audio delay control.
 *
 * No +/-5s any more: nothing in the library is out by that much, and the coarse
 * steps crowded out the fine ones you actually converge with. 0.01s is the
 * finest the offset can express - applyAudioOffset rounds to two decimals.
 */
export const AUDIO_OFFSET_STEPS = [-1, -0.5, -0.1, -0.05, -0.01, 0.01, 0.05, 0.1, 0.5, 1];
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
// open() awaits close(), so two rapid calls - a double-clicked next-episode
// button - can interleave and leave a half-built player behind.
let opening = false;

/* --------------------------------------------------------------------------
 * Next-episode timing (pure, so it can be tested without a DOM)
 * ----------------------------------------------------------------------- */

/** Is playback close enough to the end to offer the next episode? */
export function shouldOfferNext(total, current, lead = NEXT_UP_LEAD_SECONDS) {
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(current) || current < 0) return false;
  return (total - current) <= lead;
}

/** Is playback inside the final countdown window? */
export function shouldCountDown(total, current, window = COUNTDOWN_WINDOW_SECONDS) {
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(current)) return false;
  return (total - current) <= window;
}

/** Whole seconds of playback left, never negative. */
export function secondsRemaining(total, current) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(current)) return 0;
  return Math.max(0, Math.ceil(total - current));
}

const root = () => document.getElementById('player-root');

/* --------------------------------------------------------------------------
 * Route
 *
 * The player is its own screen rather than an overlay sitting on whatever page
 * you launched it from. It takes the #player hash while it is up and puts the
 * old one back on the way out, so browser Back leaves the player instead of
 * navigating the page underneath it.
 * ----------------------------------------------------------------------- */

export const PLAYER_HASH = 'player';

let previousHash = '';
/** Carried across an episode swap, where close() cannot restore it itself. */
let pendingScrollY = null;

function enterPlayerRoute() {
  if (window.location.hash.replace(/^#/, '') === PLAYER_HASH) return;
  previousHash = window.location.hash;
  window.location.hash = PLAYER_HASH;
}

function exitPlayerRoute() {
  if (window.location.hash.replace(/^#/, '') !== PLAYER_HASH) return;
  // Assigning rather than going back: the player may have been opened from a
  // deep link, in which case there is no history entry to return to.
  window.location.hash = previousHash.replace(/^#/, '') || 'home';
  previousHash = '';
}
const el = (id) => document.getElementById(id);

/* --------------------------------------------------------------------------
 * Position helpers
 * ----------------------------------------------------------------------- */

/** Absolute position in the file, whichever mode we are in. */
function position() {
  if (!ctx?.video) return 0;
  // While a seek is queued the element still holds the old stream's time, so
  // the target is the honest answer for the scrub bar and the saved progress.
  if (ctx.pendingSeek !== null && ctx.pendingSeek !== undefined) return ctx.pendingSeek;
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
  if (opening) return;
  opening = true;
  try {
    await openInner(filePath);
  } finally {
    opening = false;
  }
}

async function openInner(filePath) {
  // Everything slow happens BEFORE the old player is torn down.
  //
  // Closing first blanked the player and revealed whatever page was behind it,
  // then sat there for the length of a probe, a progress lookup and a subtitle
  // listing - a few hundred milliseconds of Home flashing up between episodes.
  // Gathering first turns the swap into one synchronous innerHTML assignment.
  const wasOpen = Boolean(ctx);

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

  // A tone-mapped file is a transcode, but saying so alone reads as an
  // unexplained quality loss. Name the actual reason instead.
  const modeLabel = info && info.mode !== 'direct'
    ? (info.tonemapped
      ? `HDR → SDR${info.tonemap_height ? ` · ${info.tonemap_height}p` : ''}`
      : `${info.mode === 'remux' ? 'Remux' : info.mode === 'remux-audio' ? 'Audio remux' : 'Transcode'}${info.lossless ? ' · lossless' : ''}`)
    : null;

  // The probe, progress and subtitle lookups are done; tear the old one down
  // now so the gap is a single synchronous swap rather than a network round
  // trip with the page behind showing through.
  if (wasOpen) await close({ save: true, keepPage: true });

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
    // Global, not per-file: brightness tracks the room, not the master.
    picture: loadPicture(),
    pendingSeek: null,
    seekTimer: null,
    wasPlayingBeforeSeek: null,
    advancing: false,
    nextTarget: null,
    video: el('player-video'),
    node: el('player')
  };

  setState({ player: { open: true, src: filePath, subs: ctx.tracks, resumeAt } });

  // The player is position:fixed, so the page behind it keeps its full scroll
  // height and the browser paints a scrollbar that moves nothing visible.
  // Remember where the page was, because locking and unlocking loses it.
  // On an episode swap the lock never lifted, so window.scrollY is meaningless
  // and the value handed over by the outgoing player is the real one.
  ctx.scrollY = pendingScrollY ?? window.scrollY;
  pendingScrollY = null;
  document.documentElement.classList.add('is-player-open');
  enterPlayerRoute();

  ctx.video.style.filter = pictureFilter(ctx.picture);
  ctx.epSeason = ctx.located?.type === 'episode' ? ctx.located.season : null;
  ctx.thumbs = { interval: 0, total: 0, ready: false, wanted: -1, frames: new Map() };

  buildMenu();
  buildEpisodes();

  // Deliberately not awaited: opening the player must never wait on ffmpeg.
  loadThumbMeta();
  attach();
  load(resumeAt, { autoplay: true });

  ctx.node.focus();
  document.addEventListener('keydown', onKeyDown);
}

/**
 * Tear the player down.
 *
 * `keepPage` is set when one episode is replacing another: the scroll lock and
 * the route belong to "a player is on screen", which is still true across a
 * swap. Releasing and reacquiring them mid-swap makes the page jump.
 */
export async function close({ save = true, keepPage = false } = {}) {
  if (!ctx) return;

  if (save) await persist(true);

  document.removeEventListener('keydown', onKeyDown);
  if (ctx.outsideClick) document.removeEventListener('click', ctx.outsideClick, true);
  clearInterval(ctx.saveTimer);
  clearTimeout(ctx.idleTimer);
  clearTimeout(ctx.seekTimer);
  clearTimeout(ctx.thumbRetry);

  // Dropping the src stops the server-side ffmpeg process straight away.
  ctx.video.removeAttribute('src');
  ctx.video.load();

  // Leaving fullscreen on an episode swap would drop you back to a window
  // mid-binge. Only a real exit gives it up.
  if (!keepPage && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  root().innerHTML = '';

  const restoreTo = ctx.scrollY || 0;
  ctx = null;

  if (keepPage) {
    // Hand the scroll position to the incoming player so it still restores
    // correctly when that one is finally closed for real.
    pendingScrollY = restoreTo;
    return;
  }

  document.documentElement.classList.remove('is-player-open');
  window.scrollTo(0, restoreTo);
  exitPlayerRoute();

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

/**
 * How long to wait before actually restarting ffmpeg on a seek.
 *
 * Every pipe-mode seek kills and respawns ffmpeg, so holding an arrow key used
 * to spawn one process per keypress and each one had to be torn down again.
 * Coalescing means a burst of presses costs a single restart at the final
 * position; the scrub bar still tracks every press immediately.
 */
const SEEK_COALESCE_MS = 220;

function seekTo(seconds) {
  const total = duration();
  const target = Math.max(0, Math.min(total ? total - 1 : seconds, seconds));

  if (ctx.seekable) {
    ctx.video.currentTime = target;
    tick();
    return;
  }

  // Pipe mode: show the new position at once, but let a burst of presses
  // settle before paying for an ffmpeg restart.
  ctx.pendingSeek = target;
  ctx.offset = target;
  ctx.video.classList.add('is-seeking');
  tick();

  clearTimeout(ctx.seekTimer);
  ctx.seekTimer = setTimeout(() => {
    if (!ctx) return;
    const wasPlaying = ctx.wasPlayingBeforeSeek ?? !ctx.video.paused;
    ctx.wasPlayingBeforeSeek = null;
    const to = ctx.pendingSeek;
    ctx.pendingSeek = null;
    ctx.video.classList.remove('is-seeking');
    load(to, { autoplay: wasPlaying });
  }, SEEK_COALESCE_MS);

  if (ctx.wasPlayingBeforeSeek === null || ctx.wasPlayingBeforeSeek === undefined) {
    ctx.wasPlayingBeforeSeek = !ctx.video.paused;
  }
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
  setFill(fraction * 100);

  const playBtn = el('play-btn');
  playBtn.innerHTML = ctx.video.paused ? playIcon() : pauseIcon();
  playBtn.setAttribute('aria-label', ctx.video.paused ? 'Play' : 'Pause');

  if (ctx.nextTarget && !shouldOfferNext(total, current)) withdrawNextOffer();
  maybeOfferNext(total, current);
}

/**
 * Write the played-so-far percentage.
 *
 * It goes on the wrapper as well as the input because the landing band has to
 * compare --fill against --preview, and CSS can only do that when both live on
 * the same element. Both are bare numbers, consumed as calc(var(--x) * 1%).
 */
function setFill(percent) {
  const value = percent.toFixed(2);
  el('seek')?.style.setProperty('--fill', value);
  el('scrub')?.style.setProperty('--fill', value);
}

/* --------------------------------------------------------------------------
 * Seek preview
 * ----------------------------------------------------------------------- */

/** Show the ball, band and card at a fraction along the track. */
function showPreview(fraction) {
  const scrub = el('scrub');
  const card = el('preview-card');
  if (!scrub || !card) return;

  const percent = fraction * 100;
  scrub.style.setProperty('--preview', percent.toFixed(2));
  // The band spans between the two points, so it needs to know which side of
  // playback the cursor is on to pick its anchor edge.
  scrub.classList.toggle('is-behind', percent < (Number(scrub.style.getPropertyValue('--fill')) || 0));
  scrub.classList.add('is-previewing');

  const total = duration();
  el('preview-time').textContent = Number.isFinite(total) && total > 0
    ? formatTime(fraction * total)
    : '--:--';

  const trackWidth = scrub.getBoundingClientRect().width;
  const cardWidth = card.getBoundingClientRect().width;
  card.style.left = `${cardLeft(fraction, trackWidth, cardWidth)}px`;

  showPreviewFrame(fraction, total);
}

function hidePreview() {
  el('scrub')?.classList.remove('is-previewing');
}

/**
 * Put the frame for this position into the card.
 *
 * Loaded through an Image probe rather than assigned to background-image
 * directly, so a frame that has not been generated yet leaves the box empty
 * instead of flashing a broken image. `wanted` guards against a slow frame
 * landing after the cursor has already moved somewhere else.
 */
function showPreviewFrame(fraction, total) {
  const frame = el('preview-frame');
  const thumbs = ctx?.thumbs;
  if (!frame || !thumbs || !thumbs.interval) return;
  if (!Number.isFinite(total) || total <= 0) return;

  const index = Math.min(
    frameIndex(fraction * total, thumbs.interval),
    Math.max(0, thumbs.total - 1)
  );
  thumbs.wanted = index;

  const known = thumbs.frames.get(index);
  if (known === 'missing') { frame.style.backgroundImage = ''; return; }

  const url = api.thumbUrl(ctx.filePath, index);
  if (known === 'ok') { frame.style.backgroundImage = `url("${url}")`; return; }

  const probe = new Image();
  probe.onload = () => {
    thumbs.frames.set(index, 'ok');
    if (ctx?.thumbs === thumbs && thumbs.wanted === index) {
      frame.style.backgroundImage = `url("${url}")`;
    }
  };
  probe.onerror = () => {
    // Remembered so a partially generated file does not re-request the same
    // missing frame on every pixel of cursor movement.
    thumbs.frames.set(index, 'missing');
    if (ctx?.thumbs === thumbs && thumbs.wanted === index) frame.style.backgroundImage = '';
  };
  probe.src = url;
}

/**
 * Thumbnail availability for the open file.
 *
 * Absent, still generating, or a missing individual frame all land on the same
 * behaviour: the card shows its timestamp and no picture. Nothing here can fail
 * in a way the user has to see.
 */
async function loadThumbMeta() {
  if (!ctx) return;
  const thumbs = ctx.thumbs;

  try {
    const response = await fetch(api.thumbMetaUrl(ctx.filePath));
    if (!response.ok) return;
    const meta = await response.json();
    if (!ctx || ctx.thumbs !== thumbs) return;

    thumbs.interval = meta.interval;
    thumbs.total = meta.total;
    thumbs.ready = meta.ready;

    // Frames that were missing a moment ago may exist now; forget those misses
    // but keep the hits, which cannot become wrong.
    for (const [index, status] of thumbs.frames) {
      if (status === 'missing') thumbs.frames.delete(index);
    }

    // A file opened for the first time reports ready:false while ffmpeg works.
    // Ask once more so sitting still eventually gets frames.
    if (!thumbs.ready) ctx.thumbRetry = setTimeout(loadThumbMeta, 20000);
  } catch {
    // No thumbnails this session. The timestamp still works.
  }
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
    // A panel left open over a hidden control bar floats unanchored.
    if (ctx && !ctx.video.paused) {
      closePopovers();
      ctx.node.classList.add('is-idle');
    }
  }, IDLE_MS);
}

/* --------------------------------------------------------------------------
 * Subtitles + settings menu
 * ----------------------------------------------------------------------- */

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function buildSubsPopover() {
  el('popover-subs').innerHTML = `
    <div class="player__menu-label">Subtitles</div>
    <button class="player__menu-item${ctx.activeTrack ? '' : ' is-active'}" data-action="set-subtitle" data-track="off">Off</button>
    ${ctx.tracks.map((track, index) => `
      <button class="player__menu-item${ctx.activeTrack === track ? ' is-active' : ''}" data-action="set-subtitle" data-track="${index}">
        ${esc(track.label || track.lang || 'Track')}${track.source === 'embedded' ? ' (embedded)' : ''}
      </button>`).join('')}
    ${ctx.tracks.length === 0 ? '<div class="player__menu-label">None found</div>' : ''}`;
}

function buildSyncPopover() {
  el('popover-sync').innerHTML = `
    <div class="player__menu-label">Audio delay</div>
    <div class="audiodelay__head">
      <span class="audiodelay__value t-num">${ctx.audioOffset > 0 ? '+' : ''}${ctx.audioOffset.toFixed(2)}s</span>
      <button class="audiodelay__reset" data-action="audio-reset">Reset</button>
    </div>
    <div class="audiodelay__hint">Positive delays the audio</div>
    <div class="audiodelay__grid">
      ${AUDIO_OFFSET_STEPS.map((step) => `
        <button class="audiodelay__step" data-action="audio-nudge" data-delta="${step}">${step > 0 ? '+' : ''}${step}s</button>`).join('')}
    </div>`;
}

function buildSpeedPopover() {
  el('popover-speed').innerHTML = `
    <div class="player__menu-label">Playback speed</div>
    ${SPEEDS.map((speed) => `
      <button class="player__menu-item${ctx.speed === speed ? ' is-active' : ''}" data-action="set-speed" data-speed="${speed}">${speed}&times;</button>`).join('')}`;
  const rate = el('rate-btn');
  if (rate) rate.innerHTML = `${ctx.speed}&times;`;
}

function buildPicturePopover() {
  el('popover-picture').innerHTML = `
    <div class="player__menu-label">Picture</div>
    <div class="picture__row">
      <span class="picture__name">Brightness</span>
      <span class="picture__value t-num" id="brightness-value">${ctx.picture.brightness}%</span>
    </div>
    <input class="range range--picture" id="brightness" type="range"
      min="${PICTURE_MIN}" max="${PICTURE_MAX}" value="${ctx.picture.brightness}" aria-label="Brightness">
    <div class="picture__row">
      <span class="picture__name">Contrast</span>
      <span class="picture__value t-num" id="contrast-value">${ctx.picture.contrast}%</span>
    </div>
    <input class="range range--picture" id="contrast" type="range"
      min="${PICTURE_MIN}" max="${PICTURE_MAX}" value="${ctx.picture.contrast}" aria-label="Contrast">
    <button class="audiodelay__reset" data-action="picture-reset">Reset</button>`;
}

/** Rebuild every popover. Cheap, and keeps the four in step with ctx. */
function buildMenu() {
  buildSubsPopover();
  buildSyncPopover();
  buildSpeedPopover();
  buildPicturePopover();
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

/* --------------------------------------------------------------------------
 * Episode sidebar
 * ----------------------------------------------------------------------- */

/** Only shows get a sidebar; a movie has nothing to list. */
function hasEpisodes() {
  return Boolean(ctx?.located && ctx.located.type === 'episode');
}

function buildEpisodes() {
  const arrow = el('ep-arrow');
  if (arrow) arrow.hidden = !hasEpisodes();
  if (!hasEpisodes()) return;

  // Stop the panel above the control bar so the settings buttons and
  // fullscreen stay reachable while it is open. Measured rather than hardcoded
  // so it keeps working if the bar's contents ever change height.
  const controls = ctx.node.querySelector('.player__controls');
  if (controls) {
    const height = Math.round(controls.getBoundingClientRect().height);
    if (height > 0) ctx.node.style.setProperty('--controls-h', `${height}px`);
  }

  const show = ctx.located.item;
  const seasons = seasonNumbers(show);
  const selected = ctx.epSeason ?? ctx.located.season;

  el('ep-show').textContent = show.title || 'Episodes';

  // Tabs render even for a one-season show, so the header does not change
  // shape between shows.
  el('ep-tabs').innerHTML = seasons.map((number) => `
    <button class="player__ep-tab${number === selected ? ' is-active' : ''}"
      data-action="select-season" data-season="${number}">S${number}</button>`).join('');

  const rows = episodeRows(show, selected, ctx.located.season, ctx.located.episode.episode_number);
  el('ep-list').innerHTML = rows.length === 0
    ? '<div class="player__menu-label">No episodes in this season</div>'
    : rows.map((row) => `
      <button class="player__ep-row${row.current ? ' is-current' : ''}${row.playable ? '' : ' is-missing'}"
        ${row.playable ? `data-action="play-episode" data-path="${esc(row.filePath)}"` : 'disabled'}>
        <span class="player__ep-still">
          ${row.still ? `<img src="${esc(row.still)}" alt="" loading="lazy">` : ''}
          <span class="player__ep-num t-num">${row.episode_number}</span>
          ${row.current ? '<span class="player__ep-now"></span>' : ''}
        </span>
        <span class="player__ep-text">
          <span class="player__ep-name">${esc(row.title || 'Untitled')}</span>
          ${row.overview ? `<span class="player__ep-desc">${esc(row.overview)}</span>` : ''}
          ${row.playable ? '' : '<span class="player__ep-desc">Not in your library</span>'}
        </span>
      </button>`).join('');
}

export function toggleEpisodes() {
  const panel = el('ep-panel');
  if (!panel || !hasEpisodes()) return;
  closePopovers();
  const opening = panel.hidden;
  panel.hidden = !opening;
  ctx.node.classList.toggle('is-episodes-open', opening);
  if (opening) {
    ctx.epSeason = ctx.located.season;
    buildEpisodes();
    el('ep-list')?.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
    // With nine seasons the active tab is often off the end of the strip.
    el('ep-tabs')?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

export function closeEpisodes() {
  const panel = el('ep-panel');
  if (panel) panel.hidden = true;
  ctx?.node.classList.remove('is-episodes-open');
}

export function selectSeason(number) {
  if (!ctx) return;
  ctx.epSeason = Number(number);
  buildEpisodes();
}

/* --------------------------------------------------------------------------
 * Setting popovers
 * ----------------------------------------------------------------------- */

const POPOVERS = ['subs', 'sync', 'speed', 'picture'];

/** Close every popover. Safe to call when none is open. */
export function closePopovers() {
  for (const name of POPOVERS) {
    const panel = el(`popover-${name}`);
    if (panel) panel.hidden = true;
  }
}

/**
 * Open one popover, closing the others.
 *
 * Exclusive by construction rather than by CSS: four panels open at once over
 * a 1440px control bar would overlap each other, and only one can be the one
 * you meant to open.
 */
export function togglePopover(name) {
  const panel = el(`popover-${name}`);
  if (!panel) return;
  const wasOpen = !panel.hidden;
  closePopovers();
  panel.hidden = wasOpen;
}

/**
 * Apply and store a picture setting. A repaint, not a stream restart.
 *
 * This deliberately does NOT rebuild the popover. Replacing the panel's
 * innerHTML would destroy the very slider being dragged, and the drag would
 * die after its first input event - the same failure that once killed typing
 * in the search box. Only the readouts and the slider positions are touched.
 */
export function setPicture({ brightness, contrast }) {
  if (!ctx) return;
  ctx.picture = { brightness: clampPicture(brightness), contrast: clampPicture(contrast) };
  ctx.video.style.filter = pictureFilter(ctx.picture);
  savePicture(ctx.picture);

  const label = (id, value) => {
    const node = el(id);
    if (node) node.textContent = `${value}%`;
  };
  label('brightness-value', ctx.picture.brightness);
  label('contrast-value', ctx.picture.contrast);

  // Keep the sliders in step when the change came from Reset rather than a drag.
  for (const [id, value] of [['brightness', ctx.picture.brightness], ['contrast', ctx.picture.contrast]]) {
    const input = el(id);
    if (input && document.activeElement !== input && Number(input.value) !== value) {
      input.value = String(value);
    }
  }
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
  const label = box.querySelector('.next-up__label');

  if (shouldCountDown(total, current)) {
    // Plain text for the last ten seconds only. Rebuilding the span each tick
    // is cheap and avoids caring whether it already exists.
    if (label) label.innerHTML = `Up next in <span id="next-up-count">${left}</span>s`;
  } else if (label && label.textContent !== 'Up next') {
    label.textContent = 'Up next';
  }

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

/** Jump to the previous playable episode, if there is one. */
export function playPrevious() {
  if (!ctx?.located || ctx.located.type !== 'episode' || ctx.advancing) {
    toast('info', 'No previous episode', 'This is not a show.');
    return;
  }
  const prev = previousEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);
  if (!prev) {
    toast('info', 'Start of series', 'There is nothing before this in your library.');
    return;
  }
  const file = (prev.episode.files || [])[0];
  if (file) open(file.file_path);
}

/** "Next episode" from the control bar, ignoring the up-next countdown. */
export function playNextEpisode() {
  if (!ctx?.located || ctx.located.type !== 'episode' || ctx.advancing) {
    toast('info', 'No next episode', 'This is not a show.');
    return;
  }
  const next = ctx.nextTarget
    || nextEpisode(ctx.located.item, ctx.located.season, ctx.located.episode.episode_number);
  if (!next) {
    toast('info', 'End of series', 'There is no next episode in your library.');
    return;
  }
  const file = (next.episode.files || [])[0];
  if (file) open(file.file_path);
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
    setFill(fraction * 100);
    if (ctx.seekable) seekTo(fraction * total);
  });
  // In pipe mode, restarting ffmpeg on every drag frame would be brutal, so the
  // seek is applied once the user lets go.
  el('seek').addEventListener('change', (event) => {
    const total = duration();
    if (!total || ctx.seekable) return;
    seekTo((Number(event.target.value) / 1000) * total);
  });

  const scrub = el('scrub');
  scrub.addEventListener('pointermove', (event) => {
    const rect = scrub.getBoundingClientRect();
    showPreview(previewFraction(event.clientX - rect.left, rect.width));
  });
  scrub.addEventListener('pointerleave', hidePreview);
  // Touch has no hover, so the preview follows the finger through a drag and
  // clears when it lifts.
  scrub.addEventListener('pointerup', hidePreview);
  scrub.addEventListener('pointercancel', hidePreview);

  el('volume').addEventListener('input', (event) => {
    const value = Number(event.target.value) / 100;
    ctx.video.volume = value;
    ctx.video.muted = value === 0;
  });

  // Bound on the panel, not the inputs: setPicture rebuilds the panel, which
  // would replace listeners attached to the sliders themselves mid-drag.
  el('popover-picture').addEventListener('input', (event) => {
    const input = event.target;
    if (input.id !== 'brightness' && input.id !== 'contrast') return;
    setPicture({ ...ctx.picture, [input.id]: Number(input.value) });
  });

  /**
   * Let a vertical wheel scroll the season strip sideways.
   *
   * The strip is a horizontal overflow container, but a mouse wheel only emits
   * deltaY, so without this it looked scrollable and refused to move. deltaX is
   * preferred when a trackpad supplies it.
   */
  el('ep-tabs').addEventListener('wheel', (event) => {
    const strip = event.currentTarget;
    if (strip.scrollWidth <= strip.clientWidth) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    strip.scrollLeft += delta;
  }, { passive: false });

  /**
   * Dismiss panels on an outside click.
   *
   * Registered in the CAPTURE phase, which is load-bearing. The app's delegated
   * click handler runs on the bubble phase, and some of its actions - picking a
   * season, for one - rebuild the panel's innerHTML. That detaches the very
   * node that was clicked, so a bubble-phase `closest` call would walk an
   * orphaned subtree, match nothing, conclude the click was outside, and close
   * the panel the user just interacted with. Capturing runs this while the
   * target is still in the tree.
   */
  ctx.outsideClick = (event) => {
    if (!ctx) return;
    if (!event.target.closest('.player__pop')) closePopovers();
    if (!event.target.closest('.player__episodes, .player__eparrow')) closeEpisodes();
  };
  document.addEventListener('click', ctx.outsideClick, true);

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
      // Peel one layer at a time: sidebar, then popovers, then fullscreen,
      // then the player itself. Closing everything at once would make Escape
      // unusable for dismissing a panel you opened by mistake.
      if (!el('ep-panel')?.hidden) closeEpisodes();
      else if (POPOVERS.some((name) => el(`popover-${name}`) && !el(`popover-${name}`).hidden)) closePopovers();
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
  skip, setSubtitle, setSpeed, togglePopover, closePopovers, setPicture,
  playNext, cancelNext
};
