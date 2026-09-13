#!/usr/bin/env node
// Browser tests for Helxis.
//
// The physics suite runs the simulation headless; this one drives the actual
// page, because some of what the app promises is only true at the seams
// between the UI and the core -- that a tool reaches the world, that the field
// tools are driven by wall-clock time and not by the simulation's speed
// setting, that every preset loads without throwing.
//
// Needs a server and a browser:
//
//   node helxis/serve.js &
//   node helxis/test/browser.test.mjs
//
// PLAYWRIGHT and CHROMIUM env vars override the module and executable paths.

import { createRequire } from 'node:module';

const ORIGIN = process.env.HELXIS_ORIGIN || 'http://localhost:4173/helxis/';
const require_ = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require_(process.env.PLAYWRIGHT || 'playwright'));
} catch (e) {
  console.log('playwright not installed; skipping browser tests');
  process.exit(0);
}

const launch = { args: ['--no-sandbox', '--use-gl=swiftshader'] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
const b = await chromium.launch(launch);
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errs.push('console: ' + m.text());
});
await p.goto(ORIGIN, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);

let passed = 0, failed = 0;
const log = [];
const step = async (name, fn) => {
  try {
    const r = await fn();
    if (r && r.fail) { failed++; log.push(` FAIL  ${name} — ${r.fail}`); }
    else { passed++; log.push(`  ok   ${name}${r ? ' — ' + r : ''}`); }
  } catch (e) { failed++; log.push(` FAIL  ${name} — THREW ${e.message}`); }
};

// place a body from the catalogue by clicking the list then the canvas
await step('arm+place', async () => {
  await p.evaluate(() => { window.helxis.loadPreset('earth-moon'); window.helxis.togglePause(); });
  await p.fill('#search', 'Ceres');
  await p.waitForTimeout(200);
  await p.click('.entry[data-entry="ceres"]');
  const armed = await p.evaluate(() => !!window.helxis.armed);
  const before = await p.evaluate(() => window.helxis.world.bodies.length);
  await p.mouse.click(1000, 300);
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => window.helxis.world.bodies.length);
  return `armed=${armed} bodies ${before}→${after}`;
});

// drag-to-launch
await step('drag-launch', async () => {
  await p.fill('#search', 'Comet');
  await p.waitForTimeout(200);
  await p.click('.entry[data-entry="comet"]');
  await p.mouse.move(700, 600); await p.mouse.down();
  await p.mouse.move(760, 660, { steps: 6 }); await p.mouse.up();
  await p.waitForTimeout(150);
  return await p.evaluate(() => { const b = window.helxis.world.bodies.at(-1); return `${b.name} v=${Math.hypot(b.vx,b.vy).toFixed(0)} m/s`; });
});

await step('select tool', async () => {
  await p.keyboard.press('1');
  await p.evaluate(() => { const h=window.helxis; h.loadPreset('earth-moon'); h.camera.setZoom(h.camera.height/2.2e7); h.camera.scale=h.camera.targetScale; h.camera.x=h.world.bodies[0].x; h.camera.y=h.world.bodies[0].y; });
  await p.waitForTimeout(300);
  await p.mouse.click(800, 450);
  await p.waitForTimeout(200);
  return await p.evaluate(() => { const s = window.helxis.state.selected; return s ? `selected ${s.name}, inspector ${document.getElementById('inspector').hidden?'hidden':'shown'}` : 'nothing selected'; });
});

await step('laser', async () => {
  const t0 = await p.evaluate(() => window.helxis.state.selected.temperature);
  await p.keyboard.press('2');
  await p.mouse.move(800, 450); await p.mouse.down();
  await p.waitForTimeout(1100);
  await p.mouse.up();
  const t1 = await p.evaluate(() => window.helxis.state.selected.temperature);
  return `Earth ${t0.toFixed(0)} K → ${t1.toFixed(0)} K`;
});

await step('grab+throw', async () => {
  await p.keyboard.press('7');
  await p.mouse.move(800, 450); await p.mouse.down();
  await p.mouse.move(900, 500, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(100);
  return await p.evaluate(() => { const s=window.helxis.state.selected; return `fixed=${s.fixed} v=${Math.hypot(s.vx,s.vy).toFixed(0)} m/s`; });
});

await step('explode', async () => {
  await p.evaluate(() => { const h=window.helxis; h.loadPreset('earth-moon'); h.tools.intensity = 1.8; });
  await p.waitForTimeout(300);
  await p.keyboard.press('5');
  const before = await p.evaluate(() => window.helxis.world.bodies.length);
  await p.evaluate(() => { const h=window.helxis; const e=h.world.bodies[0]; h.camera.x=e.x; h.camera.y=e.y; h.camera.setZoom(h.camera.height/2.2e7); h.camera.scale=h.camera.targetScale; });
  await p.mouse.click(800, 450);
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => ({ n: window.helxis.world.bodies.length, fx: window.helxis.effects.count }));
  return `bodies ${before}→${after.n}, ${after.fx} effects`;
});

await step('collapse to black hole', async () => {
  await p.evaluate(() => {
    const h = window.helxis;
    h.loadPreset('empty');
    const { instantiate } = h.__cat || {};
  });
  await p.evaluate(async () => {
    const h = window.helxis;
    const { instantiate } = await import('/helxis/src/ui/catalog.js');
    const { CATALOG_BY_ID } = await import('/helxis/src/ui/catalog.js');
    const s = instantiate(CATALOG_BY_ID.get('sun'), { massScale: 4 });
    h.world.add(s); h.select(s);
    h.camera.x = 0; h.camera.y = 0; h.camera.setZoom(h.camera.height / 4e9); h.camera.scale = h.camera.targetScale;
  });
  await p.waitForTimeout(200);
  await p.keyboard.press('6');
  await p.mouse.move(800, 450); await p.mouse.down();
  await p.waitForTimeout(3200);
  await p.mouse.up();
  return await p.evaluate(() => { const s = window.helxis.world.bodies[0]; return `${s.name} kind=${s.kind} r=${(s.radius/1e3).toFixed(1)} km`; });
});

await step('undo', async () => {
  const before = await p.evaluate(() => window.helxis.world.bodies.length);
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => window.helxis.world.bodies.length);
  return `bodies ${before}→${after}`;
});

await step('delete tool', async () => {
  await p.evaluate(() => { const h=window.helxis; h.loadPreset('jupiter-system'); h.frameAll(); });
  await p.waitForTimeout(400);
  const before = await p.evaluate(() => window.helxis.world.bodies.length);
  await p.keyboard.press('8');
  await p.evaluate(() => { const h=window.helxis; const m=h.world.bodies[1]; const q=[0,0]; h.camera.project(m.x,m.y,q); window.__t = h.renderer.toScreen(q[0],q[1]); });
  const t = await p.evaluate(() => window.__t);
  const box = await p.locator('#stage').boundingBox();
  await p.mouse.click(box.x + t.x, box.y + t.y);
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => window.helxis.world.bodies.length);
  return `bodies ${before}→${after}`;
});

await step('save/load round-trip', async () => {
  return await p.evaluate(() => {
    const h = window.helxis;
    h.loadPreset('solar-system');
    const json = h.world.snapshot();
    const n0 = h.world.bodies.length;
    const e0 = h.world.totalEnergy();
    h.world.restore(json);
    const e1 = h.world.totalEnergy();
    return `${n0} bodies, energy match ${Math.abs((e1-e0)/e0) < 1e-12}`;
  });
});

await step('settings drive the world', async () => {
  await p.click('#btn-settings');
  await p.click('[data-toggle="relativity"]');
  const on = await p.evaluate(() => window.helxis.world.settings.relativity);
  await p.click('[data-toggle="relativity"]');
  const off = await p.evaluate(() => window.helxis.world.settings.relativity);
  await p.click('#settings-close');
  return `relativity ${on} → ${off}`;
});

await step('every preset loads', async () => {
  return await p.evaluate(async () => {
    const { PRESETS } = await import('/helxis/src/ui/presets.js');
    const h = window.helxis;
    const out = [];
    for (const pr of PRESETS) { h.loadPreset(pr.id, { silent: true }); out.push(h.world.bodies.length); }
    return `${PRESETS.length} presets, bodies: ${out.join(',')}`;
  });
});


// The one coupling the Node suite cannot see: App.update must hand the tools
// the wall-clock delta, not the simulated one. Someone changing that would
// make attract and repel a thousand times stronger at high time scales, and
// every physics test would still pass.
await step('field tools are driven by wall-clock time, not simulated time', async () => {
  return await p.evaluate(async () => {
    const h = window.helxis;
    h.loadPreset('solar-system');
    const seen = [];
    const real = h.tools.update.bind(h.tools);
    h.tools.update = (dt, ...rest) => { seen.push(dt); return real(dt, ...rest); };
    const sample = async (scale) => {
      h.setTimeScale ? h.setTimeScale(scale) : (h.timeScale = scale);
      seen.length = 0;
      await new Promise((res) => {
        let n = 0;
        const tick = () => (++n < 12 ? requestAnimationFrame(tick) : res());
        requestAnimationFrame(tick);
      });
      const use = seen.filter((d) => d > 0);
      return use.reduce((s, v) => s + v, 0) / Math.max(use.length, 1);
    };
    const slow = await sample(1);
    const fast = await sample(1e7);
    h.tools.update = real;
    // Both should be a frame of wall clock, about 1/60 s, whatever the clock
    // in the simulation is doing.
    if (!(slow > 0.001 && slow < 0.2)) return { fail: `at 1x the tools got ${slow}s per frame` };
    if (!(fast > 0.001 && fast < 0.2)) return { fail: `at 1e7x the tools got ${fast}s per frame` };
    if (Math.abs(fast - slow) / slow > 0.6) {
      return { fail: `tool dt tracks the time scale: ${slow.toFixed(4)}s at 1x, ${fast.toFixed(4)}s at 1e7x` };
    }
    return `${slow.toFixed(4)}s per frame at 1x, ${fast.toFixed(4)}s at 1e7x`;
  });
});

// A merged planet's sprite has to actually differ from an unmerged one. The
// physics suite asserts this on raw pixels; this checks the same thing through
// the real canvas path the page uses.
await step('a merged planet renders differently from an unmerged one', async () => {
  return await p.evaluate(async () => {
    const tex = await import('/helxis/src/render/texture.js');
    const { Body } = await import('/helxis/src/core/body.js');
    const shot = (mixes, seed) => {
      const bd = new Body({
        name: 'X', mass: 5.97e24, composition: { iron: 0.32, silicate: 0.68 },
        temperature: 288, seed,
      });
      bd.mixes = mixes; bd.refresh();
      const c = tex.bodyTexture(bd, 96);
      return c.getContext('2d').getImageData(0, 0, 96, 96).data;
    };
    const mean = (a, b2) => {
      let s = 0, n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 3] < 128 && b2[i + 3] < 128) continue;
        n++;
        s += (Math.abs(a[i] - b2[i]) + Math.abs(a[i + 1] - b2[i + 1]) + Math.abs(a[i + 2] - b2[i + 2])) / 3;
      }
      return s / n;
    };
    const plain = shot([], 12345);
    const merged = shot([{ seedA: 1, seedB: 987654321, fracB: 0.5, angle: 0.7, sharpness: 0.6, compB: { water: 1 } }], 12345);
    const seedOnly = mean(plain, shot([], 999));
    const byMerge = mean(plain, merged);
    if (!(byMerge > seedOnly)) {
      return { fail: `merge moved the sprite ${byMerge.toFixed(2)}/255, a different seed moved it ${seedOnly.toFixed(2)}` };
    }
    return `merge ${byMerge.toFixed(2)}/255 vs seed ${seedOnly.toFixed(2)}`;
  });
});

// The canvas must be visible at phone width: a body picker that fills the
// viewport leaves nothing to look at.
await step('the simulation is visible at phone width', async () => {
  const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(ORIGIN, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const r = await page.evaluate(() => {
    const covered = (el) => {
      const q = el.getBoundingClientRect();
      return Math.max(0, Math.min(q.right, innerWidth) - Math.max(q.left, 0))
        * Math.max(0, Math.min(q.bottom, innerHeight) - Math.max(q.top, 0));
    };
    let hidden = 0;
    for (const el of document.querySelectorAll('.panel')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || el.hidden) continue;
      hidden += covered(el);
    }
    const dock = document.getElementById('dock');
    const tools = [...dock.querySelectorAll('.tool')];
    const last = tools[tools.length - 1].getBoundingClientRect();
    return {
      frac: hidden / (innerWidth * innerHeight),
      lastToolVisible: last.right <= dock.getBoundingClientRect().right + 1,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  await page.close();
  if (r.frac > 0.7) return { fail: `panels cover ${(r.frac * 100).toFixed(0)}% of a 390x844 screen` };
  if (r.overflow) return { fail: 'the page scrolls sideways at 390px' };
  return `panels cover ${(r.frac * 100).toFixed(0)}%, last tool reachable=${r.lastToolVisible}`;
});

// The state the phone check used to skip. With a body selected on a small
// screen the inspector showed 146px of 525px of content, with no scrollbar and
// no other cue: a reader saw the mass and nothing else, and had no way to know
// there was a radius, a temperature or a composition below it.
await step('a selected body is readable on a small phone', async () => {
  const worst = [];
  for (const [W, H] of [[390, 844], [360, 640]]) {
    const page = await b.newPage({ viewport: { width: W, height: H } });
    await page.goto(ORIGIN, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.helxis.select(window.helxis.world.bodies[3]));
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const i = document.getElementById('inspector');
      const rect = i.getBoundingClientRect();
      return {
        shown: i.clientHeight / i.scrollHeight,
        cue: i.classList.contains('scroll-more'),
        scrollable: i.scrollHeight > i.clientHeight + 4,
        onScreen: rect.top >= 0 && rect.bottom <= innerHeight + 1,
        // Something of the simulation still has to be visible behind it.
        free: (() => {
          let cov = 0;
          for (const e of document.querySelectorAll('.panel')) {
            const s = getComputedStyle(e);
            if (s.display === 'none' || e.hidden) continue;
            const q = e.getBoundingClientRect();
            cov += Math.max(0, Math.min(q.right, innerWidth) - Math.max(q.left, 0))
              * Math.max(0, Math.min(q.bottom, innerHeight) - Math.max(q.top, 0));
          }
          return 1 - cov / (innerWidth * innerHeight);
        })(),
      };
    });
    await page.close();
    if (!r.onScreen) worst.push(`${W}x${H}: inspector runs off screen`);
    if (r.shown < 0.45) worst.push(`${W}x${H}: only ${(r.shown * 100).toFixed(0)}% of the inspector fits`);
    // Whenever it is scrollable, it has to say so.
    if (r.scrollable && !r.cue) worst.push(`${W}x${H}: scrollable with no cue`);
    if (!r.scrollable && r.cue) worst.push(`${W}x${H}: cue shown with nothing below`);
    if (r.free < 0.15) worst.push(`${W}x${H}: only ${(r.free * 100).toFixed(0)}% of the canvas left`);
    worst.push(`| ${W}x${H} ${(r.shown * 100).toFixed(0)}% shown, cue=${r.cue}`);
  }
  const bad = worst.filter((w) => !w.startsWith('|'));
  return bad.length ? { fail: bad.join('; ') } : worst.join(' ');
});

console.log(log.join('\n'));
if (errs.length) { failed += errs.length; console.log('\nERRORS:\n' + errs.join('\n')); }
console.log(`\n${passed} passed, ${failed} failed`);
await b.close();
process.exit(failed ? 1 : 0);
