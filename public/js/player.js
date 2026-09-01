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
import { attachHls } from './hls-player.js';

const SAVE_INTERVAL_MS = 5000;
const IDLE_MS = 2600;
/*
 * Touch gets longer. 2.6s is fine when a mouse can bring the controls back by
 * moving a pixel, but on a phone every recall costs a deliberate tap, and the
 * controls kept vanishing before they could be used.
 */
const TOUCH_IDLE_MS = 5200;
/*
 * A tap produces a pointerup and then, on Safari, a synthetic click. Clicks
 * arriving within this window of a touch belong to that touch, not a mouse.
 */
const CLICK_AFTER_TOUCH_MS = 700;
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

/**
 * What a tap should do.
 *
 * The rule that matters: a tap on a video whose controls are hidden only
 * reveals them. It used to reveal the controls AND toggle playback, so opening
 * the overlay to check where you were also stopped the show — and the reveal
 * then fought the auto-hide, leaving the controls up for about a second.
 *
 * Acting on playback needs a second, deliberate tap once you can actually see
 * what you are tapping.
 */
export function tapAction({ chromeHidden, zone, isDouble }) {
  // Seeking wins outright: a double tap at the edge is unambiguous, and having
  // it depend on whether the chrome happened to be up would make it unreliable.
  if (isDouble && zone !== 'centre') return 'seek';
  if (chromeHidden) return 'reveal';
  return 'toggle';
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

/** Absolute position in the file. Every delivery path reports it directly. */
function position() {
  if (!ctx?.video) return 0;
  return ctx.video.currentTime || 0;
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
  // unexplained quality loss. Name the actual reason instead. A cached MP4 is
  // the good case - native seeking, no ffmpeg - so it says so rather than
  // borrowing the word "transcode" from the path it replaced.
  const modeLabel = !info || info.mode === 'direct' ? null
    : info.mode === 'cached-copy' ? 'Cached · lossless'
    : info.mode === 'cached-h264' ? 'Cached · 1080p'
    : info.tonemapped ? `HDR → SDR${info.tonemap_height ? ` · ${info.tonemap_height}p` : ''}`
    : `${info.mode === 'remux' ? 'Remux' : info.mode === 'remux-audio' ? 'Audio remux' : 'Transcode'}${info.lossless ? ' · lossless' : ''}`;

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
    duration: totalDuration,
    tracks: Array.isArray(tracks) ? tracks : [],
    // Subtitles load automatically when the file has any: external sidecars are
    // listed before embedded tracks, so [0] is the best available.
    activeTrack: (Array.isArray(tracks) && tracks[0]) || null,
    speed: 1,
    audioOffset: (saved && Number(saved.audio_offset)) || 0,
    // Which audio stream of the file to decode. The server re-encodes the
    // chosen one, so changing it means a new stream, exactly like the delay.
    audioIndex: 0,
    // Global, not per-file: brightness tracks the room, not the master.
    picture: loadPicture(),
    // Set by the touch handlers; read by markIdle to choose its timing and by
    // the click guard to ignore the synthetic click that follows a tap.
    lastTouchAt: 0,
    scrubbing: false,
    detachHls: null,
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

  /*
   * The stream URL is fetched in parallel with the saved progress, so it cannot
   * carry a delay that is only known once that progress arrives. Rather than
   * serialise two round trips on every open — the common case has no delay —
   * the rare file that does have one re-opens its stream once.
   */
  if (ctx.audioOffset !== 0) reloadStream(resumeAt).catch(() => {});

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
  clearInterval(ctx.hlsTimer);
  clearInterval(ctx.statsTimer);
  clearTimeout(ctx.idleTimer);
  clearTimeout(ctx.thumbRetry);

  /*
   * Dropping the src stopped the old pipe's ffmpeg because the response closed.
   * An HLS encoder outlives the request that started it, so it has to be told.
   */
  endHlsSession();
  detachHls();
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

/**
 * Tear down an attached HLS stream.
 *
 * Not optional: hls.js keeps fetching segments and driving the media element
 * until it is destroyed, so reusing the element without this leaves the old
 * stream loading underneath the new one.
 */
function detachHls() {
  if (!ctx?.detachHls) return;
  ctx.detachHls();
  ctx.detachHls = null;
}

/**
 * Tell the server nobody is watching this stream any more.
 *
 * Without it the encoder keeps producing segments until the idle sweeper
 * notices, which is up to a minute of GPU time spent on a closed player -
 * and closing one episode to open another would leave both running.
 */
function endHlsSession() {
  const id = ctx?.info?.hls_session;
  if (!id) return;
  api.endHlsSession(id).catch(() => {});
}

function load(startAt = 0, { autoplay = true } = {}) {
  /*
   * HLS covers everything that needs ffmpeg, and it seeks by segment, so the
   * element's own currentTime is the real position.
   */
  if (ctx.info?.hls) {
    detachHls();

    attachHls(ctx.video, ctx.info.hls)
      .then((detach) => {
        // The player may have closed or switched files while the library was
        // loading; detaching immediately avoids a stream with no owner.
        if (!ctx) { detach(); return; }
        ctx.detachHls = detach;

        if (startAt > 0) {
          ctx.video.addEventListener('loadedmetadata', () => {
            ctx.video.currentTime = startAt;
          }, { once: true });
        }
        if (autoplay) ctx.video.play().catch(() => {});
      })
      .catch((error) => {
        toast('error', 'Cannot play this file', error.message);
      });

    applyTrack(ctx.activeTrack);
    tick();
    return;
  }

  // A real file on disk: load once, then seek inside the element.
  if (!ctx.video.src) {
    ctx.video.src = api.streamUrl(ctx.filePath, { audioOffset: ctx.audioOffset });
    if (startAt > 0) {
      ctx.video.addEventListener('loadedmetadata', () => { ctx.video.currentTime = startAt; }, { once: true });
    }
  } else if (startAt >= 0) {
    ctx.video.currentTime = startAt;
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
 * Seeking is now the same operation whatever the delivery: a file seeks by byte
 * range, HLS seeks by segment, and the element handles both.
 *
 * There used to be a second path here for the raw ffmpeg pipe, which had no
 * byte offsets and could only seek by restarting the encoder at ?t=. It carried
 * its own coalescing timer and a ctx.offset the position had to be measured
 * against - and that offset was the reason a seek with an audio delay set
 * reported roughly double the real position. HLS replaced the pipe, so the mode
 * and its accounting are gone rather than left to be tripped over.
 */
function seekTo(seconds) {
  const total = duration();
  const target = Math.max(0, Math.min(total ? total - 1 : seconds, seconds));
  ctx.video.currentTime = target;
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

/**
 * Show the controls and arm the auto-hide.
 *
 * The delay follows how the viewer is driving the player rather than the call
 * site, because the call sites are not all reachable from the input: tapping
 * play fires the media element's own 'play' event, and if that used the mouse
 * timing it would cut short the reveal the tap had just asked for.
 */
/**
 * Can this device actually change the output volume?
 *
 * iOS makes video.volume read-only — assignments are accepted and ignored — so
 * the slider is inert there and the hardware buttons are the only control. A
 * feature test rather than a device check, because that is the actual
 * condition: anything that cannot set volume should not show a volume slider.
 */
function volumeIsAdjustable(video) {
  try {
    const original = video.volume;
    const probe = original > 0.5 ? 0.25 : 0.75;
    video.volume = probe;
    const moved = Math.abs(video.volume - probe) < 0.01;
    video.volume = original;
    return moved;
  } catch {
    return false;
  }
}

function markIdle(after) {
  if (!ctx) return;
  // Number.isFinite rather than a null check: this is easy to wire up as an
  // event listener by accident, and a MouseEvent as the delay would otherwise
  // become NaN and hide the controls immediately.
  const delay = (Number.isFinite(after) ? after : null)
    ?? (Date.now() - (ctx.lastTouchAt || 0) < CLICK_AFTER_TOUCH_MS * 3
    ? TOUCH_IDLE_MS
    : IDLE_MS);
  clearTimeout(ctx.idleTimer);
  ctx.node.classList.remove('is-idle');
  ctx.idleTimer = setTimeout(() => {
    // A panel left open over a hidden control bar floats unanchored — and the
    // bar must not vanish out from under a finger that is dragging it.
    if (ctx && !ctx.video.paused && !ctx.scrubbing) {
      closePopovers();
      ctx.node.classList.add('is-idle');
    }
  }, delay);
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
    ${ctx.tracks.length === 0 ? '<div class="player__menu-label">None found</div>' : ''}
    ${buildAudioTrackSection()}`;
}

/**
 * The audio track list, shown only when the file actually has a choice.
 *
 * /api/stream/info has always reported these and both stream routes have
 * always accepted ?audio=N; nothing in the interface ever offered them, so a
 * dual-audio file could only ever be played in its default language.
 */
function buildAudioTrackSection() {
  const tracks = ctx.info?.audio_tracks || [];
  if (tracks.length < 2) return '';

  const label = (track, index) => {
    const parts = [track.language || track.title || `Track ${index + 1}`];
    if (track.channels) parts.push(`${track.channels}ch`);
    if (track.codec) parts.push(String(track.codec).toUpperCase());
    return parts.join(' · ');
  };

  return `
    <div class="player__menu-label">Audio</div>
    ${tracks.map((track, index) => `
      <button class="player__menu-item${index === ctx.audioIndex ? ' is-active' : ''}" data-action="set-audio-track" data-index="${index}">
        ${esc(label(track, index))}
      </button>`).join('')}`;
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

const QUALITY_LABELS = [
  ['auto', 'Auto'],
  ['original', 'Original'],
  ['high', 'High &middot; 1080p'],
  ['medium', 'Medium &middot; 720p'],
  ['low', 'Low &middot; 480p']
];

/**
 * What is actually happening to this stream.
 *
 * Written because a whole session was spent guessing at exactly these numbers:
 * which delivery path a file took, whether a cap applied, how much buffer there
 * was, and which encoder session the player was talking to. Reading them off
 * the screen is faster than reading them out of a log.
 */
function renderStats() {
  const panel = el('player-stats');
  if (!panel || panel.hidden || !ctx) return;

  const video = ctx.video;
  const info = ctx.info || {};

  const buffered = video.buffered.length
    ? Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime)
    : 0;

  // Not implemented everywhere; absent is better than a wrong number.
  const q = typeof video.getVideoPlaybackQuality === 'function'
    ? video.getVideoPlaybackQuality()
    : null;

  const source = info.video
    ? `${info.video.width}x${info.video.height} ${String(info.video.codec || '').toUpperCase()}`
    : 'unknown';

  const rows = [
    ['delivery', info.hls ? 'hls' : (info.mode || 'direct')],
    ['quality', `${info.quality || 'original'}${info.tonemapped ? ' · hdr→sdr' : ''}`],
    ['origin', info.origin || '—'],
    ['source', source],
    ['output', video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : '—'],
    ['buffer', `${buffered.toFixed(1)}s`],
    ['position', `${formatTime(position())} / ${formatTime(duration())}`]
  ];

  if (q) rows.push(['frames', `${q.droppedVideoFrames} dropped of ${q.totalVideoFrames}`]);
  if (info.hls_session) rows.push(['session', info.hls_session.slice(0, 12)]);

  panel.innerHTML = rows
    .map(([label, value]) => `<div><b>${label}</b>${esc(String(value))}</div>`)
    .join('');
}

/** Show or hide the stats panel. */
export function toggleStats() {
  const panel = el('player-stats');
  if (!panel || !ctx) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderStats();
  buildMenu();
}

function buildStatsSection() {
  const shown = el('player-stats') && !el('player-stats').hidden;
  return `
    <div class="player__menu-label">Diagnostics</div>
    <button class="player__menu-item${shown ? ' is-active' : ''}" data-action="toggle-stats">
      Playback stats
    </button>`;
}

function buildSpeedPopover() {
  const quality = api.getQuality();

  el('popover-speed').innerHTML = `
    <div class="player__menu-label">Playback speed</div>
    ${SPEEDS.map((speed) => `
      <button class="player__menu-item${ctx.speed === speed ? ' is-active' : ''}" data-action="set-speed" data-speed="${speed}">${speed}&times;</button>`).join('')}
    <div class="player__menu-label">Quality</div>
    ${QUALITY_LABELS.map(([value, label]) => `
      <button class="player__menu-item${quality === value ? ' is-active' : ''}" data-action="set-quality" data-quality="${value}">${label}</button>`).join('')}
    ${buildStatsSection()}`;
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

/** Rebuild every popover. Cheap, and keeps them in step with ctx. */
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

  /*
   * The offset lives in the ffmpeg command, so it only takes effect on a new
   * stream — and the server bakes it into the HLS playlist URL, which is why
   * this has to re-ask for that URL rather than reload the one it already has.
   * Reloading the old URL reuses the same session key and therefore the same
   * encoder, and the delay silently did nothing.
   */
  reloadStream().catch(() => {});

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

/**
 * Change the quality cap and restart the stream where it left off.
 *
 * The cap lives in the ffmpeg command, so like an audio offset it can only
 * take effect on a new stream. Seekability has to be re-asked rather than
 * assumed: a capped stream is a pipe and cannot seek natively, and only the
 * server knows whether the cap actually bites on this particular file.
 */
/**
 * Re-ask the server how to play this file, then reopen the stream where it was.
 *
 * Every parameter that changes the bytes — quality, audio track, audio offset —
 * is resolved server-side and baked into the URL it hands back, so changing one
 * means fetching a new URL rather than reloading the old one. Both callers used
 * to do this by hand and only one of them did it correctly.
 */
async function reloadStream(startAt) {
  if (!ctx) return;

  const at = Number.isFinite(startAt) ? startAt : position();
  const wasPlaying = !ctx.video.paused;
  // Identity, not the path: the server answers with its own resolved form
  // (backslashes on Windows), so comparing path strings never matches and
  // would abandon every switch.
  const opened = ctx;
  const previousSession = ctx.info?.hls_session || null;

  let info;
  try {
    info = await api.getStreamInfo(ctx.filePath, {
      audioOffset: ctx.audioOffset,
      audio: ctx.audioIndex
    });
  } catch {
    // Keep playing at the old settings rather than dropping the stream.
    return;
  }

  // The player may have been closed or switched files while this was in
  // flight; adopting stale info would strand the new stream.
  if (ctx !== opened) return;

  // The parameters changed, so this is a different session. Ending the old one
  // stops an encoder that would otherwise run on until the sweeper reaped it.
  if (previousSession && previousSession !== info.hls_session) {
    api.endHlsSession(previousSession).catch(() => {});
  }

  ctx.info = info;
  // Every delivery path seeks: a file by byte range, HLS by segment.
  ctx.seekable = info.seekable !== false;

  detachHls();
  ctx.video.removeAttribute('src');
  load(at, { autoplay: wasPlaying });
  buildMenu();
}

/** Pick an audio stream. Index is into info.audio_tracks. */
export async function setAudioTrack(index) {
  const wanted = Number(index);
  if (!ctx || !Number.isFinite(wanted) || wanted === ctx.audioIndex) return;
  ctx.audioIndex = wanted;
  buildMenu();
  await reloadStream();
}

export async function setQuality(level) {
  if (!ctx || level === api.getQuality()) return;
  api.setQuality(level);
  buildMenu();
  await reloadStream();
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

  /*
   * Dragging the scrub bar has to hold the controls open.
   *
   * On touch there is no mousemove to keep resetting the idle timer - the
   * finger produces pointer and touch events instead - so the bar timed out
   * mid-drag and disappeared under the thumb that was moving it.
   */
  const seek = el('seek');
  const holdChrome = () => { ctx.scrubbing = true; markIdle(); };
  const releaseChrome = () => { ctx.scrubbing = false; markIdle(); };

  seek.addEventListener('pointerdown', holdChrome);
  seek.addEventListener('pointerup', releaseChrome);
  seek.addEventListener('pointercancel', releaseChrome);
  // Keyboard and assistive input never send pointer events, so the drag has to
  // be released by the value settling too.
  seek.addEventListener('change', releaseChrome);
  seek.addEventListener('blur', releaseChrome);

  seek.addEventListener('input', (event) => {
    // Every step of the drag counts as activity, whatever produced it.
    markIdle();
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
    markIdle();
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

  /*
   * Wrapped, not passed directly: markIdle takes a delay, and handing it
   * straight to addEventListener passes the MouseEvent as that delay, which
   * setTimeout coerces to NaN and fires immediately.
   *
   * The touch guard matters just as much. A tap synthesises a mousemove, and
   * revealing the chrome from it would beat the tap's own deferred decision to
   * it - so every first tap would look like a tap on already-visible controls
   * and pause the video, which is the behaviour being fixed.
   */
  /*
   * The mute button stays either way: muted IS settable on iOS, so it remains
   * useful even where the slider is not.
   */
  if (!volumeIsAdjustable(video)) node.classList.add('is-no-volume');

  node.addEventListener('mousemove', () => {
    if (Date.now() - (ctx?.lastTouchAt || 0) < CLICK_AFTER_TOUCH_MS) return;
    markIdle();
  });

  /* ---- touch gestures ---- */
  let lastTapAt = 0;
  let lastTapZone = null;

  node.addEventListener('click', (event) => {
    /*
     * Clicking the video toggles playback; controls handle their own clicks.
     * Touch is handled by the pointerup block below.
     *
     * The old guard was `event.pointerType !== 'touch'`, which does not work:
     * Safari delivers click as a MouseEvent, where pointerType is undefined, so
     * every tap fell through and paused the video. Chrome sends a PointerEvent
     * and was filtered correctly, which is why this only ever showed on iOS.
     * Timing off the preceding touch is the portable test.
     */
    if (Date.now() - (ctx?.lastTouchAt || 0) < CLICK_AFTER_TOUCH_MS) return;
    if (event.target === video) togglePlay();
  });

  const flashRipple = (zone) => {
    const ripple = el(zone === 'left' ? 'ripple-l' : 'ripple-r');
    if (!ripple) return;
    ripple.classList.remove('is-on');
    void ripple.offsetWidth;   // restart the animation
    ripple.classList.add('is-on');
  };

  video.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;   // mouse keeps click-to-pause

    // Suppresses the synthetic click Safari fires after a tap, and tells
    // markIdle to use the longer touch timing.
    ctx.lastTouchAt = Date.now();

    const rect = video.getBoundingClientRect();
    const zone = classifyTap(event.clientX - rect.left, rect.width);
    const now = Date.now();
    const isDouble = (now - lastTapAt) < DOUBLE_TAP_MS && lastTapZone === zone;
    // Captured now, not when the deferred decision runs: what the viewer could
    // see when they tapped is what the tap should mean.
    const chromeHidden = node.classList.contains('is-idle');

    if (tapAction({ chromeHidden, zone, isDouble }) === 'seek') {
      skip(zone === 'left' ? -SKIP_SECONDS : SKIP_SECONDS);
      flashRipple(zone);
      lastTapAt = 0;
      lastTapZone = null;
      return;
    }

    lastTapAt = now;
    lastTapZone = zone;

    /*
     * Deferred past the double-tap window, or the first tap of a seek would
     * flash the controls on its way to being a double tap.
     */
    setTimeout(() => {
      if (lastTapAt !== now) return;
      ctx.lastTouchAt = Date.now();

      if (tapAction({ chromeHidden, zone, isDouble: false }) === 'toggle') togglePlay();
      // Either way the controls stay up: after a reveal so you can use them,
      // and after a toggle so the pause button you just pressed is still there.
      markIdle();
    }, DOUBLE_TAP_MS);
  });

  ctx.saveTimer = setInterval(persist, SAVE_INTERVAL_MS);

  /*
   * The server reaps idle HLS sessions so abandoned encoders do not pile up,
   * which means a paused film has to keep saying it is still being watched.
   *
   * The id comes from /api/stream/info, not from the media element: hls.js
   * reports a blob URL and native HLS reports the playlist URL, so the old
   * attempt to read it off currentSrc never matched anything and no session
   * was ever actually kept alive.
   */
  // Stats are a once-a-second job; nothing else needs this cadence.
  ctx.statsTimer = setInterval(renderStats, 1000);

  ctx.hlsTimer = setInterval(() => {
    if (ctx?.info?.hls_session) api.touchHlsSession(ctx.info.hls_session).catch(() => {});
  }, 20000);
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

/**
 * What the four MediaError codes actually mean for this app.
 *
 * The old message said "Playback failed while streaming" for everything, which
 * is the same sentence whether the network dropped, the codec was refused, or
 * the container was rejected outright — and those need completely different
 * fixes. On a phone there is no console to check, so the code has to be on
 * screen or it is not recoverable information.
 */
const MEDIA_ERROR_DETAIL = {
  1: 'Playback was aborted.',
  2: 'The connection dropped while streaming.',
  3: 'The video decoded partway and then failed.',
  4: 'This device refused the stream format.'
};

function onError() {
  if (!ctx) return;
  const code = ctx.video?.error?.code ?? 0;
  const mode = ctx.info?.mode || 'direct';
  const quality = api.getQuality();

  const detail = `${MEDIA_ERROR_DETAIL[code] || 'Playback failed.'} `
    + `(error ${code}, ${mode}, quality ${quality})`;

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

/**
 * Fullscreen, including the one platform that does not have it.
 *
 * iPhone has no Element.requestFullscreen at all — only the video element can
 * go fullscreen, through webkitEnterFullscreen, which hands over to the native
 * player. The old code optional-chained the missing method, so the button
 * silently did nothing there.
 *
 * The element path is still preferred everywhere it exists, because it keeps
 * our own controls; the native handover is the fallback, not the default.
 */
export function toggleFullscreen() {
  if (!ctx) return;
  const video = ctx.video;

  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.())?.catch?.(() => {});
    return;
  }

  if (video.webkitDisplayingFullscreen) {
    video.webkitExitFullscreen?.();
    return;
  }

  const request = ctx.node.requestFullscreen || ctx.node.webkitRequestFullscreen;
  if (request) {
    const result = request.call(ctx.node);
    // webkitRequestFullscreen returns undefined rather than a promise.
    result?.catch?.(() => {});
    return;
  }

  // iPhone: the video itself, natively.
  video.webkitEnterFullscreen?.();
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
    case 'i': case 'I':
      event.preventDefault(); toggleStats(); break;
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
  skip, setSubtitle, setSpeed, setQuality, setAudioTrack, toggleStats,
  togglePopover, closePopovers, setPicture,
  playNext, cancelNext
};
