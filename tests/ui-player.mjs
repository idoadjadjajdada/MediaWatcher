/**
 * Browser-driven player invariants.
 *
 * Markup-shape assertions have missed five real bugs in this codebase now: a
 * re-entrant innerHTML crash, a zero-width flex card, a modal throwing on
 * item.seasons.map, a nav icon laying out at 0x0, and a dismiss handler that
 * closed the sidebar when you picked a season. All five needed a real browser.
 * This checks computed geometry and live interaction, not structure.
 *
 * Playwright's Chromium may not decode every codec in the library, so the video
 * can fail to load and duration can stay 0. That is fine - the player renders
 * its chrome the moment open() is called. Nothing here waits on playback.
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
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

/**
 * Open the first playable file of a kind. Returns false when the library has
 * nothing of that kind, so a movie-less library skips rather than fails.
 */
async function openFirst(kind) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const located = await page.evaluate(async (want) => {
    const library = await (await fetch('/api/media/library')).json();
    if (want === 'movie') {
      const movie = (library.movies || []).find((m) => (m.files || []).length);
      return movie ? movie.files[0].file_path : null;
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
  await page.waitForTimeout(700);
  return true;
}

console.log('\nsetting buttons');
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
  check('the four popovers are the expected ones',
    buttons.map((b) => b.popover).sort().join(',') === 'picture,speed,subs,sync',
    buttons.map((b) => b.popover));
  check('no setting button collapses',
    buttons.every((b) => b.w >= 40 && b.h >= 40), buttons);
  check('the rate button shows its value',
    /^\s*1\s*×\s*$/.test(await page.$eval('#rate-btn', (n) => n.textContent)));

  const openCounts = [];
  for (const name of ['subs', 'sync', 'speed', 'picture']) {
    await page.click(`[data-action="toggle-popover"][data-popover="${name}"]`);
    await page.waitForTimeout(120);
    openCounts.push(await page.$$eval('.player__pop-panel',
      (nodes) => nodes.filter((n) => !n.hidden).length));
  }
  check('exactly one popover is open at a time',
    openCounts.every((n) => n === 1), openCounts);

  console.log('\npicture');
  // The picture popover is open from the loop above. Drive several input
  // events in a row: a single one would still pass if the handler rebuilt the
  // panel and destroyed the slider being dragged.
  const filterBefore = await page.$eval('#player-video', (v) => getComputedStyle(v).filter);
  for (const value of ['80', '60', '40']) {
    await page.$eval('#brightness', (input, v) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.waitForTimeout(70);
  }
  const filterAfter = await page.$eval('#player-video', (v) => getComputedStyle(v).filter);

  check('brightness changes the video filter', filterBefore !== filterAfter,
    { before: filterBefore, after: filterAfter });
  check('the slider survives a multi-step drag',
    (await page.$eval('#brightness', (i) => i.value)) === '40');
  check('the readout follows the slider',
    (await page.$eval('#brightness-value', (n) => n.textContent)) === '40%');
  check('the control bar is not dimmed with the picture',
    (await page.$eval('.player__controls', (b) => getComputedStyle(b).filter)) === 'none');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);

  console.log('\npage scroll');
  // The player is fixed, so without a lock the page behind keeps its scroll
  // height and paints a scrollbar that moves nothing you can see.
  const scroll = await page.evaluate(() => ({
    locked: document.documentElement.classList.contains('is-player-open'),
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    bodyOverflow: getComputedStyle(document.body).overflow
  }));
  check('the page is scroll-locked behind the player', scroll.locked === true);
  check('no scrollbar can appear on either scrolling box',
    scroll.htmlOverflow === 'hidden' && scroll.bodyOverflow === 'hidden', scroll);

  console.log('\nepisode sidebar');
  const arrow = await page.$eval('#ep-arrow', (el) => ({
    hidden: el.hidden, ...el.getBoundingClientRect().toJSON()
  }));
  check('the arrow is visible on an episode', arrow.hidden === false);
  check('the arrow has real size', arrow.width > 0 && arrow.height > 0, arrow);
  check('the arrow sits on the right edge', Math.abs(arrow.right - 1440) < 2, { right: arrow.right });
  check('the arrow is vertically centred',
    Math.abs((arrow.top + arrow.height / 2) - 450) < 40, { top: arrow.top });

  await page.click('#ep-arrow');
  await page.waitForTimeout(300);

  const panel = await page.$eval('#ep-panel', (el) => ({
    hidden: el.hidden, ...el.getBoundingClientRect().toJSON()
  }));
  check('the sidebar opens', panel.hidden === false);
  check('the sidebar has real width', panel.width > 200, panel);
  // Inset from the edge rather than flush, so it can round on all four corners.
  check('the sidebar is inset from the right edge',
    panel.right < 1440 && (1440 - panel.right) <= 24, { gap: 1440 - panel.right });
  check('the sidebar is rounded',
    (await page.$eval('#ep-panel', (el) => parseFloat(getComputedStyle(el).borderRadius))) >= 8);

  const rows = await page.$$eval('.player__ep-row', (nodes) => nodes.map((n) => ({
    current: n.classList.contains('is-current'),
    w: n.getBoundingClientRect().width,
    h: n.getBoundingClientRect().height
  })));
  check('the sidebar lists episodes', rows.length > 0, { rows: rows.length });
  check('exactly one row is marked current',
    rows.filter((r) => r.current).length === 1, rows.filter((r) => r.current).length);
  check('no episode row collapses',
    rows.every((r) => r.w > 0 && r.h >= 44), rows.slice(0, 4));

  const art = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.player__ep-still img')];
    return {
      rows: document.querySelectorAll('.player__ep-row').length,
      images: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      oversized: imgs.filter((i) => /\/t\/p\/(w[5-9]\d\d|w1\d\d\d|original)\//.test(i.src)).length,
      descriptions: document.querySelectorAll('.player__ep-desc').length,
      numbers: document.querySelectorAll('.player__ep-num').length
    };
  });
  check('episode rows carry cover art', art.images > 0, art);
  check('every still actually loads', art.images === art.loaded, art);
  check('stills are requested at thumbnail size, not backdrop size',
    art.oversized === 0, { oversized: art.oversized });
  check('episode rows carry a description', art.descriptions > 0, art);
  check('every row shows its episode number', art.numbers === art.rows, art);

  // The panel is inset from the bottom so the control bar stays usable. If it
  // covered the buttons, fullscreen and every setting would be unreachable
  // while the sidebar is open.
  const reachable = await page.evaluate(() => {
    const hit = (selector) => {
      const el = document.querySelector(selector);
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(top) || el === top;
    };
    return {
      fullscreen: hit('[data-action="toggle-fullscreen"]'),
      picture: hit('[data-popover="picture"]'),
      play: hit('[data-action="toggle-play"]')
    };
  });
  check('the control bar stays reachable with the sidebar open',
    reachable.fullscreen && reachable.picture && reachable.play, reachable);

  const tabs = await page.$$eval('.player__ep-tab', (nodes) => nodes.map((n) => ({
    active: n.classList.contains('is-active'), w: n.getBoundingClientRect().width
  })));
  check('season tabs render', tabs.length > 0, { tabs: tabs.length });
  check('exactly one tab is active', tabs.filter((t) => t.active).length === 1);
  check('no tab collapses', tabs.every((t) => t.w >= 40), tabs.slice(0, 4));

  // The strip overflows, and a mouse only emits deltaY - without the wheel
  // handler it looks scrollable and refuses to move.
  const strip = await page.evaluate(() => {
    const t = document.getElementById('ep-tabs');
    return { overflows: t.scrollWidth > t.clientWidth, before: t.scrollLeft };
  });
  if (strip.overflows) {
    const tabsBox = await (await page.$('#ep-tabs')).boundingBox();
    await page.mouse.move(tabsBox.x + tabsBox.width / 2, tabsBox.y + tabsBox.height / 2);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.getElementById('ep-tabs').scrollLeft);
    check('a wheel scrolls the season strip sideways', after > strip.before,
      { before: strip.before, after });
    await page.evaluate(() => { document.getElementById('ep-tabs').scrollLeft = 0; });
  }

  if (tabs.length > 1) {
    // Picking a season rebuilds the tab strip, detaching the clicked button.
    // A bubble-phase dismiss handler would read that orphan as an outside
    // click and close the panel. This is that regression.
    const other = tabs.findIndex((t) => !t.active);
    await page.click(`.player__ep-tab >> nth=${other}`);
    await page.waitForTimeout(280);
    check('picking a season leaves the sidebar open',
      (await page.$eval('#ep-panel', (el) => el.hidden)) === false);
    check('another season marks nothing as current',
      (await page.$$eval('.player__ep-row',
        (n) => n.filter((x) => x.classList.contains('is-current')).length)) === 0);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(220);
  check('Escape closes the sidebar', await page.$eval('#ep-panel', (el) => el.hidden));
  check('Escape does not also close the player', (await page.$('#player')) !== null);

  await page.click('#ep-arrow');
  await page.waitForTimeout(260);
  await page.mouse.click(200, 450);
  await page.waitForTimeout(260);
  check('an outside click closes the sidebar', await page.$eval('#ep-panel', (el) => el.hidden));

  console.log('\nseek preview');
  const box = await (await page.$('#scrub')).boundingBox();

  /**
   * Pin playback position deterministically.
   *
   * The band's direction depends on where --fill is, and two earlier attempts
   * at this were flaky for opposite reasons: pinning a value while the video
   * still played let tick() overwrite it, and reading the live value meant the
   * test depended on how far a 4K stream happened to have buffered (it can sit
   * at 0 for seven seconds, which makes "hover behind playback" impossible).
   *
   * Pausing first stops tick() firing at all - it runs on timeupdate, and the
   * pause event fires it one last time - so a value written after the settle
   * stays put.
   */
  await page.evaluate(() => document.getElementById('player-video').pause());
  await page.waitForTimeout(500);
  const PINNED_FILL = 40;
  const pinFill = async () => {
    await page.evaluate((value) => {
      document.getElementById('scrub').style.setProperty('--fill', value.toFixed(2));
      document.getElementById('seek').style.setProperty('--fill', value.toFixed(2));
    }, PINNED_FILL);
    return page.evaluate(
      () => Number(document.getElementById('scrub').style.getPropertyValue('--fill')) || 0);
  };
  check('playback position can be pinned for the band checks',
    (await pinFill()) === PINNED_FILL);

  const readPreview = () => page.evaluate(() => {
    const node = document.getElementById('scrub');
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    return {
      previewing: node.classList.contains('is-previewing'),
      behind: node.classList.contains('is-behind'),
      preview: Number(node.style.getPropertyValue('--preview')),
      trackLeft: nr.left, trackWidth: nr.width,
      ballCentre: rect('preview-ball').left + rect('preview-ball').width / 2,
      ballOpacity: Number(getComputedStyle(document.getElementById('preview-ball')).opacity),
      bandWidth: rect('preview-band').width,
      cardLeft: rect('preview-card').left,
      cardRight: rect('preview-card').right,
      cardWidth: rect('preview-card').width,
      frameW: rect('preview-frame').width,
      frameH: rect('preview-frame').height
    };
  });

  // Halfway between playback and the right-hand end: always ahead of --fill.
  const fillAhead = await pinFill();
  const aheadAt = (fillAhead + (100 - fillAhead) / 2) / 100;
  await page.mouse.move(box.x + box.width * aheadAt, box.y + box.height / 2);
  await page.waitForTimeout(180);
  let p = await readPreview();

  check('hovering marks the scrub as previewing', p.previewing === true);
  check('--preview follows the cursor',
    Math.abs(p.preview - aheadAt * 100) < 2, { preview: p.preview, expected: aheadAt * 100 });
  check('the ball is visible', p.ballOpacity > 0.5, p.ballOpacity);

  // The band paints above the range input, so the input's native thumb ends up
  // underneath it and gets its right half swallowed. The scrub bar draws its
  // own knob above the band instead.
  const knob = await page.evaluate(() => {
    const z = (id) => Number(getComputedStyle(document.getElementById(id)).zIndex);
    const k = document.getElementById('seek-knob').getBoundingClientRect();
    return { knobZ: z('seek-knob'), bandZ: z('preview-band'), w: k.width, h: k.height };
  });
  check('the position knob paints above the landing band',
    knob.knobZ > knob.bandZ, knob);
  check('the knob has real size', knob.w > 0 && knob.h > 0, knob);
  check('the ball sits under the cursor',
    Math.abs(p.ballCentre - (p.trackLeft + p.trackWidth * aheadAt)) < 6, { ballCentre: p.ballCentre });
  check('the band renders ahead of playback',
    p.bandWidth > 0 && p.behind === false,
    { bandWidth: p.bandWidth, behind: p.behind, fill: fillAhead, hoveredAt: aheadAt * 100 });
  check('the card has real size', p.cardWidth > 100, p.cardWidth);
  // Thumbnails may still be generating, so assert the box holds its shape
  // rather than asserting a picture is present.
  check('the frame box holds its size with or without a picture',
    p.frameW > 100 && p.frameH > 50, { w: p.frameW, h: p.frameH });

  // Frames arrive asynchronously through an Image probe. Give a generated file
  // a moment, then report whether one actually landed - without failing, since
  // a cold library legitimately has none yet.
  await page.waitForTimeout(1500);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.waitForTimeout(900);
  const painted = await page.$eval('#preview-frame',
    (n) => getComputedStyle(n).backgroundImage);
  const meta = await page.evaluate(async () => {
    const player = await import('/js/player.js');
    return player.thumbState ? player.thumbState() : null;
  }).catch(() => null);
  console.log(`  [info] frame painted: ${painted !== 'none'}${meta ? ` (${meta.count}/${meta.total} generated)` : ''}`);
  check('a painted frame comes from the thumbs endpoint',
    painted === 'none' || painted.includes('/api/thumbs'), painted.slice(0, 80));

  // Halfway between the left-hand end and playback: always behind --fill.
  const fillBehind = await pinFill();
  const behindAt = (fillBehind / 2) / 100;
  await page.mouse.move(box.x + box.width * behindAt, box.y + box.height / 2);
  await page.waitForTimeout(180);
  p = await readPreview();
  check('scrubbing back flags the band as behind', p.behind === true,
    { fill: fillBehind, hoveredAt: behindAt * 100, preview: p.preview });
  check('the band renders behind playback too', p.bandWidth > 0,
    { bandWidth: p.bandWidth, fill: fillBehind, hoveredAt: behindAt * 100 });

  // Both extremes: the card must clamp rather than overhang the track.
  for (const [label, fraction] of [['left', 0.005], ['right', 0.995]]) {
    await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
    await page.waitForTimeout(160);
    p = await readPreview();
    check(`the card does not overhang the ${label} edge`,
      p.cardLeft >= p.trackLeft - 1 && p.cardRight <= p.trackLeft + p.trackWidth + 1,
      { cardLeft: p.cardLeft - p.trackLeft, cardRight: p.cardRight - p.trackLeft, track: p.trackWidth });
  }

  await page.mouse.move(box.x + box.width / 2, box.y - 220);
  await page.waitForTimeout(220);
  check('leaving the track clears the preview', (await readPreview()).previewing === false);

  const overflow = await page.evaluate(() => ({
    scrollW: document.body.scrollWidth, innerW: window.innerWidth
  }));
  check('the player causes no horizontal overflow', overflow.scrollW <= overflow.innerW, overflow);
}

console.log('\nmovie');
if (!(await openFirst('movie'))) {
  console.log('  [skip] no movie in the library');
} else {
  check('a movie has no episode arrow', (await page.$eval('#ep-arrow', (el) => el.hidden)) === true);
}

console.log('\nconsole');
check('no errors while driving the player', consoleErrors.length === 0, consoleErrors.slice(0, 6));

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
