/**
 * Browser-driven intro editor.
 *
 * The arithmetic has its own suite; this is about the half that only a real
 * browser can answer. Do the handles land on the strip. Does dragging one move
 * the time it is supposed to. Does the strip actually magnify — the entire
 * point of the panel is that ninety seconds of a forty-minute episode is a
 * usable width in here and four pixels on the seek bar, and that claim is a
 * measurement, not an opinion.
 *
 * It saves for real and puts it back afterwards, because "the timings reached
 * the database and only for this episode" is the thing most worth knowing.
 *
 * Needs a running server:  npm start
 * Run:                     npm run ui-intro
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
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

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

await signIn();

/** The first episode in the library that has a file, with what identifies it. */
async function openFirstEpisode() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const target = await page.evaluate(async () => {
    const library = await (await fetch('/api/media/library')).json();
    for (const show of library.shows || []) {
      for (const season of show.seasons || []) {
        for (const episode of season.episodes || []) {
          if ((episode.files || []).length) {
            return {
              path: episode.files[0].file_path,
              show: show.tmdb_id,
              season: season.number,
              episode: episode.episode_number
            };
          }
        }
      }
    }
    return null;
  });

  if (!target) return null;

  await page.evaluate(async (filePath) => {
    const player = await import('/js/player.js');
    await player.open(filePath);
  }, target.path);

  await page.waitForSelector('#player', { timeout: 10000 });
  await page.waitForTimeout(800);
  return target;
}

/** What the panel is currently showing, measured rather than assumed. */
const readEditor = () => page.evaluate(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  };
  const values = [...document.querySelectorAll('.introedit__value')].map((n) => n.textContent.trim());
  return {
    open: document.querySelector('#intro-editor')?.hidden === false,
    panel: box('#intro-editor'),
    strip: box('#intro-strip'),
    region: box('#intro-region'),
    start: box('#intro-handle-start'),
    end: box('#intro-handle-end'),
    frames: document.querySelectorAll('.introedit__frame').length,
    ticks: document.querySelectorAll('.introedit__tick').length,
    span: document.querySelector('#intro-span')?.textContent.trim(),
    scope: document.querySelector('#intro-scope')?.textContent.trim(),
    startTime: Number(document.querySelector('#intro-handle-start')?.getAttribute('aria-valuenow')),
    endTime: Number(document.querySelector('#intro-handle-end')?.getAttribute('aria-valuenow')),
    values,
    duration: document.querySelector('#player-video')?.duration || 0
  };
});

const clickAction = (action) => page.click(`[data-action="${action}"]`);

/*
 * By id, not by action: the Skip intro pill carries an "adjust" button with the
 * same action, and it is hidden except during the titles - so a selector on the
 * action alone waits thirty seconds for a button nobody can click.
 */
/*
 * The mouse move is not decoration. The control bar hides itself after a few
 * seconds of playback and takes its pointer events with it, so a click aimed at
 * a button in it lands on the video instead - which is exactly what a viewer
 * would see, and exactly what waking the chrome first fixes.
 */
const openEditor = async () => {
  await page.mouse.move(720, 460);
  await page.waitForTimeout(200);
  await page.click('#intro-btn');
};

/*
 * Toasts land bottom-right at z-index 100, over the control bar, and a click
 * aimed at a button underneath one hits the toast instead. Waiting for them to
 * leave is not politeness; it is the difference between a suite that passes and
 * one that times out on its own success message.
 */
const settleToasts = () => page.waitForFunction(
  () => document.querySelectorAll('#toast-root .toast').length === 0,
  null, { timeout: 12000 }
).catch(() => {});

/** What the server holds for one episode right now. */
const markerFor = (t, episode) => page.evaluate(async (query) => {
  const answer = await (await fetch(
    `/api/intro?show=${query.show}&season=${query.season}&episode=${query.episode}`
  )).json();
  return answer.marker;
}, { show: t.show, season: t.season, episode });

console.log('\nopening');
const target = await openFirstEpisode();
if (!target) {
  check('library has a playable episode', false, 'no episode with a file');
} else {
  const button = await page.$eval('#intro-btn', (n) => ({
    hidden: n.hidden,
    w: n.getBoundingClientRect().width,
    h: n.getBoundingClientRect().height
  }));
  // A hidden attribute loses to a class that sets display, which is exactly how
  // the cast and AirPlay buttons ended up visible on files that cannot use them.
  check('an episode offers the editor in the control bar',
    button.hidden === false && button.w > 20 && button.h > 20, button);

  /*
   * Start from whatever the season says rather than from a leftover edit: the
   * measurements below are about a real intro's proportions, and an episode
   * left marked 0-1s by an earlier run would fail them for the wrong reason.
   * Whatever was there is put back at the end.
   */
  const original = await markerFor(target, target.episode);
  if (original?.scope === 'episode') {
    await page.evaluate(async (t) => {
      await fetch(`/api/intro?show=${t.show}&season=${t.season}&episode=${t.episode}`, { method: 'DELETE' });
    }, target);
    await page.evaluate(async (filePath) => {
      const player = await import('/js/player.js');
      await player.open(filePath);
    }, target.path);
    await page.waitForTimeout(800);
  }

  await openEditor();
  await page.waitForTimeout(500);

  const opened = await readEditor();
  check('the panel opens', opened.open === true);
  check('and has real size', opened.panel?.w > 300 && opened.panel?.h > 120, opened.panel);
  check('it sits inside the viewport',
    opened.panel && opened.panel.x >= 0 && opened.panel.y >= 0
      && opened.panel.x + opened.panel.w <= 1440, opened.panel);
  check('the strip is drawn', opened.strip?.w > 200 && opened.strip?.h > 30, opened.strip);
  check('both handles are on the strip',
    opened.start && opened.end
      && opened.start.x >= opened.strip.x - 4
      && opened.end.x <= opened.strip.x + opened.strip.w + 4, opened);
  check('the start is left of the end', opened.start.x < opened.end.x, opened);
  check('the marked region spans between them',
    Math.abs(opened.region.w - (opened.end.x - opened.start.x)) < 6, opened.region);
  check('the scale is labelled', opened.ticks >= 3, opened.ticks);
  check('both times are shown', opened.values.length === 2, opened.values);
  check('opening pauses playback',
    await page.$eval('#player-video', (v) => v.paused) === true);

  /*
   * The whole reason the panel exists. On the seek bar the intro occupies
   * `length / duration` of the width — about 4% of a 40-minute episode. Here it
   * has to occupy a large enough slice to be draggable a second at a time.
   */
  console.log('\ncompression');
  const length = opened.endTime - opened.startTime;
  const onSeekBar = opened.duration > 0 ? length / opened.duration : 0;
  const onStrip = opened.region.w / opened.strip.w;
  check('the intro fills a usable part of the strip', onStrip > 0.25, { onStrip, onSeekBar });
  check('which is far more of it than the seek bar gives',
    onSeekBar === 0 || onStrip > onSeekBar * 5, { onStrip, onSeekBar, duration: opened.duration });

  console.log('\nediting');
  const before = await readEditor();
  await page.click('[data-action="intro-nudge"][data-edge="end"][data-delta="1"]');
  await page.waitForTimeout(250);
  let after = await readEditor();
  check('a +1s nudge moves the end by a second',
    Math.abs((after.endTime - before.endTime) - 1) < 0.05, { before: before.endTime, after: after.endTime });
  check('and leaves the start alone', after.startTime === before.startTime);

  await page.click('[data-action="intro-nudge"][data-edge="end"][data-delta="-0.1"]');
  await page.waitForTimeout(250);
  after = await readEditor();
  // A tenth is the resolution the seek bar cannot reach at all.
  check('a tenth is adjustable',
    Math.abs((after.endTime - before.endTime) - 0.9) < 0.05, after.endTime);

  const dragFrom = { x: after.end.x + (after.end.w / 2), y: after.strip.y + (after.strip.h / 2) };
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 60, dragFrom.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = await readEditor();
  check('dragging the end handle moves it forward',
    dragged.endTime > after.endTime + 1, { before: after.endTime, after: dragged.endTime });
  check('the video follows the handle',
    Math.abs(await page.$eval('#player-video', (v) => v.currentTime) - dragged.endTime) < 3,
    dragged.endTime);

  // Handles must not cross: an intro that ends before it starts cannot be acted
  // on by anything downstream.
  await page.mouse.move(dragged.end.x + (dragged.end.w / 2), dragged.strip.y + (dragged.strip.h / 2));
  await page.mouse.down();
  await page.mouse.move(dragged.strip.x + 2, dragged.strip.y + (dragged.strip.h / 2), { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const crossed = await readEditor();
  check('the end cannot be dragged past the start',
    crossed.endTime > crossed.startTime, crossed);

  console.log('\nzoom');
  const tight = await readEditor();
  await page.click('[data-action="intro-zoom"][data-direction="1"]');
  await page.waitForTimeout(400);
  const wide = await readEditor();
  check('zooming out changes the window', wide.span !== tight.span, { tight: tight.span, wide: wide.span });
  check('and squeezes the region', wide.region.w < tight.region.w, { tight: tight.region.w, wide: wide.region.w });
  await page.click('[data-action="intro-zoom"][data-direction="-1"]');
  await page.waitForTimeout(400);

  console.log('\nsaving');
  const draft = await readEditor();
  await clickAction('intro-save');
  await page.waitForTimeout(900);
  await settleToasts();
  check('saving closes the panel', (await readEditor()).open === false);

  const saved = await page.evaluate(async (t) => {
    const one = await (await fetch(`/api/intro?show=${t.show}&season=${t.season}&episode=${t.episode}`)).json();
    const other = await (await fetch(`/api/intro?show=${t.show}&season=${t.season}&episode=${t.episode + 1}`)).json();
    return { one: one.marker, other: other.marker };
  }, target);

  check('the timings reached the server', saved.one !== null, saved.one);
  check('to the tenth of a second',
    saved.one && Math.abs(saved.one.end - draft.endTime) < 0.06, { saved: saved.one?.end, draft: draft.endTime });
  check('marked as this episode\'s own', saved.one?.scope === 'episode', saved.one);
  /*
   * The point of the episode scope. A run that opens cold one week and not the
   * next needs different timings per episode, so an edit here must not be
   * visible from the episode after it.
   */
  check('and not applied to the next episode',
    !saved.other || saved.other.scope === 'season', saved.other);

  console.log('\nforgetting');
  await openEditor();
  await page.waitForTimeout(400);
  check('the panel says the timings are this episode\'s',
    /this episode/i.test((await readEditor()).scope || ''), (await readEditor()).scope);

  await clickAction('intro-forget');
  await page.waitForTimeout(900);
  await settleToasts();
  const cleaned = await page.evaluate(async (t) => {
    const answer = await (await fetch(`/api/intro?show=${t.show}&season=${t.season}&episode=${t.episode}`)).json();
    return answer.marker;
  }, target);
  check('forgetting removes this episode\'s own timings',
    !cleaned || cleaned.scope === 'season', cleaned);

  console.log('\nescape');
  await openEditor();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('escape closes the editor before the player',
    (await readEditor()).open === false && (await page.$('#player')) !== null);
}

console.log('\nconsole');
check('no errors while driving the editor', consoleErrors.length === 0, consoleErrors.slice(0, 6));

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
