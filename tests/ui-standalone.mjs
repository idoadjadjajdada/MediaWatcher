/**
 * The app as it is on a home screen, not in a browser tab.
 *
 * Launched from the home screen there is no browser chrome, so the page owns
 * the whole screen — including the strip under the clock and the island, and
 * the strip the home indicator sits on. iOS reports those as safe-area insets
 * and the layout has to hold its controls off them; a browser tab reports zero
 * for all four, which is why a layout can look finished for a year and still
 * put the search field under the clock the first time someone installs it.
 *
 * Chromium will not report an iPhone's insets, so this sets them: every rule
 * that respects them reads --safe-top and its three siblings from :root, and
 * writing those four values simulates the phone exactly. That is what those
 * variables are for as much as the layout is.
 *
 * Landscape is not an afterthought here. It is how anything gets watched, and
 * it is the orientation where the island moves beside the back button rather
 * than above it.
 *
 * Needs a running server:  npm start
 * Run:                     npm run ui-standalone
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

/*
 * An iPhone 15 Pro, in CSS pixels. Portrait gives up the top to the island and
 * the bottom to the home indicator; landscape gives up both sides to the island
 * and keeps a shallower bottom inset.
 */
const PORTRAIT = { width: 393, height: 852, insets: { top: 59, right: 0, bottom: 34, left: 0 } };
const LANDSCAPE = { width: 852, height: 393, insets: { top: 0, right: 59, bottom: 21, left: 59 } };

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
const context = await browser.newContext({ viewport: { width: PORTRAIT.width, height: PORTRAIT.height } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

/** Put the phone's insets on the page, the way iOS would. */
const wearInsets = (insets) => page.evaluate((values) => {
  const root = document.documentElement;
  root.style.setProperty('--safe-top', `${values.top}px`);
  root.style.setProperty('--safe-right', `${values.right}px`);
  root.style.setProperty('--safe-bottom', `${values.bottom}px`);
  root.style.setProperty('--safe-left', `${values.left}px`);
}, insets);

/**
 * Where every one of these elements sits, against the box the hardware leaves.
 *
 * A tolerance of one pixel, because a border or a rounded corner landing
 * exactly on the boundary is not a control anyone will fail to press.
 */
const inspect = (selectors, screen) => page.evaluate(({ list, size, insets }) => {
  const safe = {
    top: insets.top,
    left: insets.left,
    right: size.width - insets.right,
    bottom: size.height - insets.bottom
  };

  return list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return { selector, found: false };
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { selector, found: true, drawn: false };
    return {
      selector,
      found: true,
      drawn: true,
      rect: { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      inside: r.top >= safe.top - 1 && r.left >= safe.left - 1
        && r.right <= safe.right + 1 && r.bottom <= safe.bottom + 1
    };
  });
}, { list: selectors, size: { width: screen.width, height: screen.height }, insets: screen.insets });

async function allInside(label, selectors, screen) {
  const results = await inspect(selectors, screen);
  for (const result of results) {
    if (!result.found) { check(`${label} — ${result.selector} exists`, false, 'not in the DOM'); continue; }
    if (!result.drawn) continue;   // hidden right now; nothing to place
    check(`${label} — ${result.selector} clears the hardware`, result.inside, result.rect);
  }
}

/** Get past the gate, exactly as the other UI suites do. */
async function signIn() {
  let password = process.env.MW_PASSWORD || '';
  if (!password) {
    try {
      const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
      const line = env.split(/\r?\n/).find((entry) => entry.startsWith('AUTH_PASSWORD='));
      password = line ? line.slice('AUTH_PASSWORD='.length).split(/\s+#/)[0].trim() : '';
    } catch {
      // No .env beside the test. An ungated server still works.
    }
  }
  if (!password) return;

  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (secret) => {
    await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: secret, remember: false })
    });
  }, password);
}

console.log('\nthe gate, portrait');
await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
await wearInsets(PORTRAIT.insets);
await page.waitForTimeout(300);
// The first screen a new phone sees, and the one nobody thinks to check.
await allInside('gate', ['.gate', '.gate__mark', '.gate__submit'], PORTRAIT);

await signIn();

console.log('\nthe shell, portrait');
await page.goto(BASE, { waitUntil: 'networkidle' });
await wearInsets(PORTRAIT.insets);
await page.waitForTimeout(1200);

await allInside('shell', [
  '.topbar__search',      // under the clock without the inset
  '.topbar__settings',
  '.tabbar__item',        // under the home indicator without it
  '.navrail__mark'        // hidden at this width; skipped when undrawn
], PORTRAIT);

const barGrew = await page.evaluate(() => {
  const bar = document.querySelector('.topbar');
  const search = document.querySelector('.topbar__search');
  return { bar: Math.round(bar.getBoundingClientRect().height), search: Math.round(search.getBoundingClientRect().height) };
});
// The bar keeps its own height and stands the inset above it, rather than the
// two sharing one strip and squashing the field.
check('shell — the top bar grew by the inset rather than squashing',
  barGrew.bar >= 60 + 59 - 1, barGrew);

console.log('\nno horizontal overflow');
for (const screen of [PORTRAIT, LANDSCAPE]) {
  await page.setViewportSize({ width: screen.width, height: screen.height });
  await wearInsets(screen.insets);
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }));
  check(`${screen.width}x${screen.height} — nothing runs off the side`,
    overflow.scroll <= overflow.client + 1, overflow);
}

console.log('\nthe player, landscape');
await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height });
await wearInsets(LANDSCAPE.insets);

const opened = await page.evaluate(async () => {
  const library = await (await fetch('/api/media/library')).json();
  for (const show of library.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        if ((episode.files || []).length) {
          const player = await import('/js/player.js');
          await player.open(episode.files[0].file_path);
          return true;
        }
      }
    }
  }
  return false;
});

if (!opened) {
  check('library has a playable episode', false, 'no episode with a file');
} else {
  await page.waitForSelector('#player', { timeout: 10000 });
  await wearInsets(LANDSCAPE.insets);
  await page.waitForTimeout(1200);
  // Waking the chrome: an idle player hides the very controls being measured.
  await page.mouse.move(400, 200);
  await page.waitForTimeout(300);

  await allInside('player', [
    '[data-action="close-player"]',   // top left, beside the island in landscape
    '.player__title',
    '#seek',
    '#play-btn',
    '[data-action="toggle-fullscreen"]',
    '#time-current',
    '#time-total'
  ], LANDSCAPE);

  await page.evaluate(async () => {
    const player = await import('/js/player.js');
    player.openIntroEditor();
  });
  await page.waitForTimeout(600);
  await allInside('player', ['#intro-editor', '#intro-strip'], LANDSCAPE);
  await page.evaluate(async () => {
    const player = await import('/js/player.js');
    player.closeIntroEditor();
    await player.close({ save: false });
  });
}

console.log('\nconsole');
check('no errors while measuring', consoleErrors.length === 0, consoleErrors.slice(0, 6));

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
