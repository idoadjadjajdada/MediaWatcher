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
import * as offline from './offline.js';
import * as push from './push.js';
import { canInstall, isInstalled, prompt as promptInstall } from './install.js';

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
  <button class="toggle${value ? ' is-on' : ''}" role="switch" aria-checked="${value}"
    data-action="settings-toggle" data-field="${field}"><span class="toggle__dot"></span></button>`;

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
      ${row('Pitch follows speed',
    'Off, voices keep their pitch at any speed. On, slower is deeper and faster is higher — '
    + 'the way a tape does it, with no pitch correction to smear the transients.',
    toggle('pitchFollowsSpeed', prefs.pitchFollowsSpeed))}
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
      ${renderEnrolment()}
    </section>`;
}

/**
 * Adding a device that cannot comfortably type.
 *
 * The password gate is right and it is miserable on a television: twelve
 * characters entered with a D-pad, usually while someone waits. This mints a
 * code, draws it as a QR, and the device that scans it is signed in. Single
 * use and five minutes, so the photograph someone takes of the screen is worth
 * nothing afterwards.
 */
function renderEnrolment() {
  const enrolment = state.settings?.enrolment;

  return `
    <div class="settings__sub">
      <h3 class="settings__subheading">Add a device</h3>
      <p class="settings__note">
        Point a phone or a television at this code and it signs in without the
        password. Good once, and for five minutes.
      </p>
      ${enrolment ? `
        <div class="enrol">
          <img class="enrol__qr" alt="Enrolment code" src="${esc(api.qrUrl(enrolment.url))}">
          <div class="enrol__detail">
            <div class="enrol__url">${esc(enrolment.url.replace(/\?enrol=.*$/, ''))}</div>
            <div class="settings__note">
              Expires ${esc(formatWhen(enrolment.expiresAt))}. The code itself is in
              the QR and nowhere else on this page — reading it off the screen is
              the only way to use it.
            </div>
          </div>
        </div>` : ''}
      <div class="settings__actions">
        <button class="btn btn--secondary" data-action="settings-enrol">
          ${enrolment ? 'Show another' : 'Show a code'}
        </button>
        ${enrolment ? '<button class="btn btn--ghost" data-action="settings-enrol-cancel">Cancel it</button>' : ''}
      </div>
    </div>`;
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
/**
 * Installing, and what has been saved to this device.
 *
 * The install button only appears where the browser has actually offered one.
 * Chrome hands over a `beforeinstallprompt` event; Safari on iOS never does
 * and expects Share -> Add to Home Screen instead, so there it says so rather
 * than showing a button that cannot work.
 */
function renderOffline() {
  const saved = state.settings?.offline;
  const quota = state.settings?.quota;

  const used = quota && quota.quota > 0
    ? `${formatBytes(quota.usage)} of about ${formatBytes(quota.quota)} used`
    : null;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Offline</h2>
      <p class="settings__note">
        Saved titles play with no connection at all, straight from this device.
        ${used ? esc(used) : 'Browsers report storage space only approximately.'}
      </p>
      ${canInstall() ? `
        <div class="settings__actions">
          <button class="btn btn--primary" data-action="settings-install">Install app</button>
        </div>`
    : `<p class="settings__note">
          ${/iphone|ipad/i.test(navigator.userAgent)
        ? 'To install: Share, then Add to Home Screen.'
        : isInstalled()
          ? 'Already installed.'
          : 'This browser has not offered an install prompt.'}
        </p>`}
      ${!saved ? '<div class="settings__loading">Loading…</div>'
    : saved.length === 0 ? '<div class="settings__empty">Nothing saved yet. Open a title and choose Save offline.</div>' : `
      <div class="table-scroll">
        <table class="table">
          <thead><tr><th>Title</th><th>Size</th><th>Saved</th><th></th></tr></thead>
          <tbody>
            ${saved.map((entry) => `
              <tr>
                <td>${esc(entry.title || entry.filePath.split(/[\/]/).pop())}</td>
                <td class="t-num">${esc(formatBytes(entry.bytes))}</td>
                <td class="t-num">${esc(formatWhen(entry.savedAt))}</td>
                <td><button class="btn btn--ghost btn--danger" data-action="settings-unsave"
                  data-path="${esc(entry.filePath)}">Remove</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="settings__actions">
        <button class="btn btn--secondary" data-action="settings-unsave-all">Remove everything saved</button>
      </div>`}
    </section>`;
}

/**
 * Warming the library.
 *
 * Anything downloaded from now on is converted and thumbnailed automatically
 * when it lands. A library that already existed never went through that, which
 * is why its first play of any MKV waits on a tone map and an encode — so this
 * is the catch-up button for what is already on disk.
 */
function renderPerformance() {
  const warm = state.settings?.warm;
  const busy = Boolean(warm && (warm.running || warm.pending > 0));

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Performance</h2>
      <p class="settings__note">
        Playing an MKV that no browser can decode means tone-mapping and
        encoding it first, which is what makes the first few seconds slow.
        Converting ahead of time removes that wait entirely — the file then
        opens from a ready copy with no encoder involved.
      </p>
      ${warm ? `
        <div class="facts">
          <div class="fact"><dt>Waiting</dt><dd class="t-num">${warm.pending}</dd></div>
          <div class="fact"><dt>Converted</dt><dd class="t-num">${warm.converted}</dd></div>
          <div class="fact"><dt>Already fine</dt><dd class="t-num">${warm.skipped}</dd></div>
          <div class="fact"><dt>Failed</dt><dd class="t-num">${warm.failed}</dd></div>
        </div>` : ''}
      ${busy ? `<p class="settings__note">Working through the queue now. It runs behind anything you are watching, so you can leave it.</p>` : ''}
      <div class="settings__actions">
        <button class="btn btn--primary" data-action="settings-warm" ${busy ? 'disabled' : ''}>
          ${busy ? 'Converting…' : 'Convert library ahead of time'}
        </button>
        <button class="btn btn--secondary" data-action="settings-refresh">Refresh</button>
      </div>
      ${renderWarmPolicy()}
      ${renderBenchmark()}
    </section>`;
}

/**
 * Which files are worth converting ahead of time.
 *
 * Warming everything is the right default for a library of 1080p web rips and
 * the wrong one for almost anything else: a 4K remux converted for a phone
 * that will never play it is an hour of encoding and twenty gigabytes spent on
 * a file nobody asked for.
 *
 * The dry run is the important half of this panel. Rules on their own are not
 * an answer to the question anyone has, which is what they will do to this
 * library.
 */
function renderWarmPolicy() {
  const state_ = state.settings?.warmPolicy;
  if (!state_) return '';

  const { policy, preview } = state_;
  const gb = policy.maxBytes > 0 ? Math.round(policy.maxBytes / 1024 ** 3) : 0;

  const reasons = Object.entries(preview.reasons || {})
    .sort((a, b) => b[1] - a[1]);

  return `
    <div class="settings__sub">
      <h3 class="settings__subheading">What gets converted</h3>

      ${row('Films', 'Convert films ahead of time.', toggle('warmMovies', policy.movies))}
      ${row('Shows', 'Convert episodes ahead of time.', toggle('warmShows', policy.shows))}
      ${row('Size limit', gb > 0
    ? 'Files larger than this are left alone and converted on first play instead.'
    : 'No limit — every file is a candidate, including 4K remuxes.',
  stepper('warmMaxGb', gb, gb > 0 ? ' GB' : ' (off)', 0, 200, 5))}

      <div class="setting">
        <div class="setting__text">
          <div class="setting__label">Never convert paths containing</div>
          <div class="setting__hint">
            One per line. Matched anywhere in the path, ignoring case — a folder
            name, a release group, a drive letter.
          </div>
        </div>
      </div>
      <textarea class="env__value warm__exclude" id="warm-exclude" rows="3"
        data-action="warm-exclude" spellcheck="false"
        placeholder="Extras&#10;Behind the Scenes">${esc(policy.exclude.join('\n'))}</textarea>

      <div class="facts">
        <div class="fact"><dt>Would convert</dt><dd class="t-num">${preview.included} files · ${esc(formatBytes(preview.bytes))}</dd></div>
        <div class="fact"><dt>Would pass over</dt><dd class="t-num">${preview.excluded}</dd></div>
        ${reasons.map(([reason, count]) => `
          <div class="fact"><dt>${esc(reason)}</dt><dd class="t-num">${count}</dd></div>`).join('')}
      </div>

      ${preview.titles.length === 0 ? '' : `
        <div class="settings__sub">
          <h3 class="settings__subheading">Named titles</h3>
          <p class="settings__note">
            A rule about one title beats every general rule above, both ways
            round — which is the point of having one.
          </p>
          <div class="warm-titles">
            ${preview.titles.map((entry) => `
              <div class="warm-title">
                <span class="warm-title__name">${esc(entry.title || entry.key)}</span>
                <span class="badge">${esc(entry.choice)}</span>
                <button class="btn btn--ghost" data-action="warm-title-clear"
                  data-kind="${esc(entry.kind)}" data-id="${entry.tmdbId}">Clear</button>
              </div>`).join('')}
          </div>
        </div>`}
    </div>`;
}

/**
 * What this machine can keep up with.
 *
 * A realtime factor is the only number that answers the question anyone
 * actually has, which is whether transcoding will hold or stall. Above 1.0 the
 * encoder produces video faster than it is watched.
 */
function renderBenchmark() {
  const state_ = state.settings?.benchmark;
  const result = state_?.result;
  const running = Boolean(state_?.running);

  return `
    <div class="settings__sub">
      <h3 class="settings__subheading">This machine</h3>
      <p class="settings__note">
        Encodes a few seconds of the largest file in your library on each path
        and times it. Above 1× means the encoder produces video faster than it
        is watched; below it, playback stalls and no amount of buffering helps.
      </p>
      ${result?.ok ? `
        <div class="facts">
          ${result.runs.map((run) => `
            <div class="fact">
              <dt>${esc(run.label)}</dt>
              <dd class="t-num${run.ok && run.speed < 1 ? ' is-slow' : ''}">
                ${run.ok ? `${run.speed.toFixed(2)}×` : esc(run.error || 'failed')}
              </dd>
            </div>`).join('')}
          <div class="fact"><dt>Hardware encoder</dt><dd class="t-num">${esc(result.encoder || 'none')}</dd></div>
          <div class="fact"><dt>Measured</dt><dd class="t-num">${esc(formatWhen(result.at))}</dd></div>
        </div>
        <p class="settings__note">
          ${esc(result.verdict)}
          Measured against <code>${esc(result.sample.name)}</code>${result.sample.hdr ? ', which is HDR' : ''}.
        </p>` : ''}
      ${result && !result.ok ? `<div class="settings__warn">${esc(result.error)}</div>` : ''}
      <div class="settings__actions">
        <button class="btn btn--secondary" data-action="settings-benchmark" ${running ? 'disabled' : ''}>
          ${running ? 'Measuring…' : 'Measure this machine'}
        </button>
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
 * Encoders
 *
 * The one panel on this page that is alive rather than a snapshot. Everything
 * else answers a question about how the install is configured; this answers
 * "why is this machine busy right now", and a two-second-old answer to that is
 * a different answer.
 * ----------------------------------------------------------------------- */

/** A file path as the part anyone recognises. */
const baseName = (filePath) => String(filePath || '').split(/[\\/]/).pop() || '';

const KIND_LABELS = {
  hls: 'Streaming',
  convert: 'Converting',
  thumbnail: 'Thumbnails',
  intro: 'Intro detection'
};

/**
 * One row per running process.
 *
 * The realtime factor is the number worth reading: below 1.0 the encoder is
 * producing video more slowly than it is watched, which is a stall in the
 * making rather than a stall that has happened yet.
 */
function encoderRows(encoders) {
  if (!encoders) return '<div class="settings__loading">Loading…</div>';
  if (encoders.running.length === 0) {
    return '<div class="settings__empty">Nothing is encoding.</div>';
  }

  return `<div class="encoders">${encoders.running.map((proc) => {
    const slow = Number.isFinite(proc.speed) && proc.speed < 1;
    return `
      <div class="encoder">
        <div class="encoder__main">
          <div class="encoder__title">
            <span class="encoder__kind encoder__kind--${esc(proc.kind)}">${esc(KIND_LABELS[proc.kind] || proc.kind)}</span>
            ${esc(baseName(proc.filePath) || proc.label)}
          </div>
          <div class="encoder__meta t-num">
            ${esc(proc.label)}${proc.detail ? ` · ${esc(proc.detail)}` : ''}
            · running ${esc(formatUptime(proc.elapsedSeconds))}
            ${proc.outSeconds === null ? '' : ` · reached ${esc(formatUptime(proc.outSeconds))}`}
          </div>
        </div>
        <div class="encoder__speed t-num${slow ? ' is-slow' : ''}">
          ${proc.speed === null ? '—' : `${proc.speed.toFixed(2)}×`}
        </div>
        <button class="btn btn--ghost" data-action="settings-kill-encoder" data-id="${esc(proc.id)}">Stop</button>
      </div>`;
  }).join('')}</div>`;
}

function renderEncoders() {
  const encoders = state.settings?.encoders;
  const pool = state.settings?.diagnostics?.caches?.hlsPool;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Encoders</h2>
      <p class="settings__note">
        Every ffmpeg process this server is running. Playback takes a slot
        immediately; conversions, thumbnails and intro detection wait for what
        playback leaves. A realtime factor below 1× means that encoder is
        producing video more slowly than it is being watched.
      </p>
      ${encoders ? `
        <div class="facts">
          <div class="fact"><dt>Running</dt><dd class="t-num">${encoders.running.length}</dd></div>
          <div class="fact"><dt>Budget</dt><dd class="t-num">${encoders.interactive} playing · ${encoders.background} background of ${encoders.ceiling}</dd></div>
          <div class="fact"><dt>Waiting for a slot</dt><dd class="t-num">${encoders.waiting}</dd></div>
          ${pool ? `<div class="fact"><dt>Pooled segments</dt><dd class="t-num">${esc(formatBytes(pool.bytes))} · ${pool.files} files</dd></div>` : ''}
        </div>` : ''}
      <div id="encoder-list">${encoderRows(encoders)}</div>
    </section>`;
}

/* --------------------------------------------------------------------------
 * Sources
 *
 * Where results and downloads actually come from, and whether either is
 * healthy. Both were previously only knowable by watching a search go wrong.
 * ----------------------------------------------------------------------- */

function renderSources() {
  const stats = state.settings?.sourceStats;
  const account = state.settings?.account;

  const ms = (value) => (value === null || value === undefined ? '—' : `${Math.round(value)}ms`);

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Sources</h2>

      <div class="settings__sub">
        <h3 class="settings__subheading">AllDebrid</h3>
        ${account === null ? '<div class="settings__warn">Could not reach AllDebrid.</div>' : ''}
        ${account ? `
          <div class="facts">
            <div class="fact"><dt>Account</dt><dd class="t-num">${esc(account.username || '—')}</dd></div>
            <div class="fact"><dt>Premium</dt><dd>${account.premium ? 'Yes' : 'No'}${account.trial ? ' (trial)' : ''}</dd></div>
            <div class="fact"><dt>Paid until</dt><dd class="t-num">${esc(formatWhen(account.premiumUntil))}</dd></div>
            <div class="fact"><dt>Renewing</dt><dd>${account.subscribed ? 'Yes' : 'No'}</dd></div>
          </div>
          ${account.premium ? '' : `
            <div class="settings__warn">
              This account is not premium, so every download will fail at the
              point of unlocking a link.
            </div>`}` : ''}
      </div>

      <div class="settings__sub">
        <h3 class="settings__subheading">Search sources</h3>
        <p class="settings__note">
          The last ${stats?.window || 100} searches per source. A source that
          answers quickly and returns nothing every time is the quiet failure:
          it never appears as an error and never contributes a result either.
        </p>
        ${!stats || stats.sources.length === 0
    ? '<div class="settings__empty">Nothing searched yet.</div>'
    : `<div class="table-scroll"><table class="table">
            <thead><tr>
              <th>Source</th><th>Searches</th><th>Failed</th><th>Timed out</th>
              <th>Empty</th><th>Median</th><th>p95</th><th>Results</th>
            </tr></thead>
            <tbody>
              ${stats.sources.map((source) => `
                <tr>
                  <td>${esc(source.label || source.id)}</td>
                  <td class="t-num">${source.searches}</td>
                  <td class="t-num${source.failed > 0 ? ' is-slow' : ''}">${source.failed}</td>
                  <td class="t-num">${source.timedOut}</td>
                  <td class="t-num">${source.empty}</td>
                  <td class="t-num">${esc(ms(source.medianMs))}</td>
                  <td class="t-num">${esc(ms(source.p95Ms))}</td>
                  <td class="t-num">${source.resultsPerSearch}</td>
                </tr>
                ${source.lastError ? `
                  <tr class="table__note"><td colspan="8">${esc(source.lastError)}</td></tr>` : ''}`).join('')}
            </tbody>
          </table></div>`}
        <div class="settings__actions">
          <button class="btn btn--ghost" data-action="settings-reset-sources">Start the history again</button>
        </div>
      </div>
    </section>`;
}

/* --------------------------------------------------------------------------
 * The server itself
 *
 * Three things that used to require being at the machine: reading the log,
 * changing a setting, and restarting. Over the tunnel none of those were
 * available, which is exactly when they are wanted.
 * ----------------------------------------------------------------------- */

/** Edits not yet saved, by key. Kept out of `state` so a re-render cannot lose them. */
const envDraft = new Map();

function renderEnv() {
  const env = state.settings?.env;
  if (!env) return '<div class="settings__loading">Loading…</div>';

  const value = (entry) => (envDraft.has(entry.key) ? envDraft.get(entry.key) : entry.value);

  return `
    <div class="env">
      ${env.entries.map((entry) => `
        <label class="env__row${envDraft.has(entry.key) ? ' is-edited' : ''}">
          <span class="env__key">
            ${esc(entry.key)}
            ${entry.required ? '<span class="env__flag">required</span>' : ''}
            ${entry.documented ? '' : '<span class="env__flag env__flag--warn">not a known setting</span>'}
          </span>
          <input class="env__value" type="${entry.secret ? 'password' : 'text'}"
            id="env-${esc(entry.key)}" data-action="settings-env-edit" data-key="${esc(entry.key)}"
            value="${esc(value(entry))}" autocomplete="off" spellcheck="false">
        </label>`).join('')}
    </div>
    ${env.missing.length > 0 ? `
      <p class="settings__note">
        Never set, and documented in <code>.env.example</code>:
        ${env.missing.map((key) => `<code>${esc(key)}</code>`).join(' ')}
      </p>` : ''}`;
}

/**
 * The log, as lines rather than as one blob.
 *
 * Levels are coloured the way the launcher colours them, because they are the
 * same stream and reading them should not be a different skill in two places.
 */
function logLines(log) {
  if (!log) return '<div class="settings__loading">Loading…</div>';
  if (log.lines.length === 0) return '<div class="settings__empty">Nothing logged yet.</div>';

  return `<div class="logview">${log.lines.map((line) => `
    <div class="logline logline--${esc(line.level)}">
      <span class="logline__time t-num">${esc(new Date(line.at).toLocaleTimeString())}</span>
      <span class="logline__scope">${esc(line.scope)}</span>
      <span class="logline__text">${esc(line.text)}</span>
    </div>`).join('')}</div>`;
}

function renderServer() {
  const log = state.settings?.log;
  const env = state.settings?.env;
  const dirty = envDraft.size > 0;

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Server</h2>

      <div class="settings__sub">
        <h3 class="settings__subheading">Log</h3>
        <p class="settings__note">
          The last few thousand lines, in memory. Anything that looks like a
          key is redacted before it is stored, because this is reachable from
          the tunnel and the console on the machine is not.
        </p>
        <div class="settings__actions">
          ${['', 'error', 'warn', 'info'].map((level) => `
            <button class="btn btn--ghost${(state.settings?.logLevel || '') === level ? ' is-active' : ''}"
              data-action="settings-log-level" data-level="${level}">
              ${level === '' ? 'Everything' : level[0].toUpperCase() + level.slice(1)}
            </button>`).join('')}
          <button class="btn btn--ghost${state.settings?.logFollow ? ' is-active' : ''}"
            data-action="settings-log-follow">${state.settings?.logFollow ? 'Following' : 'Follow'}</button>
        </div>
        <div id="log-lines">${logLines(log)}</div>
      </div>

      <div class="settings__sub">
        <h3 class="settings__subheading">Settings file</h3>
        <p class="settings__note">
          <code>${esc(env?.path || '.env')}</code>. Secrets are masked; leaving one
          masked keeps whatever is already there. Nothing here takes effect
          until the server restarts — every value is read once at boot.
        </p>
        ${renderEnv()}
      </div>

      <div class="settings__sub">
        <h3 class="settings__subheading">Confirm</h3>
        <p class="settings__note">
          Saving settings and restarting both need your password again. A
          signed-in device is a cookie on a phone that might be sitting
          unlocked on a table; neither of these should rest on that alone.
        </p>
        <label class="env__row">
          <span class="env__key">Password</span>
          <input class="env__value" type="password" id="admin-password"
            autocomplete="current-password" placeholder="Your MediaWatcher password">
        </label>
        <div class="settings__actions">
          <button class="btn btn--primary" data-action="settings-env-save" ${dirty ? '' : 'disabled'}>
            ${dirty ? `Save ${envDraft.size} change${envDraft.size === 1 ? '' : 's'}` : 'Save settings'}
          </button>
          ${dirty ? '<button class="btn btn--ghost" data-action="settings-env-discard">Discard</button>' : ''}
          <button class="btn btn--danger" data-action="settings-restart">Restart the server</button>
        </div>
      </div>
    </section>`;
}

/**
 * Being told when something happens.
 *
 * The launcher raises a toast on the machine the server runs on, which is the
 * one place you are not when a download finishes. Three things have to be true
 * before a notification can arrive and they fail differently, so the state
 * says which one is missing rather than offering one dead switch.
 */
function renderNotifications() {
  const state_ = state.settings?.push;
  if (!state_) return '';

  if (!state_.supported) {
    return `
      <section class="settings__group">
        <h2 class="settings__heading">Notifications</h2>
        <p class="settings__note">
          ${state_.needsInstall
    ? 'On iPhone and iPad this works once MediaWatcher has been added to the home screen — Safari only allows notifications from an installed app.'
    : 'This browser cannot receive notifications.'}
        </p>
      </section>`;
  }

  const blocked = state_.permission === 'denied';

  return `
    <section class="settings__group">
      <h2 class="settings__heading">Notifications</h2>
      <p class="settings__note">
        A finished or failed download, on this device, wherever you are. The
        push itself carries nothing — it is an empty knock, and the app asks
        this server what it was about — so no title from your library ever
        passes through Google or Mozilla.
      </p>
      ${blocked ? `
        <div class="settings__warn">
          Notifications are blocked for this site. That has to be undone in your
          browser's settings for this page; a site cannot ask again once refused.
        </div>` : ''}
      <div class="facts">
        <div class="fact"><dt>This device</dt><dd>${state_.subscribed ? 'Subscribed' : 'Not subscribed'}</dd></div>
        <div class="fact"><dt>Devices subscribed</dt><dd class="t-num">${state.settings?.pushCount ?? 0}</dd></div>
      </div>
      <div class="settings__actions">
        ${state_.subscribed
    ? '<button class="btn btn--secondary" data-action="settings-push-off">Turn off on this device</button>'
    : `<button class="btn btn--primary" data-action="settings-push-on" ${blocked ? 'disabled' : ''}>Notify this device</button>`}
        <button class="btn btn--ghost" data-action="settings-push-test"
          ${state.settings?.pushCount > 0 ? '' : 'disabled'}>Send a test</button>
      </div>
    </section>`;
}

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
      ${renderPerformance()}
      ${renderEncoders()}
      ${renderOffline()}
      ${renderNotifications()}
      ${renderStorage()}
      ${renderDevices()}
      ${renderLogins()}
      ${renderSources()}
      ${renderServer()}
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
  const [devices, logins, diagnostics, storage, saved, quota, warm, encoders, env, log, benchmark,
    sourceStats, warmPolicy, pushState, pushKey, account] =
    await Promise.all([
      api.getDevices().catch(() => []),
      api.getLoginHistory().catch(() => []),
      api.getDiagnostics().catch(() => null),
      api.getStorage().catch(() => null),
      offline.listSaved().catch(() => []),
      offline.quota().catch(() => null),
      api.getWarmStatus().catch(() => null),
      api.getEncoders().catch(() => null),
      api.getEnv().catch(() => null),
      api.getServerLog({ limit: 400 }).catch(() => null),
      api.getBenchmark().catch(() => null),
      api.getSourceStats().catch(() => null),
      api.getWarmPolicy().catch(() => null),
      push.status().catch(() => null),
      api.getPushKey().catch(() => null),
      // null means the call failed, which is itself worth showing: an
      // unreachable AllDebrid is the reason every download is about to fail.
      api.getDebridAccount().catch(() => null)
    ]);
  setState({
    settings: {
      devices, logins, diagnostics, storage, offline: saved, quota, warm, encoders,
      env, log, benchmark, sourceStats, account, warmPolicy,
      push: pushState, pushCount: pushKey?.subscribers ?? 0,
      // Carried across a reload so following the log survives a refresh of the
      // page's data, which is the one time you are most likely to be doing it.
      logLevel: state.settings?.logLevel || '',
      logFollow: Boolean(state.settings?.logFollow)
    }
  });
}

/* --------------------------------------------------------------------------
 * Live encoders
 *
 * This is the one place on the page that updates itself, and the only one that
 * patches the DOM rather than re-rendering. A full re-render every couple of
 * seconds would be correct and unusable: it would blow away focus, scroll
 * position and any half-typed value elsewhere on the page. So the poll
 * replaces the contents of one element and touches nothing else.
 * ----------------------------------------------------------------------- */

const ENCODER_POLL_MS = 2000;
let encoderTimer = null;

async function pollEncoders() {
  const host = document.getElementById('encoder-list');
  // Navigated away, or the page re-rendered without this section. Either way
  // there is nothing to update and no reason to keep asking.
  if (!host) return stopEncoderWatch();

  const encoders = await api.getEncoders().catch(() => null);
  if (!encoders) return undefined;

  // Kept on state so the next full render of the page starts from what is
  // actually running rather than from whatever was there when it loaded.
  state.settings.encoders = encoders;
  host.innerHTML = encoderRows(encoders);
  return undefined;
}

/** Start the poll. Idempotent — navigating back to the page must not stack them. */
export function startEncoderWatch() {
  if (encoderTimer) return;
  encoderTimer = setInterval(() => { pollEncoders(); }, ENCODER_POLL_MS);
}

export function stopEncoderWatch() {
  if (!encoderTimer) return;
  clearInterval(encoderTimer);
  encoderTimer = null;
}

/** Stop one encoder, then show the result immediately rather than on the next tick. */
export async function killEncoder(id) {
  try {
    await api.killEncoder(id);
    await pollEncoders();
  } catch (error) {
    toast('error', 'Could not stop that encoder', error.message);
  }
}

/* --------------------------------------------------------------------------
 * The server section
 * ----------------------------------------------------------------------- */

const LOG_POLL_MS = 3000;
let logTimer = null;

async function fetchLog() {
  const log = await api.getServerLog({ limit: 400, level: state.settings?.logLevel || '' })
    .catch(() => null);
  if (!log) return;
  state.settings.log = log;

  const host = document.getElementById('log-lines');
  if (!host) return;
  host.innerHTML = logLines(log);
  // Following means the newest line, which is at the bottom.
  host.scrollTop = host.scrollHeight;
}

/** Follow the log, or stop. Nothing polls unless you asked it to. */
export function toggleLogFollow() {
  const following = !state.settings?.logFollow;
  state.settings.logFollow = following;

  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  if (following) {
    logTimer = setInterval(() => {
      // Navigated away: stop rather than keep asking from a page nobody has open.
      if (!document.getElementById('log-lines')) return stopLogFollow();
      return fetchLog();
    }, LOG_POLL_MS);
  }
  setState({});
}

export function stopLogFollow() {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  if (state.settings) state.settings.logFollow = false;
}

export async function setLogLevel(level) {
  state.settings.logLevel = level || '';
  await fetchLog();
  setState({});
}

/** Record an edit without re-rendering: re-rendering mid-type loses the caret. */
export function editEnv(key, value) {
  const entry = state.settings?.env?.entries.find((row) => row.key === key);
  // Back to what it was, including a secret returned to its mask, is not an edit.
  if (entry && entry.value === value) envDraft.delete(key);
  else envDraft.set(key, value);

  // The Save button's label counts the edits, so it does have to change — but
  // only it, not the inputs around it.
  const save = document.querySelector('[data-action="settings-env-save"]');
  if (save) {
    save.disabled = envDraft.size === 0;
    save.textContent = envDraft.size === 0
      ? 'Save settings'
      : `Save ${envDraft.size} change${envDraft.size === 1 ? '' : 's'}`;
  }
}

const passwordField = () => document.getElementById('admin-password');

export function discardEnvEdits() {
  envDraft.clear();
  setState({});
}

export async function saveEnv() {
  if (envDraft.size === 0) return;
  const password = passwordField()?.value || '';
  if (!password) {
    toast('error', 'Password needed', 'Enter your password below to save settings.');
    return;
  }

  try {
    const result = await api.saveEnv(Object.fromEntries(envDraft), password);
    envDraft.clear();
    const field = passwordField();
    if (field) field.value = '';
    state.settings.env = await api.getEnv().catch(() => state.settings.env);
    setState({});
    toast('success', `Saved ${result.applied.length} setting${result.applied.length === 1 ? '' : 's'}`,
      result.restartRequired ? 'Restart the server for it to take effect.' : '');
  } catch (error) {
    toast('error', 'Could not save', error.message);
  }
}

/**
 * Restart, and then wait for it to come back.
 *
 * The waiting is the part worth doing properly: the page cannot tell a server
 * that is restarting from one that has died, and neither can you, so it polls
 * until health answers and says which happened.
 */
export async function restartServer() {
  const password = passwordField()?.value || '';
  if (!password) {
    toast('error', 'Password needed', 'Enter your password below to restart.');
    return;
  }

  try {
    await api.restartServer(password);
  } catch (error) {
    // 409 is "nothing is supervising this, it would not come back" — a refusal
    // worth reading rather than a failure worth retrying.
    toast('error', 'Not restarting', error.message);
    return;
  }

  const field = passwordField();
  if (field) field.value = '';
  toast('info', 'Restarting…', 'Waiting for the server to come back.');

  const deadline = Date.now() + 60000;
  const poll = async () => {
    if (Date.now() > deadline) {
      toast('error', 'It has not come back', 'Check the launcher on the machine itself.');
      return;
    }
    try {
      await api.health();
      toast('success', 'Back up');
      await loadSettings();
    } catch {
      setTimeout(poll, 1500);
    }
  };
  // Long enough that the poll does not catch the server it is about to leave.
  setTimeout(poll, 2500);
}

/**
 * Mint an enrolment code.
 *
 * Needs the password for the same reason saving settings does: a code is a way
 * into the server, so handing one out has to be at least as hard as signing in.
 */
export async function createEnrolment() {
  const password = passwordField()?.value || '';
  if (!password) {
    toast('error', 'Password needed', 'Enter your password in the Server section below.');
    return;
  }

  try {
    state.settings.enrolment = await api.createEnrolment(password);
    setState({});
  } catch (error) {
    toast('error', 'Could not make a code', error.message);
  }
}

export async function cancelEnrolment() {
  const password = passwordField()?.value || '';
  try {
    await api.cancelEnrolments(password);
    state.settings.enrolment = null;
    setState({});
    toast('success', 'Cancelled');
  } catch (error) {
    toast('error', 'Could not cancel it', error.message);
  }
}

export async function enablePush() {
  try {
    await push.subscribe();
    toast('success', 'This device will be notified');
    await loadSettings();
  } catch (error) {
    toast('error', 'Could not turn notifications on', error.message);
  }
}

export async function disablePush() {
  try {
    await push.unsubscribe();
    toast('success', 'Notifications off for this device');
    await loadSettings();
  } catch (error) {
    toast('error', 'Could not turn them off', error.message);
  }
}

/**
 * Prove the chain works.
 *
 * Worth its own button: there are four places it can break — permission, the
 * subscription, the push service and the worker — and the alternative to
 * testing is finding out on the night it matters.
 */
export async function testPush() {
  try {
    const result = await api.testPush();
    toast('info', `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}`,
      'If nothing appears, the notification was blocked by the system rather than by this app.');
  } catch (error) {
    toast('error', 'Could not send it', error.message);
  }
}

/** Forget the source history — for a source that has just been fixed. */
export async function resetSourceStats() {
  try {
    await api.resetSourceStats();
    state.settings.sourceStats = await api.getSourceStats().catch(() => null);
    setState({});
    toast('success', 'History cleared');
  } catch (error) {
    toast('error', 'Could not clear it', error.message);
  }
}

export async function runBenchmark() {
  state.settings.benchmark = { running: true, result: state.settings?.benchmark?.result || null };
  setState({});
  toast('info', 'Measuring…', 'A few short encodes. This takes about a minute.');

  try {
    const result = await api.runBenchmark();
    state.settings.benchmark = { running: false, result };
    setState({});
    if (result.ok) toast('success', 'Measured', result.verdict);
    else toast('error', 'Could not measure', result.error);
  } catch (error) {
    state.settings.benchmark = { running: false, result: null };
    setState({});
    toast('error', 'Could not measure', error.message);
  }
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

/*
 * Which fields belong to the server rather than to this device.
 *
 * Everything else on this page is a property of the screen you are sitting in
 * front of and lives in localStorage. What gets converted ahead of time is a
 * property of the library, so a phone and a television have to agree about it
 * — which means it is stored once, on the server.
 */
const WARM_FIELDS = new Set(['warmMovies', 'warmShows', 'warmMaxGb']);

/** Change one field of the warm policy and save the whole thing back. */
async function patchWarmPolicy(patch) {
  const current = state.settings?.warmPolicy?.policy;
  if (!current) return;

  // Rendered from the answer rather than from the patch, so the page shows
  // what was actually stored — the server normalises, and disagreeing with it
  // is how a settings page starts lying.
  const next = { ...current, ...patch };
  state.settings.warmPolicy = { ...state.settings.warmPolicy, policy: next };
  setState({});

  try {
    await api.saveWarmPolicy(next);
    state.settings.warmPolicy = await api.getWarmPolicy();
    setState({});
  } catch (error) {
    toast('error', 'Could not save that', error.message);
  }
}

export function stepSetting(field, delta) {
  const amount = Number(delta);
  if (!Number.isFinite(amount)) return;

  if (field === 'warmMaxGb') {
    const current = state.settings?.warmPolicy?.policy?.maxBytes || 0;
    const gb = Math.max(0, Math.round(current / 1024 ** 3) + amount);
    // Zero is "no limit" rather than "convert nothing", which is why the
    // control bottoms out there rather than at one.
    patchWarmPolicy({ maxBytes: gb * 1024 ** 3 });
    return;
  }

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
  if (WARM_FIELDS.has(field)) {
    const policy = state.settings?.warmPolicy?.policy;
    if (!policy) return;
    const key = field === 'warmMovies' ? 'movies' : 'shows';
    patchWarmPolicy({ [key]: !policy[key] });
    return;
  }

  const current = loadDevicePrefs();
  saveDevicePrefs({ [field]: !current[field] });
  setState({});
}

/**
 * The exclusion list, saved when you stop typing rather than on every key.
 *
 * Saving per keystroke would write a rule for every prefix of every line, and
 * the page re-renders on the answer — which would take the caret with it.
 */
let excludeTimer = null;
export function editWarmExclude(text) {
  clearTimeout(excludeTimer);
  excludeTimer = setTimeout(() => {
    const exclude = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
    patchWarmPolicy({ exclude });
  }, 800);
}

/** Drop one title's rule, putting it back under the general ones. */
export async function clearWarmTitle(kind, tmdbId) {
  try {
    await api.setWarmTitleRule(kind, Number(tmdbId), 'auto');
    state.settings.warmPolicy = await api.getWarmPolicy();
    setState({});
  } catch (error) {
    toast('error', 'Could not clear that', error.message);
  }
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

export async function install() {
  const outcome = await promptInstall();
  if (outcome === 'accepted') toast('success', 'Installed', 'It will open like an app from now on.');
}

export async function warmLibrary() {
  try {
    const result = await api.warmLibrary();
    setState({ settings: { ...state.settings, warm: result } });
    toast(
      'success',
      result.queued > 0 ? `Converting ${result.queued} file${result.queued === 1 ? '' : 's'}` : 'Nothing to convert',
      result.queued > 0
        ? 'It runs behind anything you are watching.'
        : 'Everything is already converted or already plays directly.'
    );
  } catch (error) {
    toast('error', 'Could not start', error.message);
  }
}

export async function unsave(filePath) {
  await offline.remove(filePath);
  setState({ settings: { ...state.settings, offline: await offline.listSaved() } });
  toast('success', 'Removed from this device');
}

export async function unsaveAll() {
  const count = await offline.removeAll();
  setState({ settings: { ...state.settings, offline: await offline.listSaved() } });
  toast('success', count > 0 ? `Removed ${count} saved title${count === 1 ? '' : 's'}` : 'Nothing was saved');
}

export default { renderSettings, loadSettings };
