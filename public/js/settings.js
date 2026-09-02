/**
 * The settings page.
 *
 * Everything here was previously either unreachable or buried in the player's
 * menus, which meant it could only be changed while something was playing.
 * Four groups, in the order you actually need them:
 *
 *   Playback    what happens without you asking - autoplay, intro skipping
 *   Appearance  subtitles and picture, the two things that vary by screen
 *   Devices     who is remembered, and every attempt at the gate
 *   Diagnostics whether this install is actually healthy
 *
 * Rendering is a pure function of `state` plus localStorage, like every other
 * page; the handlers below write and then re-render rather than patching the
 * DOM in place.
 */
import * as api from './api.js';
import { state, setState } from './state.js';
import { esc, icon, toast } from './views.js';
import {
  loadDevicePrefs, saveDevicePrefs, resetDevicePrefs
} from './device-prefs.js';
import {
  loadSubtitleStyle, saveSubtitleStyle, normaliseStyle, COLOURS,
  SIZE_MIN, SIZE_MAX, OPACITY_MIN, OPACITY_MAX, POSITION_MIN, POSITION_MAX
} from './subtitle-style.js';
import {
  loadPicture, savePicture, clampPicture, PICTURE_MIN, PICTURE_MAX
} from './picture.js';

/* --------------------------------------------------------------------------
 * Formatting
 * ----------------------------------------------------------------------- */

/** Bytes as a human size. The API returns numbers; presentation is ours. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const value = n / 1000 ** exponent;
  // One decimal below 10 so "1.4 GB" does not round to "1 GB", none above it
  // where the extra digit is noise.
  return `${value < 10 && exponent > 0 ? value.toFixed(1) : Math.round(value)} ${units[exponent]}`;
}

/** A duration in seconds as the largest two units that are non-zero. */
export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** A timestamp as something readable, or a dash when there isn't one. */
export function formatWhen(ms) {
  if (!ms) return '—';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/* --------------------------------------------------------------------------
 * Controls
 * ----------------------------------------------------------------------- */

const row = (label, hint, control) => `
  <div class="setting">
    <div class="setting__text">
      <div class="setting__label">${esc(label)}</div>
      ${hint ? `<div class="setting__hint">${esc(hint)}</div>` : ''}
    </div>
    <div class="setting__control">${control}</div>
  </div>`;

const toggle = (field, value) => `
  <button class="switch${value ? ' is-on' : ''}" role="switch" aria-checked="${value}"
    data-action="settings-toggle" data-field="${field}"><span class="switch__dot"></span></button>`;

const stepper = (field, value, suffix, min, max, step) => `
  <div class="stepper">
    <button class="stepper__btn" data-action="settings-step" data-field="${field}" data-delta="${-step}"
      ${value <= min ? 'disabled' : ''} aria-label="Decrease">&minus;</button>
    <span class="stepper__value t-num">${value}${suffix}</span>
    <button class="stepper__btn" data-action="settings-step" data-field="${field}" data-delta="${step}"
      ${value >= max ? 'disabled' : ''} aria-label="Increase">+</button>
  </div>`;

const choices = (field, value, options) => `
  <div class="choices">
    ${options.map(([key, label]) => `
      <button class="choices__item${value === key ? ' is-active' : ''}"
        data-action="settings-choose" data-field="${field}" data-value="${esc(key)}">${label}</button>`).join('')}
  </div>`;

/* --------------------------------------------------------------------------
 * Sections
 * ----------------------------------------------------------------------- */

function renderPlayback(prefs) {
  return `
    <section class="settings__group">
      <h2 class="settings__heading">Playback</h2>
      ${row('Quality', 'Applies to this device only. Auto picks by whether you are on the LAN or the tunnel.',
    choices('quality', api.getQuality(), api.QUALITY_LEVELS.map((level) => [level, level[0].toUpperCase() + level.slice(1)])))}
      ${row('Autoplay next episode', 'Start the next episode when one finishes.',
    toggle('autoplayNext', prefs.autoplayNext))}
      ${row('Next-up card', 'How long before the end it appears.',
    stepper('nextUpLeadSeconds', prefs.nextUpLeadSeconds, 's', 5, 120, 5))}
      ${row('Skip intro', 'Offer the button, take it automatically, or never show it.',
    choices('introBehaviour', prefs.introBehaviour, [['offer', 'Offer'], ['auto', 'Automatic'], ['off', 'Off']]))}
      ${row('Resume prompt', 'Show where you got to when reopening something.',
    toggle('resumePrompt', prefs.resumePrompt))}
      ${row('Seek step', 'How far the skip buttons and arrow keys jump.',
    stepper('seekSeconds', prefs.seekSeconds, 's', 5, 60, 5))}
    </section>`;
}

function renderAppearance(subtitle, picture) {
  return `
    <section class="settings__group">
      <h2 class="settings__heading">Appearance</h2>
      ${row('Subtitle size', null, stepper('size', subtitle.size, '%', SIZE_MIN, SIZE_MAX, 10))}
      ${row('Subtitle background', 'Opacity of the box behind the text.',
    stepper('opacity', subtitle.opacity, '%', OPACITY_MIN, OPACITY_MAX, 10))}
      ${row('Subtitle height', 'How far off the bottom edge subtitles sit.',
    stepper('position', subtitle.position, '%', POSITION_MIN, POSITION_MAX, 2))}
      ${row('Subtitle colour', null, `
        <div class="swatches">
          ${Object.entries(COLOURS).map(([name, hex]) => `
            <button class="swatch${subtitle.colour === name ? ' is-active' : ''}"
              data-action="settings-colour" data-value="${name}"
              style="background:${hex}" title="${name}" aria-label="${name}"></button>`).join('')}
        </div>`)}
      ${row('Brightness', 'A repaint, not a re-encode — instant on any file.',
    stepper('brightness', picture.brightness, '%', PICTURE_MIN, PICTURE_MAX, 5))}
      ${row('Contrast', null, stepper('contrast', picture.contrast, '%', PICTURE_MIN, PICTURE_MAX, 5))}
      <div class="settings__actions">
        <button class="btn btn--secondary" data-action="settings-reset-appearance">Reset appearance</button>
      </div>
    </section>`;
}

function renderDevices() {
  const devices = state.settings?.devices;
  if (!devices) return '<section class="settings__group"><h2 class="settings__heading">Devices</h2><div class="settings__loading">Loading…</div></section>';

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Devices</h2>
      <p class="settings__note">
        Each row is a live credential. Revoking one locks that device out on its
        very next request — it does not wait for anything to expire.
      </p>
      ${devices.length === 0 ? '<div class="settings__empty">Nothing is remembered. Devices appear here when someone ticks “remember me”.</div>' : `
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Name</th><th>Where</th><th>First seen</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            ${devices.map((device) => `
              <tr>
                <td>${esc(device.name || 'Unnamed')}</td>
                <td><span class="badge badge--${esc(device.origin || 'other')}">${esc(device.origin || 'unknown')}</span></td>
                <td class="t-num">${esc(formatWhen(device.first_seen))}</td>
                <td class="t-num">${esc(formatWhen(device.last_seen))}</td>
                <td><button class="btn btn--ghost btn--danger" data-action="settings-revoke"
                  data-id="${esc(device.id)}">Revoke</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </section>`;
}

function renderLogins() {
  const logins = state.settings?.logins;
  if (!logins) return '';

  const failures = logins.filter((entry) => !entry.ok).length;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Login history</h2>
      <p class="settings__note">
        Every attempt at the gate, successful or not. ${failures > 0
    ? `<strong>${failures} failed</strong> in the last ${logins.length} attempts.`
    : 'No failures in this window.'}
      </p>
      ${logins.length === 0 ? '<div class="settings__empty">Nothing recorded yet.</div>' : `
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th></th><th>When</th><th>Where</th><th>Address</th><th>Device</th></tr></thead>
          <tbody>
            ${logins.slice(0, 50).map((entry) => `
              <tr class="${entry.ok ? '' : 'is-failure'}">
                <td>${entry.ok ? icon('check', 'icon-sm') : '<span class="dot dot--bad"></span>'}</td>
                <td class="t-num">${esc(formatWhen(entry.at))}</td>
                <td><span class="badge badge--${esc(entry.origin || 'other')}">${esc(entry.origin || 'unknown')}</span></td>
                <td class="t-num">${esc(entry.ip || '—')}</td>
                <td>${esc(entry.deviceName || (entry.ok ? 'Not remembered' : '—'))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
    </section>`;
}

/**
 * Where the space went, biggest first.
 *
 * By title rather than by folder: the organiser decides the folder layout, so
 * a per-directory breakdown answers a question about the organiser, while what
 * you actually want to know is what to delete. Shows also carry a per-episode
 * figure, because the total only tells you a show is long.
 */
function renderStorage() {
  const storage = state.settings?.storage;
  if (!storage) return '<section class="settings__group"><h2 class="settings__heading">Storage</h2><div class="settings__loading">Loading…</div></section>';

  const widest = storage.titles[0]?.bytes || 1;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Storage</h2>
      <div class="facts">
        <div class="fact"><dt>Everything</dt><dd class="t-num">${esc(formatBytes(storage.totalBytes))}</dd></div>
        <div class="fact"><dt>Movies</dt><dd class="t-num">${esc(formatBytes(storage.movieBytes))}</dd></div>
        <div class="fact"><dt>Shows</dt><dd class="t-num">${esc(formatBytes(storage.showBytes))}</dd></div>
      </div>
      ${storage.titles.length === 0 ? '<div class="settings__empty">Nothing scanned yet.</div>' : `
      <div class="bars">
        ${storage.titles.slice(0, 20).map((title) => `
          <div class="bar">
            <div class="bar__head">
              <span class="bar__title">${esc(title.title)}</span>
              <span class="bar__size t-num">${esc(formatBytes(title.bytes))}</span>
            </div>
            <div class="bar__track"><span class="bar__fill" style="width:${Math.max(1, (title.bytes / widest) * 100).toFixed(1)}%"></span></div>
            <div class="bar__meta">
              ${title.type === 'show'
    ? `${title.episodes} episodes across ${title.seasons} season${title.seasons === 1 ? '' : 's'} · ${esc(formatBytes(title.bytesPerEpisode))} each`
    : `${title.files} file${title.files === 1 ? '' : 's'}${title.year ? ` · ${title.year}` : ''}`}
            </div>
          </div>`).join('')}
      </div>`}
    </section>`;
}

function renderDiagnostics() {
  const d = state.settings?.diagnostics;
  if (!d) return '<section class="settings__group"><h2 class="settings__heading">Diagnostics</h2><div class="settings__loading">Loading…</div></section>';

  const ok = (value) => `<span class="dot dot--${value ? 'good' : 'bad'}"></span>${value ? 'Yes' : 'No'}`;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Diagnostics</h2>
      <div class="facts">
        <div class="fact"><dt>Uptime</dt><dd class="t-num">${esc(formatUptime(d.server.uptimeSeconds))}</dd></div>
        <div class="fact"><dt>Node</dt><dd class="t-num">${esc(d.server.node)}</dd></div>
        <div class="fact"><dt>Platform</dt><dd>${esc(d.server.platform)}</dd></div>
        <div class="fact"><dt>Memory</dt><dd class="t-num">${esc(formatBytes(d.server.memoryBytes))}</dd></div>
        <div class="fact"><dt>ffmpeg</dt><dd>${ok(d.ffmpeg.available)}</dd></div>
        <div class="fact"><dt>Library folder</dt><dd>${ok(d.library.exists)}</dd></div>
        <div class="fact"><dt>Titles</dt><dd class="t-num">${d.library.movies} movies · ${d.library.shows} shows</dd></div>
        <div class="fact"><dt>Library size</dt><dd class="t-num">${esc(formatBytes(d.library.bytes))} in ${d.library.files} files</dd></div>
        <div class="fact"><dt>Last scan</dt><dd class="t-num">${esc(formatWhen(d.library.lastScanAt))}</dd></div>
        <div class="fact"><dt>Unidentified</dt><dd class="t-num">${d.library.unknown}</dd></div>
        <div class="fact"><dt>Video cache</dt><dd class="t-num">${esc(formatBytes(d.caches.mp4.bytes))} · ${d.caches.mp4.files} files</dd></div>
        <div class="fact"><dt>Thumbnail cache</dt><dd class="t-num">${esc(formatBytes(d.caches.thumbs.bytes))} · ${d.caches.thumbs.files} files</dd></div>
        <div class="fact"><dt>TMDB</dt><dd>${ok(d.integrations.tmdb)}</dd></div>
        <div class="fact"><dt>AllDebrid</dt><dd>${ok(d.integrations.alldebrid)}</dd></div>
        <div class="fact"><dt>Jackett</dt><dd>${ok(d.integrations.jackett)}</dd></div>
        <div class="fact"><dt>Subtitle search</dt><dd>${ok(d.integrations.opensubtitles.search)}</dd></div>
        <div class="fact"><dt>Subtitle download</dt><dd>${ok(d.integrations.opensubtitles.download)}</dd></div>
        <div class="fact"><dt>Tailnet host</dt><dd class="t-num">${esc(d.integrations.tailnetHost || 'not set')}</dd></div>
        <div class="fact"><dt>Failed logins (24h)</dt><dd class="t-num">${d.access.failedLogins24h}</dd></div>
      </div>
      ${d.ffmpeg.available ? '' : `
        <div class="settings__warn">
          ffmpeg could not be run at <code>${esc(d.ffmpeg.ffmpegPath)}</code>. Anything
          that is not already browser-native will fail to play until this is fixed.
        </div>`}
      <div class="settings__actions">
        <button class="btn btn--secondary" data-action="settings-refresh">Refresh</button>
      </div>
    </section>`;
}

/* --------------------------------------------------------------------------
 * Page
 * ----------------------------------------------------------------------- */

export function renderSettings() {
  const prefs = loadDevicePrefs();
  const subtitle = loadSubtitleStyle();
  const picture = loadPicture();

  return `
    <div class="settings">
      <header class="settings__head">
        <h1 class="page__title">Settings</h1>
        <p class="settings__lede">
          Playback and appearance are stored on this device — a phone and a TV
          want different answers, so they are deliberately not synced.
        </p>
      </header>
      ${renderPlayback(prefs)}
      ${renderAppearance(subtitle, picture)}
      ${renderStorage()}
      ${renderDevices()}
      ${renderLogins()}
      ${renderDiagnostics()}
    </div>`;
}

/**
 * Load everything the page needs from the server.
 *
 * Each part lands independently so a failing diagnostics call does not take
 * the device list with it - and the sections render a loading state until
 * their own data arrives rather than blocking the whole page.
 */
export async function loadSettings() {
  const [devices, logins, diagnostics, storage] = await Promise.all([
    api.getDevices().catch(() => []),
    api.getLoginHistory().catch(() => []),
    api.getDiagnostics().catch(() => null),
    api.getStorage().catch(() => null)
  ]);
  setState({ settings: { devices, logins, diagnostics, storage } });
}

/* --------------------------------------------------------------------------
 * Handlers
 * ----------------------------------------------------------------------- */

/*
 * Which store a field belongs to. Three of them - device prefs, subtitle
 * style and picture - already existed with their own clamping, and routing by
 * name here keeps that clamping where it is rather than restating it.
 */
const SUBTITLE_FIELDS = new Set(['size', 'opacity', 'position']);
const PICTURE_FIELDS = new Set(['brightness', 'contrast']);

export function stepSetting(field, delta) {
  const amount = Number(delta);
  if (!Number.isFinite(amount)) return;

  if (SUBTITLE_FIELDS.has(field)) {
    const current = loadSubtitleStyle();
    saveSubtitleStyle(normaliseStyle({ ...current, [field]: current[field] + amount }));
  } else if (PICTURE_FIELDS.has(field)) {
    const current = loadPicture();
    savePicture({ ...current, [field]: clampPicture(current[field] + amount) });
  } else {
    const current = loadDevicePrefs();
    saveDevicePrefs({ [field]: (current[field] ?? 0) + amount });
  }
  setState({});
}

export function toggleSetting(field) {
  const current = loadDevicePrefs();
  saveDevicePrefs({ [field]: !current[field] });
  setState({});
}

export function chooseSetting(field, value) {
  // Quality already had its own store, shared with the player's menu.
  if (field === 'quality') api.setQuality(value);
  else saveDevicePrefs({ [field]: value });
  setState({});
}

export function chooseSubtitleColour(colour) {
  saveSubtitleStyle(normaliseStyle({ ...loadSubtitleStyle(), colour }));
  setState({});
}

export function resetAppearance() {
  saveSubtitleStyle(normaliseStyle({}));
  savePicture({ brightness: 100, contrast: 100 });
  setState({});
  toast('success', 'Appearance reset');
}

export function resetAll() {
  resetDevicePrefs();
  resetAppearance();
}

export async function revokeDevice(id) {
  try {
    await api.revokeDevice(id);
    // Re-read rather than splicing the row out: the server is the authority on
    // what is still a credential, and a failed delete must not look successful.
    setState({ settings: { ...state.settings, devices: await api.getDevices() } });
    toast('success', 'Device revoked', 'It is locked out on its next request.');
  } catch (error) {
    toast('error', 'Could not revoke that device', error.message);
  }
}

export async function refreshDiagnostics() {
  await loadSettings();
  toast('success', 'Refreshed');
}

export default { renderSettings, loadSettings };
