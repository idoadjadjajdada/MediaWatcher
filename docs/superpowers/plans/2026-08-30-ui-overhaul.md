# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild MediaWatcher's frontend in a cinematic monochrome design language that works as well under a thumb as under a mouse, and add a player audio-delay control.

**Architecture:** The 1352-line stylesheet is split into four token-driven files and rewritten monochrome. The mobile drawer is replaced by a bottom tab bar, killing the invisible-hamburger bug by removing the component it lives in. One rail component replaces the mixed rail/grid layout. The player keeps its classic control bar and gains touch gestures. Audio delay is the only server-side work: ffmpeg gets a second time-shifted input so audio can still be stream-copied.

**Tech Stack:** Vanilla ES modules, no build step, no framework. Node 20+ for tests. Playwright + Chromium (already installed) for browser verification.

**Spec:** `docs/superpowers/specs/2026-08-30-ui-overhaul-design.md`

## Global Constraints

- **No build step, no framework, no bundler.** Vanilla ES modules served straight from `public/`.
- **No new runtime dependencies.** Playwright is dev-only and is resolved from the existing install, not added to `dependencies`.
- **Monochrome palette only.** `--danger` `#ef4444` and `--warn` `#f59e0b` are the sole non-grey values and appear only on state, never decoration.
- **Animate `opacity` and `transform` only.** Motion: 160ms state, 240ms entrance, both `cubic-bezier(.22,1,.36,1)`. The existing `prefers-reduced-motion` block must keep covering all new motion.
- **Every interactive element ≥44px on the 375px viewport.**
- **No horizontal page overflow at any viewport:** `document.body.scrollWidth <= window.innerWidth`.
- **CSP forbids inline handlers.** All interaction stays on `[data-action]` delegation in `app.js`.
- **Audio offset sign convention:** positive delays the audio, negative advances it. Clamped to ±30s.
- **Verification is browser-driven** at 1440 / 768 / 375. Markup-shape assertions are not sufficient — four UI bugs in this codebase have already passed them.

---

## File Structure

| File | Responsibility |
|---|---|
| `tests/ui-check.mjs` | Playwright harness: geometry invariants at three viewports. Used by every UI task. |
| `public/css/styles.css` | Slim entry: `@import` the four below, in order. |
| `public/css/base.css` | Reset, tokens, typography, shared primitives (buttons, inputs, badges). |
| `public/css/shell.css` | Desktop icon rail, mobile tab bar, top bar, toasts. |
| `public/css/content.css` | Hero, rails, cards, modal, page layouts, search, downloads. |
| `public/css/player.css` | Player chrome only. |
| `public/js/views.js` | Shell, home, pages, modal, player markup. |
| `public/js/player.js` | Playback, gestures, menu, audio offset. |
| `public/js/app.js` | Router, actions. |
| `public/js/state.js` | Adds `player.audioOffset`. |
| `public/js/api.js` | Adds `audioOffset` to `streamUrl`. |
| `services/transcoder.js` | Two-input `-itsoffset` path; `decide` override. |
| `routes/stream.js` | Reads and validates `?audioOffset=`. |
| `routes/progress.js` | Carries `audio_offset`. |
| `db/schema.sql`, `db/index.js` | `progress.audio_offset` column + guarded migration. |
| `tests/audio-offset.test.mjs` | Node tests for the server-side offset logic. |

---

## Task 1: Browser verification harness

Every later task depends on this. It must exist and pass against the **current** UI first, so a later failure means the change broke something rather than the harness being wrong.

**Files:**
- Create: `tests/ui-check.mjs`
- Modify: `package.json` (add `ui-check` script)

**Interfaces:**
- Consumes: a MediaWatcher server on `http://127.0.0.1:3000`
- Produces: `npm run ui-check` — exits 0 when every viewport passes, 1 otherwise. Later tasks run this verbatim.

- [ ] **Step 1: Write the harness**

Create `tests/ui-check.mjs`:

```js
/**
 * Browser-driven UI invariants.
 *
 * Markup-shape assertions have missed four real bugs in this codebase: a
 * re-entrant innerHTML crash, a zero-width flex card, a modal throwing on
 * item.seasons.map, and a nav icon laying out at 0x0. All four needed a real
 * browser. This checks computed geometry, not structure.
 *
 * Needs a running server:  npm start
 * Run:                     npm run ui-check
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_CHECK_URL || 'http://127.0.0.1:3000';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, touch: false },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'mobile', width: 375, height: 812, touch: true }
];

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
function check(scope, name, ok, detail) {
  total += 1;
  if (ok) {
    console.log(`  [pass] ${scope} - ${name}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${scope} - ${name}`);
    if (detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  }
}

/** Geometry facts gathered inside the page. */
const COLLECT = () => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'visible' ? false
      : s.display !== 'none' && s.visibility === 'visible' && s.opacity !== '0';
  };

  const zeroSized = [];
  for (const el of document.querySelectorAll('svg, img, button, a, input')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      zeroSized.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').slice(0, 40),
        w: r.width, h: r.height
      });
    }
  }

  const small = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, [data-action]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.height < 44 || r.width < 44) {
      small.push({
        tag: el.tagName.toLowerCase(),
        action: el.getAttribute('data-action') || '',
        cls: (el.getAttribute('class') || '').slice(0, 40),
        w: Math.round(r.width), h: Math.round(r.height)
      });
    }
  }

  const navTargets = [...document.querySelectorAll('[data-action="navigate"]')]
    .filter(visible)
    .map((el) => el.dataset.page);

  return {
    scrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
    zeroSized,
    small,
    navTargets,
    railsWithVisibleScrollbar: [...document.querySelectorAll('.rail')].filter((r) => {
      const s = getComputedStyle(r);
      return s.scrollbarWidth !== 'none' && r.scrollHeight > r.clientHeight + 1;
    }).length
  };
};

const playwright = loadPlaywright();
const browser = await playwright.chromium.launch();
const consoleErrors = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch,
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${vp.name}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${vp.name}: ${e.message}`));

  console.log(`\n${vp.name} (${vp.width}x${vp.height})`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const facts = await page.evaluate(COLLECT);

  check(vp.name, 'no horizontal overflow', facts.scrollW <= facts.innerW,
    { scrollWidth: facts.scrollW, innerWidth: facts.innerW });
  check(vp.name, 'nothing renders at zero size', facts.zeroSized.length === 0, facts.zeroSized.slice(0, 6));
  check(vp.name, 'navigation is reachable', facts.navTargets.length >= 5, facts.navTargets);
  if (vp.touch) {
    check(vp.name, 'touch targets are at least 44px', facts.small.length === 0, facts.small.slice(0, 8));
  }
  check(vp.name, 'no rail shows a scrollbar track', facts.railsWithVisibleScrollbar === 0);

  await context.close();
}

check('console', 'no errors during load', consoleErrors.length === 0, consoleErrors.slice(0, 6));

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

In `package.json`, add to `"scripts"` after `"test"`:

```json
"ui-check": "node tests/ui-check.mjs"
```

- [ ] **Step 3: Start a server and run the harness against the CURRENT UI**

```bash
npm start
```

In a second shell:

```bash
npm run ui-check
```

Expected: it runs and **reports failures**, specifically:
- `mobile - nothing renders at zero size` FAILS, listing the `topbar__menu` svg at `0x0`
- `mobile - touch targets are at least 44px` likely FAILS with several entries

This is the harness proving it catches the known bug. If `no horizontal overflow` or `navigation is reachable` fail on desktop, stop — the harness is wrong, not the app.

- [ ] **Step 4: Record the baseline**

Save the failing output to `docs/superpowers/ui-baseline.txt` so later tasks can be compared against where things started:

```bash
npm run ui-check > docs/superpowers/ui-baseline.txt 2>&1 || true
```

- [ ] **Step 5: Commit**

```bash
git add tests/ui-check.mjs package.json docs/superpowers/ui-baseline.txt
git commit -m "test: add browser-driven UI geometry harness"
```

---

## Task 2: Split the stylesheet and install monochrome tokens

**Files:**
- Create: `public/css/base.css`, `public/css/shell.css`, `public/css/content.css`, `public/css/player.css`
- Modify: `public/css/styles.css` (becomes an import list)

**Interfaces:**
- Produces: the token set every later task uses. Exact names below — later tasks reference them verbatim.

- [ ] **Step 1: Create `public/css/base.css` with the new tokens**

```css
/* Reset, design tokens, typography, shared primitives. */

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
img { max-width: 100%; display: block; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
input, select { font: inherit; }

:root {
  /* Surfaces - true black so artwork sits on it, not near-black. */
  --bg: #000000;
  --surface: #0d0d0d;
  --surface-2: #171717;
  --line: rgba(255, 255, 255, .09);

  /* Foreground */
  --fg: #ffffff;
  --fg-2: rgba(255, 255, 255, .68);
  --fg-3: rgba(255, 255, 255, .42);

  /* The only non-grey values in the system. State only, never decoration. */
  --danger: #ef4444;
  --warn: #f59e0b;

  /* Layout */
  --rail-w: 64px;
  --tabbar-h: 56px;
  --topbar-h: 60px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;

  --radius-sm: 4px;
  --radius: 8px;
  --radius-lg: 14px;
  --radius-pill: 999px;

  --shadow: 0 24px 64px rgba(0, 0, 0, .7);

  --ease: cubic-bezier(.22, 1, .36, 1);
  --state: 160ms var(--ease);
  --enter: 240ms var(--ease);

  --z-sticky: 20;
  --z-tabbar: 40;
  --z-modal: 60;
  --z-player: 80;
  --z-toast: 100;
}

/* Type scale. Tracking tightens as size grows. */
.t-hero   { font-size: 44px; font-weight: 800; letter-spacing: -1.1px; line-height: .98; }
.t-section{ font-size: 15px; font-weight: 700; letter-spacing: -.1px; }
.t-card   { font-size: 12px; font-weight: 600; }
.t-meta   { font-size: 10px; font-weight: 600; letter-spacing: .9px; text-transform: uppercase; color: var(--fg-3); }
.t-num    { font-variant-numeric: tabular-nums; }

@media (max-width: 1023px) { .t-hero { font-size: 30px; letter-spacing: -.8px; } }
@media (max-width: 767px)  { .t-hero { font-size: 21px; letter-spacing: -.6px; } }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: 44px; padding: 0 var(--space-4);
  border-radius: var(--radius-sm); font-weight: 600; font-size: 12px;
  transition: transform var(--state), background var(--state), opacity var(--state);
}
.btn:active { transform: scale(.97); }
.btn--primary { background: var(--fg); color: #000; }
.btn--primary:hover { opacity: .88; }
.btn--secondary { background: rgba(255, 255, 255, .15); color: var(--fg); }
.btn--secondary:hover { background: rgba(255, 255, 255, .24); }
.btn--ghost { background: transparent; color: var(--fg-2); }
.btn--ghost:hover { background: var(--surface-2); color: var(--fg); }
.btn--danger { background: transparent; color: var(--danger); border: 1px solid rgba(239, 68, 68, .4); }
.btn--icon { width: 44px; padding: 0; }
.btn:disabled { opacity: .38; cursor: default; }

/* Icons always carry a size. The nav icon shipped without one and laid out
   at 0x0 on mobile, making the menu button invisible. */
svg { width: 20px; height: 20px; flex: none; }
.icon-sm { width: 16px; height: 16px; }
.icon-lg { width: 24px; height: 24px; }

.input {
  width: 100%; min-height: 44px; padding: 0 var(--space-4);
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--radius); color: var(--fg);
}
.input::placeholder { color: var(--fg-3); }
.input:focus { outline: none; border-color: rgba(255, 255, 255, .3); }

.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px; border-radius: var(--radius-sm);
  font-size: 10px; font-weight: 700; letter-spacing: .5px;
  border: 1px solid var(--line); color: var(--fg-2);
}
.badge--danger { color: var(--danger); border-color: rgba(239, 68, 68, .4); }
.badge--warn { color: var(--warn); border-color: rgba(245, 158, 11, .4); }

.spinner {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, .18); border-top-color: var(--fg);
  animation: spin .8s linear infinite;
}
.spinner--lg { width: 34px; height: 34px; border-width: 3px; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes rise-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}
```

- [ ] **Step 2: Create the three remaining files as empty placeholders with headers**

`public/css/shell.css`:
```css
/* Desktop icon rail, mobile tab bar, top bar, toasts. */
```

`public/css/content.css`:
```css
/* Hero, rails, cards, modal, page layouts, search, downloads. */
```

`public/css/player.css`:
```css
/* Player chrome. */
```

- [ ] **Step 3: Replace `public/css/styles.css` entirely**

```css
/* MediaWatcher styles.
   Split by responsibility; order matters - base defines the tokens the rest use. */
@import url('./base.css');
@import url('./shell.css');
@import url('./content.css');
@import url('./player.css');
```

- [ ] **Step 4: Confirm the app still boots**

Restart the server, then:

```bash
npm run ui-check
```

Expected: the page loads and the harness runs. It will report **more** failures than the baseline, because every component rule was just deleted — that is correct at this stage. What must NOT happen: `console - no errors during load` failing. A JS error here means something other than CSS broke.

Also load `http://localhost:3000` by eye and confirm text renders white on black rather than a blank page.

- [ ] **Step 5: Commit**

```bash
git add public/css/
git commit -m "refactor(css): split stylesheet into four files and install monochrome tokens"
```

---

## Task 3: Shell — icon rail, bottom tab bar, no drawer

This is where the invisible-hamburger bug dies.

**Files:**
- Modify: `public/js/views.js` (`icon`, `renderShell`, `updateShell`)
- Modify: `public/js/app.js` (remove `toggle-drawer`)
- Modify: `public/js/state.js` (remove `drawerOpen`)
- Modify: `public/css/shell.css`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces: `.rail` desktop nav and `.tabbar` mobile nav, both emitting `data-action="navigate" data-page="<page>"`. Task 5 and later rely on `.app-shell` / `.main` still existing.

- [ ] **Step 1: Give `icon()` a default size class**

In `public/js/views.js`, replace the `icon` function:

```js
export function icon(name, className = '') {
  const body = ICONS[name] || '';
  // Default to a sized class. Called bare, this produced <svg class=""> which
  // laid out at 0x0 and made the mobile menu button invisible.
  const cls = className || 'icon';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
```

- [ ] **Step 2: Rewrite `renderShell`**

Replace the whole `renderShell` function in `public/js/views.js`:

```js
export function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <aside class="rail" id="rail">
        <div class="rail__mark">${playIcon()}</div>
        <nav class="rail__nav">
          ${NAV.map((entry) => `
            <button class="rail__item" data-action="navigate" data-page="${entry.page}" aria-label="${entry.label}" title="${entry.label}">
              ${icon(entry.iconName, 'icon')}
              ${entry.page === 'downloads' ? '<span class="rail__badge" id="jobs-badge" hidden>0</span>' : ''}
            </button>`).join('')}
        </nav>
        <button class="rail__item rail__item--foot" data-action="rescan" id="rescan-btn" aria-label="Rescan" title="Rescan library">
          ${icon('refresh', 'icon')}
        </button>
      </aside>

      <header class="topbar">
        <div class="topbar__search">
          ${icon('search', 'icon-sm')}
          <input class="input topbar__input" id="global-search" type="search" placeholder="Search" autocomplete="off">
        </div>
        <button class="btn btn--secondary topbar__add" data-action="add-torrent">
          ${icon('plus', 'icon-sm')}<span class="btn__label">Add</span>
        </button>
      </header>

      <main class="main" id="main"></main>

      <nav class="tabbar" id="tabbar">
        ${NAV.map((entry) => `
          <button class="tabbar__item" data-action="navigate" data-page="${entry.page}">
            ${icon(entry.iconName, 'icon')}
            <span class="tabbar__label">${entry.label}</span>
            ${entry.page === 'downloads' ? '<span class="tabbar__badge" id="jobs-badge-m" hidden>0</span>' : ''}
          </button>`).join('')}
      </nav>
    </div>`;
}
```

- [ ] **Step 3: Rewrite `updateShell`**

Replace the whole `updateShell` function. The drawer and scrim handling goes; both nav surfaces get the active state and the badge:

```js
export function updateShell() {
  document.querySelectorAll('.rail__item, .tabbar__item').forEach((node) => {
    if (!node.dataset.page) return;
    node.classList.toggle('is-active', node.dataset.page === state.currentPage);
  });

  const count = activeJobCount();
  for (const id of ['jobs-badge', 'jobs-badge-m']) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  const rescan = document.getElementById('rescan-btn');
  if (rescan) {
    rescan.disabled = state.scanning;
    rescan.classList.toggle('is-busy', state.scanning);
  }
}
```

- [ ] **Step 4: Remove the drawer from state and actions**

In `public/js/state.js`, delete the `drawerOpen: false` line from the state object.

In `public/js/app.js`, delete the `'toggle-drawer'` entry from `ACTIONS`, and in the `navigate` function delete `setState({ drawerOpen: false })` — replace the body with:

```js
function navigate(page) {
  if (!PAGES.includes(page)) return;
  window.location.hash = page;
  if (currentHashPage() === state.currentPage) setState({});
}
```

- [ ] **Step 5: Write `public/css/shell.css`**

```css
/* Desktop icon rail, mobile tab bar, top bar, toasts. */

.app-shell {
  display: grid;
  min-height: 100vh;
  grid-template-columns: var(--rail-w) 1fr;
  grid-template-rows: var(--topbar-h) 1fr;
  grid-template-areas:
    "rail topbar"
    "rail main";
}

/* ---- desktop rail ---- */
.rail {
  grid-area: rail;
  display: flex; flex-direction: column; align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) 0;
  border-right: 1px solid var(--line);
  position: sticky; top: 0; height: 100vh;
}
.rail__mark {
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  background: var(--fg); color: #000;
  display: grid; place-items: center; margin-bottom: var(--space-3);
}
.rail__mark svg { width: 14px; height: 14px; }
.rail__nav { display: flex; flex-direction: column; gap: var(--space-2); }
.rail__item {
  position: relative;
  width: 44px; height: 44px; border-radius: var(--radius);
  display: grid; place-items: center;
  color: var(--fg-3);
  transition: color var(--state), background var(--state);
}
.rail__item:hover { color: var(--fg); background: var(--surface-2); }
.rail__item.is-active { color: var(--fg); background: rgba(255, 255, 255, .14); }
.rail__item--foot { margin-top: auto; }
.rail__item.is-busy svg { animation: spin 1s linear infinite; }
.rail__badge, .tabbar__badge {
  position: absolute; top: 5px; right: 5px;
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--fg); color: #000;
  font-size: 9px; font-weight: 700;
  display: grid; place-items: center;
}

/* ---- top bar ---- */
.topbar {
  grid-area: topbar;
  display: flex; align-items: center; gap: var(--space-3);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: var(--z-sticky);
  background: rgba(0, 0, 0, .82);
}
.topbar__search { position: relative; flex: 1; max-width: 420px; display: flex; align-items: center; }
.topbar__search svg { position: absolute; left: var(--space-3); color: var(--fg-3); pointer-events: none; }
.topbar__input { padding-left: 38px; }

/* ---- main ---- */
.main { grid-area: main; min-width: 0; }

/* ---- mobile tab bar (hidden until mobile) ---- */
.tabbar { display: none; }

/* ---- toasts ---- */
.toast-stack {
  position: fixed; right: var(--space-5); bottom: var(--space-5);
  z-index: var(--z-toast); display: flex; flex-direction: column; gap: var(--space-2);
}
.toast {
  min-width: 260px; padding: var(--space-3) var(--space-4);
  background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow);
  animation: rise-in var(--enter) both;
}
.toast.is-leaving { animation: fade-in var(--state) reverse both; }
.toast__title { font-weight: 700; font-size: 12px; }
.toast__text { color: var(--fg-2); font-size: 11px; margin-top: 2px; }
.toast--error .toast__title { color: var(--danger); }
.toast--warn .toast__title { color: var(--warn); }

.boot { display: grid; place-items: center; gap: var(--space-4); min-height: 100vh; }
.boot__label { color: var(--fg-3); }
.noscript { padding: var(--space-5); color: var(--fg); }

/* ---- mobile ---- */
@media (max-width: 767px) {
  .app-shell {
    grid-template-columns: 1fr;
    grid-template-rows: var(--topbar-h) 1fr auto;
    grid-template-areas: "topbar" "main" "tabbar";
  }
  .rail { display: none; }

  .topbar { padding: 0 var(--space-4); }
  .topbar__search { max-width: none; }
  .topbar__add .btn__label { display: none; }
  .topbar__add { width: 44px; padding: 0; }

  .tabbar {
    grid-area: tabbar;
    display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
    position: sticky; bottom: 0; z-index: var(--z-tabbar);
    border-top: 1px solid var(--line);
    background: rgba(0, 0, 0, .92);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .tabbar__item {
    position: relative;
    min-height: var(--tabbar-h);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    color: var(--fg-3);
    transition: color var(--state);
  }
  .tabbar__item.is-active { color: var(--fg); }
  .tabbar__label { font-size: 10px; font-weight: 600; }
  .tabbar__badge { top: 6px; right: 50%; margin-right: -22px; }

  .toast-stack { left: var(--space-3); right: var(--space-3); bottom: calc(var(--tabbar-h) + var(--space-3)); }
  .toast { min-width: 0; }
}
```

- [ ] **Step 6: Verify in the browser**

Restart the server, then:

```bash
npm run ui-check
```

Expected, and this is the point of the task:
- `mobile - nothing renders at zero size` now **PASSES** — the 0×0 icon is gone
- `mobile - navigation is reachable` **PASSES** with five entries
- `desktop - navigation is reachable` **PASSES**
- `console - no errors during load` **PASSES**

Content-area checks will still fail; `content.css` is empty until Task 4.

Then look at it by eye at 375px and confirm a bottom tab bar with five visible labelled tabs, and that tapping one changes page.

- [ ] **Step 7: Commit**

```bash
git add public/js/views.js public/js/app.js public/js/state.js public/css/shell.css
git commit -m "feat(ui): icon rail on desktop, bottom tab bar on mobile, drawer removed"
```

---

## Task 4: Rail component and cards

**Files:**
- Modify: `public/js/views.js` (card and rail helpers)
- Modify: `public/js/app.js` (rail arrow action)
- Modify: `public/css/content.css`

**Interfaces:**
- Consumes: tokens from Task 2
- Produces:
  - `posterCard(item, type, { owned, progress })` → HTML string. `owned` boolean, `progress` a 0–1 number or `null`.
  - `rail(title, cardsHtml, { count })` → HTML string wrapping `.rail` with optional header count and scroll arrows.
  Task 5 and Task 6 call both.

- [ ] **Step 1: Replace the card helpers in `views.js`**

Replace the existing `posterCard` and `discoverCard` functions with a single one:

```js
/**
 * One poster card, used for library and discovery alike.
 * The underline is the only thing distinguishing them: full bar = owned,
 * partial = watch progress, absent = discoverable.
 */
export function posterCard(item, type, { owned = false, progress = null } = {}) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  const action = owned
    ? `data-action="open-detail" data-type="${esc(type)}" data-id="${item.tmdb_id}"`
    : `data-action="open-discover" data-type="${esc(type)}" data-id="${item.tmdb_id}"`;

  const width = progress === null ? 100 : Math.max(2, Math.min(100, progress * 100));
  const bar = owned
    ? `<div class="card__owned"><span style="width:${width.toFixed(1)}%"></span></div>`
    : '';

  return `
    <article class="card" ${action} tabindex="0" aria-label="${esc(item.title)}">
      <div class="card__art">
        ${poster}
        ${bar}
      </div>
      <div class="card__title t-card">${esc(item.title)}</div>
      <div class="card__meta">${item.year || ''}</div>
    </article>`;
}

/** A horizontal row. One component for every row in the app. */
export function rail(title, cardsHtml, { count = null } = {}) {
  return `
    <section class="row">
      <div class="row__head">
        <h2 class="t-section">${esc(title)}</h2>
        ${count !== null ? `<span class="t-meta">${count}</span>` : ''}
      </div>
      <div class="row__wrap">
        <button class="row__arrow row__arrow--prev" data-action="rail-scroll" data-dir="-1" aria-label="Scroll left">${icon('back', 'icon')}</button>
        <div class="rail">${cardsHtml}</div>
        <button class="row__arrow row__arrow--next" data-action="rail-scroll" data-dir="1" aria-label="Scroll right">${icon('chevron', 'icon')}</button>
      </div>
    </section>`;
}
```

- [ ] **Step 2: Add the arrow action in `app.js`**

Add to `ACTIONS`:

```js
  'rail-scroll': (el) => {
    const wrap = el.closest('.row__wrap');
    const track = wrap ? wrap.querySelector('.rail') : null;
    if (!track) return;
    const dir = Number(el.dataset.dir) || 1;
    track.scrollBy({ left: dir * Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
  },
```

- [ ] **Step 3: Write the rail and card rules into `public/css/content.css`**

Append:

```css
/* ---- rows and rails ---- */
.page { padding: var(--space-5); }
.row { margin-bottom: var(--space-6); }
.row__head { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-3); }
.row__head .t-meta { margin-left: auto; }
.row__wrap { position: relative; }

.rail {
  display: flex; gap: var(--space-3);
  overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x mandatory;
  scroll-padding-left: var(--space-5);
  /* The visible grey track was the ugliest thing on the old page. */
  scrollbar-width: none;
  -ms-overflow-style: none;
  padding-bottom: var(--space-2);
}
.rail::-webkit-scrollbar { display: none; }
.rail > * { scroll-snap-align: start; }

.row__arrow {
  position: absolute; top: 0; bottom: var(--space-2); width: 52px;
  display: none; align-items: center; z-index: 2;
  color: var(--fg); opacity: 0;
  transition: opacity var(--state);
}
.row__arrow--prev { left: 0; justify-content: flex-start;
  background: linear-gradient(90deg, var(--bg) 40%, transparent); }
.row__arrow--next { right: 0; justify-content: flex-end;
  background: linear-gradient(270deg, var(--bg) 40%, transparent); }
/* Pointer devices only - an arrow you cannot hover is dead weight on touch. */
@media (hover: hover) {
  .row__wrap:hover .row__arrow { display: flex; opacity: 1; }
}

/* ---- cards ---- */
.card {
  flex: none; width: 150px; cursor: pointer;
  transition: transform var(--state), filter var(--state);
}
.card__art { position: relative; aspect-ratio: 2 / 3; border-radius: var(--radius);
  overflow: hidden; background: var(--surface); }
.card__poster { width: 100%; height: 100%; object-fit: cover; }
.card__placeholder {
  width: 100%; height: 100%; display: grid; place-items: center;
  padding: var(--space-3); text-align: center;
  color: var(--fg-3); font-size: 11px; font-weight: 600;
}
.card__owned {
  position: absolute; left: 5px; right: 5px; bottom: 5px; height: 2.5px;
  border-radius: 2px; background: rgba(0, 0, 0, .55); overflow: hidden;
}
.card__owned span { display: block; height: 100%; background: var(--fg); border-radius: 2px; }
.card__title { margin-top: var(--space-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card__meta { font-size: 10px; color: var(--fg-3); }
@media (hover: hover) {
  .card:hover { transform: scale(1.04); }
  .card:hover .card__art { filter: brightness(1.12); }
}
.card:focus-visible { outline: 2px solid var(--fg); outline-offset: 3px; }

@media (max-width: 1023px) { .card { width: 120px; } }
@media (max-width: 767px) {
  .page { padding: var(--space-4) 0 var(--space-4) var(--space-4); }
  .row__head { padding-right: var(--space-4); }
  .card { width: 108px; }
}
```

- [ ] **Step 4: Verify**

There is nothing calling `rail()` yet, so this task is verified in Task 5. For now confirm nothing regressed:

```bash
npm run ui-check
```

Expected: same result as the end of Task 3 — nav and zero-size checks pass, console clean.

- [ ] **Step 5: Commit**

```bash
git add public/js/views.js public/js/app.js public/css/content.css
git commit -m "feat(ui): single rail component with snap scrolling and owned markers"
```

---

## Task 5: Home — hero and collapsing library rails

**Files:**
- Modify: `public/js/views.js` (`renderHome`, hero helpers)
- Modify: `public/css/content.css`

**Interfaces:**
- Consumes: `posterCard`, `rail` from Task 4; `recentlyAdded`, `locateFile` from `state.js`
- Produces: `pickHero(library, progress)` → `{ item, type, file, resumeRow }` or `null`

- [ ] **Step 1: Add hero selection**

Add to `views.js` above `renderHome`:

```js
/**
 * Which title leads the page.
 *
 * The old rule picked at random on every render, so the hero changed identity
 * whenever state updated. Prefer the thing you were last watching, so Resume
 * actually means something.
 */
export function pickHero(library, progress) {
  const all = [...library.movies, ...library.shows];
  if (all.length === 0) return null;

  for (const row of progress) {
    const located = locateFile(row.file_path);
    if (!located) continue;
    return {
      item: located.item,
      type: located.type === 'episode' ? 'show' : 'movie',
      file: { file_path: row.file_path },
      resumeRow: row,
      located
    };
  }

  const withArt = all.filter((entry) => entry.backdrop);
  const pool = withArt.length > 0 ? withArt : all;
  const item = pool.slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a))[0];
  const isShow = Array.isArray(item.seasons);
  return {
    item,
    type: isShow ? 'show' : 'movie',
    file: isShow ? firstEpisodeFile(item) : (item.files || [])[0],
    resumeRow: null,
    located: null
  };
}

function newestAddedAt(item) {
  let newest = 0;
  for (const file of item.files || []) newest = Math.max(newest, file.added_at || 0);
  for (const season of item.seasons || []) {
    for (const episode of season.episodes) {
      for (const file of episode.files || []) newest = Math.max(newest, file.added_at || 0);
    }
  }
  return newest;
}
```

- [ ] **Step 2: Rewrite `renderHome`**

Replace the whole function:

```js
export function renderHome() {
  const { movies, shows } = state.library;
  const all = [...movies, ...shows];

  if (state.loading) return loadingState('Loading your library…');

  if (all.length === 0) {
    return emptyState({
      iconName: 'inbox',
      title: 'Your library is empty',
      text: 'Drop video files into library/movies or library/shows, or search for something to download.',
      action: { label: 'Search for something', action: 'navigate', page: 'search' }
    });
  }

  const hero = pickHero(state.library, state.progress);
  const ownedIds = new Set(all.map((entry) => entry.tmdb_id));

  /* --- continue watching --- */
  const continueCards = state.progress.map((row) => {
    const located = locateFile(row.file_path);
    if (!located) return '';
    const pct = row.duration > 0 ? row.position / row.duration : 0;
    return posterCard(located.item, located.type === 'episode' ? 'show' : 'movie',
      { owned: true, progress: pct });
  }).filter(Boolean).join('');

  /* --- library rails, collapsed by size ---
     With a handful of titles, "Recently added" and "Your library" are the same
     three posters twice, directly under Continue watching showing them again. */
  const byNewest = all.slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a));
  const libraryRails = byNewest.length > 8
    ? rail('Recently added', byNewest.slice(0, 20).map(cardFor).join(''))
      + rail('Your library', byNewest.map(cardFor).join(''), { count: `${byNewest.length} titles` })
    : rail('Your library', byNewest.map(cardFor).join(''), { count: `${byNewest.length} titles` });

  function cardFor(entry) {
    return posterCard(entry, Array.isArray(entry.seasons) ? 'show' : 'movie', { owned: true });
  }

  /* --- discovery --- */
  const discoverRails = (state.discover.rails || []).map((r) => rail(
    r.title,
    (r.items || []).map((entry) => posterCard(
      entry,
      entry.type === 'show' ? 'show' : 'movie',
      { owned: ownedIds.has(entry.tmdb_id) }
    )).join('')
  )).join('');

  return `
    ${hero ? renderHero(hero) : ''}
    <div class="page">
      ${continueCards ? rail('Continue watching', continueCards) : ''}
      ${libraryRails}
      ${discoverRails}
    </div>`;
}

function renderHero(hero) {
  const { item, type, file, located } = hero;
  const isShow = type === 'show';

  let line = '';
  if (located && located.type === 'episode') {
    const title = located.episode.title ? ` · ${located.episode.title}` : '';
    line = `${episodeTag(located.season, located.episode.episode_number)}${title}`;
  } else {
    line = [item.year, formatRuntime(item.runtime), (item.genres || [])[0]]
      .filter(Boolean).join(' · ');
  }

  const remaining = hero.resumeRow && hero.resumeRow.duration > 0
    ? ` · ${formatTime(hero.resumeRow.duration - hero.resumeRow.position)} left`
    : '';

  return `
    <section class="hero">
      ${item.backdrop ? `<img class="hero__art" alt="" src="${esc(item.backdrop)}">` : ''}
      <div class="hero__scrim"></div>
      <div class="hero__body">
        <h1 class="hero__title t-hero">${esc(item.title)}</h1>
        <div class="hero__meta t-meta">${esc(line)}${esc(remaining)}</div>
        ${item.overview ? `<p class="hero__overview">${esc(item.overview)}</p>` : ''}
        <div class="hero__actions">
          ${file ? `<button class="btn btn--primary" data-action="play" data-path="${esc(file.file_path)}">
            ${playIcon('icon-sm')}${hero.resumeRow ? 'Resume' : 'Play'}</button>` : ''}
          <button class="btn btn--secondary" data-action="open-detail" data-type="${isShow ? 'show' : 'movie'}" data-id="${item.tmdb_id}">More info</button>
        </div>
      </div>
    </section>`;
}
```

- [ ] **Step 3: Add hero CSS to `public/css/content.css`**

Append:

```css
/* ---- hero ---- */
.hero { position: relative; height: 60vh; max-height: 520px; min-height: 340px; }
.hero__art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hero__scrim {
  position: absolute; inset: 0;
  background:
    linear-gradient(90deg, var(--bg) 6%, rgba(0, 0, 0, .78) 36%, transparent 72%),
    linear-gradient(0deg, var(--bg) 1%, transparent 40%);
}
.hero__body { position: absolute; left: var(--space-6); bottom: var(--space-6); right: 44%; }
.hero__title { margin: 0 0 var(--space-2); }
.hero__meta { margin-bottom: var(--space-3); }
.hero__overview {
  color: var(--fg-2); margin: 0 0 var(--space-4); max-width: 52ch;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.hero__actions { display: flex; gap: var(--space-2); }

@media (max-width: 1023px) {
  .hero { height: 46vh; min-height: 300px; }
  .hero__body { right: 24%; left: var(--space-5); bottom: var(--space-5); }
}
@media (max-width: 767px) {
  .hero { height: 42vh; min-height: 280px; }
  .hero__scrim {
    background: linear-gradient(0deg, var(--bg) 4%, rgba(0, 0, 0, .35) 52%, rgba(0, 0, 0, .55) 100%);
  }
  .hero__body { left: var(--space-4); right: var(--space-4); bottom: var(--space-4); }
  .hero__overview { display: none; }
  .hero__actions .btn--primary { flex: 1; }
}
```

- [ ] **Step 4: Verify in the browser**

```bash
npm run ui-check
```

Expected: all checks pass at all three viewports, including `no rail shows a scrollbar track`.

Then by eye at 1440 and 375:
- The hero shows **Rick and Morty** (your most recent progress row), with **Resume**, not a random title
- Reloading twice does not change which title the hero shows
- One `Your library` rail, not two — the library has 3 titles, under the 8 threshold
- Library posters carry a white underline; discovery posters do not
- Rails drag-scroll on touch and show an arrow on hover on desktop

- [ ] **Step 5: Commit**

```bash
git add public/js/views.js public/css/content.css
git commit -m "feat(ui): cinematic hero with resume selection and collapsing library rails"
```

---

## Task 6: Remaining pages and the detail modal

**Files:**
- Modify: `public/js/views.js` (`renderMovies`, `renderShows`, `renderDownloads`, `renderDetailModal`, `renderSeason`)
- Modify: `public/js/search.js` (result and suggestion markup)
- Modify: `public/css/content.css`

**Interfaces:**
- Consumes: `posterCard`, `rail` from Task 4
- Produces: nothing new; these are the last consumers.

- [ ] **Step 1: Rewrite the library pages to use the shared card**

In `views.js`, replace the bodies of `renderMovies` and `renderShows` so both use a grid of the shared card:

```js
export function renderMovies() {
  if (state.loading) return loadingState('Loading movies…');
  const { movies } = state.library;

  if (movies.length === 0) {
    return `<div class="page"><div class="page__head"><h1 class="t-hero">Movies</h1></div>
      ${emptyState({
    iconName: 'film',
    title: 'No movies yet',
    text: 'Add files under library/movies and press Rescan, or find something to download.',
    action: { label: 'Search for a movie', action: 'navigate', page: 'search' }
  })}</div>`;
  }

  return `
    <div class="page">
      <div class="page__head">
        <h1 class="t-hero">Movies</h1>
        <span class="t-meta">${movies.length} title${movies.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid">${movies.map((m) => posterCard(m, 'movie', { owned: true })).join('')}</div>
    </div>`;
}

export function renderShows() {
  if (state.loading) return loadingState('Loading shows…');
  const { shows } = state.library;

  if (shows.length === 0) {
    return `<div class="page"><div class="page__head"><h1 class="t-hero">Shows</h1></div>
      ${emptyState({
    iconName: 'tv',
    title: 'No shows yet',
    text: 'Add files under library/shows/<Show Name>/Season 01 and press Rescan.',
    action: { label: 'Search for a show', action: 'navigate', page: 'search' }
  })}</div>`;
  }

  return `
    <div class="page">
      <div class="page__head">
        <h1 class="t-hero">Shows</h1>
        <span class="t-meta">${shows.length} title${shows.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid">${shows.map((s) => posterCard(s, 'show', { owned: true })).join('')}</div>
    </div>`;
}
```

- [ ] **Step 2: Guard the episode list in the modal**

In `renderDetailModal`, the episode block must stay gated on having the data. It currently reads:

```js
    isShow && Array.isArray(item.seasons) && item.seasons.length ? `
```

Leave that condition exactly as it is — a discovery show is `isShow === true` with no `seasons` array, and this is what stops `.map` throwing. Only the surrounding classes change.

- [ ] **Step 3: Append the remaining component CSS to `public/css/content.css`**

```css
/* ---- page furniture ---- */
.page__head { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-5); }
.page__head .t-meta { margin-left: auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--space-4); }
.grid .card { width: auto; }

.empty { display: grid; place-items: center; gap: var(--space-3); padding: var(--space-7) var(--space-4); text-align: center; }
.empty__icon { color: var(--fg-3); }
.empty__icon svg { width: 34px; height: 34px; }
.empty__title { font-size: 16px; font-weight: 700; }
.empty__text { color: var(--fg-2); max-width: 46ch; margin: 0; }
.loading-state { display: grid; place-items: center; gap: var(--space-3); padding: var(--space-7); color: var(--fg-3); }

/* ---- modal ---- */
.modal-backdrop {
  position: fixed; inset: 0; z-index: var(--z-modal);
  background: rgba(0, 0, 0, .8);
  display: grid; place-items: center; padding: var(--space-5);
  animation: fade-in var(--state) both;
}
.modal {
  width: min(920px, 100%); max-height: 88vh; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius-lg); box-shadow: var(--shadow);
  animation: rise-in var(--enter) both; position: relative;
}
.modal__close { position: absolute; top: var(--space-3); right: var(--space-3); z-index: 2;
  width: 44px; height: 44px; border-radius: 50%; background: rgba(0, 0, 0, .6); color: var(--fg);
  display: grid; place-items: center; }
.modal__hero { position: relative; aspect-ratio: 16 / 7; overflow: hidden; }
.modal__backdrop { width: 100%; height: 100%; object-fit: cover; }
.modal__hero::after { content: ''; position: absolute; inset: 0;
  background: linear-gradient(0deg, var(--surface) 2%, transparent 60%); }
.modal__body { padding: var(--space-5); }
.modal__title { font-size: 30px; font-weight: 800; letter-spacing: -.8px; margin: 0 0 var(--space-3); }
.modal__chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4); }
.modal__overview { color: var(--fg-2); margin: 0 0 var(--space-4); }
.modal__actions { display: flex; gap: var(--space-2); margin-bottom: var(--space-5); }

.cast { display: flex; gap: var(--space-3); overflow-x: auto; scrollbar-width: none; margin-bottom: var(--space-5); }
.cast::-webkit-scrollbar { display: none; }
.cast__person { flex: none; width: 84px; text-align: center; }
.cast__photo { width: 84px; height: 84px; border-radius: 50%; object-fit: cover; background: var(--surface-2); }
.cast__name { font-size: 11px; font-weight: 600; margin-top: var(--space-2); }
.cast__role { font-size: 10px; color: var(--fg-3); }

.season { border-top: 1px solid var(--line); }
.season__toggle { display: flex; align-items: center; gap: var(--space-2); width: 100%;
  min-height: 44px; text-align: left; font-weight: 600; }
.season__count { margin-left: auto; color: var(--fg-3); font-size: 11px; }
.season__chevron { transition: transform var(--state); }
.season.is-open .season__chevron { transform: rotate(90deg); }
.season__episodes { display: none; flex-direction: column; gap: var(--space-2); padding-bottom: var(--space-3); }
.season.is-open .season__episodes { display: flex; }
.episode { display: grid; grid-template-columns: 120px 1fr auto; gap: var(--space-3);
  align-items: center; padding: var(--space-2); border-radius: var(--radius); cursor: pointer; }
.episode:hover { background: var(--surface-2); }
.episode__still { width: 120px; aspect-ratio: 16 / 9; object-fit: cover; border-radius: var(--radius-sm);
  background: var(--surface-2); }
.episode__title { font-size: 12px; font-weight: 600; }
.episode__number { color: var(--fg-3); }
.episode__overview { font-size: 11px; color: var(--fg-3); margin-top: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* ---- search + downloads ---- */
.search-toolbar { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-5); }
.search-toolbar__row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.chip { min-height: 44px; padding: 0 var(--space-4); border-radius: var(--radius-pill);
  border: 1px solid var(--line); color: var(--fg-2); font-size: 12px; font-weight: 600; }
.chip.is-active { background: var(--fg); color: #000; border-color: var(--fg); }

.result-list, .job-list { display: flex; flex-direction: column; gap: var(--space-2); }
.result, .job { background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: var(--space-4); }
.result { display: grid; grid-template-columns: 1fr auto auto auto auto; gap: var(--space-4); align-items: center; }
.result__title { font-size: 12px; font-weight: 600; }
.result__badges { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-top: var(--space-2); }
.result__stat { text-align: right; font-size: 10px; color: var(--fg-3); }
.result__stat strong { display: block; font-size: 13px; color: var(--fg); }

.progress { height: 3px; background: rgba(255, 255, 255, .16); border-radius: 2px; overflow: hidden; }
.progress__fill { height: 100%; background: var(--fg); }
.job__head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
.job__title { font-weight: 600; font-size: 12px; }
.job__actions { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
.job__stats { display: flex; justify-content: space-between; font-size: 10px; color: var(--fg-3); margin-top: var(--space-2); }
.job__error { color: var(--danger); font-size: 11px; }

.suggestions { display: flex; flex-direction: column; gap: 2px; margin-top: var(--space-2);
  padding: var(--space-2); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); max-height: 340px; overflow-y: auto; }
.suggestion { display: flex; align-items: center; gap: var(--space-3); min-height: 44px;
  padding: var(--space-2); border-radius: var(--radius-sm); text-align: left; }
.suggestion:hover, .suggestion.is-active { background: var(--surface-2); }

@media (max-width: 767px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: var(--space-3); padding-right: var(--space-4); }
  .modal-backdrop { padding: 0; }
  .modal { max-height: 100vh; height: 100vh; border-radius: 0; border: 0; }
  .modal__title { font-size: 22px; }
  .result { grid-template-columns: 1fr auto; row-gap: var(--space-2); }
  .result__main { grid-column: 1 / -1; }
  .episode { grid-template-columns: 88px 1fr; }
  .episode__still { width: 88px; }
}
```

- [ ] **Step 4: Verify every page in the browser**

```bash
npm run ui-check
```

Expected: all checks pass.

Then by eye, at 1440 and 375, visit each of Home, Movies, Shows, Search, Downloads and open a detail modal from each of a library card and a discovery card. The discovery-show modal must open without throwing — that is the bug this codebase has hit before.

- [ ] **Step 5: Commit**

```bash
git add public/js/views.js public/js/search.js public/css/content.css
git commit -m "feat(ui): restyle library pages, modal, search and downloads"
```

---

## Task 7: Player chrome

**Files:**
- Modify: `public/js/views.js` (`renderPlayer`)
- Create: `public/css/player.css` content

**Interfaces:**
- Consumes: tokens from Task 2
- Produces: element ids the player already binds — `player`, `player-video`, `seek`, `volume`, `time-current`, `time-total`, `play-btn`, `mute-btn`, `player-menu`, `menu-panel`, `next-up`, `next-up-count`, `next-up-title`. Task 8 and Task 10 rely on these names.

- [ ] **Step 1: Rewrite `renderPlayer`**

```js
export function renderPlayer({ title, subtitle, modeLabel, lossless }) {
  return `
    <div class="player" id="player" tabindex="-1">
      <video class="player__video" id="player-video" playsinline></video>

      <div class="player__touch" id="player-touch" aria-hidden="true">
        <div class="player__ripple player__ripple--l" id="ripple-l"><span>-10s</span></div>
        <div class="player__ripple player__ripple--r" id="ripple-r"><span>+10s</span></div>
      </div>

      <div class="player__spinner"><div class="spinner spinner--lg"></div></div>

      <div class="player__top">
        <button class="player__btn" data-action="close-player" aria-label="Back">${icon('back', 'icon-lg')}</button>
        <div class="player__heading">
          <div class="player__title">${esc(title)}</div>
          ${subtitle ? `<div class="player__subtitle">${esc(subtitle)}</div>` : ''}
        </div>
        ${modeLabel ? `<span class="badge${lossless ? '' : ' badge--warn'} player__mode">${esc(modeLabel)}</span>` : ''}
      </div>

      <div class="next-up" id="next-up" hidden>
        <div class="next-up__label">Up next in <span id="next-up-count">10</span>s</div>
        <div class="next-up__title" id="next-up-title"></div>
        <div class="next-up__actions">
          <button class="btn btn--primary" data-action="play-next">Play now</button>
          <button class="btn btn--ghost" data-action="cancel-next">Cancel</button>
        </div>
      </div>

      <div class="player__controls">
        <input class="range" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
        <div class="player__times t-num">
          <span id="time-current">0:00</span>
          <span id="time-total">0:00</span>
        </div>
        <div class="player__buttons">
          <button class="player__btn" data-action="seek-back" aria-label="Back 10 seconds">${icon('back10', 'icon-lg')}</button>
          <button class="player__btn player__btn--play" data-action="toggle-play" id="play-btn" aria-label="Play">${playIcon('icon-lg')}</button>
          <button class="player__btn" data-action="seek-forward" aria-label="Forward 10 seconds">${icon('fwd10', 'icon-lg')}</button>
          <div class="player__volume">
            <button class="player__btn" data-action="toggle-mute" id="mute-btn" aria-label="Mute">${icon('volume', 'icon')}</button>
            <input class="range range--vol" id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
          </div>
          <div class="player__spacer"></div>
          <div class="player__menu" id="player-menu">
            <button class="player__btn" data-action="toggle-menu" aria-label="Settings">${icon('settings', 'icon')}</button>
            <div class="player__menu-panel" id="menu-panel"></div>
          </div>
          <button class="player__btn" data-action="toggle-fullscreen" aria-label="Fullscreen">${icon('fullscreen', 'icon')}</button>
        </div>
      </div>
    </div>`;
}
```

- [ ] **Step 2: Write `public/css/player.css`**

```css
/* Player chrome. */

.player { position: fixed; inset: 0; z-index: var(--z-player); background: #000; }
.player__video { width: 100%; height: 100%; object-fit: contain; background: #000;
  /* Stops the browser's own double-tap-to-zoom fighting the seek gesture. */
  touch-action: manipulation; }

.player__top, .player__controls { transition: opacity var(--state), transform var(--state); }
.player.is-idle .player__top { opacity: 0; transform: translateY(-8px); pointer-events: none; }
.player.is-idle .player__controls { opacity: 0; transform: translateY(8px); pointer-events: none; }
.player.is-idle { cursor: none; }

.player__top {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-4);
  background: linear-gradient(180deg, rgba(0, 0, 0, .82), transparent);
}
.player__heading { min-width: 0; }
.player__title { font-size: 15px; font-weight: 700; letter-spacing: -.2px; }
.player__subtitle { font-size: 11px; color: var(--fg-2); margin-top: 2px; }
.player__mode { margin-left: auto; flex: none; }

.player__controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  padding: var(--space-6) var(--space-4) var(--space-4);
  background: linear-gradient(0deg, rgba(0, 0, 0, .9), transparent);
}
.player__times { display: flex; justify-content: space-between; font-size: 11px;
  color: var(--fg-2); margin-top: var(--space-2); }
.player__buttons { display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2); }
.player__spacer { margin-left: auto; }
.player__btn { width: 44px; height: 44px; display: grid; place-items: center;
  border-radius: var(--radius); color: var(--fg); transition: background var(--state); }
.player__btn:hover { background: rgba(255, 255, 255, .14); }
.player__btn--play svg { width: 28px; height: 28px; }
.player__volume { display: flex; align-items: center; gap: var(--space-2); }

.range { -webkit-appearance: none; appearance: none; width: 100%; height: 22px;
  background: transparent; cursor: pointer; }
.range::-webkit-slider-runnable-track { height: 3px; border-radius: 2px;
  background: linear-gradient(90deg, var(--fg) 0 calc(var(--fill, 0) * 1%),
                              rgba(255, 255, 255, .24) calc(var(--fill, 0) * 1%) 100%); }
.range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
  width: 13px; height: 13px; border-radius: 50%; background: var(--fg); margin-top: -5px;
  opacity: 0; transition: opacity var(--state); }
.range:hover::-webkit-slider-thumb, .range:active::-webkit-slider-thumb { opacity: 1; }
.range--vol { width: 84px; }

.player__spinner { position: absolute; inset: 0; display: none; place-items: center; z-index: 2; }
.player.is-buffering .player__spinner { display: grid; }

/* Touch gesture surface - invisible; the ripples are the only feedback. */
.player__touch { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.player__ripple {
  position: absolute; top: 0; bottom: 0; width: 30%;
  display: grid; place-items: center; opacity: 0;
  background: radial-gradient(circle at var(--rx, 50%) 50%, rgba(255, 255, 255, .18), transparent 62%);
}
.player__ripple span { font-size: 13px; font-weight: 700; }
.player__ripple--l { left: 0; }
.player__ripple--r { right: 0; }
.player__ripple.is-on { animation: fade-in 420ms var(--ease) reverse both; }

.player__menu { position: relative; }
.player__menu-panel {
  display: none; position: absolute; right: 0; bottom: 52px; width: 250px;
  padding: var(--space-3); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow); max-height: 60vh; overflow-y: auto;
}
.player__menu.is-open .player__menu-panel { display: block; }
.player__menu-group + .player__menu-group { margin-top: var(--space-4);
  padding-top: var(--space-3); border-top: 1px solid var(--line); }
.player__menu-label { font-size: 10px; font-weight: 700; letter-spacing: .9px;
  text-transform: uppercase; color: var(--fg-3); margin-bottom: var(--space-2); }
.player__menu-item { display: block; width: 100%; min-height: 40px; padding: 0 var(--space-3);
  text-align: left; border-radius: var(--radius-sm); font-size: 12px; }
.player__menu-item:hover { background: var(--surface-2); }
.player__menu-item.is-active { background: var(--fg); color: #000; font-weight: 700; }

.next-up { position: absolute; right: var(--space-5); bottom: 132px; z-index: 4; width: 300px;
  padding: var(--space-4); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow); animation: rise-in var(--enter) both; }
.next-up__label { font-size: 10px; color: var(--fg-3); text-transform: uppercase; letter-spacing: .9px; }
.next-up__title { font-weight: 700; font-size: 13px; margin: var(--space-2) 0 var(--space-3); }
.next-up__actions { display: flex; gap: var(--space-2); }

@media (max-width: 767px) {
  .player__volume { display: none; }
  .player__controls { padding: var(--space-6) var(--space-3) var(--space-3); }
  .next-up { left: var(--space-4); right: var(--space-4); width: auto; bottom: 140px; }
  .player__menu-panel { position: fixed; left: var(--space-4); right: var(--space-4);
    bottom: 140px; width: auto; }
}
```

- [ ] **Step 3: Verify by playing something**

Restart the server, open the app, and play a Rick and Morty episode. Confirm:
- Title and `SxxExx · episode name` top-left, playback-mode badge top-right reading `Remux · lossless`
- Scrub, times in tabular numerals, one control row
- Chrome fades after ~2.5s of no movement and returns on mouse move
- At 375px the volume control is hidden and every button is ≥44px

```bash
npm run ui-check
```

Expected: all checks still pass (the player is not open during the harness run, so this is a regression guard).

- [ ] **Step 4: Commit**

```bash
git add public/js/views.js public/css/player.css
git commit -m "feat(player): cinematic control bar with playback-mode badge"
```

---

## Task 8: Player touch gestures

**Files:**
- Modify: `public/js/player.js`
- Test: `tests/player-gestures.test.mjs`

**Interfaces:**
- Consumes: `player-touch`, `ripple-l`, `ripple-r` from Task 7
- Produces: `classifyTap(x, width)` → `'left' | 'centre' | 'right'`, exported for testing

- [ ] **Step 1: Write the failing test**

Create `tests/player-gestures.test.mjs`:

```js
/**
 * Tap zone classification for the player's double-tap seek.
 *
 * Run: npm test
 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ canPlayType: () => '' }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};

const { classifyTap, DOUBLE_TAP_MS } = await import('../public/js/player.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nclassifyTap');
check('far left is left', classifyTap(10, 1000) === 'left');
check('just inside the left third is left', classifyTap(299, 1000) === 'left');
check('exactly a third across is centre', classifyTap(300, 1000) === 'centre');
check('middle is centre', classifyTap(500, 1000) === 'centre');
check('just inside the right third is centre', classifyTap(699, 1000) === 'centre');
check('two thirds across is right', classifyTap(700, 1000) === 'right');
check('far right is right', classifyTap(990, 1000) === 'right');
check('a zero-width surface never throws', classifyTap(0, 0) === 'centre');

console.log('\nDOUBLE_TAP_MS');
check('double tap window is 300ms', DOUBLE_TAP_MS === 300);

console.log('');
if (failures === 0) { console.log(`${total} checks, all passed\n`); process.exit(0); }
console.log(`${total} checks, ${failures} FAILED\n`); process.exit(1);
```

- [ ] **Step 2: Add the test to `npm test`**

In `package.json`, extend the `test` script so it ends with:

```
&& node tests/player-gestures.test.mjs
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm test
```

Expected: FAIL — `The requested module '../public/js/player.js' does not provide an export named 'classifyTap'`.

- [ ] **Step 4: Implement the gestures in `public/js/player.js`**

Add near the top, beside the other constants:

```js
export const DOUBLE_TAP_MS = 300;
const SEEK_STEP = 10;

/**
 * Which third of the video surface a tap landed in.
 * Left and right thirds seek; the centre toggles the chrome.
 */
export function classifyTap(x, width) {
  if (!width || width <= 0) return 'centre';
  const third = width / 3;
  if (x < third) return 'left';
  if (x >= width - third) return 'right';
  return 'centre';
}
```

Then add to `attach()`, after the existing listeners:

```js
  /* ---- touch gestures ---- */
  let lastTapAt = 0;
  let lastTapZone = null;

  const flashRipple = (zone) => {
    const node = el(zone === 'left' ? 'ripple-l' : 'ripple-r');
    if (!node) return;
    node.classList.remove('is-on');
    void node.offsetWidth;   // restart the animation
    node.classList.add('is-on');
  };

  video.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse') return;   // mouse keeps click-to-pause

    const rect = video.getBoundingClientRect();
    const zone = classifyTap(event.clientX - rect.left, rect.width);
    const now = Date.now();
    const isDouble = (now - lastTapAt) < DOUBLE_TAP_MS && lastTapZone === zone;

    if (isDouble && zone !== 'centre') {
      skip(zone === 'left' ? -SEEK_STEP : SEEK_STEP);
      flashRipple(zone);
      lastTapAt = 0;
      lastTapZone = null;
      return;
    }

    lastTapAt = now;
    lastTapZone = zone;

    // A single tap toggles the chrome, but only once the double-tap window has
    // closed - otherwise every seek also flickers the controls.
    setTimeout(() => {
      if (lastTapAt !== now) return;
      if (node.classList.contains('is-idle')) markIdle();
      else node.classList.add('is-idle');
    }, DOUBLE_TAP_MS);
  });
```

- [ ] **Step 5: Run the tests**

```bash
npm test
```

Expected: PASS — all suites green, including the nine new gesture checks.

- [ ] **Step 6: Verify on a touch viewport**

Open the app in Chromium with touch emulation at 375px, play an episode, and confirm:
- Double-tapping the left third jumps back 10s and flashes a `-10s` ripple
- Double-tapping the right third jumps forward 10s
- A single tap in the centre toggles the chrome and does **not** seek
- Double-tapping does not also toggle the chrome
- Double-tapping does not zoom the page

- [ ] **Step 7: Commit**

```bash
git add public/js/player.js tests/player-gestures.test.mjs package.json
git commit -m "feat(player): double-tap to seek and tap to toggle chrome on touch"
```

---

## Task 9: Audio delay — server side

**Files:**
- Modify: `services/transcoder.js` (`buildArgs`, `decide`)
- Modify: `routes/stream.js`
- Modify: `db/schema.sql`, `db/index.js`, `routes/progress.js`
- Test: `tests/audio-offset.test.mjs`

**Interfaces:**
- Produces:
  - `buildArgs(filePath, { mode, startSeconds, audioIndex, audioOffset })` — exported for testing
  - `decide(info, caps, { audioOffset })` — returns `remux` instead of `direct` when the offset is non-zero
  - `clampAudioOffset(value)` → number in `[-30, 30]`, `0` for anything non-finite
  - `progress.audio_offset` column, carried by `GET`/`POST /api/progress`

- [ ] **Step 1: Write the failing test**

Create `tests/audio-offset.test.mjs`:

```js
/**
 * Audio delay, server side.
 *
 * The offset has to survive as a stream copy - a filter approach (adelay,
 * atrim) would force an audio re-encode and quietly cost losslessness. That is
 * what the "stays lossless" checks below are guarding.
 *
 * Run: npm test
 */
import { buildArgs, decide, clampAudioOffset } from '../services/transcoder.js';

let total = 0;
let failures = 0;
const check = (name, condition, detail) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) { failures += 1; if (detail !== undefined) console.log(`         ${detail}`); }
};

const FILE = 'C:\\media\\ep.mkv';

console.log('\nclampAudioOffset');
check('passes a normal value through', clampAudioOffset(0.5) === 0.5);
check('passes a negative value through', clampAudioOffset(-1.25) === -1.25);
check('clamps above the ceiling', clampAudioOffset(99) === 30);
check('clamps below the floor', clampAudioOffset(-99) === -30);
check('treats a string number as a number', clampAudioOffset('2.5') === 2.5);
check('treats nonsense as zero', clampAudioOffset('banana') === 0);
check('treats undefined as zero', clampAudioOffset(undefined) === 0);
check('treats NaN as zero', clampAudioOffset(NaN) === 0);

console.log('\nbuildArgs at offset 0');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 0, audioIndex: 0, audioOffset: 0 });
  const inputs = args.filter((a) => a === '-i').length;
  check('uses a single input', inputs === 1, `inputs=${inputs}`);
  check('no -itsoffset', !args.includes('-itsoffset'));
  check('maps audio from input 0', args.includes('0:a:0?'));
}

console.log('\nbuildArgs with an offset');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 12, audioIndex: 1, audioOffset: 0.5 });
  const inputs = args.filter((a) => a === '-i').length;
  check('opens the file twice', inputs === 2, `inputs=${inputs}`);

  const off = args.indexOf('-itsoffset');
  check('-itsoffset is present', off !== -1);
  check('-itsoffset carries the value', args[off + 1] === '0.5', args[off + 1]);
  const secondInput = args.indexOf('-i', args.indexOf('-i') + 1);
  check('-itsoffset comes before the second -i', off < secondInput, `${off} < ${secondInput}`);

  check('video comes from input 0', args.includes('0:v:0'));
  check('audio comes from input 1', args.includes('1:a:1?'));
  check('both inputs are seeked', args.filter((a) => a === '-ss').length === 2);

  const v = args.indexOf('-c:v');
  const a = args.indexOf('-c:a');
  check('video stays a copy', args[v + 1] === 'copy');
  check('audio stays a copy - remux must not become lossy', args[a + 1] === 'copy', args[a + 1]);
}

console.log('\nbuildArgs with a negative offset');
{
  const args = buildArgs(FILE, { mode: 'remux', startSeconds: 0, audioIndex: 0, audioOffset: -1.5 });
  const off = args.indexOf('-itsoffset');
  check('carries the negative value', args[off + 1] === '-1.5', args[off + 1]);
}

console.log('\ndecide');
{
  const playable = {
    container: '.mp4',
    video: { codec: 'h264' },
    audio: [{ index: 0, codec: 'aac', default: true }],
    duration: 1200,
    subtitles: []
  };
  check('plays direct with no offset', decide(playable, {}, { audioOffset: 0 }).mode === 'direct');
  check('becomes remux with an offset', decide(playable, {}, { audioOffset: 0.5 }).mode === 'remux',
    decide(playable, {}, { audioOffset: 0.5 }).mode);
  check('offset mode is still lossless', decide(playable, {}, { audioOffset: 0.5 }).lossless === true);
  check('offset mode is not seekable by range', decide(playable, {}, { audioOffset: 0.5 }).seekable === false);
  check('a negative offset also forces remux', decide(playable, {}, { audioOffset: -0.2 }).mode === 'remux');
  check('missing options behave as no offset', decide(playable, {}).mode === 'direct');
}

console.log('');
if (failures === 0) { console.log(`${total} checks, all passed\n`); process.exit(0); }
console.log(`${total} checks, ${failures} FAILED\n`); process.exit(1);
```

- [ ] **Step 2: Add it to `npm test` and watch it fail**

Extend the `test` script with `&& node tests/audio-offset.test.mjs`, then:

```bash
npm test
```

Expected: FAIL — `does not provide an export named 'clampAudioOffset'`.

- [ ] **Step 3: Implement in `services/transcoder.js`**

Add the clamp near the top of the file:

```js
export const MAX_AUDIO_OFFSET = 30;

/** Seconds to shift audio by. Positive delays it, negative advances it. */
export function clampAudioOffset(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(-MAX_AUDIO_OFFSET, Math.min(MAX_AUDIO_OFFSET, seconds));
}
```

Replace `buildArgs` entirely and export it:

```js
export function buildArgs(filePath, { mode, startSeconds = 0, audioIndex = 0, audioOffset = 0 }) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  const offset = clampAudioOffset(audioOffset);

  // Seeking before -i is the fast path: ffmpeg jumps rather than decoding to
  // the timestamp. With -c copy it lands on the nearest keyframe.
  const seek = () => { if (startSeconds > 0) args.push('-ss', String(startSeconds)); };

  seek();
  args.push('-i', filePath);

  if (offset !== 0) {
    // A second, time-shifted view of the same file. Audio can still be copied
    // this way; an adelay/atrim filter would force a re-encode.
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

  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}
```

In `decide`, take a third argument and override `direct`. Change the signature and add the override just before the return:

```js
export function decide(info, caps = {}, options = {}) {
  const offset = clampAudioOffset(options.audioOffset);
  // ... existing body unchanged, up to where `mode` is settled ...
```

and immediately after `if (mode === 'direct') reasons.push('plays natively — streaming untouched bytes');` insert:

```js
  // direct streams raw bytes with no ffmpeg in the path, so it cannot carry an
  // audio offset. Promote to remux: still a stream copy, still lossless.
  if (offset !== 0 && mode === 'direct') {
    mode = 'remux';
    reasons.push(`audio offset ${offset}s requires ffmpeg — remuxing instead of direct`);
  }
```

`mode` must be declared with `let`, which it already is.

Finally, pass the offset through `openStream` — it already forwards its options object to `buildArgs`, so no change is needed there beyond callers supplying `audioOffset`.

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS — all suites green including the 27 new audio-offset checks.

- [ ] **Step 5: Wire the stream route**

In `routes/stream.js`, add the parse beside the existing query reads in the `GET /` handler and in `streamViaFfmpeg`:

In `streamViaFfmpeg`, replace the first two lines with:

```js
  const startSeconds = Math.max(0, Number(req.query.t) || 0);
  const audioIndex = Math.max(0, Number(req.query.audio) || 0);
  const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
```

and pass it into `openStream`:

```js
  const { stream, kill } = transcoder.openStream(filePath, {
    mode: decision.mode,
    startSeconds,
    audioIndex,
    audioOffset
  });
```

In the `GET /` handler, pass the offset into `decide` and stop honouring the direct escape hatch when an offset is set:

```js
    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);

    // ?mode=direct is an escape hatch, but an offset needs ffmpeg.
    if (req.query.mode === 'direct' && audioOffset === 0) {
      return streamBytes(req, res, filePath, stats.size);
    }

    const info = await transcoder.probe(filePath);
    const decision = transcoder.decide(info, capsFrom(req), { audioOffset });
```

Do the same in the `/info` handler so the reported mode matches what will actually be served:

```js
    const audioOffset = transcoder.clampAudioOffset(req.query.audioOffset);
    const decision = transcoder.decide(info, capsFrom(req), { audioOffset });
```

- [ ] **Step 6: Add the database column**

In `db/schema.sql`, add to the `progress` table definition for fresh databases:

```sql
  audio_offset REAL NOT NULL DEFAULT 0,
```

placed directly after the `completed` line.

In `db/index.js`, immediately after the `db.exec(fs.readFileSync(...))` line, add the migration for existing databases:

```js
// CREATE TABLE IF NOT EXISTS cannot add a column to a table that already
// exists, so new columns need an explicit ALTER. SQLite has no
// "IF NOT EXISTS" for columns; a duplicate is the expected no-op.
try {
  db.exec('ALTER TABLE progress ADD COLUMN audio_offset REAL NOT NULL DEFAULT 0');
  log.info('migrated: progress.audio_offset added');
} catch (error) {
  if (!/duplicate column name/i.test(error.message)) throw error;
}
```

Then extend the progress statements. In `stmt.progressUpsert`, add `audio_offset` to the column list, to the `VALUES` list as `@audio_offset`, and to the conflict update as:

```sql
      audio_offset = COALESCE(excluded.audio_offset, progress.audio_offset),
```

and in `upsertProgress`, add to the `row` object:

```js
    audio_offset: input.audio_offset ?? null,
```

- [ ] **Step 7: Carry it through the progress route**

In `routes/progress.js`, add to the `upsertProgress` call in the POST handler:

```js
    audio_offset: body.audio_offset
```

- [ ] **Step 8: Verify against the real server**

Restart the server. Then confirm the offset actually changes the ffmpeg command and the file still plays:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "http://127.0.0.1:3000/api/stream/info?path=<an-mp4-episode-path>"
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "http://127.0.0.1:3000/api/stream/info?path=<same-path>&audioOffset=0.5"
```

Expected: the first reports `"mode":"direct"`, the second `"mode":"remux"` with the reason naming the offset. Use `/api/media/library` to get a real path.

- [ ] **Step 9: Commit**

```bash
git add services/transcoder.js routes/stream.js routes/progress.js db/ tests/audio-offset.test.mjs package.json
git commit -m "feat(player): server-side audio delay via a time-shifted second ffmpeg input"
```

---

## Task 10: Audio delay — player UI

**Files:**
- Modify: `public/js/state.js`, `public/js/api.js`, `public/js/player.js`, `public/js/app.js`
- Modify: `public/css/player.css`

**Interfaces:**
- Consumes: `clampAudioOffset` semantics from Task 9 (±30s), `buildMenu` from Task 7
- Produces: `nudgeAudioOffset(delta)` and `resetAudioOffset()` exported from `player.js`

- [ ] **Step 1: Add the offset to state and the stream URL**

In `public/js/state.js`, change the player slice to:

```js
  player: { open: false, src: '', subs: null, resumeAt: 0, audioOffset: 0 },
```

In `public/js/api.js`, extend `streamUrl`:

```js
export function streamUrl(filePath, { start = 0, audio, audioOffset = 0 } = {}) {
  const caps = decoderCapabilities();
  return `/api/stream?${q({
    path: filePath,
    t: start > 0 ? Math.floor(start) : '',
    audio,
    audioOffset: audioOffset || '',
    hevc: caps.hevc ? 1 : '',
    ac3: caps.ac3 ? 1 : ''
  })}`;
}
```

- [ ] **Step 2: Add the nudge logic to `player.js`**

Add beside the other constants:

```js
export const AUDIO_OFFSET_STEPS = [-5, -1, -0.5, -0.1, -0.05, 0.05, 0.1, 0.5, 1, 5];
const MAX_AUDIO_OFFSET = 30;
```

Add the functions:

```js
/**
 * Nudge the audio offset and restart the stream at the current position.
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
  if (value === ctx.audioOffset) return;
  ctx.audioOffset = value;

  // The offset lives in the ffmpeg command, so it can only change by
  // restarting the stream. Same mechanic as seeking in pipe mode.
  const at = position();
  const wasPlaying = !ctx.video.paused;
  ctx.seekable = false;          // an offset always means an ffmpeg pipe
  load(at, { autoplay: wasPlaying });

  persist().catch(() => {});
  buildMenu();
  setState({ player: { ...state.player, audioOffset: value } });
}
```

In `open()`, initialise it from the saved progress row and include it in the ctx object:

```js
    audioOffset: (saved && Number(saved.audio_offset)) || 0,
```

and in the `load()` function pass it into the URL — replace both `api.streamUrl` calls:

```js
      ctx.video.src = api.streamUrl(ctx.filePath, { audioOffset: ctx.audioOffset });
```
```js
    ctx.video.src = api.streamUrl(ctx.filePath, { start: ctx.offset, audioOffset: ctx.audioOffset });
```

In `persist()`, add to the payload:

```js
      audio_offset: ctx.audioOffset,
```

- [ ] **Step 3: Add the menu group**

In `buildMenu()`, append a third group before the closing backtick:

```js
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
```

- [ ] **Step 4: Wire the actions and keyboard**

In `public/js/app.js`, add to `ACTIONS`:

```js
  'audio-nudge': (el) => player.nudgeAudioOffset(Number(el.dataset.delta)),
  'audio-reset': () => player.resetAudioOffset(),
```

In `player.js`'s `onKeyDown`, add two cases before `default`:

```js
    case '[':
      event.preventDefault(); nudgeAudioOffset(-0.05); break;
    case ']':
      event.preventDefault(); nudgeAudioOffset(0.05); break;
```

- [ ] **Step 5: Style it in `public/css/player.css`**

Append:

```css
.audiodelay__head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); }
.audiodelay__value { font-size: 15px; font-weight: 700; }
.audiodelay__reset { margin-left: auto; font-size: 11px; color: var(--fg-3); min-height: 32px; padding: 0 var(--space-2); }
.audiodelay__reset:hover { color: var(--fg); }
.audiodelay__hint { font-size: 10px; color: var(--fg-3); margin-bottom: var(--space-2); }
.audiodelay__grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.audiodelay__step {
  min-height: 34px; border-radius: var(--radius-sm); border: 1px solid var(--line);
  font-size: 10px; font-weight: 600; color: var(--fg-2);
}
.audiodelay__step:hover { background: var(--surface-2); color: var(--fg); }

@media (max-width: 767px) {
  .audiodelay__step { min-height: 44px; }
}
```

- [ ] **Step 6: Verify end to end**

Play an episode, open the settings menu, and confirm:
- An `Audio delay` group showing `0.00s`, a Reset, and two rows of five steps
- Tapping `+0.1s` twice shows `+0.20s` — cumulative, not absolute
- The picture continues from roughly where it was after each nudge
- Reset returns to `0.00s`
- `[` and `]` nudge by 0.05s on desktop
- Closing and reopening the same episode restores the offset

```bash
npm test && npm run ui-check
```

Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add public/js/ public/css/player.css
git commit -m "feat(player): audio delay control with cumulative nudging and per-file persistence"
```

---

## Task 11: Next-up timing

**Files:**
- Modify: `public/js/player.js` (`NEXT_UP_LEAD_SECONDS`, `maybeOfferNext`, new `shouldCountDown`)
- Modify: `tests/player-nextup.test.mjs`

**Interfaces:**
- Consumes: `shouldOfferNext`, `secondsRemaining` (already exported)
- Produces: `COUNTDOWN_WINDOW_SECONDS = 10` and `shouldCountDown(total, current, window)` → boolean

- [ ] **Step 1: Extend the existing test**

Append to `tests/player-nextup.test.mjs`, before the summary block:

```js
console.log('\nshouldCountDown');
check('no number a minute out', shouldCountDown(EPISODE, EPISODE - 60) === false);
check('no number at 11 seconds', shouldCountDown(EPISODE, EPISODE - 11) === false);
check('number at exactly 10 seconds', shouldCountDown(EPISODE, EPISODE - 10) === true);
check('number at 3 seconds', shouldCountDown(EPISODE, EPISODE - 3) === true);
check('number past the end', shouldCountDown(EPISODE, EPISODE + 5) === true);
check('no number for an unknown duration', shouldCountDown(0, 10) === false);
check('window is 10 seconds', COUNTDOWN_WINDOW_SECONDS === 10);
check('lead is a full minute', NEXT_UP_LEAD_SECONDS === 60);
```

and extend the import on line 20 to:

```js
const { shouldOfferNext, secondsRemaining, shouldCountDown,
        NEXT_UP_LEAD_SECONDS, COUNTDOWN_WINDOW_SECONDS } =
  await import('../public/js/player.js');
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test
```

Expected: FAIL — `does not provide an export named 'shouldCountDown'`.

- [ ] **Step 3: Implement**

In `public/js/player.js`, change the lead and add the new predicate:

```js
export const NEXT_UP_LEAD_SECONDS = 60;
export const COUNTDOWN_WINDOW_SECONDS = 10;

/**
 * Should the card show a ticking number yet?
 *
 * The card itself appears a minute out so there is time to reach for Cancel,
 * but a number counting from 60 is just noise. It starts in the last ten
 * seconds and runs to zero, which is the actual end of the episode - the
 * advance is not ten seconds after the card appears. Firing early is the bug
 * fixed in 45227d8 and it takes the ending with it.
 */
export function shouldCountDown(total, current, window = COUNTDOWN_WINDOW_SECONDS) {
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(current)) return false;
  return (total - current) <= window;
}
```

In `maybeOfferNext`, replace the counter block:

```js
  const left = secondsRemaining(total, current);
  const counter = el('next-up-count');
  const label = box.querySelector('.next-up__label');

  if (shouldCountDown(total, current)) {
    if (counter) counter.textContent = String(left);
    if (label) label.innerHTML = `Up next in <span id="next-up-count">${left}</span>s`;
  } else if (label && !ctx.plainLabelSet) {
    ctx.plainLabelSet = true;
    label.textContent = 'Up next';
  }

  if (shouldCountDown(total, current)) ctx.plainLabelSet = false;
```

- [ ] **Step 4: Run the tests**

```bash
npm test
```

Expected: PASS, including the eight new checks and all pre-existing ones — they reference `NEXT_UP_LEAD_SECONDS` rather than `45`, so raising it does not invalidate them.

- [ ] **Step 5: Verify by watching an episode end**

Seek to roughly 70 seconds before the end of a Rick and Morty episode and confirm:
- At ~60s the card appears reading **Up next** with the next episode and a Cancel, no number
- The number appears only in the last 10 seconds and counts to zero
- The next episode starts when the current one actually ends, with the credits having played
- Pressing Cancel removes the card and nothing auto-advances

- [ ] **Step 6: Commit**

```bash
git add public/js/player.js tests/player-nextup.test.mjs
git commit -m "feat(player): next-up card a minute out, countdown only in the last 10s"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Monochrome tokens, type scale, motion | 2 |
| CSS split into four files | 2 |
| `icon()` default size / invisible menu bug | 3 |
| Desktop 64px icon rail | 3 |
| Mobile bottom tab bar, drawer removed | 3 |
| One rail component, no scrollbar, hover arrows | 4 |
| Owned marker and progress bar | 4 |
| Hero, scrim, selection change | 5 |
| Library rail collapsing at ≤8 titles | 5 |
| Movies / Shows / Search / Downloads / modal | 6 |
| Player classic bar, mode badge, idle fade | 7 |
| Double-tap seek, tap toggle, touch-action | 8 |
| Audio delay: ffmpeg two-input, lossless copy | 9 |
| Audio delay: direct → remux override | 9 |
| Audio delay: clamp ±30s | 9 |
| Audio delay: `progress.audio_offset` + migration | 9 |
| Audio delay: menu UI, cumulative, keyboard | 10 |
| Next-up at 60s, countdown in the last 10s | 11 |
| Browser verification at 1440/768/375 | 1, then every UI task |

**Type consistency checked:** `posterCard(item, type, { owned, progress })` and `rail(title, cardsHtml, { count })` are defined in Task 4 and called with those exact shapes in Tasks 5 and 6. `buildArgs(filePath, { mode, startSeconds, audioIndex, audioOffset })` and `decide(info, caps, { audioOffset })` are defined in Task 9 and consumed by Task 10 through `api.streamUrl({ audioOffset })`. `clampAudioOffset` is the single clamp, used by both the route and the tests; the client clamps to the same ±30 constant. `classifyTap` / `DOUBLE_TAP_MS` are defined and tested in Task 8 only.

**Known ordering dependency:** `content.css` is empty between Tasks 2 and 4, so the app looks broken in that window. Task 3's verification step says so explicitly and only asserts the shell checks. This is deliberate — the shell is verifiable without content, and bundling them would make one unreviewable task.

**Deliberate omission:** the WPF launcher is not re-skinned. The spec records that the launcher and web app stop sharing a palette as an accepted consequence, and it is not in scope here.
