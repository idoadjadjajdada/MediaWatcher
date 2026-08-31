# Player Controls and Seek Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the player's single settings menu into four buttons, add brightness and contrast, give shows an episode sidebar, and make the seek bar preview the frame a scrub will land on.

**Architecture:** Arithmetic comes out of `player.js` into two new browser modules (`picture.js`, `preview.js`) so it is testable without a DOM; `player.js` keeps only wiring. Thumbnails are a new server subsystem — one service, one route — that degrades to timestamp-only whenever it cannot answer. Client work (Tasks 1-7) lands before server work (Tasks 8-10), so the seek bar is usable before thumbnails exist.

**Tech Stack:** Node 20+ ESM, Express 4, vanilla browser ES modules, ffmpeg/ffprobe as external binaries, Playwright + Chromium for browser checks.

## Global Constraints

- **Do not restyle anything outside the player.** Tokens, colours, control-bar geometry, hero and rails are fixed by the UI overhaul. New elements reuse existing classes and tokens.
- Picture range is **20-150%**, default **100%**, for both brightness and contrast.
- Frame interval is `max(10, ceil(duration / 300))` seconds.
- `--fill` and `--preview` are **bare numbers**, not lengths — CSS consumes them as `calc(var(--fill, 0) * 1%)`. See `public/css/player.css:68`.
- Thumbnail cache key is `sha1(path + "|" + size + "|" + floor(mtimeMs))`.
- Every thumbnail failure is silent: the ball, band and timestamp never depend on a frame arriving.
- Browser-module files under `public/js/` are imported directly by node tests. **They must not touch `document`, `window` or `localStorage` at module top level** — only inside functions. Existing precedent: `tests/player-nextup.test.mjs` imports `public/js/player.js`.
- Commit with the repo's configured identity (`steelestrongpta@gmail.com`). Do not pass `--author` or `-c user.email`.
- Never print or commit `.env` contents. `TORRENTIO_CONFIG` embeds the AllDebrid key.

## File Structure

| File | Responsibility |
|---|---|
| `public/js/picture.js` | **New.** Clamping, filter string, `localStorage` read/write for brightness + contrast. |
| `public/js/preview.js` | **New.** Pointer-position → fraction, time → frame index, card clamping. |
| `public/js/state.js` | Gains `episodeRows`, next to the `playableEpisodes`/`nextEpisode` traversal already there. |
| `public/js/views.js` | Four buttons, sidebar markup, preview layer markup, four new icons. |
| `public/js/player.js` | Popover state, picture wiring, sidebar wiring, preview wiring. No new arithmetic. |
| `public/css/player.css` | Popovers, sidebar, ball, band, card. |
| `services/thumbnails.js` | **New.** `frameInterval`, `frameCount`, `cacheKey`, generation queue, frame lookup. |
| `routes/thumbs.js` | **New.** The two endpoints and path validation. |
| `tests/picture.test.mjs`, `tests/episode-rows.test.mjs`, `tests/seek-preview.test.mjs`, `tests/thumbnails.test.mjs` | **New.** DOM-free unit tests. |
| `tests/ui-player.mjs` | **New.** Browser-driven player checks. Separate from `ui-check.mjs`, which only visits Home. |

### Test conventions

Every `tests/*.test.mjs` file in this repo is a plain node script with this shape. Follow it exactly:

```javascript
let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ngroup name');
check('does the thing', fn(input) === expected);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

### What the browser can and cannot verify

Playwright's bundled Chromium often lacks the proprietary codecs this library uses, so **the video element may never decode and `duration` may stay 0**. The player renders its chrome the moment `open()` is called, before any media loads, so chrome geometry is fully checkable. Anything that needs a real duration — the card's timestamp text, frame indices — is verified in the DOM-free unit tests instead. Do not write a browser assertion that waits for playback.

---

## Task 1: Picture module

**Files:**
- Create: `public/js/picture.js`
- Test: `tests/picture.test.mjs`
- Modify: `package.json:13` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `clampPicture(value) -> number`, `pictureFilter({brightness, contrast}) -> string`, `loadPicture() -> {brightness, contrast}`, `savePicture({brightness, contrast}) -> void`, and the constants `PICTURE_MIN = 20`, `PICTURE_MAX = 150`, `PICTURE_DEFAULT = 100`.

- [ ] **Step 1: Write the failing test**

Create `tests/picture.test.mjs`:

```javascript
/**
 * Picture controls — clamping, filter string, persistence.
 *
 * Run: node tests/picture.test.mjs
 */
import {
  clampPicture, pictureFilter, loadPicture, savePicture,
  PICTURE_MIN, PICTURE_MAX, PICTURE_DEFAULT
} from '../public/js/picture.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nclampPicture');
check('keeps a value in range', clampPicture(75) === 75);
check('clamps below the minimum', clampPicture(5) === PICTURE_MIN);
check('clamps above the maximum', clampPicture(400) === PICTURE_MAX);
check('accepts the exact minimum', clampPicture(20) === 20);
check('accepts the exact maximum', clampPicture(150) === 150);
check('rounds a fractional value', clampPicture(99.6) === 100);
check('falls back to the default on NaN', clampPicture(NaN) === PICTURE_DEFAULT);
check('falls back to the default on a string', clampPicture('bright') === PICTURE_DEFAULT);
check('falls back to the default on null', clampPicture(null) === PICTURE_DEFAULT);
check('falls back to the default on undefined', clampPicture(undefined) === PICTURE_DEFAULT);
check('falls back to the default on Infinity', clampPicture(Infinity) === PICTURE_DEFAULT);

console.log('\npictureFilter');
check('100/100 is the identity filter',
  pictureFilter({ brightness: 100, contrast: 100 }) === 'brightness(1) contrast(1)');
check('dims correctly',
  pictureFilter({ brightness: 50, contrast: 100 }) === 'brightness(0.5) contrast(1)');
check('boosts correctly',
  pictureFilter({ brightness: 150, contrast: 150 }) === 'brightness(1.5) contrast(1.5)');
check('clamps inside the filter string',
  pictureFilter({ brightness: 9000, contrast: 0 }) === 'brightness(1.5) contrast(0.2)');
check('garbage in gives the identity filter',
  pictureFilter({ brightness: 'x', contrast: undefined }) === 'brightness(1) contrast(1)');

console.log('\nloadPicture / savePicture');

// No localStorage in node at all — this is the private-browsing path.
check('loads defaults with no storage available',
  loadPicture().brightness === PICTURE_DEFAULT && loadPicture().contrast === PICTURE_DEFAULT);
check('saving without storage does not throw', (() => {
  try { savePicture({ brightness: 60, contrast: 60 }); return true; } catch { return false; }
})());

// A minimal stand-in for the browser API.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

check('defaults when nothing is stored', loadPicture().brightness === PICTURE_DEFAULT);
savePicture({ brightness: 60, contrast: 140 });
check('a saved value reads back', loadPicture().brightness === 60 && loadPicture().contrast === 140);
savePicture({ brightness: 9000, contrast: -5 });
check('out-of-range values are clamped on the way in',
  loadPicture().brightness === PICTURE_MAX && loadPicture().contrast === PICTURE_MIN);

store.set('mw.picture', 'not json{');
check('corrupt stored JSON falls back to defaults',
  loadPicture().brightness === PICTURE_DEFAULT && loadPicture().contrast === PICTURE_DEFAULT);

store.set('mw.picture', '{"brightness":70}');
check('a missing field falls back to the default for that field',
  loadPicture().brightness === 70 && loadPicture().contrast === PICTURE_DEFAULT);

globalThis.localStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); }
};
check('storage that throws on read falls back to defaults',
  loadPicture().brightness === PICTURE_DEFAULT);
check('storage that throws on write does not propagate', (() => {
  try { savePicture({ brightness: 60, contrast: 60 }); return true; } catch { return false; }
})());

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/picture.test.mjs`
Expected: FAIL — `Cannot find module '.../public/js/picture.js'`

- [ ] **Step 3: Write the implementation**

Create `public/js/picture.js`:

```javascript
/**
 * Picture controls — brightness and contrast.
 *
 * A CSS filter on the video element, not on the player root: on the root the
 * control bar and subtitles would dim along with the picture, which is the
 * opposite of what dimming is for.
 *
 * Unlike audio delay, this never reaches ffmpeg. It is a repaint, so it is
 * instant and behaves identically in direct, remux and transcode modes.
 *
 * Settings are global rather than per-file: brightness tracks how bright the
 * room is, not how a file was mastered.
 */

export const PICTURE_MIN = 20;
export const PICTURE_MAX = 150;
export const PICTURE_DEFAULT = 100;

const STORAGE_KEY = 'mw.picture';

/** Clamp to the allowed range. Anything unparseable becomes the default. */
export function clampPicture(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PICTURE_DEFAULT;
  return Math.max(PICTURE_MIN, Math.min(PICTURE_MAX, Math.round(number)));
}

/** The exact CSS filter string for a picture setting. */
export function pictureFilter({ brightness, contrast } = {}) {
  const b = clampPicture(brightness) / 100;
  const c = clampPicture(contrast) / 100;
  return `brightness(${b}) contrast(${c})`;
}

/**
 * Read the stored setting.
 *
 * Every failure path returns the default rather than throwing: a browser with
 * storage blocked must still play video.
 */
export function loadPicture() {
  const fallback = { brightness: PICTURE_DEFAULT, contrast: PICTURE_DEFAULT };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      brightness: clampPicture(parsed?.brightness),
      contrast: clampPicture(parsed?.contrast)
    };
  } catch {
    return fallback;
  }
}

/** Store the setting. A blocked write is not an error worth surfacing. */
export function savePicture({ brightness, contrast } = {}) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      brightness: clampPicture(brightness),
      contrast: clampPicture(contrast)
    }));
  } catch {
    // Private browsing. The filter still applies for this session.
  }
}

export default { clampPicture, pictureFilter, loadPicture, savePicture };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/picture.test.mjs`
Expected: PASS — `21 checks, all passed`

- [ ] **Step 5: Add it to the test script**

In `package.json`, append to the `test` script so it reads:

```json
"test": "node tests/search-resolution.test.mjs && node tests/tmdb-suggest.test.mjs && node tests/discover.test.mjs && node tests/player-nextup.test.mjs && node tests/player-gestures.test.mjs && node tests/audio-offset.test.mjs && node tests/picture.test.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add public/js/picture.js tests/picture.test.mjs package.json
git commit -m "feat(player): brightness and contrast module with clamping and persistence"
```

---

## Task 2: Four setting buttons

**Files:**
- Modify: `public/js/views.js` — the `ICONS` map (line 25) and `renderPlayer` (line 638)
- Modify: `public/js/player.js` — `buildMenu` (line 355), `toggleMenu` (line 457), the action dispatch
- Modify: `public/css/player.css`

**Interfaces:**
- Consumes: `clampPicture`, `pictureFilter`, `loadPicture`, `savePicture` from Task 1.
- Produces: `openPopover(name)` and `closePopovers()` in `player.js`; the DOM contract `data-action="toggle-popover" data-popover="subs|sync|speed|picture"` and panels with ids `popover-subs`, `popover-sync`, `popover-speed`, `popover-picture`.

- [ ] **Step 1: Add the four icons**

In `public/js/views.js`, inside the `ICONS` object (starts line 25), add these four entries after `settings`:

```javascript
  cc: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9.5 10.5a2 2 0 1 0 0 3M15.5 10.5a2 2 0 1 0 0 3"/>',
  sync: '<path d="M4 8h12l-3-3M20 16H8l3 3"/><path d="M4 8v2M20 16v-2"/>',
  speed: '<path d="M12 20a8 8 0 1 1 8-8"/><path d="m12 12 4-3"/><circle cx="12" cy="12" r="1.4"/>',
  brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
```

- [ ] **Step 2: Replace the right-hand cluster markup**

In `public/js/views.js`, in `renderPlayer`, replace this block:

```javascript
          <div class="player__buttons-right">
            <div class="player__menu" id="player-menu">
              <button class="player__btn" data-action="toggle-menu" aria-label="Settings">${icon('settings', 'icon')}</button>
              <div class="player__menu-panel" id="menu-panel"></div>
            </div>
            <button class="player__btn" data-action="toggle-fullscreen" aria-label="Fullscreen">${icon('fullscreen', 'icon')}</button>
          </div>
```

with:

```javascript
          <div class="player__buttons-right" id="player-settings">
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="subs"
                aria-label="Subtitles" title="Subtitles">${icon('cc', 'icon')}</button>
              <div class="player__pop-panel" id="popover-subs" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="sync"
                aria-label="Audio delay" title="Audio delay">${icon('sync', 'icon')}</button>
              <div class="player__pop-panel" id="popover-sync" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn player__btn--rate" data-action="toggle-popover" data-popover="speed"
                aria-label="Playback speed" title="Playback speed" id="rate-btn">1&times;</button>
              <div class="player__pop-panel" id="popover-speed" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="picture"
                aria-label="Picture" title="Brightness and contrast">${icon('brightness', 'icon')}</button>
              <div class="player__pop-panel" id="popover-picture" hidden></div>
            </div>
            <button class="player__btn" data-action="toggle-fullscreen" aria-label="Fullscreen">${icon('fullscreen', 'icon')}</button>
          </div>
```

- [ ] **Step 3: Split `buildMenu` into four builders**

In `public/js/player.js`, add the import at the top, alongside the existing imports:

```javascript
import { clampPicture, pictureFilter, loadPicture, savePicture, PICTURE_MIN, PICTURE_MAX } from './picture.js';
```

Replace the whole `buildMenu` function (line 355 onward, through its closing brace) with:

```javascript
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
```

- [ ] **Step 4: Replace `toggleMenu` with exclusive popover control**

In `public/js/player.js`, replace:

```javascript
export function toggleMenu() {
  el('player-menu')?.classList.toggle('is-open');
}
```

with:

```javascript
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
```

- [ ] **Step 5: Wire the actions**

Find the action dispatch in `public/js/player.js` (search for `'toggle-menu'`). Replace the `toggle-menu` case with:

```javascript
    case 'toggle-popover': togglePopover(target.dataset.popover); break;
    case 'picture-reset': setPicture({ brightness: 100, contrast: 100 }); break;
```

Add `setPicture` next to the other exported setters:

```javascript
/** Apply and store a picture setting. A repaint, not a stream restart. */
export function setPicture({ brightness, contrast }) {
  if (!ctx) return;
  ctx.picture = { brightness: clampPicture(brightness), contrast: clampPicture(contrast) };
  ctx.video.style.filter = pictureFilter(ctx.picture);
  savePicture(ctx.picture);
  buildPicturePopover();
}
```

In `attach()`, add listeners for the two sliders. They are rebuilt with the popover, so bind on the container rather than the inputs:

```javascript
  el('popover-picture').addEventListener('input', (event) => {
    const input = event.target;
    if (input.id !== 'brightness' && input.id !== 'contrast') return;
    setPicture({ ...ctx.picture, [input.id]: Number(input.value) });
  });
```

- [ ] **Step 6: Load the stored picture on open**

In `openInner`, where `ctx` is built, add the picture field next to `audioOffset`:

```javascript
    picture: loadPicture(),
```

And immediately after the video element exists, apply it:

```javascript
  ctx.video.style.filter = pictureFilter(ctx.picture);
```

- [ ] **Step 7: Close the popovers when the player goes idle**

A panel left open over a hidden control bar floats unanchored. In `markIdle`
(`player.js:343`), add `closePopovers()` to the timeout body so it reads:

```javascript
  ctx.idleTimer = setTimeout(() => {
    if (ctx && !ctx.video.paused) {
      closePopovers();
      ctx.node.classList.add('is-idle');
    }
  }, IDLE_MS);
```

The episode sidebar deliberately does **not** close on idle — it is a full-height
panel that anchors itself, and closing it mid-scroll would be hostile.

- [ ] **Step 8: Style the popovers and the rate button**

Append to `public/css/player.css`:

```css
/* ---- setting popovers ----
   Four buttons, one panel each, exclusive. The panel is anchored to its own
   button rather than to the bar so it stays put when the bar reflows. */
.player__pop { position: relative; display: flex; }
.player__pop-panel {
  position: absolute; bottom: calc(100% + var(--space-2)); right: 0;
  min-width: 200px; max-height: 46vh; overflow-y: auto;
  padding: var(--space-3); border-radius: var(--radius);
  background: rgba(16, 16, 18, .96);
  box-shadow: 0 8px 30px rgba(0, 0, 0, .55);
  backdrop-filter: blur(12px);
}
.player__pop-panel[hidden] { display: none; }

/* The rate button shows its value instead of an icon, so a stray 1.5x is
   visible without opening anything. */
.player__btn--rate {
  font: 600 13px/1 var(--font); letter-spacing: .01em;
  min-width: 44px;
}

.picture__row {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: var(--space-2);
}
.picture__name { font-size: 12px; opacity: .72; }
.picture__value { font-size: 12px; }
.range--picture { width: 100%; margin-bottom: var(--space-2); }
```

- [ ] **Step 9: Verify by hand**

Run: `npm start`, open `http://127.0.0.1:3000`, play an episode.
Expected: four buttons plus fullscreen on the right; each opens its own panel; opening one closes the others; the rate button reads `1×`; dragging brightness dims the picture but **not** the control bar.

Stop the server when done — do not leave it running.

- [ ] **Step 10: Commit**

```bash
git add public/js/views.js public/js/player.js public/css/player.css
git commit -m "feat(player): split settings into four buttons and add picture controls"
```

---

## Task 3: Episode rows

**Files:**
- Modify: `public/js/state.js` — add after `previousEpisode` (line 142)
- Test: `tests/episode-rows.test.mjs`
- Modify: `package.json:13`

**Interfaces:**
- Consumes: nothing.
- Produces: `episodeRows(show, seasonNumber, currentSeason, currentEpisode)` returning an array of `{ season: number, episode_number: number, title: string, filePath: string|null, playable: boolean, current: boolean }`, and `seasonNumbers(show)` returning a sorted array of numbers.

- [ ] **Step 1: Write the failing test**

Create `tests/episode-rows.test.mjs`:

```javascript
/**
 * Episode sidebar rows.
 *
 * Run: node tests/episode-rows.test.mjs
 */
import { episodeRows, seasonNumbers } from '../public/js/state.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const show = {
  title: 'Rick and Morty',
  seasons: [
    { number: 2, episodes: [
      { episode_number: 2, title: 'Mortynight Run', files: [{ file_path: '/lib/s2e2.mkv' }] },
      { episode_number: 1, title: 'A Rickle in Time', files: [{ file_path: '/lib/s2e1.mkv' }] },
      { episode_number: 3, title: 'Auto Erotic', files: [] }
    ] },
    { number: 1, episodes: [
      { episode_number: 1, title: 'Pilot', files: [{ file_path: '/lib/s1e1.mkv' }] }
    ] },
    { number: 3, episodes: [] }
  ]
};

console.log('\nseasonNumbers');
check('sorts ascending', JSON.stringify(seasonNumbers(show)) === '[1,2,3]');
check('a show with no seasons gives an empty list', seasonNumbers({}).length === 0);
check('a null show gives an empty list', seasonNumbers(null).length === 0);

console.log('\nepisodeRows');
const s2 = episodeRows(show, 2, 2, 2);
check('returns every episode of the season', s2.length === 3);
check('sorts by episode number', s2.map((r) => r.episode_number).join(',') === '1,2,3');
check('carries the season number', s2.every((r) => r.season === 2));
check('carries the title', s2[0].title === 'A Rickle in Time');
check('carries the file path', s2[0].filePath === '/lib/s2e1.mkv');

check('an episode with a file is playable', s2[0].playable === true);
check('an episode with no file is not playable', s2[2].playable === false);
check('an episode with no file has a null path', s2[2].filePath === null);

check('marks the current episode', s2[1].current === true);
check('does not mark the others', s2[0].current === false && s2[2].current === false);

// The current episode is S02E02, so nothing in season 1 may be marked -
// matching on episode number alone would light up S01E01 against S02E01.
const s1 = episodeRows(show, 1, 2, 1);
check('does not mark a same-numbered episode in another season', s1[0].current === false);

check('an empty season gives an empty list', episodeRows(show, 3, 2, 2).length === 0);
check('an unknown season gives an empty list', episodeRows(show, 99, 2, 2).length === 0);
check('a null show gives an empty list', episodeRows(null, 1, 1, 1).length === 0);
check('every row carries the full shape', s2.every((row) =>
  typeof row.season === 'number' &&
  typeof row.episode_number === 'number' &&
  typeof row.title === 'string' &&
  (row.filePath === null || typeof row.filePath === 'string') &&
  typeof row.playable === 'boolean' &&
  typeof row.current === 'boolean'));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/episode-rows.test.mjs`
Expected: FAIL — `The requested module '../public/js/state.js' does not provide an export named 'episodeRows'`

- [ ] **Step 3: Write the implementation**

In `public/js/state.js`, add after `previousEpisode`:

```javascript
/** Every season number a show has, ascending. */
export function seasonNumbers(show) {
  return (show?.seasons || []).map((season) => season.number).sort((a, b) => a - b);
}

/**
 * One season's episodes, shaped for the sidebar.
 *
 * Episodes with no file are kept rather than filtered: a gap in the library
 * should read as a gap, not silently renumber the list. The caller dims them.
 *
 * `current` matches on season AND episode number - matching on episode number
 * alone would mark S01E01 while S02E01 is playing.
 */
export function episodeRows(show, seasonNumber, currentSeason, currentEpisode) {
  const season = (show?.seasons || []).find((entry) => entry.number === seasonNumber);
  if (!season) return [];

  return [...(season.episodes || [])]
    .sort((a, b) => a.episode_number - b.episode_number)
    .map((episode) => {
      const file = (episode.files || [])[0] || null;
      return {
        season: season.number,
        episode_number: episode.episode_number,
        title: episode.title || '',
        filePath: file ? file.file_path : null,
        playable: Boolean(file),
        current: season.number === currentSeason && episode.episode_number === currentEpisode
      };
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/episode-rows.test.mjs`
Expected: PASS — `18 checks, all passed`

- [ ] **Step 5: Add it to the test script**

Append ` && node tests/episode-rows.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 6: Commit**

```bash
git add public/js/state.js tests/episode-rows.test.mjs package.json
git commit -m "feat(player): episode row shaping for the sidebar"
```

---

## Task 4: Episode sidebar

**Files:**
- Modify: `public/js/views.js` — `renderPlayer`
- Modify: `public/js/player.js` — sidebar state and wiring
- Modify: `public/css/player.css`

**Interfaces:**
- Consumes: `episodeRows`, `seasonNumbers` from Task 3; `closePopovers` from Task 2; the existing `open(filePath)` and `episodeTag(season, number)`.
- Produces: `toggleEpisodes()`, `closeEpisodes()`, `selectSeason(number)` in `player.js`.

- [ ] **Step 1: Add the arrow and panel markup**

In `public/js/views.js`, in `renderPlayer`, insert immediately after the `next-up` block and before `<div class="player__controls">`:

```javascript
      <button class="player__eparrow" id="ep-arrow" data-action="toggle-episodes"
        aria-label="Episodes" title="Episodes" hidden>${icon('back', 'icon-lg')}</button>

      <aside class="player__episodes" id="ep-panel" hidden>
        <div class="player__ep-head">
          <div class="player__ep-title" id="ep-show"></div>
          <button class="player__btn" data-action="close-episodes" aria-label="Close">${icon('close', 'icon')}</button>
        </div>
        <div class="player__ep-tabs" id="ep-tabs"></div>
        <div class="player__ep-list" id="ep-list"></div>
      </aside>
```

The `back` icon is a left-pointing chevron, which is what the arrow needs.

- [ ] **Step 2: Build the sidebar**

In `public/js/player.js`, import the two new helpers by adding them to the existing `./state.js` import:

```javascript
import { state, setState, locateFile, nextEpisode, previousEpisode, episodeRows, seasonNumbers } from './state.js';
```

(Keep whatever that import already lists; add only `episodeRows` and `seasonNumbers`.)

Add the builder:

```javascript
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
        <span class="player__ep-tag t-num">${esc(episodeTag(row.season, row.episode_number))}</span>
        <span class="player__ep-name">${esc(row.title || 'Untitled')}</span>
      </button>`).join('');
}

export function toggleEpisodes() {
  const panel = el('ep-panel');
  if (!panel || !hasEpisodes()) return;
  closePopovers();
  const opening = panel.hidden;
  panel.hidden = !opening;
  if (opening) {
    ctx.epSeason = ctx.located.season;
    buildEpisodes();
    el('ep-list')?.querySelector('.is-current')?.scrollIntoView({ block: 'center' });
  }
}

export function closeEpisodes() {
  const panel = el('ep-panel');
  if (panel) panel.hidden = true;
}

export function selectSeason(number) {
  if (!ctx) return;
  ctx.epSeason = Number(number);
  buildEpisodes();
}
```

- [ ] **Step 3: Wire the actions**

In the action dispatch in `public/js/player.js`, add:

```javascript
    case 'toggle-episodes': toggleEpisodes(); break;
    case 'close-episodes': closeEpisodes(); break;
    case 'select-season': selectSeason(target.dataset.season); break;
    case 'play-episode': closeEpisodes(); open(target.dataset.path); break;
```

In `openInner`, after `ctx` is built, add:

```javascript
  ctx.epSeason = ctx.located?.type === 'episode' ? ctx.located.season : null;
  buildEpisodes();
```

Extend the existing Escape handler so it closes the sidebar and popovers before it closes the player:

```javascript
    case 'Escape':
      if (!el('ep-panel')?.hidden) { closeEpisodes(); break; }
      if (POPOVERS.some((name) => !el(`popover-${name}`)?.hidden)) { closePopovers(); break; }
      close();
      break;
```

Add a document-level click handler in `attach()` that closes both on an outside click:

```javascript
  ctx.outsideClick = (event) => {
    if (!ctx) return;
    if (!event.target.closest('.player__pop')) closePopovers();
    if (!event.target.closest('.player__episodes, .player__eparrow')) closeEpisodes();
  };
  document.addEventListener('click', ctx.outsideClick);
```

In `close()`, remove it so a closed player leaves no listener behind:

```javascript
  if (ctx?.outsideClick) document.removeEventListener('click', ctx.outsideClick);
```

- [ ] **Step 4: Style the arrow and panel**

Append to `public/css/player.css`:

```css
/* ---- episode sidebar ----
   Rendered only for episodes. It sits above the video, so it swallows its own
   taps and never reaches the double-tap-to-seek listener bound to the video. */
.player__eparrow {
  position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  z-index: 3;
  display: grid; place-items: center;
  width: 34px; height: 72px;
  border: 0; border-radius: var(--radius) 0 0 var(--radius);
  background: rgba(16, 16, 18, .74); color: var(--fg);
  cursor: pointer;
  transition: opacity var(--state), background var(--state);
}
.player__eparrow:hover { background: rgba(16, 16, 18, .92); }
.player__eparrow[hidden] { display: none; }
.player.is-idle .player__eparrow { opacity: 0; pointer-events: none; }

.player__episodes {
  position: absolute; right: 0; top: 0; bottom: 0; z-index: 4;
  width: min(360px, 86vw);
  display: flex; flex-direction: column;
  background: rgba(16, 16, 18, .97);
  box-shadow: -8px 0 34px rgba(0, 0, 0, .5);
  backdrop-filter: blur(14px);
}
.player__episodes[hidden] { display: none; }

.player__ep-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-3);
}
.player__ep-title { font-weight: 600; }
.player__ep-tabs {
  display: flex; gap: var(--space-1); overflow-x: auto;
  padding: 0 var(--space-3) var(--space-3);
  scrollbar-width: none;
}
.player__ep-tabs::-webkit-scrollbar { display: none; }
.player__ep-tab {
  flex: none; min-width: 44px; height: 44px;
  border: 0; border-radius: var(--radius);
  background: rgba(255, 255, 255, .08); color: var(--fg);
  font: 600 12px/1 var(--font); cursor: pointer;
}
.player__ep-tab.is-active { background: var(--fg); color: #101012; }

.player__ep-list { flex: 1; overflow-y: auto; padding: 0 var(--space-2) var(--space-3); }
.player__ep-row {
  display: flex; align-items: center; gap: var(--space-2);
  width: 100%; min-height: 44px; padding: var(--space-2);
  border: 0; border-radius: var(--radius);
  background: transparent; color: var(--fg); text-align: left;
  font: 400 13px/1.3 var(--font); cursor: pointer;
}
.player__ep-row:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
.player__ep-row.is-current { background: rgba(255, 255, 255, .14); font-weight: 600; }
.player__ep-row.is-missing { opacity: .38; cursor: default; }
.player__ep-tag { flex: none; opacity: .68; font-size: 12px; }
.player__ep-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 5: Verify by hand**

Run: `npm start`, play an **episode**.
Expected: an arrow on the right edge, vertically centred; clicking it slides in the panel, the current season tab is active, the playing episode is highlighted and scrolled into view; picking another episode plays it; the panel closes on Escape, on the ×, and on an outside click.

Then play a **movie**.
Expected: no arrow at all.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add public/js/views.js public/js/player.js public/css/player.css
git commit -m "feat(player): right-edge episode sidebar with season tabs"
```

---

## Task 5: Seek preview arithmetic

**Files:**
- Create: `public/js/preview.js`
- Test: `tests/seek-preview.test.mjs`
- Modify: `package.json:13`

**Interfaces:**
- Consumes: nothing.
- Produces: `previewFraction(x, width) -> number` in `[0,1]`, `frameIndex(time, interval) -> number`, `cardLeft(fraction, trackWidth, cardWidth) -> number`.

- [ ] **Step 1: Write the failing test**

Create `tests/seek-preview.test.mjs`:

```javascript
/**
 * Seek bar preview arithmetic.
 *
 * Run: node tests/seek-preview.test.mjs
 */
import { previewFraction, frameIndex, cardLeft } from '../public/js/preview.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\npreviewFraction');
check('midpoint is 0.5', previewFraction(200, 400) === 0.5);
check('left edge is 0', previewFraction(0, 400) === 0);
check('right edge is 1', previewFraction(400, 400) === 1);
check('clamps a negative position', previewFraction(-30, 400) === 0);
check('clamps past the right edge', previewFraction(900, 400) === 1);
check('zero width gives 0 rather than NaN', previewFraction(10, 0) === 0);
check('negative width gives 0', previewFraction(10, -5) === 0);
check('NaN position gives 0', previewFraction(NaN, 400) === 0);
check('NaN width gives 0', previewFraction(10, NaN) === 0);

console.log('\nframeIndex');
check('start of file is frame 0', frameIndex(0, 10) === 0);
check('floors within an interval', frameIndex(9.9, 10) === 0);
check('crosses to the next frame', frameIndex(10, 10) === 1);
check('handles a long position', frameIndex(1325, 10) === 132);
check('respects a wider interval', frameIndex(1325, 24) === 55);
check('never returns a negative index', frameIndex(-50, 10) === 0);
check('a zero interval gives 0 rather than Infinity', frameIndex(100, 0) === 0);
check('NaN time gives 0', frameIndex(NaN, 10) === 0);

console.log('\ncardLeft');
// A 160px card on a 1000px track: centred on the cursor, but never overhanging.
check('centres in the middle of the track', cardLeft(0.5, 1000, 160) === 420);
check('clamps at the left edge', cardLeft(0, 1000, 160) === 0);
check('clamps at the right edge', cardLeft(1, 1000, 160) === 840);
check('clamps just inside the left edge', cardLeft(0.02, 1000, 160) === 0);
check('a card wider than the track pins to 0', cardLeft(0.5, 100, 160) === 0);
check('zero track width gives 0', cardLeft(0.5, 0, 160) === 0);

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/seek-preview.test.mjs`
Expected: FAIL — `Cannot find module '.../public/js/preview.js'`

- [ ] **Step 3: Write the implementation**

Create `public/js/preview.js`:

```javascript
/**
 * Seek bar preview arithmetic.
 *
 * Kept out of player.js so it can be tested without a DOM: every function here
 * takes numbers and returns numbers.
 */

/** Pointer position along the track, as a fraction in [0, 1]. */
export function previewFraction(x, width) {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.min(1, x / width));
}

/** Which generated frame covers this position. */
export function frameIndex(time, interval) {
  if (!Number.isFinite(time) || !Number.isFinite(interval) || interval <= 0) return 0;
  return Math.max(0, Math.floor(time / interval));
}

/**
 * Left offset for the preview card, centred on the cursor but clamped so it
 * never overhangs either end of the track.
 */
export function cardLeft(fraction, trackWidth, cardWidth) {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return 0;
  if (!Number.isFinite(cardWidth) || cardWidth <= 0) return 0;
  const centred = (fraction * trackWidth) - (cardWidth / 2);
  return Math.max(0, Math.min(trackWidth - cardWidth, centred));
}

export default { previewFraction, frameIndex, cardLeft };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/seek-preview.test.mjs`
Expected: PASS — `23 checks, all passed`

- [ ] **Step 5: Add it to the test script**

Append ` && node tests/seek-preview.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 6: Commit**

```bash
git add public/js/preview.js tests/seek-preview.test.mjs package.json
git commit -m "feat(player): seek preview arithmetic"
```

---

## Task 6: Seek bar ball, band and card

**Files:**
- Modify: `public/js/views.js` — `renderPlayer`
- Modify: `public/js/player.js` — pointer wiring
- Modify: `public/css/player.css`

**Interfaces:**
- Consumes: `previewFraction`, `cardLeft` from Task 5; the existing `formatTime` and `duration()`.
- Produces: the DOM contract `#scrub` (wrapper), `#preview-ball`, `#preview-card`, `#preview-time`, `#preview-frame`, and the `--preview` custom property on `#scrub`. Task 10 fills `#preview-frame`.

- [ ] **Step 1: Wrap the seek input in a preview layer**

In `public/js/views.js`, in `renderPlayer`, replace:

```javascript
          <input class="range" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
```

with:

```javascript
          <div class="player__scrub" id="scrub">
            <input class="range" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
            <div class="player__band" id="preview-band" aria-hidden="true"></div>
            <div class="player__ball" id="preview-ball" aria-hidden="true"></div>
            <div class="player__card" id="preview-card" aria-hidden="true">
              <div class="player__card-frame" id="preview-frame"></div>
              <div class="player__card-time t-num" id="preview-time">0:00</div>
            </div>
          </div>
```

- [ ] **Step 2: Mirror `--fill` onto the scrub wrapper**

The band needs both values on the same element. In `public/js/player.js`, find every place that sets `--fill` on the seek input (the `input` listener in `attach()`, and `tick()`), and set it on the wrapper too. Add this helper and call it wherever `--fill` is currently written:

```javascript
/** Keep --fill on the wrapper as well, so the band can compare it to --preview. */
function setFill(percent) {
  const value = percent.toFixed(2);
  el('seek')?.style.setProperty('--fill', value);
  el('scrub')?.style.setProperty('--fill', value);
}
```

- [ ] **Step 3: Wire the pointer**

Add the import to `public/js/player.js`:

```javascript
import { previewFraction, cardLeft } from './preview.js';
```

Add the preview functions:

```javascript
/* --------------------------------------------------------------------------
 * Seek preview
 * ----------------------------------------------------------------------- */

/** Show the ball, band and card at a fraction along the track. */
function showPreview(fraction) {
  const scrub = el('scrub');
  const card = el('preview-card');
  if (!scrub || !card) return;

  scrub.style.setProperty('--preview', (fraction * 100).toFixed(2));
  scrub.classList.add('is-previewing');

  const total = duration();
  el('preview-time').textContent = Number.isFinite(total) && total > 0
    ? formatTime(fraction * total)
    : '--:--';

  const trackWidth = scrub.getBoundingClientRect().width;
  const cardWidth = card.getBoundingClientRect().width;
  card.style.left = `${cardLeft(fraction, trackWidth, cardWidth)}px`;
}

function hidePreview() {
  el('scrub')?.classList.remove('is-previewing');
}
```

In `attach()`, add the listeners:

```javascript
  const scrub = el('scrub');
  scrub.addEventListener('pointermove', (event) => {
    const rect = scrub.getBoundingClientRect();
    showPreview(previewFraction(event.clientX - rect.left, rect.width));
  });
  scrub.addEventListener('pointerleave', hidePreview);
  // Touch has no hover, so the preview follows the finger through a drag and
  // clears when it lifts.
  scrub.addEventListener('pointercancel', hidePreview);
  scrub.addEventListener('pointerup', hidePreview);
```

- [ ] **Step 4: Style the ball, band and card**

Append to `public/css/player.css`:

```css
/* ---- seek preview ----
   A native range input cannot carry a second thumb, so the ball and band are
   a layer over the track. --fill and --preview are bare numbers, consumed as
   calc(var(--x) * 1%), matching the existing track gradient. */
.player__scrub { position: relative; }
.player__scrub .range { position: relative; z-index: 2; }

.player__band, .player__ball, .player__card {
  position: absolute; pointer-events: none;
  opacity: 0; transition: opacity var(--state);
}
.player__scrub.is-previewing .player__band,
.player__scrub.is-previewing .player__ball,
.player__scrub.is-previewing .player__card { opacity: 1; }

/* The stretch between where playback is and where you would land. Renders in
   either direction: scrubbing backward shades what would be replayed. */
.player__band {
  top: 50%; height: 5px; margin-top: -2.5px; z-index: 1;
  left: min(calc(var(--fill, 0) * 1%), calc(var(--preview, 0) * 1%));
  width: max(0px, calc(abs(var(--preview, 0) - var(--fill, 0)) * 1%));
  border-radius: 3px;
  background: rgba(0, 0, 0, .55);
}

.player__ball {
  top: 50%; z-index: 3;
  left: calc(var(--preview, 0) * 1%);
  width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px;
  border-radius: 50%;
  background: rgba(255, 255, 255, .45);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .4);
}

.player__card {
  bottom: calc(100% + 10px); left: 0; z-index: 4;
  width: 168px; padding: 4px;
  border-radius: var(--radius);
  background: rgba(16, 16, 18, .96);
  box-shadow: 0 8px 26px rgba(0, 0, 0, .55);
}
.player__card-frame {
  width: 160px; height: 90px; border-radius: 4px;
  background: rgba(255, 255, 255, .06) center / cover no-repeat;
}
.player__card-time { text-align: center; padding: 4px 0 2px; font-size: 12px; }
```

`abs()` in CSS is not universally supported. If the band does not render in the browser check, replace the `width` line with two rules driven by a class that `showPreview` toggles:

```css
.player__band { width: calc((var(--preview, 0) - var(--fill, 0)) * 1%); }
.player__scrub.is-behind .player__band { width: calc((var(--fill, 0) - var(--preview, 0)) * 1%); }
```

and in `showPreview`, add:

```javascript
  const fillPercent = Number(scrub.style.getPropertyValue('--fill')) || 0;
  scrub.classList.toggle('is-behind', fraction * 100 < fillPercent);
```

- [ ] **Step 5: Verify by hand**

Run: `npm start`, play anything, hover along the seek bar.
Expected: a translucent ball tracks the cursor, the solid knob stays where playback is, a dark band spans between them in both directions, and a card floats above showing the timestamp and clamping at both ends instead of overhanging.

Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add public/js/views.js public/js/player.js public/css/player.css
git commit -m "feat(player): seek bar preview ball, landing band and timestamp card"
```

---

## Task 7: Browser checks for the player

**Files:**
- Create: `tests/ui-player.mjs`
- Modify: `package.json` — add a `ui-player` script

**Interfaces:**
- Consumes: every DOM contract from Tasks 2, 4 and 6.
- Produces: nothing other tasks depend on.

**Why this task exists:** four separate UI bugs in this codebase passed markup-shape assertions and only failed when a browser drove the page. Geometry is the thing to assert, not structure.

- [ ] **Step 1: Write the harness**

Create `tests/ui-player.mjs`:

```javascript
/**
 * Browser-driven player invariants.
 *
 * Playwright's Chromium usually cannot decode this library's codecs, so the
 * video may never load and duration may stay 0. That is fine: the player
 * renders its chrome the moment open() is called. Assert chrome geometry here
 * and leave anything needing a real duration to the unit tests.
 *
 * Needs a running server:  npm start
 * Run:                     npm run ui-player
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_CHECK_URL || 'http://127.0.0.1:3000';

/** Playwright lives in the npx cache on this machine, not in node_modules. */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
    if (!fs.existsSync(cache)) throw new Error('playwright not found and no npx cache');
    for (const entry of fs.readdirSync(cache)) {
      const candidate = path.join(cache, entry, 'node_modules', 'playwright');
      if (fs.existsSync(candidate)) return require(candidate);
    }
    throw new Error('playwright not found in node_modules or the npx cache');
  }
}

let total = 0;
let failures = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) {
    console.log(`  [pass] ${name}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${name}`);
    if (detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  }
}

const playwright = loadPlaywright();
const browser = await playwright.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

/**
 * Open the first playable file of a given kind through the real UI.
 * Returns false when the library has nothing of that kind.
 */
async function openFirst(kind) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const located = await page.evaluate(async (want) => {
    const library = await (await fetch('/api/media/library')).json();
    if (want === 'movie') {
      const movie = (library.movies || []).find((m) => (m.files || []).length);
      return movie ? (movie.files[0].file_path) : null;
    }
    for (const show of library.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          if ((episode.files || []).length) return episode.files[0].file_path;
        }
      }
    }
    return null;
  }, kind);

  if (!located) return false;

  await page.evaluate(async (filePath) => {
    const player = await import('/js/player.js');
    await player.open(filePath);
  }, located);

  await page.waitForSelector('#player', { timeout: 10000 });
  await page.waitForTimeout(600);
  return true;
}

console.log('\nepisode');
if (!(await openFirst('episode'))) {
  check('library has a playable episode', false, 'no episode with a file');
} else {
  const buttons = await page.$$eval('#player-settings [data-action="toggle-popover"]',
    (nodes) => nodes.map((n) => ({
      popover: n.dataset.popover,
      w: n.getBoundingClientRect().width,
      h: n.getBoundingClientRect().height
    })));

  check('four setting buttons are present', buttons.length === 4, buttons.map((b) => b.popover));
  check('every setting button has real size',
    buttons.every((b) => b.w >= 32 && b.h >= 32), buttons);
  check('the four popovers are the expected ones',
    buttons.map((b) => b.popover).sort().join(',') === 'picture,speed,subs,sync',
    buttons.map((b) => b.popover));

  // Exclusivity: open each in turn, assert exactly one panel is visible.
  const openCounts = [];
  for (const name of ['subs', 'sync', 'speed', 'picture']) {
    await page.click(`[data-action="toggle-popover"][data-popover="${name}"]`);
    await page.waitForTimeout(120);
    openCounts.push(await page.$$eval('.player__pop-panel',
      (nodes) => nodes.filter((n) => !n.hidden).length));
  }
  check('exactly one popover is open at a time',
    openCounts.every((n) => n === 1), openCounts);

  // The picture popover is open from the loop above.
  const filterBefore = await page.$eval('#player-video', (v) => getComputedStyle(v).filter);
  await page.$eval('#brightness', (input) => {
    input.value = '40';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(120);
  const filterAfter = await page.$eval('#player-video', (v) => getComputedStyle(v).filter);
  check('brightness changes the video filter', filterBefore !== filterAfter,
    { before: filterBefore, after: filterAfter });

  const barDimmed = await page.$eval('.player__controls',
    (bar) => getComputedStyle(bar).filter);
  check('the control bar is not dimmed with the picture',
    barDimmed === 'none', barDimmed);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);

  const arrow = await page.$eval('#ep-arrow', (el) => ({
    hidden: el.hidden,
    ...el.getBoundingClientRect().toJSON()
  }));
  check('the episode arrow is visible on an episode', arrow.hidden === false);
  check('the arrow has real size', arrow.width > 0 && arrow.height > 0, arrow);
  check('the arrow sits on the right edge',
    Math.abs(arrow.right - 1440) < 2, { right: arrow.right });
  check('the arrow is vertically centred',
    Math.abs((arrow.top + arrow.height / 2) - 450) < 40, { top: arrow.top });

  await page.click('#ep-arrow');
  await page.waitForTimeout(300);

  const panel = await page.$eval('#ep-panel', (el) => ({
    hidden: el.hidden,
    ...el.getBoundingClientRect().toJSON()
  }));
  check('the sidebar opens', panel.hidden === false);
  check('the sidebar has real width', panel.width > 200, panel);
  check('the sidebar is flush right', Math.abs(panel.right - 1440) < 2, { right: panel.right });

  const rows = await page.$$eval('.player__ep-row', (nodes) => nodes.map((n) => ({
    current: n.classList.contains('is-current'),
    w: n.getBoundingClientRect().width,
    h: n.getBoundingClientRect().height
  })));
  check('the sidebar lists episodes', rows.length > 0, { rows: rows.length });
  check('exactly one row is marked current',
    rows.filter((r) => r.current).length === 1, rows.filter((r) => r.current).length);
  check('no episode row collapses', rows.every((r) => r.w > 0 && r.h >= 44), rows.slice(0, 4));

  const tabs = await page.$$eval('.player__ep-tab', (nodes) => nodes.length);
  check('season tabs render', tabs > 0, { tabs });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes the sidebar', await page.$eval('#ep-panel', (el) => el.hidden));

  // Seek preview. Hover the middle of the track and read the geometry back.
  const scrub = await page.$('#scrub');
  const box = await scrub.boundingBox();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.waitForTimeout(200);

  const preview = await page.evaluate(() => {
    const node = document.getElementById('scrub');
    const ball = document.getElementById('preview-ball');
    const card = document.getElementById('preview-card');
    const band = document.getElementById('preview-band');
    return {
      previewing: node.classList.contains('is-previewing'),
      preview: Number(node.style.getPropertyValue('--preview')),
      trackWidth: node.getBoundingClientRect().width,
      trackLeft: node.getBoundingClientRect().left,
      ballCentre: ball.getBoundingClientRect().left + ball.getBoundingClientRect().width / 2,
      ballOpacity: Number(getComputedStyle(ball).opacity),
      cardLeft: card.getBoundingClientRect().left,
      cardRight: card.getBoundingClientRect().right,
      cardWidth: card.getBoundingClientRect().width,
      bandWidth: band.getBoundingClientRect().width
    };
  });

  check('hovering marks the scrub as previewing', preview.previewing === true);
  check('--preview lands near 75%', Math.abs(preview.preview - 75) < 3, preview.preview);
  check('the ball is visible', preview.ballOpacity > 0.5, preview.ballOpacity);
  check('the ball sits under the cursor',
    Math.abs(preview.ballCentre - (preview.trackLeft + preview.trackWidth * 0.75)) < 6,
    { ballCentre: preview.ballCentre });
  check('the card has real size', preview.cardWidth > 100, preview.cardWidth);
  check('the card does not overhang the track',
    preview.cardLeft >= preview.trackLeft - 1
    && preview.cardRight <= preview.trackLeft + preview.trackWidth + 1,
    preview);
  check('the band renders ahead of playback', preview.bandWidth > 0, preview.bandWidth);

  // Scrubbing backward: the band must render on the other side too.
  await page.evaluate(() => {
    document.getElementById('scrub').style.setProperty('--fill', '90.00');
  });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const backward = await page.$eval('#preview-band', (b) => b.getBoundingClientRect().width);
  check('the band renders behind playback too', backward > 0, backward);

  const overflow = await page.evaluate(() => ({
    scrollW: document.body.scrollWidth, innerW: window.innerWidth
  }));
  check('the player causes no horizontal overflow',
    overflow.scrollW <= overflow.innerW, overflow);
}

console.log('\nmovie');
if (!(await openFirst('movie'))) {
  console.log('  [skip] no movie in the library');
} else {
  const arrowHidden = await page.$eval('#ep-arrow', (el) => el.hidden);
  check('a movie has no episode arrow', arrowHidden === true);
}

check('no console errors while driving the player', consoleErrors.length === 0,
  consoleErrors.slice(0, 6));

await context.close();
await browser.close();

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Add the script**

In `package.json`, add next to `ui-check`:

```json
"ui-player": "node tests/ui-player.mjs"
```

- [ ] **Step 3: Run it**

```bash
npm start &
sleep 4
npm run ui-player
```

Expected: all checks pass. Fix whatever fails — this harness exists precisely to catch what the unit tests cannot.

**Stop the server before moving on.** Find and kill it:

```bash
pid=$(netstat -ano | grep -E ':3000\s+.*LISTENING' | awk '{print $5}' | head -1)
taskkill //PID $pid //T //F
```

- [ ] **Step 4: Commit**

```bash
git add tests/ui-player.mjs package.json
git commit -m "test: browser-driven checks for player settings, sidebar and seek preview"
```

---

## Task 8: Thumbnail service

**Files:**
- Create: `services/thumbnails.js`
- Test: `tests/thumbnails.test.mjs`
- Modify: `package.json:13`, `.gitignore`

**Interfaces:**
- Consumes: `probe(filePath)` from `services/transcoder.js`, which returns `{ duration, ... }`; `isAvailable()` from the same module, which returns a **Promise** resolving to a boolean (`transcoder.js:52`) — note it is `isAvailable`, not `ffmpegAvailable`; `config.ffmpeg` and `ROOT_DIR` from `config/index.js`.
- Produces: `frameInterval(duration) -> number`, `frameCount(duration, interval) -> number`, `cacheKey(filePath, size, mtimeMs) -> string`, `getMeta(filePath) -> Promise<{interval, count, total, ready}>`, `framePath(filePath, index) -> Promise<string|null>`, and the constants `FRAME_SECONDS = 10`, `MAX_FRAMES = 300`.

- [ ] **Step 1: Write the failing test**

Create `tests/thumbnails.test.mjs`:

```javascript
/**
 * Thumbnail service — interval arithmetic and cache keys.
 *
 * The pure parts only. Generation needs ffmpeg and a real file, and is covered
 * by driving the player in tests/ui-player.mjs.
 *
 * Run: node tests/thumbnails.test.mjs
 */
import {
  frameInterval, frameCount, cacheKey, FRAME_SECONDS, MAX_FRAMES
} from '../services/thumbnails.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nframeInterval');
check('a 22-minute episode gets the base interval', frameInterval(22 * 60) === FRAME_SECONDS);
check('a short clip gets the base interval', frameInterval(45) === FRAME_SECONDS);
check('exactly at the cap stays at the base interval',
  frameInterval(FRAME_SECONDS * MAX_FRAMES) === FRAME_SECONDS);
check('one second past the cap stretches',
  frameInterval(FRAME_SECONDS * MAX_FRAMES + 1) === FRAME_SECONDS + 1);
check('a two-hour film stretches to 24s', frameInterval(2 * 60 * 60) === 24);
check('never returns below the base interval', frameInterval(1) === FRAME_SECONDS);
check('zero duration gives the base interval', frameInterval(0) === FRAME_SECONDS);
check('null duration gives the base interval', frameInterval(null) === FRAME_SECONDS);
check('NaN duration gives the base interval', frameInterval(NaN) === FRAME_SECONDS);
check('a negative duration gives the base interval', frameInterval(-30) === FRAME_SECONDS);

console.log('\nframeCount');
check('a 22-minute episode at 10s gives 132', frameCount(22 * 60, 10) === 132);
check('rounds a partial final interval up', frameCount(95, 10) === 10);
check('never exceeds the cap', frameCount(2 * 60 * 60, frameInterval(2 * 60 * 60)) <= MAX_FRAMES);
check('zero duration gives zero frames', frameCount(0, 10) === 0);
check('null duration gives zero frames', frameCount(null, 10) === 0);
check('a zero interval gives zero rather than Infinity', frameCount(600, 0) === 0);

console.log('\ncacheKey');
const a = cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000);
check('is a 40-character sha1 hex string', /^[0-9a-f]{40}$/.test(a));
check('is stable for identical inputs',
  a === cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000));
check('changes when the path changes',
  a !== cacheKey('/lib/show/s1e2.mkv', 1234567, 1700000000000));
check('changes when the size changes',
  a !== cacheKey('/lib/show/s1e1.mkv', 999, 1700000000000));
check('changes when the mtime changes',
  a !== cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000009999));
check('ignores sub-millisecond mtime drift',
  a === cacheKey('/lib/show/s1e1.mkv', 1234567, 1700000000000.7));
// Without a separator, ("ab", 1) and ("a", "b1") would collide.
check('separates its fields',
  cacheKey('ab', 1, 0) !== cacheKey('a', 'b1', 0));

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/thumbnails.test.mjs`
Expected: FAIL — `Cannot find module '.../services/thumbnails.js'`

- [ ] **Step 3: Write the implementation**

Create `services/thumbnails.js`:

```javascript
/**
 * Seek-preview thumbnails.
 *
 * Frames are grabbed by input-seeking - `-ss` before `-i` - so ffmpeg jumps to
 * the nearest keyframe rather than decoding forward from the start. A full
 * end-to-end decode of a 22-minute episode costs over a minute; a few hundred
 * input-seek grabs cost seconds. This is the same fast path the transcoder
 * already relies on for seeking.
 *
 * Every failure here is silent by design. The seek bar's ball, band and
 * timestamp never depend on a frame arriving, so a missing ffmpeg degrades the
 * preview rather than breaking the player.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, createLogger, ROOT_DIR } from '../config/index.js';
import { probe, isAvailable } from './transcoder.js';

const log = createLogger('thumbnails');

export const FRAME_SECONDS = 10;
export const MAX_FRAMES = 300;
const CONCURRENCY = 4;
const CACHE_DIR = path.join(ROOT_DIR, 'cache', 'thumbs');

/** One frame every FRAME_SECONDS, stretched so no file exceeds MAX_FRAMES. */
export function frameInterval(duration) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return FRAME_SECONDS;
  return Math.max(FRAME_SECONDS, Math.ceil(seconds / MAX_FRAMES));
}

/** How many frames a file of this duration produces at this interval. */
export function frameCount(duration, interval) {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  return Math.ceil(seconds / interval);
}

/**
 * Cache identity for a file.
 *
 * Size and mtime are part of the key, so a replaced or re-downloaded file gets
 * a new key and regenerates with no explicit invalidation step anywhere.
 */
export function cacheKey(filePath, size, mtimeMs) {
  return crypto.createHash('sha1')
    .update(`${filePath}|${size}|${Math.floor(Number(mtimeMs) || 0)}`)
    .digest('hex');
}

/** In-flight generations, keyed by cache key, so hovering cannot double-start. */
const running = new Map();

function keyFor(filePath) {
  const stat = fs.statSync(filePath);
  return cacheKey(filePath, stat.size, stat.mtimeMs);
}

function dirFor(key) {
  return path.join(CACHE_DIR, key);
}

/** Grab one frame. Resolves false rather than throwing on any failure. */
function grabFrame(filePath, seconds, outPath) {
  return new Promise((resolve) => {
    const child = spawn(config.ffmpeg.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(seconds),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-q:v', '5',
      '-y', outPath
    ], { windowsHide: true });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath)));
  });
}

/** Generate every frame for a file, CONCURRENCY at a time. */
async function generate(filePath, key, interval, count) {
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });

  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const outPath = path.join(dir, `${index}.jpg`);
      if (fs.existsSync(outPath)) continue;
      await grabFrame(filePath, index * interval, outPath);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log.info(`generated ${count} frames for ${path.basename(filePath)} in ${Date.now() - started}ms`);
}

/**
 * Interval, expected count, and how many frames exist so far.
 *
 * Starts generation if it is not already running. Returns `ready: false` while
 * frames are still landing; the client shows the timestamp alone until then.
 */
export async function getMeta(filePath) {
  if (!(await isAvailable())) {
    return { interval: FRAME_SECONDS, count: 0, total: 0, ready: false, available: false };
  }

  const info = await probe(filePath);
  const interval = frameInterval(info?.duration);
  const total = frameCount(info?.duration, interval);
  const key = keyFor(filePath);
  const dir = dirFor(key);

  const count = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.jpg')).length
    : 0;

  if (total > 0 && count < total && !running.has(key)) {
    const job = generate(filePath, key, interval, total)
      .catch((error) => log.warn(`generation failed: ${error.message}`))
      .finally(() => running.delete(key));
    running.set(key, job);
  }

  return { interval, count, total, ready: total > 0 && count >= total, available: true };
}

/** Absolute path to one generated frame, or null if it does not exist yet. */
export async function framePath(filePath, index) {
  const candidate = path.join(dirFor(keyFor(filePath)), `${Number(index)}.jpg`);
  return fs.existsSync(candidate) ? candidate : null;
}

export default { frameInterval, frameCount, cacheKey, getMeta, framePath };
```

- [ ] **Step 4: Confirm the transcoder exports what this imports**

Run: `grep -n "export function isAvailable\|export async function probe" services/transcoder.js`
Expected: exactly two lines, at 52 and 115. Both are already correct in the code above — this step is a guard against a rename, not a decision point.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node tests/thumbnails.test.mjs`
Expected: PASS — `27 checks, all passed`

- [ ] **Step 6: Ignore the cache directory**

Add to `.gitignore`, under the `# User media and in-progress downloads` group:

```
cache/
```

- [ ] **Step 7: Add it to the test script**

Append ` && node tests/thumbnails.test.mjs` to the `test` script in `package.json`.

- [ ] **Step 8: Commit**

```bash
git add services/thumbnails.js tests/thumbnails.test.mjs package.json .gitignore
git commit -m "feat(thumbs): frame generation by input-seeking, cached per file identity"
```

---

## Task 9: Thumbnail endpoints

**Files:**
- Create: `routes/thumbs.js`
- Modify: `server.js:113` — register the router

**Interfaces:**
- Consumes: `getMeta(filePath)` and `framePath(filePath, index)` from Task 8; `isInsideLibrary(candidate)` from `services/organizer.js`.
- Produces: `GET /api/thumbs/meta?path=` → `{ interval, count, total, ready }`; `GET /api/thumbs?path=&i=N` → `image/jpeg`.

- [ ] **Step 1: Write the route**

Create `routes/thumbs.js`:

```javascript
/**
 * GET /api/thumbs/meta?path=   — interval and how many frames exist yet
 * GET /api/thumbs?path=&i=N    — one generated frame
 *
 * Every path arrives from the client and is checked against the library root
 * before anything is opened, exactly as the stream route does.
 *
 * Nothing here is required for playback: the client falls back to a timestamp
 * whenever a frame is unavailable, so 404 and 503 are ordinary answers.
 */
import fs from 'node:fs';
import express from 'express';
import { createLogger } from '../config/index.js';
import { isInsideLibrary } from '../services/organizer.js';
import * as thumbnails from '../services/thumbnails.js';

const log = createLogger('api:thumbs');
const router = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Resolve and validate the ?path= parameter. Returns null once it has replied. */
function resolvePath(req, res) {
  const filePath = req.query.path;
  if (!filePath) {
    res.status(400).json({ error: 'path is required' });
    return null;
  }
  if (!isInsideLibrary(filePath)) {
    log.warn(`rejected a path outside the library: ${filePath}`);
    res.status(403).json({ error: 'path is outside the library' });
    return null;
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'file not found' });
    return null;
  }
  return filePath;
}

router.get('/meta', wrap(async (req, res) => {
  const filePath = resolvePath(req, res);
  if (!filePath) return;

  const meta = await thumbnails.getMeta(filePath);
  if (!meta.available) {
    return res.status(503).json({ error: 'ffmpeg unavailable' });
  }
  res.json({ interval: meta.interval, count: meta.count, total: meta.total, ready: meta.ready });
}));

router.get('/', wrap(async (req, res) => {
  const filePath = resolvePath(req, res);
  if (!filePath) return;

  const index = Number(req.query.i);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'i must be a non-negative integer' });
  }

  const frame = await thumbnails.framePath(filePath, index);
  if (!frame) return res.status(404).json({ error: 'frame not generated yet' });

  // The cache key already encodes path, size and mtime, so a given URL can
  // never point at a different frame.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/jpeg');
  fs.createReadStream(frame).pipe(res);
}));

export default router;
```

- [ ] **Step 2: Register it**

In `server.js`, add the import alongside the other routers, and register it next to the stream router (line 113):

```javascript
app.use('/api/thumbs', thumbsRouter);
```

- [ ] **Step 3: Verify the endpoints**

Start the server, then derive a real library path from the running API rather than
typing one in:

```bash
npm start &
sleep 4

ENC=$(node -e '
  const res = await fetch("http://127.0.0.1:3000/api/media/library");
  const lib = await res.json();
  for (const show of lib.shows || [])
    for (const season of show.seasons || [])
      for (const ep of season.episodes || [])
        if ((ep.files || []).length) {
          console.log(encodeURIComponent(ep.files[0].file_path));
          process.exit(0);
        }
  console.error("no playable episode in the library");
  process.exit(1);
' --input-type=module)

echo "using: $ENC"
```

Ask for the meta twice, a few seconds apart:

```bash
curl -s "http://127.0.0.1:3000/api/thumbs/meta?path=$ENC"
sleep 8
curl -s "http://127.0.0.1:3000/api/thumbs/meta?path=$ENC"
```

Expected: JSON with `interval`, `count`, `total`, `ready`. `count` climbs between the
two calls, and `ready` eventually turns true. For a 22-minute episode expect
`interval: 10` and `total` around 130.

Fetch a frame and confirm it is really a JPEG:

```bash
curl -s -o "$CLAUDE_JOB_DIR/tmp/frame.jpg" "http://127.0.0.1:3000/api/thumbs?path=$ENC&i=5"
file "$CLAUDE_JOB_DIR/tmp/frame.jpg"
```

Expected: `JPEG image data`.

Then confirm the guard rails:

```bash
curl -s -o /dev/null -w 'outside library: %{http_code}\n' \
  "http://127.0.0.1:3000/api/thumbs/meta?path=C%3A%2FWindows%2Fwin.ini"
curl -s -o /dev/null -w 'negative index:  %{http_code}\n' \
  "http://127.0.0.1:3000/api/thumbs?path=$ENC&i=-1"
curl -s -o /dev/null -w 'missing path:    %{http_code}\n' \
  "http://127.0.0.1:3000/api/thumbs/meta"
```

Expected, in order: `403`, `400`, `400`.

**Stop the server before moving on:**

```bash
pid=$(netstat -ano | grep -E ':3000\s+.*LISTENING' | awk '{print $5}' | head -1)
taskkill //PID $pid //T //F
```

- [ ] **Step 4: Commit**

```bash
git add routes/thumbs.js server.js
git commit -m "feat(thumbs): meta and frame endpoints with library path validation"
```

---

## Task 10: Wire frames into the preview card

**Files:**
- Modify: `public/js/api.js` — two URL builders
- Modify: `public/js/player.js` — `showPreview` and `openInner`
- Modify: `tests/ui-player.mjs` — one added check

**Interfaces:**
- Consumes: the endpoints from Task 9; `frameIndex` from Task 5; `showPreview` from Task 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the URL builders**

In `public/js/api.js`, next to `streamUrl` (line 113), add:

```javascript
export const thumbMetaUrl = (filePath) =>
  `/api/thumbs/meta?path=${encodeURIComponent(filePath)}`;

export const thumbUrl = (filePath, index) =>
  `/api/thumbs?path=${encodeURIComponent(filePath)}&i=${index}`;
```

Add both to the default export object at the bottom of the file.

- [ ] **Step 2: Fetch the meta on open**

In `public/js/player.js`, add to the `frameIndex` import from Task 5:

```javascript
import { previewFraction, cardLeft, frameIndex } from './preview.js';
```

Add the thumbnail state and loader:

```javascript
/**
 * Thumbnail availability for the open file.
 *
 * Absent, still generating, or a missing individual frame all land on the same
 * behaviour: the card shows its timestamp and no picture. Nothing here can
 * fail in a way the user has to see.
 */
async function loadThumbMeta() {
  if (!ctx) return;
  ctx.thumbs = { interval: 0, total: 0, ready: false, frames: new Map() };
  try {
    const response = await fetch(api.thumbMetaUrl(ctx.filePath));
    if (!response.ok) return;
    const meta = await response.json();
    if (!ctx) return;
    ctx.thumbs.interval = meta.interval;
    ctx.thumbs.total = meta.total;
    ctx.thumbs.ready = meta.ready;
  } catch {
    // No thumbnails this session. The timestamp still works.
  }
}
```

In `openInner`, after `ctx` is built, call it without awaiting — the player must not wait on ffmpeg:

```javascript
  loadThumbMeta();
```

- [ ] **Step 3: Show the frame in the card**

In `showPreview`, after the timestamp is set, add:

```javascript
  const frame = el('preview-frame');
  const thumbs = ctx?.thumbs;
  if (!frame || !thumbs || !thumbs.interval || !Number.isFinite(total) || total <= 0) return;

  const index = Math.min(frameIndex(fraction * total, thumbs.interval), Math.max(0, thumbs.total - 1));
  if (thumbs.frames.get(index) === 'missing') {
    frame.style.backgroundImage = '';
    return;
  }
  frame.style.backgroundImage = `url("${api.thumbUrl(ctx.filePath, index)}")`;
```

Frames that 404 leave the box empty, which is what the placeholder background already looks like. Remember the misses so a partially generated file does not re-request the same missing frame on every pixel of movement:

```javascript
  const probe = new Image();
  probe.onerror = () => thumbs.frames.set(index, 'missing');
  probe.onload = () => thumbs.frames.set(index, 'ok');
  probe.src = api.thumbUrl(ctx.filePath, index);
```

- [ ] **Step 4: Re-check the meta once while generating**

A file opened for the first time reports `ready: false`. Re-ask once, 20 seconds in, so a long sitting still eventually gets frames:

```javascript
  if (!ctx.thumbs.ready) {
    ctx.thumbRetry = setTimeout(loadThumbMeta, 20000);
  }
```

Place this at the end of `loadThumbMeta`. Clear it in `close()`:

```javascript
  clearTimeout(ctx.thumbRetry);
```

- [ ] **Step 5: Add the browser check**

In `tests/ui-player.mjs`, after the existing `the card has real size` check, add:

```javascript
  // Thumbnails may still be generating, so assert the card degrades correctly
  // rather than asserting a picture is present.
  const frameBox = await page.$eval('#preview-frame', (el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, image: getComputedStyle(el).backgroundImage };
  });
  check('the frame box holds its size with or without a picture',
    frameBox.w > 100 && frameBox.h > 50, frameBox);
```

- [ ] **Step 6: Run everything**

```bash
npm test
npm start &
sleep 4
npm run ui-check
npm run ui-player
```

Expected: every suite passes. Hover the seek bar by hand after a few seconds of generation and confirm frames appear in the card.

**Stop the server.**

- [ ] **Step 7: Commit**

```bash
git add public/js/api.js public/js/player.js tests/ui-player.mjs
git commit -m "feat(player): show generated frames in the seek preview card"
```

---

## Completion

After Task 10:

- [ ] Run the full suite one final time: `npm test`, then `npm run ui-check` and `npm run ui-player` against a running server.
- [ ] Confirm nothing is listening on port 3000.
- [ ] Confirm `git status` is clean and `cache/` is not tracked.
- [ ] **REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch.
