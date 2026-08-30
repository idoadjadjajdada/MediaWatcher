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
    return s.display !== 'none' && s.visibility === 'visible' && s.opacity !== '0';
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
      return s.scrollbarWidth !== 'none' && r.scrollWidth > r.clientWidth + 1;
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
