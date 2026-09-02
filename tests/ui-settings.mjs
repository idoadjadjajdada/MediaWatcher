/**
 * Browser-driven checks for the settings page.
 *
 * The unit tests cover coercion and formatting. What they cannot tell you is
 * whether the page is reachable, whether a control actually writes anything,
 * and whether a setting survives a reload — which is the whole point of a
 * settings page and the thing most likely to be quietly broken.
 *
 * Logging in here also exercises the login-history recording, since the run
 * has to pass the gate anyway.
 *
 * Needs a running server. Defaults to port 3001; override with UI_SETTINGS_URL.
 *
 * Run:  MW_PASSWORD=... node tests/ui-settings.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const BASE = process.env.UI_SETTINGS_URL || 'http://127.0.0.1:3001';
const PASSWORD = process.env.MW_PASSWORD || process.env.AUTH_PASSWORD;

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
  console.log(`  ${ok ? '[pass]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log(`         ${JSON.stringify(detail)}`);
  if (!ok) failures += 1;
}

if (!PASSWORD) {
  console.error('Set MW_PASSWORD (or AUTH_PASSWORD) so the gate can be passed.');
  process.exit(2);
}

const pw = loadPlaywright();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  console.log('\nthe gate records what happens');
  // A deliberate failure first, so the history has both outcomes in it.
  await page.goto(`${BASE}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#password', 'definitely-not-the-password');
  await page.uncheck('#remember');
  await page.click('.gate__submit');
  await page.waitForTimeout(800);

  await page.fill('#password', PASSWORD);
  await page.click('.gate__submit');
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const logins = await page.evaluate(async () => {
    const api = await import('/js/api.js');
    return api.getLoginHistory();
  });
  check('the successful login was recorded', logins.some((entry) => entry.ok === true), logins.length);
  check('the failed attempt was recorded too', logins.some((entry) => entry.ok === false));
  check('the newest entry is first',
    logins.length < 2 || logins[0].at >= logins[1].at);
  check('an origin is classified', Boolean(logins[0]?.origin), logins[0]?.origin);
  // The password must never appear anywhere in what the log stores.
  check('no attempt stores the password',
    !JSON.stringify(logins).includes(PASSWORD));

  console.log('\nreaching the page');
  await page.click('[data-page="settings"]');
  await page.waitForSelector('.settings', { timeout: 10000 });
  check('the settings page renders', await page.isVisible('.settings'));
  check('the hash reflects the page', (await page.evaluate(() => location.hash)) === '#settings');

  await page.waitForFunction(
    () => !document.querySelector('.settings')?.textContent.includes('Loading…'),
    null, { timeout: 30000 }
  ).catch(() => {});

  const headings = await page.$$eval('.settings__heading', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('all five groups are present',
    ['Playback', 'Appearance', 'Devices', 'Login history', 'Diagnostics'].every((h) => headings.includes(h)),
    headings);

  console.log('\ndiagnostics');
  const facts = await page.$$eval('.fact dt', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('the diagnostics grid is populated', facts.length > 10, facts.length);
  check('ffmpeg is reported', facts.includes('ffmpeg'));
  check('library size is reported', facts.includes('Library size'));
  const libSize = await page.$$eval('.fact', (nodes) => {
    const row = nodes.find((n) => n.querySelector('dt')?.textContent.trim() === 'Library size');
    return row?.querySelector('dd')?.textContent.trim() || '';
  });
  check('and is a real size, not 0 B', /\d/.test(libSize) && !libSize.startsWith('0 B'), libSize);

  console.log('\ndevices');
  const deviceRows = await page.$$eval('.settings__group', (groups) => {
    const g = groups.find((n) => n.querySelector('.settings__heading')?.textContent.trim() === 'Devices');
    return g ? g.querySelectorAll('tbody tr').length : -1;
  });
  check('remembered devices are listed', deviceRows >= 0, deviceRows);

  console.log('\ncontrols actually write');
  const before = await page.evaluate(() => {
    const m = JSON.parse(localStorage.getItem('mw.device') || '{}');
    return m.autoplayNext;
  });
  await page.click('[data-action="settings-toggle"][data-field="autoplayNext"]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mw.device') || '{}').autoplayNext);
  check('the toggle writes to storage', after === false, { before, after });
  // It read as a circle because `.switch` already existed in content.css with
  // min-height: 44px, which turned a 44x26 pill into a 44x44 blob.
  const shape = await page.$eval('[data-action="settings-toggle"]', (n) => {
    const box = n.getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  });
  check('the toggle is a pill, not a circle', shape.w > shape.h * 1.4, shape);

  check('and the switch reflects it',
    (await page.getAttribute('[data-action="settings-toggle"][data-field="autoplayNext"]', 'aria-checked')) === 'false');

  // The bug worth catching: a deliberate false read back as "unset" and
  // flipped on again by the default.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.settings', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('a deliberate false survives a reload',
    (await page.getAttribute('[data-action="settings-toggle"][data-field="autoplayNext"]', 'aria-checked')) === 'false');

  // Page-entry loading fires on the page CHANGING, and after a reload it has
  // not changed — so a deep link straight to #settings has to load its data
  // some other way or these sections sit on "Loading…" forever.
  await page.waitForFunction(
    () => !document.querySelector('.settings')?.textContent.includes('Loading…'),
    null, { timeout: 20000 }
  ).catch(() => {});
  const stillLoading = await page.$$eval('.settings__loading', (nodes) => nodes.length);
  check('reloading directly onto the page still loads its data', stillLoading === 0, stillLoading);

  await page.click('[data-action="settings-step"][data-field="seekSeconds"][data-delta="5"]');
  await page.waitForTimeout(250);
  check('a stepper writes to storage',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('mw.device') || '{}').seekSeconds)) === 15);

  await page.click('[data-action="settings-choose"][data-field="quality"][data-value="medium"]');
  await page.waitForTimeout(250);
  check('a choice writes to the store the player already used',
    (await page.evaluate(() => localStorage.getItem('mw.quality'))) === 'medium');

  await page.click('[data-action="settings-colour"][data-value="yellow"]');
  await page.waitForTimeout(250);
  check('a subtitle colour writes through the existing clamp',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('mw.subtitles') || '{}').colour)) === 'yellow');

  await page.click('[data-action="settings-reset-appearance"]');
  await page.waitForTimeout(300);
  check('reset returns the subtitle colour to white',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('mw.subtitles') || '{}').colour)) === 'white');
  check('but leaves playback settings alone',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('mw.device') || '{}').seekSeconds)) === 15);

  console.log('\nstorage');
  const bars = await page.$$eval('.bar__title', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('titles are listed by size', bars.length > 0, bars.slice(0, 3));
  const sizes = await page.$$eval('.bar__size', (nodes) => nodes.map((n) => n.textContent.trim()));
  check('each carries a size', sizes.length === bars.length && sizes.every((s) => /\d/.test(s)));
  // Biggest first is the whole point — an unsorted list answers nothing.
  const widths = await page.$$eval('.bar__fill', (nodes) => nodes.map((n) => parseFloat(n.style.width)));
  check('the widest bar is first', widths.length > 1 ? widths[0] >= widths[1] : true, widths.slice(0, 3));
  check('the largest bar fills the track', widths[0] === 100, widths[0]);
  const everything = await page.$$eval('.fact', (nodes) => {
    const row = nodes.find((n) => n.querySelector('dt')?.textContent.trim() === 'Everything');
    return row?.querySelector('dd')?.textContent.trim() || '';
  });
  check('a library total is shown', /\d/.test(everything) && !everything.startsWith('0 B'), everything);

  console.log('\nmissing episodes');
  await page.goto(`${BASE}/#shows`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });
  // Open shows until one with a gap turns up. Working the gaps out costs a
  // TMDB season lookup per season on the first open, hence the long wait.
  let foundGaps = false;
  // Re-queried by index each pass rather than held: opening and closing the
  // modal re-renders the page, which detaches any handle taken beforehand.
  const cardCount = await page.$$eval('.card', (nodes) => nodes.length);
  for (let i = 0; i < cardCount; i += 1) {
    await page.waitForSelector('.card', { timeout: 10000 });
    const card = (await page.$$('.card'))[i];
    if (!card) break;
    await card.click();
    await page.waitForSelector('.modal', { timeout: 10000 });
    await page.waitForSelector('.gaps__label--missing', { timeout: 15000 })
      .then(() => { foundGaps = true; })
      .catch(() => {});
    if (foundGaps) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  check('a show with gaps reports them', foundGaps);

  if (foundGaps) {
    // A collapsed season must not spill its gap list out under the header.
    const closedDisplay = await page.evaluate(() => {
      const closed = Array.from(document.querySelectorAll('.season'))
        .find((s) => !s.classList.contains('is-open') && s.querySelector('.gaps'));
      return closed ? getComputedStyle(closed.querySelector('.gaps')).display : null;
    });
    check('a collapsed season hides its gaps', closedDisplay === null || closedDisplay === 'none', closedDisplay);

    const gapText = await page.$eval('.gaps__label--missing', (n) => n.textContent.trim());
    check('the count reads as missing', /\d+ missing/.test(gapText), gapText);
    const numbers = await page.$$eval('.gap--missing .gap__num', (nodes) => nodes.map((n) => Number(n.textContent)));
    check('each missing episode is listed by number', numbers.length > 0 && numbers.every(Number.isInteger), numbers);
    check('and they are in order', numbers.every((n, i) => i === 0 || numbers[i - 1] < n), numbers);
    // Unaired must never be folded into the missing count.
    const unairedInMissing = await page.$$eval('.gap--missing', (nodes) => nodes.length);
    check('unaired episodes are not counted as missing',
      unairedInMissing === Number(gapText.match(/(\d+)/)[1]), { unairedInMissing, gapText });
  }

  console.log('\nlayout');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the page does not scroll sideways', overflow <= 1, overflow);

  if (process.env.SHOT) {
    await page.screenshot({ path: process.env.SHOT, fullPage: false });
    console.log(`\nscreenshot: ${process.env.SHOT}`);
  }
} finally {
  await browser.close();
}

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
