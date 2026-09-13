#!/usr/bin/env node
// Physics tests for Helxis.
//
// These are not unit tests of the code's shape; they check the simulation
// against quantities that were measured or derived somewhere else. If a change
// breaks one of them, the physics has changed, whatever the code looks like.
//
//   node helxis/test/physics.test.mjs

import {
  G, C, AU, YEAR, DAY, M_SUN, M_EARTH, M_MOON, R_EARTH,
} from '../src/core/const.js';
import { Body } from '../src/core/body.js';
import { World } from '../src/core/world.js';
import { Quadtree } from '../src/core/quadtree.js';
import { compactRadius } from '../src/core/body.js';
import { resolveCollision, sweptContactDisp } from '../src/core/collide.js';
import {
  orbitalElements, stateFromElements, circularOrbitState,
} from '../src/core/kepler.js';
import { loadPreset, PRESETS } from '../src/ui/presets.js';
import { CATALOG, instantiate } from '../src/ui/catalog.js';
import { radiusFromMass, bulkDensity, compressionFactor } from '../src/core/materials.js';
import { texturePixels } from '../src/render/texture.js';
import { EMPTY, matKey, matIndex } from '../src/core/cells.js';
import { ToolController } from '../src/ui/tools.js';
import { applyToWorld, defaultSettings } from '../src/ui/settings.js';

let passed = 0, failed = 0;
const results = [];

function check(name, actual, expected, tolerance, unit = '') {
  const err = expected === 0 ? Math.abs(actual) : Math.abs((actual - expected) / expected);
  const ok = err <= tolerance;
  ok ? passed++ : failed++;
  results.push(
    `${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(46)} ` +
    `${fmt(actual)}${unit} vs ${fmt(expected)}${unit}  (${(err * 100).toPrecision(2)}% off, allow ${(tolerance * 100).toPrecision(2)}%)`
  );
  return ok;
}

function assert(name, condition, detail = '') {
  condition ? passed++ : failed++;
  results.push(`${condition ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
  return condition;
}

function fmt(v) {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(4);
  return v.toPrecision(6);
}

function section(title) { results.push(`\n${title}`); }

// ───────────────────────────────────────────────────────────── bodies ──────

section('Derived properties of real bodies');
{
  const e = instantiate(CATALOG.find((c) => c.id === 'earth'));
  check('Earth surface gravity', e.surfaceGravity, 9.80665, 0.01, ' m/s²');
  check('Earth escape velocity', e.escapeVelocity, 11186, 0.01, ' m/s');
  check('Earth mean density', e.density, 5513, 0.01, ' kg/m³');

  const j = instantiate(CATALOG.find((c) => c.id === 'jupiter'));
  // GM/r² at the 1-bar equatorial radius. The 24.79 usually quoted is the
  // *effective* gravity, which subtracts the centrifugal term from a 9.9-hour
  // rotation and accounts for oblateness; neither is modelled here.
  check('Jupiter gravitational acceleration', j.surfaceGravity, 25.92, 0.01, ' m/s²');
  check('Jupiter mean density', j.density, 1326, 0.01, ' kg/m³');

  const s = instantiate(CATALOG.find((c) => c.id === 'sun'));
  check('Sun effective temperature', s.temperature, 5772, 0.01, ' K');
  check('Sun luminosity', s.luminosity, 3.828e26, 0.02, ' W');

  const bh = instantiate(CATALOG.find((c) => c.id === 'black-hole'));
  check('10 M☉ Schwarzschild radius', bh.radius, 29532, 0.01, ' m');

  // The mass-radius model has to work without a measured radius to lean on.
  const modelled = radiusFromMass(M_EARTH, { iron: 0.32, silicate: 0.68 });
  check('modelled Earth radius (no measured value)', modelled, R_EARTH, 0.03, ' m');
}

// ───────────────────────────────────────────────────────────── gravity ─────

section('Barnes-Hut against a direct N² sum');
{
  const bodies = [{ x: 0, y: 0, vx: 0, vy: 0, mass: M_SUN, radius: 7e8 }];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 1500; i++) {
    const a = rnd() * 2e12 + 1e10, t = rnd() * 6.283;
    bodies.push({ x: Math.cos(t) * a, y: Math.sin(t) * a, vx: 0, vy: 0, mass: 1e22 * rnd(), radius: 1e6 });
  }
  const qt = new Quadtree();
  for (const theta of [0.2, 0.5, 0.8]) {
    qt.build(bodies);
    const out = [0, 0];
    let worst = 0;
    for (let i = 1; i < 100; i++) {
      qt.accelerate(i, G, theta, 0, out);
      let ax = 0, ay = 0;
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const dx = bodies[j].x - bodies[i].x, dy = bodies[j].y - bodies[i].y;
        const d2 = dx * dx + dy * dy, inv = 1 / (d2 * Math.sqrt(d2));
        ax += G * bodies[j].mass * dx * inv;
        ay += G * bodies[j].mass * dy * inv;
      }
      worst = Math.max(worst, Math.hypot(out[0] - ax, out[1] - ay) / Math.hypot(ax, ay));
    }
    const limit = theta <= 0.2 ? 1e-6 : theta <= 0.5 ? 1e-5 : 1e-4;
    assert(`θ=${theta} worst-case acceleration error`, worst < limit, `${worst.toExponential(2)} < ${limit.toExponential(0)}`);
  }
}

// ───────────────────────────────────────────────────────── integrator ──────

section('Integrator');
{
  // Fourth order is not a decoration. Plain Verlet at the same step produces a
  // spurious perihelion advance three orders of magnitude larger than the
  // relativistic signal it would be used to measure.
  const precess = (integrator) => {
    const w = new World({ collisions: false, thermal: false, tidalDisruption: false, integrator, eta: 0.012, frameBudgetMs: 1e9, maxSubsteps: 1e9 });
    w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN, fixed: true }));
    const st = stateFromElements(G * M_SUN, 5.790905e10, 0.20563, 0, 0, 3.3011e23);
    const b = w.add(new Body({ name: 'M', mass: 3.3011e23, ...st }));
    const mu = G * (M_SUN + 3.3011e23);
    const a0 = orbitalElements(b.x, b.y, b.vx, b.vy, mu).argP;
    for (let t = 0; t < 100 * YEAR;) t += w.advance(Math.min(YEAR / 4, 100 * YEAR - t));
    let d = orbitalElements(b.x, b.y, b.vx, b.vy, mu).argP - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d * 206264.806);
  };
  const v2 = precess('verlet');
  const v4 = precess('yoshida4');
  assert('fourth order beats second by >100x on an eccentric orbit',
    v4 * 100 < v2, `verlet ${v2.toFixed(0)}″ vs yoshida4 ${v4.toFixed(2)}″ per century`);
}
{
  const w = new World({ collisions: false, thermal: false, tidalDisruption: false, frameBudgetMs: 1e9 });
  const sun = w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN }));
  const st = circularOrbitState(sun, AU, 0, false, M_EARTH);
  const earth = w.add(new Body({ name: 'Earth', mass: M_EARTH, ...st }));
  const e0 = w.totalEnergy();
  for (let t = 0; t < 10 * YEAR;) t += w.advance(Math.min(YEAR / 12, 10 * YEAR - t));
  const e1 = w.totalEnergy();
  assert('energy drift over 10 simulated years', Math.abs((e1 - e0) / e0) < 1e-11,
    `${Math.abs((e1 - e0) / e0).toExponential(2)}`);
  const el = orbitalElements(earth.x - sun.x, earth.y - sun.y, earth.vx - sun.vx, earth.vy - sun.vy, G * (M_SUN + M_EARTH));
  check('semi-major axis after 10 years', el.a, AU, 1e-6, ' m');
  assert('a circular orbit stays circular', el.e < 1e-5, `e = ${el.e.toExponential(2)}`);
}

section('Regressions found in review');
{
  // A collision leaves every acceleration stale. If the next substep is chosen
  // without recomputing them, a body a merge just created has a = 0, the step
  // chooser sees nothing to resolve, and the whole remaining frame is taken as
  // one ballistic drift — which threw the giant-impact disc a light-year clear
  // of the planet at high time scales.
  // Run at the wall-clock budget the app actually uses, since that is the
  // configuration the bug appeared in.
  const w = new World({ frameBudgetMs: 11 });
  loadPreset(w, 'giant-impact');
  const megayearPerSecond = 3.15576e13 / 60;
  let worstFrame = 0;
  for (let i = 0; i < 240; i++) {
    const t0 = Date.now();
    w.advance(megayearPerSecond);
    worstFrame = Math.max(worstFrame, Date.now() - t0);
  }
  const planet = w.bodies.slice().sort((a, b) => b.mass - a.mass)[0];
  let furthest = 0;
  for (const b of w.bodies) furthest = Math.max(furthest, Math.hypot(b.x - planet.x, b.y - planet.y));
  assert('debris stays bound at 1 Myr/s', furthest < planet.radius * 200,
    `furthest ${(furthest / planet.radius).toFixed(1)} planetary radii`);
  // And the frame budget has to actually bound the frame, including through a
  // cascade of disruptions inside a single step.
  assert('no frame runs away during the cascade', worstFrame < 400, `worst frame ${worstFrame} ms`);
}
{
  // Two bodies inside one another must not see a 1/d² singularity. Point-mass
  // gravity at one metre of separation gave 6.7e11 m/s², which turned a touching
  // pair into seven hundred fragments at a quarter of light speed in one frame.
  const w = new World({ frameBudgetMs: 1e9 });
  const R = 8.87e5;
  w.add(new Body({ name: 'A', mass: 1e22, radius: R, composition: { silicate: 1 } }));
  w.add(new Body({ name: 'B', mass: 1e22, radius: R, composition: { silicate: 1 }, x: 1 }));
  w.computeAccelerations();
  const a = Math.hypot(w.bodies[0].ax, w.bodies[0].ay);
  // Newton's shell theorem: the interior field falls linearly to zero.
  assert('overlapping bodies feel the interior field, not a singularity', a < 1,
    `${a.toExponential(2)} m/s² at 1 m separation`);

  const w2 = new World({ frameBudgetMs: 200 });
  w2.add(new Body({ name: 'A', mass: 1e22, radius: R, composition: { silicate: 1 } }));
  w2.add(new Body({ name: 'B', mass: 1e22, radius: R, composition: { silicate: 1 }, x: 1 }));
  let vmax = 0;
  for (let i = 0; i < 40; i++) w2.advance(YEAR / 40);
  for (const b of w2.bodies) vmax = Math.max(vmax, Math.hypot(b.vx, b.vy));
  assert('and a year of it produces no explosion', w2.bodies.length <= 2 && vmax < 1e5,
    `${w2.bodies.length} bodies, fastest ${vmax.toExponential(2)} m/s`);
}
{
  // The opening criterion measures distance to a node's centre of mass, so a
  // node containing the querent can be accepted once theta passes 1/sqrt(2) —
  // and the body is then pulled by its own mass.
  const qt = new Quadtree();
  const pair = [
    { x: 0, y: 0, vx: 0, vy: 0, mass: 1e24, radius: 1 },
    { x: 1e9, y: 0, vx: 0, vy: 0, mass: 2e24, radius: 1 },
  ];
  const out = [0, 0, 0];
  const exact = (G * 2e24) / 1e18;
  let worst = 0;
  for (const theta of [0.5, 0.75, 1.0]) {
    qt.build(pair);
    qt.accelerate(0, G, theta, 0, out);
    worst = Math.max(worst, Math.abs(Math.hypot(out[0], out[1]) / exact - 1));
  }
  assert('no body attracts itself at any theta', worst < 1e-12, `worst error ${worst.toExponential(2)}`);
}
{
  // Degenerate matter cannot be run through scalings calibrated on rock.
  const ns = () => new Body({
    name: 'NS', kind: 'ns', mass: 1.6 * M_SUN,
    radius: compactRadius('ns', 1.6 * M_SUN), composition: { neutronium: 1 },
  });
  const earth = new Body({ name: 'E', mass: M_EARTH, composition: { iron: 0.32, silicate: 0.68 } });
  const a = ns();
  earth.x = a.radius + earth.radius;
  earth.vx = -1e6;
  const r = resolveCollision(a, earth, {});
  assert('a neutron star that eats a planet stays a neutron star', a.radius < 2e4 && a.kind === 'ns',
    `${(a.radius / 1e3).toFixed(1)} km, rho ${a.density.toExponential(2)}`);

  const p = ns(), q = ns();
  q.x = p.radius + q.radius;
  q.vx = -1e8;
  const r2 = resolveCollision(p, q, {});
  assert('two neutron stars merge rather than bouncing at 0.17c',
    r2.regime === 'compact-merger' || r2.regime === 'accretion', String(r2.regime));

  const big1 = new Body({ name: 'A', kind: 'ns', mass: 2.0 * M_SUN, radius: compactRadius('ns', 2.0 * M_SUN), composition: { neutronium: 1 } });
  const big2 = new Body({ name: 'B', kind: 'ns', mass: 2.0 * M_SUN, radius: compactRadius('ns', 2.0 * M_SUN), composition: { neutronium: 1 }, x: 3e4, vx: -1e7 });
  resolveCollision(big1, big2, {});
  assert('and a merger past the TOV limit collapses to a black hole', big1.kind === 'bh',
    `${(big1.mass / M_SUN).toFixed(2)} M☉ -> ${big1.kind}`);
}
{
  // Insolation has to reach everything derived from temperature, not just the
  // number: the sprite cache is keyed on what refresh() computes.
  const b = new Body({ name: 'Rock', mass: 1e21, composition: { silicate: 0.7, ice: 0.3 }, temperature: 120 });
  const key0 = b.textureKey;
  b.insolation = 3000;
  // Radiative relaxation for a body this size runs to ~10^11 s; a couple of
  // hundred megaseconds would move it by a quarter of a kelvin.
  for (let i = 0; i < 400; i++) b.thermalStep(1e9);
  assert('radiative heating warms the body', b.temperature > 250,
    `120 K -> ${b.temperature.toFixed(0)} K`);
  assert('and invalidates its sprite', b.textureKey !== key0,
    `key ${key0 === b.textureKey ? 'unchanged' : 'updated'}`);

  // And the key must keep changing once the crater list has hit its cap.
  const c = new Body({ name: 'T', mass: M_EARTH, radius: R_EARTH, composition: { iron: 0.32, silicate: 0.68 } });
  const rng = () => 0.5;
  for (let i = 0; i < 60; i++) c.addCrater(Math.cos(i), Math.sin(i), 1e18, 3e4, 2e4, rng);
  const keyAtCap = c.textureKey;
  c.addCrater(1, 0, 1e18, 3e4, 2e4, rng);
  assert('a new crater past the cap still invalidates the sprite', c.textureKey !== keyAtCap);
}
{
  // A pile of bodies in mutual contact has to come apart, not resolve one pair
  // per step and leave the rest interpenetrating.
  //
  // Two earlier versions of this test were wrong in opposite directions. The
  // first spaced the bodies 188 km apart and closed them 72 km, so nothing ever
  // touched and "no overlapping pairs" passed for the wrong reason entirely.
  // The second closed them at 260 m/s — nearly five times their mutual escape
  // velocity — which shatters rather than bounces, and the cascade filled the
  // body cap. Contact happens between about 0.2 and 1 escape velocities, which
  // for these is 11 to 57 m/s.
  const w = new World({ frameBudgetMs: 300 });
  const N = 6;
  const ring = 43e3 * 2.4;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    w.add(new Body({
      name: `R${i}`, kind: 'asteroid', mass: 1e18,
      composition: { silicate: 0.8, carbon: 0.2 },
      x: Math.cos(th) * ring, y: Math.sin(th) * ring,
      vx: -Math.cos(th) * 25, vy: -Math.sin(th) * 25,
    }));
  }
  let collisions = 0, mostInOneStep = 0, stepsWithMany = 0;
  w.on('collision', () => { collisions++; });
  for (let i = 0; i < 300; i++) {
    const before = collisions;
    w.advance(20);
    const inStep = collisions - before;
    if (inStep > mostInOneStep) mostInOneStep = inStep;
    if (inStep >= 2) stepsWithMany++;
  }
  assert('the cluster actually collides', collisions > 10, `${collisions} collisions`);
  assert('and many contacts are resolved within a single step',
    mostInOneStep >= 3, `most in one step: ${mostInOneStep}, steps with 2+: ${stepsWithMany}`);

  let overlapping = 0;
  for (let i = 0; i < w.bodies.length; i++) {
    for (let j = i + 1; j < w.bodies.length; j++) {
      const a = w.bodies[i], b = w.bodies[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.radius + b.radius) * 0.98) overlapping++;
    }
  }
  assert('and it leaves no interpenetrating pairs', overlapping === 0,
    `${overlapping} overlapping pairs among ${w.bodies.length} bodies`);
}
{
  // Fragments must not be created inside one another: a swarm born overlapping
  // is shattered again by the next contact pass, and eighteen asteroids became
  // twelve hundred fragments in seven thousand interpenetrating pairs.
  let worst = 0, events = 0;
  for (let k = 0; k < 200; k++) {
    const mt = M_EARTH * Math.pow(10, (k % 7) - 3);
    const mp = mt * Math.pow(10, -(k % 5) * 0.5);
    const t = new Body({ name: 'T', mass: mt, composition: { iron: 0.32, silicate: 0.68 } });
    const probe = new Body({ mass: mp, composition: { iron: 0.3, silicate: 0.7 } });
    const rs = t.radius + probe.radius;
    const bp = (k % 11) / 11;
    const p = new Body({
      name: 'P', mass: mp, composition: { iron: 0.3, silicate: 0.7 },
      x: Math.sqrt(Math.max(0, 1 - bp * bp)) * rs * 0.999, y: bp * rs * 0.999,
      vx: -(50 * Math.pow(10, (k % 9) * 0.45)),
    });
    const out = resolveCollision(t, p, {});
    const made = out.added || [];
    if (made.length < 2) continue;
    events++;
    // Against each other AND against whatever survived. Comparing only the new
    // pieces to each other is how this test passed while 391 of 624 collisions
    // in a wider sweep were spawning ejecta inside the body it came off: the
    // ring layouts spaced the pieces but nothing spaced them from the target.
    const removed = new Set(out.removed || []);
    const all = [t, p].filter((b) => !removed.has(b)).concat(made);
    let ov = 0;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i], b = all[j];
        // Two bodies that both survived intact are the collision pair itself,
        // still in contact; the world's contact solver owns separating those.
        if (!made.includes(a) && !made.includes(b)) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.radius + b.radius) * 0.98) ov++;
      }
    }
    if (ov > worst) worst = ov;
  }
  assert('no collision product is born inside another, or inside a survivor',
    worst === 0, `${events} multi-body outcomes, worst ${worst} overlapping pairs`);
}
{
  // A wider sweep of the same thing: mass ratio, impact parameter and speed
  // together, checking every conserved quantity at once. This is the grid that
  // found the ejecta overlaps, so it stays.
  const comp = { iron: 0.32, silicate: 0.68 };
  let worstM = 0, worstP = 0, worstC = 0, overlaps = 0, nonFinite = 0, n = 0;
  for (const gamma of [1, 0.3, 0.1, 0.03, 0.01, 0.003]) {
    for (const bp of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 0.98]) {
      for (const v of [0.3, 0.6, 0.9, 1.05, 1.2, 1.5, 2, 3, 5, 8, 15, 30, 60]) {
        const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
        const probe = new Body({ mass: M_EARTH * gamma, composition: comp });
        const rs = t.radius + probe.radius;
        const vEsc = Math.sqrt((2 * G * M_EARTH * (1 + gamma)) / rs);
        const p = new Body({
          name: 'P', mass: M_EARTH * gamma, composition: comp,
          x: Math.sqrt(Math.max(0, 1 - bp * bp)) * rs * 0.999,
          y: bp * rs * 0.999, vx: -v * vEsc,
        });
        const m0 = t.mass + p.mass;
        const p0 = [t.mass * t.vx + p.mass * p.vx, t.mass * t.vy + p.mass * p.vy];
        const c0 = [(t.mass * t.x + p.mass * p.x) / m0, (t.mass * t.y + p.mass * p.y) / m0];
        const out = resolveCollision(t, p, { allowBounce: true });
        n++;
        const removed = new Set(out.removed || []);
        const live = [t, p].filter((b) => !removed.has(b)).concat(out.added || []);
        const m1 = live.reduce((a, b) => a + b.mass, 0);
        const p1 = [live.reduce((a, b) => a + b.mass * b.vx, 0),
          live.reduce((a, b) => a + b.mass * b.vy, 0)];
        const c1 = [live.reduce((a, b) => a + b.mass * b.x, 0) / m1,
          live.reduce((a, b) => a + b.mass * b.y, 0) / m1];
        if (live.some((b) => ![b.x, b.y, b.vx, b.vy, b.mass, b.radius].every(isFinite))) nonFinite++;
        worstM = Math.max(worstM, Math.abs(m1 - m0) / m0);
        worstP = Math.max(worstP, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
          / (Math.abs(M_EARTH * gamma * v * vEsc) || 1));
        worstC = Math.max(worstC, Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / rs);
        const made = out.added || [];
        for (let i = 0; i < live.length; i++) {
          for (let j = i + 1; j < live.length; j++) {
            const a = live[i], b = live[j];
            if (!made.includes(a) && !made.includes(b)) continue;
            if (Math.hypot(a.x - b.x, a.y - b.y) < (a.radius + b.radius) * 0.98) overlaps++;
          }
        }
      }
    }
  }
  assert(`mass survives all ${n} collisions`, worstM < 1e-12, worstM.toExponential(2));
  assert('so does momentum', worstP < 1e-12, worstP.toExponential(2));
  assert('and the centre of mass does not jump', worstC < 1e-12,
    `${worstC.toExponential(2)} contact radii`);
  assert('nothing comes out non-finite', nonFinite === 0, `${nonFinite} cases`);
  assert('and nothing is born interpenetrating', overlaps === 0, `${overlaps} pairs`);
}
{
  // Cratering means a small projectile excavating a large target. An equal-mass
  // impactor cannot crater anything, and calling it that sent the pair through
  // doCratering, which deletes the projectile and sprays ejecta from a surface
  // that is half of what just hit it. The grazing branch of the classifier had
  // a mass-ratio guard; the head-on branch did not.
  const comp = { iron: 0.32, silicate: 0.68 };
  const regimeFor = (gamma, v, bp) => {
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: M_EARTH * gamma, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * M_EARTH * (1 + gamma)) / rs);
    const p = new Body({
      name: 'P', mass: M_EARTH * gamma, composition: comp,
      x: Math.sqrt(Math.max(0, 1 - bp * bp)) * rs * 0.999,
      y: bp * rs * 0.999, vx: -v * vEsc,
    });
    return resolveCollision(t, p, { allowBounce: true }).regime;
  };
  let bad = null;
  for (const gamma of [1, 0.7, 0.4, 0.2, 0.11, 0.05, 0.01, 0.0011]) {
    for (const v of [1.05, 1.2, 1.5, 2, 3, 5, 10, 30]) {
      for (const bp of [0, 0.2, 0.4, 0.6, 0.8]) {
        if (regimeFor(gamma, v, bp) === 'cratering') bad = `gamma=${gamma} v=${v} b=${bp}`;
      }
    }
  }
  // LS12 separate partial accretion from erosion by whether the largest remnant
  // is heavier than the target was. Checking the label against the products is
  // the only way to catch the boundary moving: with the old `ratio < 1` split,
  // an equal-mass pair at 1.1 escape velocities was called erosion while the
  // target had grown 89%, and no test noticed because they all read the label.
  const outcome = (gamma, v, bp) => {
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: M_EARTH * gamma, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * M_EARTH * (1 + gamma)) / rs);
    const p = new Body({
      name: 'P', mass: M_EARTH * gamma, composition: comp,
      x: Math.sqrt(Math.max(0, 1 - bp * bp)) * rs * 0.999,
      y: bp * rs * 0.999, vx: -v * vEsc,
    });
    const r = resolveCollision(t, p, { allowBounce: true });
    const removed = new Set(r.removed || []);
    const live = [t, p].filter((b) => !removed.has(b)).concat(r.added || []);
    const lr = live.reduce((m, b) => Math.max(m, b.mass), 0);
    return { regime: r.regime, lr };
  };
  let mislabelled = null, sawAccretion = 0, sawErosion = 0;
  for (const gamma of [1, 0.5, 0.2, 0.05]) {
    for (const v of [1.2, 2, 3, 4, 5, 6, 8]) {
      for (const bp of [0, 0.3, 0.6]) {
        const o = outcome(gamma, v, bp);
        if (o.regime === 'merge' || o.regime === 'graze-and-merge' || o.regime === 'cratering') {
          sawAccretion++;
          // Accretion means the largest remnant is at least the target it hit.
          if (o.lr < M_EARTH * 0.999) {
            mislabelled = `${o.regime} at gamma=${gamma} v=${v} b=${bp} left ${(o.lr / M_EARTH).toFixed(3)} Me`;
          }
        } else if (o.regime === 'erosion') {
          sawErosion++;
          if (o.lr > M_EARTH * 1.001) {
            mislabelled = `erosion at gamma=${gamma} v=${v} b=${bp} GREW the target to ${(o.lr / M_EARTH).toFixed(3)} Me`;
          }
        }
      }
    }
  }
  assert('accretion accretes and erosion erodes, by the products not the label',
    mislabelled === null, mislabelled || `${sawAccretion} accreting, ${sawErosion} eroding, all consistent`);
  assert('and the sweep actually reached both sides of the boundary',
    sawAccretion > 4 && sawErosion > 0, `${sawAccretion} accreting, ${sawErosion} eroding`);

  assert('nothing above a thousandth of the target mass is called cratering',
    bad === null, bad || 'none in 320 combinations');
  assert('a small fast projectile still craters',
    regimeFor(1e-6, 5, 0) === 'cratering', regimeFor(1e-6, 5, 0));
  assert('and a small slow one does too',
    regimeFor(1e-6, 0.5, 0) === 'cratering', regimeFor(1e-6, 0.5, 0));
}
{
  // The step must not depend on how large a body is, only on where it is.
  const stepsPerOrbit = (radius) => {
    const w = new World({ collisions: false, thermal: false, tidalDisruption: false, frameBudgetMs: 1e9 });
    const sun = w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN }));
    const st = circularOrbitState(sun, AU, 0, false, 1e12);
    w.add(new Body({ name: 'x', mass: 1e12, radius, ...st }));
    w.computeAccelerations();
    return YEAR / w.chooseDt(YEAR);
  };
  const big = stepsPerOrbit(6.371e6);
  const small = stepsPerOrbit(0.5);
  assert('a pebble does not slow the whole scene down', Math.abs(big - small) < 1,
    `${big.toFixed(0)} vs ${small.toFixed(0)} steps per orbit`);
}
{
  // A body too light for degeneracy to be relevant must not become a "white
  // dwarf" larger than it started.
  assert('the degenerate radius for an Earth mass exceeds Earth',
    compactRadius('wd', M_EARTH) > R_EARTH,
    `${(compactRadius('wd', M_EARTH) / 1e3).toExponential(2)} km`);
}
{
  // Zero is a legitimate position and velocity; zero mass is not.
  const ok = new Body({ name: 'origin', mass: 1e20, x: 0, y: 0, vx: 0, vy: 0 });
  assert('a body at the origin, at rest, stays there', ok.x === 0 && ok.vx === 0);
  let rejected = 0;
  for (const bad of [{ mass: 0 }, { mass: -1 }, { mass: NaN }, { mass: 1e20, radius: 0 }, { mass: 1e20, radius: -5 }]) {
    try { new Body({ name: 'bad', ...bad }); } catch (e) { rejected++; }
  }
  assert('mass and radius are validated, not silently defaulted', rejected === 5, `${rejected}/5 rejected`);
}

section('Regressions found in the second review');
{
  // Barnes-Hut evaluates each body against summarised clusters independently,
  // so its forces are not exactly pairwise antisymmetric and the system picks
  // up a spurious net acceleration. Unprojected, that put 4.6 mm/s on the solar
  // system's barycentre over twenty years, and 2e-2 relative momentum error at
  // a wide opening angle.
  for (const theta of [0.3, 0.5, 0.8]) {
    const w = new World({ collisions: false, thermal: false, tidalDisruption: false, frameBudgetMs: 1e9, maxSubsteps: 1e9, theta });
    loadPreset(w, 'solar-system');
    const bc0 = w.barycenter();
    let scale = 0;
    for (const b of w.bodies) scale += b.mass * Math.hypot(b.vx, b.vy);
    for (let t = 0; t < 20 * YEAR;) t += w.advance(Math.min(YEAR / 12, 20 * YEAR - t));
    const bc1 = w.barycenter();
    const dP = Math.hypot(bc1.vx - bc0.vx, bc1.vy - bc0.vy) * bc1.mass;
    assert(`momentum holds over 20 years at theta=${theta}`, dP / scale < 1e-12,
      `|dP|/sum(m|v|) = ${(dP / scale).toExponential(2)}`);
  }
}
{
  // Every comparison against NaN is false, so `t < 0 || t > 1` accepted one as
  // a valid contact time. A single non-finite coordinate then propagated into
  // rolled-back positions and out of the frame loop as an exception.
  assert('a NaN position is not a contact',
    sweptContactDisp(
      { x0: 0, y0: 0, x: 0, y: 0, radius: 1e6 },
      { x0: NaN, y0: 0, x: NaN, y: 0, radius: 1e6 }
    ) === null);

  const w = new World({ frameBudgetMs: 200 });
  const sun = w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN }));
  const st = circularOrbitState(sun, AU, 0, false, M_EARTH);
  w.add(new Body({ name: 'Earth', mass: M_EARTH, ...st }));
  const rogue = w.add(new Body({ name: 'Rogue', mass: 1e20, x: 2 * AU, y: 0, vx: 0, vy: 1e4 }));
  rogue.vx = NaN;
  let threw = null;
  try { for (let i = 0; i < 20; i++) w.advance(DAY); } catch (e) { threw = e.message; }
  assert('and a NaN body does not take the simulation down', threw === null, String(threw));
  assert('it is removed instead', !w.bodies.includes(rogue) && w.nonFiniteRemoved > 0,
    `${w.bodies.length} bodies left, ${w.nonFiniteRemoved || 0} culled`);
  for (const b of w.bodies) {
    assert(`${b.name} survived finite`, isFinite(b.x) && isFinite(b.vx));
  }
}
{
  // Shedding a circumplanetary disc must not move the pair's centre of mass:
  // placing bodies on a ring while leaving the remnant at the centre teleports
  // mass outward by a few planetary radii.
  const w = new World({ frameBudgetMs: 1e9 });
  loadPreset(w, 'giant-impact');
  let com0 = null;
  w.on('collision', () => { if (!com0) com0 = true; });
  const before = w.barycenter();
  let regime = null;
  w.on('collision', (r) => { if (!regime) regime = r.regime; });
  for (let t = 0; t < 80000 && !regime;) t += w.advance(30);
  const after = w.barycenter();
  // Compare against the planetary radius, which is the scale the error had.
  const planet = w.bodies.slice().sort((a, b) => b.mass - a.mass)[0];
  const shift = Math.hypot(after.x - before.x, after.y - before.y);
  assert('the centre of mass does not jump when a disc is shed',
    shift < planet.radius * 0.05,
    `${regime}, shifted ${(shift / planet.radius).toExponential(2)} planetary radii`);
}
{
  // The mass-radius model has to work across composition, not just for rock.
  const cases = [
    ['Mercury', 3.3011e23, 2.4397e6, { iron: 0.70, silicate: 0.30 }],
    ['Earth', 5.97217e24, 6.371e6, { iron: 0.323, silicate: 0.6765, water: 0.0005 }],
    ['Uranus', 8.6810e25, 2.5362e7, { hydrogen: 0.18, helium: 0.14, ice: 0.60, ammonia: 0.05, methane: 0.03 }],
    ['Neptune', 1.02413e26, 2.4622e7, { hydrogen: 0.19, helium: 0.13, ice: 0.60, ammonia: 0.05, methane: 0.03 }],
    ['Jupiter', 1.89813e27, 6.9911e7, { hydrogen: 0.71, helium: 0.24, silicate: 0.04, ice: 0.01 }],
    ['Saturn', 5.6834e26, 5.8232e7, { hydrogen: 0.73, helium: 0.25, silicate: 0.02 }],
    ['Europa', 4.799844e22, 1.5608e6, { iron: 0.11, silicate: 0.81, ice: 0.08 }],
  ];
  for (const [name, m, r, comp] of cases) {
    check(`${name} radius from mass and composition`, radiusFromMass(m, comp), r, 0.08, ' m');
  }
}

section('Regressions found in the third review');
{
  // Merge history is what the textures are made of. Leaving `mixes` out of the
  // merged body's options meant every merge silently erased every earlier one,
  // so a body could only remember the last thing that hit it.
  let planet = new Body({
    name: 'P', mass: M_EARTH, composition: { iron: 0.32, silicate: 0.68 }, temperature: 300,
  });
  const counts = [];
  for (const comp of [{ ice: 1 }, { iron: 1 }, { carbon: 1 }]) {
    const m = 0.05 * M_EARTH;
    const imp = new Body({
      name: 'I', mass: m, composition: comp, temperature: 300,
      x: (planet.radius + new Body({ mass: m, composition: comp }).radius) * 0.999,
      vx: -4000,
    });
    const r = resolveCollision(planet, imp, {});
    // The merged body, not whatever happens to be first: a classifier change
    // that turns this into cratering puts ejecta at index 0, and reading
    // `.mixes` off that threw a TypeError that took the whole suite down
    // instead of failing one assertion.
    const merged = (r.added || []).find((b) => b.mass > planet.mass * 0.5);
    if (!merged) {
      assert('each impact merges rather than doing something else',
        false, `regime ${r.regime}, ${(r.added || []).length} products`);
      break;
    }
    planet = merged;
    counts.push(planet.mixes.length);
  }
  assert('every merge is remembered, not just the last',
    counts.join(',') === '1,2,3', `mixes after each merge: ${counts.join(', ')}`);
}
{
  // An evolved star must not be forced onto the main-sequence relation: the red
  // giant came out at 2 L☉ and 1044 K instead of ~600 L☉ and 4300 K.
  const rg = instantiate(CATALOG.find((c) => c.id === 'red-giant'));
  check('red giant effective temperature', rg.temperature, 4300, 0.001, ' K');
  check('red giant luminosity', rg.luminosity / 3.828e26, 596, 0.02, ' L☉');
  const sun = instantiate(CATALOG.find((c) => c.id === 'sun'));
  check('and the main sequence is untouched', sun.temperature, 5772, 0.001, ' K');
}
{
  // No catalogue entry may be denser than the material it is made of.
  // Compare each entry against what its own composition and mass imply. A
  // blanket ceiling would be wrong in both directions: an iron world really is
  // denser than iron grains, a brown dwarf is denser still, and a volatile-rich
  // super-Earth compresses several times more than rock does. This catches an
  // entry whose quoted mass and radius disagree with what it is made of — which
  // is how an M-type asteroid ended up at twice the density of solid iron and a
  // rubble pile denser than basalt.
  // Only an impossibly *high* density is a bug. Low is ordinary: real small
  // bodies are porous — a comet is around 500 kg/m³ and a rubble pile 1200,
  // both well under the grain density of what they are made of — and Helxis
  // does not model void space. Nothing may exceed what its own materials allow,
  // though, and small bodies barely self-compress, so their grain density is
  // very nearly the ceiling. That is what caught an M-type asteroid quoted at
  // twice the density of solid iron, and a rubble pile denser than basalt.
  const bad = [];
  for (const entry of CATALOG) {
    const b = instantiate(entry);
    if (b.isCompact || b.kind === 'bh' || b.kind === 'star') continue;
    // Past about five Jupiter masses the interior is electron-degenerate and
    // the compression fit stops meaning anything — a brown dwarf really is
    // eighty times denser than its grain density.
    if (b.mass > 5 * 1.89813e27) continue;
    const ceiling = bulkDensity(b.composition) * compressionFactor(b.mass, b.composition) * 1.4;
    if (b.density > ceiling) {
      bad.push(`${entry.id}: ${b.density.toFixed(0)} kg/m³, above the ${ceiling.toFixed(0)} its composition allows`);
    }
  }
  assert('no catalogue body is denser than its materials allow', bad.length === 0, bad.join('; '));
}
{
  // A neutron-star merger past the TOV limit has to collapse. A 20% radiative
  // efficiency — a surface-accretion figure, not a merger's — took away enough
  // mass that a 1.5 + 1.6 pair landed under the limit and stayed a neutron star.
  const mk = (m, x, vx) => new Body({
    name: 'NS', kind: 'ns', mass: m * M_SUN, radius: compactRadius('ns', m * M_SUN),
    composition: { neutronium: 1 }, x, vx,
  });
  const a = mk(1.5, 0, 0);
  const b = mk(1.6, 2.2e4, -1e7);
  const m0 = a.mass + b.mass;
  const result = resolveCollision(a, b, {});
  const gone = new Set(result.removed || []);
  const survivor = [a, b].find((x) => !gone.has(x));
  assert('a 1.5 + 1.6 M☉ merger collapses to a black hole', survivor.kind === 'bh',
    `${(survivor.mass / M_SUN).toFixed(3)} M☉, kind ${survivor.kind}`);
  assert('and radiates under one percent of the rest mass',
    (m0 - survivor.mass) / m0 < 0.01,
    `${(((m0 - survivor.mass) / m0) * 100).toFixed(2)}%`);
}
{
  // A crater a few tens of kilometres across is an ordinary event and has to be
  // recorded; the old floor discarded anything under 76 km on an Earth.
  const e = new Body({
    name: 'E', mass: M_EARTH, radius: R_EARTH, composition: { iron: 0.32, silicate: 0.68 },
  });
  const rng = () => 0.5;
  const m = 3000 * (4 / 3) * Math.PI * Math.pow(2500, 3);   // a 5 km impactor
  e.addCrater(1, 0, m, 2500, 2e4, rng);
  assert('a 5 km impactor leaves a recorded crater', e.craters.length === 1,
    e.craters.length ? `${(e.craters[0].size * e.radius / 1e3).toFixed(0)} km` : 'not recorded');
}
{
  // A blackbody at 1 AU sits at 278.6 K — a number from the solar constant and
  // nothing in this codebase. The equilibrium test elsewhere compares the code
  // against its own formula, which only shows the relaxation converges.
  const w = new World({ collisions: false, tidalDisruption: false, frameBudgetMs: 1e9 });
  w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN, fixed: true }));
  const rock = w.add(new Body({
    name: 'Rock', mass: 1e21, composition: { carbon: 1 },   // albedo 0.04
    temperature: 10, x: AU, y: 0, fixed: true,
  }));
  for (let i = 0; i < 60; i++) w.advance(1000 * YEAR);
  // (1 - 0.04)^0.25 = 0.9899 of the zero-albedo value.
  check('a near-black body at 1 AU sits where the textbook says',
    rock.temperature, 278.6 * 0.9899, 0.01, ' K');
}

section('Kepler round-trip');
{
  const mu = G * M_SUN;
  const s = stateFromElements(mu, 1.00000011 * AU, 0.0167, 0, 0);
  const el = orbitalElements(s.x, s.y, s.vx, s.vy, mu);
  check('eccentricity round-trip', el.e, 0.0167, 1e-9);
  // The sidereal year, 365.256363 days. It came out at 0.99989 yr against the
  // older solar mass this used to carry; with the IAU nominal value it lands on
  // the measured one.
  check('orbital period from elements', el.period, 365.256363 * DAY, 5e-4, ' s');
  check('Earth perihelion speed', Math.hypot(s.vx, s.vy), 30290, 1e-3, ' m/s');
}

section('Relativistic perihelion precession');
{
  // Mercury: a = 0.387 AU, e = 0.2056. General relativity predicts 42.98″ per
  // century; the Newtonian run measures the numerical noise floor.
  // eta is tightened here because this is a precision measurement, not a
  // gameplay setting: resolving a 43-arcsecond-per-century signal needs the
  // numerical floor an order of magnitude below it.
  const run = (relativity) => {
    const w = new World({ collisions: false, thermal: false, tidalDisruption: false, relativity, eta: 0.006, frameBudgetMs: 1e9, maxSubsteps: 1e9 });
    const sun = w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN, fixed: true }));
    const s = stateFromElements(G * M_SUN, 5.790905e10, 0.205630, 0, 0, 3.3011e23);
    const m = w.add(new Body({ name: 'Mercury', mass: 3.3011e23, ...s }));
    const mu = G * (M_SUN + 3.3011e23);
    const a0 = orbitalElements(m.x, m.y, m.vx, m.vy, mu).argP;
    for (let t = 0; t < 100 * YEAR;) t += w.advance(Math.min(YEAR / 4, 100 * YEAR - t));
    let d = orbitalElements(m.x, m.y, m.vx, m.vy, mu).argP - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d * 206264.806;
  };
  const newtonian = run(false);
  assert('Newtonian noise floor is below the signal', Math.abs(newtonian) < 1,
    `${newtonian.toFixed(3)}″/century vs the 42.98″ being measured`);
  check('relativistic advance', run(true) - newtonian, 42.98, 0.02, '″/century');
}

section('Figure-eight choreography');
{
  const w = new World({ collisions: false, thermal: false, tidalDisruption: false, theta: 0, frameBudgetMs: 1e9 });
  loadPreset(w, 'figure-eight');
  const start = w.bodies.map((b) => ({ x: b.x, y: b.y }));
  const T = 6.32591398 * Math.sqrt((AU * AU * AU) / (G * M_SUN));
  for (let t = 0; t < T;) t += w.advance(Math.min(T / 500, T - t));
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    worst = Math.max(worst, Math.hypot(w.bodies[i].x - start[i].x, w.bodies[i].y - start[i].y) / AU);
  }
  assert('all three return to their start after one period', worst < 1e-3, `${worst.toExponential(2)} AU`);
}

// ─────────────────────────────────────────────────────────── collisions ────

section('Collision conservation, every regime');
{
  const cases = [
    ['merge (slow head-on)', M_EARTH, M_MOON, 5000, 0],
    ['graze-and-merge', M_EARTH, 0.13 * M_EARTH, 9800, 0.7],
    ['hit-and-run', M_EARTH, 0.2 * M_EARTH, 30000, 0.95],
    ['cratering', M_EARTH, 1e16, 20000, 0.2],
    ['cratering with ejecta', M_EARTH, 4e21, 90000, 0.2],
    ['erosion', M_EARTH, 0.3 * M_EARTH, 40000, 0],
    ['supercatastrophic', M_EARTH, 0.5 * M_EARTH, 120000, 0.1],
    ['bounce (small strong bodies)', 1e18, 4e17, 30, 0.3],
    ['relativistic-speed impact', M_EARTH, M_MOON, 3e7, 0.1],
  ];
  const seen = new Set();
  for (const [label, mt, mp, v, bp] of cases) {
    const t = new Body({ name: 'T', mass: mt, composition: { iron: 0.32, silicate: 0.68 }, temperature: 300 });
    const rsum = t.radius + new Body({ mass: mp, composition: { iron: 0.3, silicate: 0.7 } }).radius;
    const p = new Body({
      name: 'P', mass: mp, composition: { iron: 0.3, silicate: 0.7 }, temperature: 300,
      x: Math.sqrt(Math.max(0, 1 - bp * bp)) * rsum * 0.999, y: bp * rsum * 0.999, vx: -v, vy: 0,
    });
    const m0 = t.mass + p.mass;
    const p0x = t.mass * t.vx + p.mass * p.vx, p0y = t.mass * t.vy + p.mass * p.vy;
    const scale = Math.max(Math.abs(p0x), mp * v);
    const c0x = (t.x * t.mass + p.x * p.mass) / m0;
    const c0y = (t.y * t.mass + p.y * p.mass) / m0;

    const r = resolveCollision(t, p, {});
    const out = [];
    for (const b of [t, p]) if (!(r.removed || []).includes(b)) out.push(b);
    for (const b of (r.added || [])) out.push(b);

    let m1 = 0, px = 0, py = 0, vmax = 0, cx = 0, cy = 0;
    for (const b of out) {
      m1 += b.mass; px += b.mass * b.vx; py += b.mass * b.vy;
      cx += b.mass * b.x; cy += b.mass * b.y;
      vmax = Math.max(vmax, Math.hypot(b.vx, b.vy));
    }
    seen.add(r.regime);
    assert(`${label}: mass conserved`, Math.abs(m1 - m0) / m0 < 1e-12, `${r.regime}, ${out.length} bodies`);
    assert(`${label}: momentum conserved`, Math.hypot(px - p0x, py - p0y) / scale < 1e-12, r.regime);
    assert(`${label}: nothing goes superluminal`, vmax < C, `${(vmax / C).toExponential(2)} c`);
    // Position, not just momentum. Spawning debris on a ring while leaving the
    // survivor where it was moves the centre of mass without touching the
    // momentum at all — which is exactly why it survived two reviews.
    assert(`${label}: centre of mass does not jump`,
      Math.hypot(cx / m1 - c0x, cy / m1 - c0y) / rsum < 1e-9,
      `${(Math.hypot(cx / m1 - c0x, cy / m1 - c0y) / rsum).toExponential(2)} contact radii`);
    // And nothing may be created already inside something else.
    let born = 0;
    const made = r.added || [];
    for (let i = 0; i < made.length; i++) {
      for (let j = i + 1; j < made.length; j++) {
        const a = made[i], b = made[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.radius + b.radius) * 0.98) born++;
      }
    }
    assert(`${label}: nothing is born overlapping`, born === 0, `${born} pairs, ${made.length} created`);
  }
  assert('every outcome regime is reachable', seen.size >= 6, [...seen].join(', '));
}

section('Swept contact catches a tunnelling impactor');
{
  const w = new World({ frameBudgetMs: 1e9 });
  const target = w.add(new Body({ name: 'Target', mass: M_EARTH, composition: { iron: 0.32, silicate: 0.68 } }));
  // Closing at 1000 km/s from 10^9 m away: one step at this rate crosses the
  // target entirely, so only a swept test can catch it.
  w.add(new Body({
    name: 'Bullet', mass: 1e18, composition: { iron: 0.9, nickel: 0.1 },
    x: 1e9, y: 0, vx: -1e6, vy: 0,
  }));
  let hit = false;
  w.on('collision', () => { hit = true; });
  for (let i = 0; i < 400 && !hit; i++) w.advance(5);
  assert('a 1000 km/s impactor is not missed', hit);
}

section('Giant impact reproduces the lunar iron depletion');
{
  const w = new World({ frameBudgetMs: 1e9 });
  loadPreset(w, 'giant-impact');
  const m0 = w.bodies.reduce((s, b) => s + b.mass, 0);
  let regime = null;
  w.on('collision', (r) => { if (!regime) regime = r.regime; });
  for (let t = 0; t < 80000 && !regime;) t += w.advance(30);
  const sorted = w.bodies.slice().sort((a, b) => b.mass - a.mass);
  const disc = sorted.slice(1).reduce((s, b) => s + b.mass, 0);

  assert('outcome is a graze-and-merge', regime === 'graze-and-merge', String(regime));
  assert('disc is 0.5–4 lunar masses', disc / M_MOON > 0.5 && disc / M_MOON < 4,
    `${(disc / M_MOON).toFixed(2)} M☾`);
  const discIron = sorted[1] ? (sorted[1].composition.iron || 0) : 1;
  const planetIron = sorted[0].composition.iron || 0;
  assert('disc is iron-poor next to the planet', discIron < planetIron * 0.25,
    `${(discIron * 100).toFixed(1)}% vs ${(planetIron * 100).toFixed(1)}%`);
  const m1 = w.bodies.reduce((s, b) => s + b.mass, 0);
  assert('mass conserved through the event', Math.abs(m1 - m0) / m0 < 1e-12);
}

// ────────────────────────────────────────────────────────────── thermal ────

section('Thermal equilibrium');
{
  // An airless grey body at 1 AU settles at T = (S(1-A)/4σ)^¼. With the albedo
  // this composition gives, that is a specific number, and nothing in the code
  // writes it down — it comes out of absorbed flux against emitted flux.
  const w = new World({ collisions: false, tidalDisruption: false, frameBudgetMs: 1e9 });
  // Pin both: this is a test of the thermal model, and an orbiting rock would
  // force the integrator down to a ninety-thousand-second step, so sixty
  // thousand years of cooling would never fit inside the substep ceiling.
  // Pinning also holds the separation at exactly 1 AU, which is the point.
  const sun = w.add(new Body({ name: 'Sun', kind: 'star', mass: M_SUN, fixed: true }));
  const rock = w.add(new Body({
    name: 'Rock', mass: 1e21, composition: { silicate: 1 },
    temperature: 10, x: AU, y: 0, fixed: true,
  }));
  // The radiative relaxation time for a rock this size is a few thousand years.
  for (let i = 0; i < 60; i++) w.advance(1000 * YEAR);
  const S = 3.828e26 / (4 * Math.PI * AU * AU);
  const expected = Math.pow((S * (1 - rock.albedo)) / (4 * 5.670374419e-8), 0.25);
  check('airless rock at 1 AU reaches equilibrium', rock.temperature, expected, 0.005, ' K');

  // And it must not overshoot on the way: a body starting hot has to fall to
  // the same number from above.
  const hot = w.add(new Body({
    name: 'Hot rock', mass: 1e21, composition: { silicate: 1 },
    temperature: 4000, x: AU, y: 0, fixed: true,
  }));
  let peak = 0;
  for (let i = 0; i < 60; i++) { w.advance(1000 * YEAR); peak = Math.max(peak, hot.temperature - expected); }
  check('and reaches the same value from above', hot.temperature, expected, 0.005, ' K');
  assert('cooling never undershoots', hot.temperature > expected * 0.99,
    `settled at ${hot.temperature.toFixed(1)} K`);
  assert('and it is in the right ballpark for the Earth', rock.temperature > 260 && rock.temperature < 290,
    `${rock.temperature.toFixed(1)} K`);
}

section('Latent heat is spent before the temperature moves on');
{
  const b = new Body({ name: 'Iron', mass: 1e18, composition: { iron: 1 }, temperature: 1000 });
  const cp = b.specificHeat;
  // Exactly enough to reach the melting point.
  b.addHeat((1811 - 1000) * b.mass * cp);
  check('warms to the melting point', b.temperature, 1811, 0.02, ' K');
  const before = b.differentiation;
  // A tenth of the latent heat of fusion: the temperature must not move.
  b.addHeat(0.1 * b.mass * 2.47e5);
  assert('holds at the melting point while melting', Math.abs(b.temperature - 1811) < 1,
    `${b.temperature.toFixed(1)} K`);
  assert('and melting drives differentiation', b.differentiation > before,
    `${before.toFixed(3)} → ${b.differentiation.toFixed(3)}`);
}

// ──────────────────────────────────────────────────────────── presets ──────

section('Presets');
{
  for (const preset of PRESETS) {
    const w = new World({ frameBudgetMs: 1e9 });
    let err = null;
    try {
      loadPreset(w, preset.id);
      w.advance(DAY);
    } catch (e) { err = e.message; }
    assert(`${preset.name} builds and steps`, err === null, err || `${w.bodies.length} bodies`);
    if (!err) {
      const bad = w.bodies.find((b) => !isFinite(b.x) || !isFinite(b.y) || !isFinite(b.vx) || !(b.mass > 0));
      assert(`${preset.name} stays finite`, !bad, bad ? `${bad.name} is NaN` : '');
    }
  }

  const w = new World({ collisions: false, thermal: false, tidalDisruption: false, frameBudgetMs: 1e9 });
  loadPreset(w, 'solar-system');
  const sun = w.bodies.find((b) => b.name === 'Sun');
  const expect = { Mercury: 0.2408, Venus: 0.6152, Earth: 1.0000, Mars: 1.8808, Jupiter: 11.862, Saturn: 29.457, Uranus: 84.02, Neptune: 164.79 };
  for (const [name, years] of Object.entries(expect)) {
    const b = w.bodies.find((x) => x.name === name);
    const el = orbitalElements(b.x - sun.x, b.y - sun.y, b.vx - sun.vx, b.vy - sun.vy, G * (sun.mass + b.mass));
    check(`${name} orbital period`, el.period / YEAR, years, 0.002, ' yr');
  }
}

section('The whole catalogue instantiates');
{
  let bad = 0;
  for (const entry of CATALOG) {
    const b = instantiate(entry);
    if (!(b.radius > 0) || !(b.mass > 0) || !isFinite(b.density) || !b.surfaceComposition) {
      bad++;
      results.push(` FAIL  ${entry.id} produced an unusable body`);
    }
  }
  assert(`all ${CATALOG.length} catalogue entries produce a usable body`, bad === 0);
}

section('A merge is visible in the sprite it produces');
{
  // The claim the whole app rests on: a body's texture reflects how it mixed.
  // Pass 5 measured that it did not — the merge record was a colour lerp
  // applied before the elevation shading, the ocean and the frost, all of
  // which then ran over it, and the entire merge history moved the sprite less
  // than re-rolling the random seed did. So the seed is the yardstick here: a
  // merge that changes the picture by less than a different seed does has not
  // changed the picture.
  const mixOf = (compB, fracB, sharpness) => [{
    seedA: 1, seedB: 987654321, fracB, angle: 0.7, sharpness, compB,
  }];
  const sprite = (mixes, seed) => {
    const b = new Body({
      name: 'X', mass: M_EARTH, composition: { iron: 0.32, silicate: 0.68 },
      temperature: 288, seed,
    });
    b.mixes = mixes;
    b.refresh();
    return texturePixels(b, 96);
  };
  // Two numbers per comparison: the mean over the whole disc, and the mean over
  // the most-changed sixth of it. A projectile worth a tenth of the mass should
  // not repaint the planet, so the local figure is the one that has to clear
  // the bar for a partial-coverage merge.
  const diff = (a, b) => {
    const d = [];
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 128 && b[i + 3] < 128) continue;
      d.push((Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
        + Math.abs(a[i + 2] - b[i + 2])) / 3);
    }
    d.sort((x, y) => y - x);
    const top = d.slice(0, Math.max(1, Math.round(d.length * 0.15)));
    return {
      mean: d.reduce((s, v) => s + v, 0) / d.length,
      local: top.reduce((s, v) => s + v, 0) / top.length,
    };
  };

  const plain = sprite([], 12345);
  const floor = diff(plain, sprite([], 999));
  assert('a different seed is a real change, so it is a fair yardstick',
    floor.mean > 3, `${floor.mean.toFixed(2)}/255 per channel`);

  const iron = diff(plain, sprite(mixOf({ iron: 1 }, 0.5, 0.6), 12345));
  assert('an iron half-merge outweighs a change of seed',
    iron.mean > floor.mean && iron.local > floor.local,
    `merge ${iron.mean.toFixed(2)}/${iron.local.toFixed(2)} vs seed ${floor.mean.toFixed(2)}/${floor.local.toFixed(2)}`);

  // Iron and silicate are within fifteen units of each other in every channel,
  // so this one cannot be carried by colour: it is the terrain and the scarp.
  const ice = diff(plain, sprite(mixOf({ water: 1 }, 0.5, 0.6), 12345));
  assert('and an icy one is larger still, because the material differs more',
    ice.mean > iron.mean, `ice ${ice.mean.toFixed(2)} vs iron ${iron.mean.toFixed(2)}`);

  // A tenth of the mass covers a tenth of the face: the disc-wide mean should
  // stay small while the region it touched is unmistakable.
  const small = diff(plain, sprite(mixOf({ silicate: 0.7, iron: 0.05, carbon: 0.25 }, 0.115, 0.5), 12345));
  assert('a small impactor marks its own region without repainting the world',
    small.local > floor.local && small.mean < iron.mean,
    `local ${small.local.toFixed(2)} vs seed ${floor.local.toFixed(2)}, disc mean ${small.mean.toFixed(2)}`);

  // Two merges identical in every way except the impactor's terrain seed. The
  // mask, and so the scarp, is driven by angle/fracB/sharpness and the body's
  // own seed, and the colour comes from compB -- all identical here. Any
  // difference at all is the impactor's own height field, which is the part of
  // "the impactor brings its own ground" that the colour lerp and the scarp
  // would otherwise cover for.
  const terrainOnly = diff(
    sprite([{ seedA: 1, seedB: 111111, fracB: 0.5, angle: 0.7, sharpness: 0.6, compB: { iron: 1 } }], 12345),
    sprite([{ seedA: 1, seedB: 999999, fracB: 0.5, angle: 0.7, sharpness: 0.6, compB: { iron: 1 } }], 12345),
  );
  assert('the impactor brings its own terrain, not just its own colour',
    terrainOnly.local > 8, `${terrainOnly.mean.toFixed(2)}/${terrainOnly.local.toFixed(2)} from the terrain seed alone`);

  // A violent merge is the case that used to fail this. Widening the mask's
  // transition band with the stirring — which is what "a stirred mix has a
  // broad transition" meant in code — made the band wider than the disc at
  // full stir, so the mask never reached either material anywhere and the face
  // came out a flat average: 6.09/255 against an unmerged body, *below* the
  // 7.00 a change of seed produces. Stirring draws two materials into
  // filaments; it does not homogenise them. The band stays narrow and the
  // violence goes into the frequency of the warp instead.
  const stirred = diff(plain, sprite(mixOf({ iron: 1 }, 0.5, 0.05), 12345));
  assert('a violently stirred merge is still a picture of a merge',
    stirred.local > floor.local,
    `${stirred.mean.toFixed(2)}/${stirred.local.toFixed(2)} vs seed ${floor.mean.toFixed(2)}/${floor.local.toFixed(2)}`);
  // Iron on silicate is the hardest case there is — the two are within fifteen
  // units of each other in every channel, so a marble of them is genuinely
  // subtle and only the local figure clears the bar. With a material that
  // differs, a stirred merge is unmistakable.
  const stirredIce = diff(plain, sprite(mixOf({ water: 1 }, 0.5, 0.05), 12345));
  assert('and with a different material it is obvious',
    stirredIce.mean > floor.mean * 2, `${stirredIce.mean.toFixed(2)}/255 disc-wide`);

  // Sharpness is the record of how fast the two came together. The renderer
  // draws a scarp for a clean seam and a marble for a stirred one; if those
  // two look the same, the velocity is not in the picture.
  const seamVsStir = diff(
    sprite(mixOf({ iron: 1 }, 0.5, 0.9), 12345),
    sprite(mixOf({ iron: 1 }, 0.5, 0.05), 12345),
  );
  assert('a clean seam and a stirred marble are different pictures',
    seamVsStir.mean > floor.mean && seamVsStir.local > floor.local,
    `${seamVsStir.mean.toFixed(2)}/${seamVsStir.local.toFixed(2)} vs seed ${floor.mean.toFixed(2)}/${floor.local.toFixed(2)}`);

  // And that record has to be reachable: a pair falling together from rest at
  // infinity arrives at exactly the mutual escape velocity, and the old ramp
  // bottomed the sharpness out at its stirred floor for anything at or above
  // that, so the seam the renderer can draw never occurred in play.
  const sharpnessAt = (vOverEsc) => {
    const comp = { iron: 0.32, silicate: 0.68 };
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: M_EARTH * 0.3, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * M_EARTH * 1.3) / rs);
    const p = new Body({
      name: 'P', mass: M_EARTH * 0.3, composition: comp,
      x: rs * 0.999, vx: -vOverEsc * vEsc,
    });
    const merged = (resolveCollision(t, p, {}).added || [])[0];
    return merged && merged.mixes.length ? merged.mixes[0].sharpness : null;
  };
  const slow = sharpnessAt(0.2), atEsc = sharpnessAt(1.0);
  assert('a body falling from rest at infinity still leaves a seam',
    atEsc > 0.3, `sharpness at v_esc = ${atEsc}`);
  assert('and a slower one leaves a cleaner seam than a faster one',
    slow > atEsc, `${slow} at 0.2 v_esc vs ${atEsc} at 1.0`);
}

section('Regressions found in the fifth review');
{
  // One NaN used to delete the entire scene: cullNonFinite ran only at the end
  // of advance(), a full step after the tree had smeared it through every
  // acceleration. Twelve bodies in, zero out, all twelve reported culled.
  for (const field of ['x', 'y', 'vx', 'vy', 'mass', 'radius']) {
    const w = new World({ frameBudgetMs: 1e9 });
    loadPreset(w, 'solar-system');
    const n0 = w.bodies.length;
    w.bodies[3][field] = NaN;
    w.advance(DAY);
    assert(`a NaN ${field} takes one body, not the scene`,
      w.bodies.length === n0 - 1
        && w.bodies.every((b) => [b.x, b.y, b.vx, b.vy].every(isFinite)),
      `${w.bodies.length} of ${n0} survived`);
  }
}
{
  // A strength-dominated *pair* of boulders may bounce. A boulder and a planet
  // may not: `Math.min(target.radius, proj.radius) < 5e5` asked whether either
  // body was small, which is true of every impact onto a planet, and since a
  // body falling from rest at infinity arrives at exactly the mutual escape
  // velocity, everything below that was classified merge and then converted to
  // bounce. A 360 km rock rebounded off the Earth and left.
  const comp = { iron: 0.32, silicate: 0.68 };
  const onEarth = (mp, v) => {
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: mp, composition: comp });
    const rs = t.radius + probe.radius;
    const p = new Body({ name: 'P', mass: mp, composition: comp, x: rs * 0.999, vx: -v });
    return resolveCollision(t, p, { allowBounce: true }).regime;
  };
  let bounced = null;
  for (const mp of [1.3e13, 1.3e17, 1.3e19, 8e20, 1.3e22]) {
    for (const v of [3e3, 8e3, 11e3, 20e3]) {
      if (onEarth(mp, v) === 'bounce') bounced = `${mp.toExponential(1)} kg at ${v / 1000} km/s`;
    }
  }
  assert('nothing bounces off a planet', bounced === null, bounced || 'none of 20');

  // The case above no longer discriminates on its own: the classifier sends a
  // small projectile to `cratering`, which never reaches the bounce branch at
  // all, so `Math.min` and `Math.max` both pass it. The guard is only load-
  // bearing where the outcome *is* a merge and exactly one body is under the
  // 500 km threshold -- a 143 km rock onto an 828 km dwarf, which merges.
  const mixedPair = (v) => {
    const Mt = 1e22, Mp = 5e19;
    const t = new Body({ name: 'T', mass: Mt, composition: comp });
    const probe = new Body({ mass: Mp, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * (Mt + Mp)) / rs);
    const p = new Body({ name: 'P', mass: Mp, composition: comp, x: rs * 0.999, vx: -v * vEsc });
    return { regime: resolveCollision(t, p, { allowBounce: true }).regime, small: probe.radius, big: t.radius };
  };
  const pair = mixedPair(0.7);
  assert('the guard measures the larger body, not the smaller',
    pair.small < 5e5 && pair.big > 5e5 && pair.regime === 'merge',
    `${(pair.small / 1e3).toFixed(0)} km onto ${(pair.big / 1e3).toFixed(0)} km -> ${pair.regime}`);
  // But two boulders still do.
  const a = new Body({ name: 'a', mass: 1e12, composition: { silicate: 1 } });
  const probe2 = new Body({ mass: 1e12, composition: { silicate: 1 } });
  const rs2 = a.radius + probe2.radius;
  const b2 = new Body({ name: 'b', mass: 1e12, composition: { silicate: 1 }, x: rs2 * 0.999, vx: -3 });
  assert('two boulders still bounce off each other',
    resolveCollision(a, b2, { allowBounce: true }).regime === 'bounce');
}
{
  // Two Earths grazing at b = 0.99 and fifty escape velocities -- 562 km/s --
  // used to produce literally nothing: same regime, same two masses, zero
  // debris. Only about a thousandth of each body is inside the other at that
  // impact parameter, which is why it stays a hit-and-run rather than becoming
  // a disruption; but that thousandth cannot survive half a million metres per
  // second, and it was surviving because the LS12 interacting-mass correction
  // diverges as the interacting fraction goes to zero, sending Q*_RD to
  // infinity and the stripped mass with it.
  const comp = { iron: 0.32, silicate: 0.68 };
  const graze = (bp, vOverEsc) => {
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: M_EARTH, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * M_EARTH * 2) / rs);
    const p = new Body({
      name: 'P', mass: M_EARTH, composition: comp,
      x: Math.sqrt(1 - bp * bp) * rs * 0.999, y: bp * rs * 0.999, vx: -vOverEsc * vEsc,
    });
    const r = resolveCollision(t, p, { allowBounce: true });
    return {
      regime: r.regime,
      debris: (r.added || []).reduce((s, x) => s + x.mass, 0),
      pieces: (r.added || []).length,
      lost: (M_EARTH - p.mass) / M_EARTH,
    };
  };
  const fast = graze(0.99, 50);
  assert('a hypervelocity graze destroys the material that touched',
    fast.debris > 0 && fast.pieces > 0,
    `${fast.regime}, ${fast.pieces} pieces, projectile lost ${(fast.lost * 100).toFixed(3)}%`);
  // Faster has to take more, at the same geometry.
  const slow = graze(0.99, 2);
  assert('and takes more of it than a slow one does',
    fast.lost > slow.lost, `${fast.lost.toExponential(2)} vs ${slow.lost.toExponential(2)}`);
  // Deeper has to take more, at the same speed: a nearly head-on pass at this
  // speed is not survivable at all.
  const deep = graze(0.3, 50);
  assert('and a deeper pass at the same speed destroys both bodies',
    deep.regime === 'supercatastrophic' || deep.regime === 'disruption',
    `${deep.regime}`);

  // The reverse calculation itself. Where the projectile is much lighter, the
  // forward test says the target is fine -- which it is -- and only the
  // role-swapped one notices that the projectile is not. These cases come out
  // `hitrun` without it, with both bodies walking away.
  const uneven = (gamma, bp, v) => {
    const t = new Body({ name: 'T', mass: M_EARTH, composition: comp });
    const probe = new Body({ mass: M_EARTH * gamma, composition: comp });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * M_EARTH * (1 + gamma)) / rs);
    const p = new Body({
      name: 'P', mass: M_EARTH * gamma, composition: comp,
      x: Math.sqrt(1 - bp * bp) * rs * 0.999, y: bp * rs * 0.999, vx: -v * vEsc,
    });
    return resolveCollision(t, p, { allowBounce: true }).regime;
  };
  const wrecked = [
    ['gamma=0.10 b=0.8 v=4', uneven(0.10, 0.8, 4)],
    ['gamma=0.05 b=0.8 v=6', uneven(0.05, 0.8, 6)],
    ['gamma=0.02 b=0.9 v=6', uneven(0.02, 0.9, 6)],
  ];
  const survived = wrecked.filter(([, r]) => r !== 'disruption' && r !== 'supercatastrophic');
  assert('a light projectile grazing fast is destroyed even though the target is not',
    survived.length === 0,
    survived.length ? survived.map(([k, r]) => `${k} -> ${r}`).join(', ')
      : wrecked.map(([k, r]) => `${k} -> ${r}`).join(', '));
}
{
  // The energy diagnostic has to use the same force law the tree does, or the
  // drift figure measures the disagreement between two models rather than the
  // integrator -- precisely in the scenes where someone is watching it, since
  // overlapping bodies are what a collision is.
  const w = new World({ frameBudgetMs: 1e9, collisions: false });
  const a = new Body({ name: 'A', mass: M_EARTH, radius: R_EARTH, x: -R_EARTH * 0.4 });
  const b = new Body({ name: 'B', mass: M_EARTH, radius: R_EARTH, x: R_EARTH * 0.4 });
  w.add(a); w.add(b);
  w.settings.wantDiagnostics = true;
  const e0 = w.totalEnergy();
  for (let i = 0; i < 4000; i++) w.advance(0.5);
  const drift = Math.abs((w.totalEnergy() - e0) / e0);
  assert('energy is conserved while two bodies pass through each other',
    drift < 1e-4, `${drift.toExponential(2)} over ${w.steps} steps`);
  // And the interior potential is continuous with the exterior one at contact.
  const at = (d) => {
    const w2 = new World();
    w2.add(new Body({ name: 'A', mass: M_EARTH, radius: R_EARTH }));
    w2.add(new Body({ name: 'B', mass: M_EARTH, radius: R_EARTH, x: d }));
    return w2.totalEnergy();
  };
  const R = 2 * R_EARTH;
  check('the potential is continuous at contact',
    at(R * 0.9999), at(R * 1.0001), 1e-3);
}
{
  // Every crater is recorded at its true size; the renderer decides what it can
  // draw. A gate at 1/256 of the disc threw away Meteor Crater, which this
  // scaling otherwise gets to within 2%.
  const rng = () => 0.5;
  const earth = () => new Body({
    name: 'E', mass: M_EARTH, radius: R_EARTH, composition: { iron: 0.32, silicate: 0.68 },
  });
  const e = earth();
  e.addCrater(1, 0, 3e8, 25, 12800, rng);
  assert('Meteor Crater is recorded at all', e.craters.length === 1,
    `${e.craters.length} craters`);
  // Guarded: when the record is dropped this has to fail, not throw and take
  // every assertion after it down with it.
  check('and at the right size',
    e.craters.length ? e.craters[0].size * R_EARTH / 1000 : 0, 1.2, 0.25, ' km');
  // A stream of gravel must not push a basin off the capped list.
  const big = earth();
  big.addCrater(1, 0, 1e15, 5000, 20000, rng);
  const basin = big.craters[0].size;
  for (let i = 0; i < 120; i++) big.addCrater(Math.cos(i), Math.sin(i), 3e8, 25, 12800, rng);
  assert('and gravel does not evict a basin',
    big.craters.some((c) => c.size === basin), `${big.craters.length} held`);
}
{
  // Sunlight has to warm a planet on a timescale someone can watch, and an
  // impact has to leave one molten. Relaxing both through the bulk gave 100.09 K
  // after a hundred years; relaxing both through the skin cooled a magma ocean
  // in ninety seconds.
  const at1AU = (mass, t0, years) => {
    const w = new World({ frameBudgetMs: 1e9, maxSubsteps: 4000, collisions: false });
    w.add(new Body({
      name: 'Sun', kind: 'star', mass: M_SUN, radius: 6.957e8, temperature: 5772, fixed: true,
    }));
    const b = new Body({
      name: 'B', mass, composition: { iron: 0.32, silicate: 0.68 }, temperature: t0,
      x: AU, fixed: true,
    });
    w.add(b);
    while (w.time < years * YEAR) w.advance(YEAR / 40);
    return b.temperature;
  };
  check('an Earth-mass rock at 1 AU reaches equilibrium within a few years',
    at1AU(M_EARTH, 100, 5), 267, 0.03, ' K');
  const molten = at1AU(M_EARTH, 2200, 5);
  assert('and a molten one is still molten five years later',
    molten > 1800, `${molten.toFixed(0)} K`);
}

section('The eccentric-orbit limit the README admits to');
{
  // eta*sqrt(r/|a|) has no time-to-perihelion term, so a very eccentric orbit
  // is under-resolved at closest approach. The README quotes these; they are
  // measured here so the number and the claim cannot drift apart, and so that
  // an attempt to improve the step chooser has something to beat.
  const drift = (eta, years) => {
    const w = new World({
      frameBudgetMs: 1e9, maxSubsteps: 1e9,
      collisions: false, thermal: false, tidalDisruption: false,
    });
    w.settings.eta = eta;
    w.add(new Body({ name: 'S', kind: 'star', mass: M_SUN, radius: 7e8 }));
    const st = stateFromElements(G * M_SUN, 5 * AU, 0.98, 0, Math.PI);
    w.add(new Body({ name: 'C', mass: 1e14, radius: 5e3, ...st }));
    w.computeAccelerations();
    const e0 = w.totalEnergy();
    while (w.time < years * YEAR) w.advance(YEAR / 8);
    return Math.abs((w.totalEnergy() - e0) / e0);
  };
  const d06 = drift(0.06, 20);
  check('e = 0.98 drifts 1.1e-3 over 20 years at the shipped eta', d06, 1.12e-3, 0.35);
  check('and 9.7e-3 over 200', drift(0.06, 200), 9.71e-3, 0.35);
  // Halving eta must divide the error by about 2^4. If it stops doing that,
  // something other than truncation is in the way.
  const order = Math.log2(d06 / drift(0.03, 20));
  check('convergence is fourth order, so this is truncation not a bug',
    order, 4.15, 0.12);
}

section('Planets are made of something now');
{
  // The interior as cells, and what a collision does to it. Everything in this
  // section is about the model that replaced compositions-as-numbers: a body
  // has material in places, and an impact damages the material where it hits.
  const comp = { iron: 0.32, silicate: 0.68 };
  const earth = () => new Body({
    name: 'E', mass: M_EARTH, radius: R_EARTH, composition: comp,
    temperature: 288, differentiation: 1, seed: 4242,
  });
  const ringOf = (f, r0, r1) => {
    const acc = {};
    let t = 0;
    for (let j = 0; j < f.n; j++) {
      for (let i = 0; i < f.n; i++) {
        const k = f.idx(i, j);
        if (f.mat[k] === EMPTY) continue;
        const r = Math.hypot(f.u(i), f.u(j));
        if (r < r0 || r >= r1) continue;
        acc[matKey(f.mat[k])] = (acc[matKey(f.mat[k])] || 0) + 1;
        t++;
      }
    }
    for (const key in acc) acc[key] /= t;
    return acc;
  };

  // A differentiated body has its iron in the middle, because that is what
  // differentiated means. Nothing in the renderer decides this any more.
  {
    const b = earth();
    const f = b.ensureField();
    assert('a planet builds an interior', f && f.filled > 1000, `${f ? f.filled : 0} cells`);
    const core = ringOf(f, 0, 0.35), skin = ringOf(f, 0.85, 1);
    assert('with its iron in the core', (core.iron || 0) > 0.9,
      `core is ${((core.iron || 0) * 100).toFixed(0)}% iron`);
    assert('and none of it at the surface', (skin.iron || 0) < 0.05,
      `surface is ${((skin.iron || 0) * 100).toFixed(0)}% iron`);
    // A star has no interior worth resolving and must not get one.
    const star = new Body({ name: 'S', kind: 'star', mass: M_SUN, radius: 7e8, temperature: 5772 });
    assert('a star does not', star.ensureField() === null);
  }

  // A small impact damages the planet. It does not rearrange it, and it does
  // not take any of it away: the crater is a dent in material that is still
  // there, and it is still there once everything has cooled.
  {
    const b = earth();
    const f = b.ensureField();
    const m0 = b.mass, filled0 = f.filled;
    const hit = b.takeImpact(1, 0, {
      vImp: 18000, projMass: 1e20, projComp: { water: 0.6, silicate: 0.4 },
      craterSize: 0.2, rng: () => 0.5,
    });
    assert('a small impact takes no mass off a planet', hit.ejectedMass === 0,
      `${(hit.ejectedMass / m0).toExponential(1)} of the body`);
    assert('and leaves no holes in it', f.filled === filled0, `${filled0} -> ${f.filled}`);
    let deepest = 0;
    for (let k = 0; k < f.n * f.n; k++) if (f.mat[k] !== EMPTY) deepest = Math.min(deepest, f.relief[k]);
    assert('but it does leave a crater', deepest < -0.4, `deepest relief ${deepest.toFixed(2)}`);
    // Cool it right down; a hole in cold rock does not heal.
    for (let i = 0; i < 200; i++) f.relax(YEAR * 20, { equilibriumT: 288, coolSeconds: YEAR * 60 });
    let after = 0;
    for (let k = 0; k < f.n * f.n; k++) if (f.mat[k] !== EMPTY) after = Math.min(after, f.relief[k]);
    assert('and the crater is still there a long time later', after < -0.3,
      `${deepest.toFixed(2)} -> ${after.toFixed(2)}`);
  }

  // What escapes is limited by the energy that arrived, not by how wide the
  // hole is. Taking the whole bowl had a 1e20 kg impactor throwing away two
  // hundred times its own mass.
  {
    const b = earth();
    b.ensureField();
    const hit = b.takeImpact(1, 0, {
      vImp: 25000, projMass: 1e21, projComp: comp, craterSize: 0.3, rng: () => 0.5,
    });
    const budget = 1e21 * 0.5 * 25000 * 25000 / (0.5 * b.escapeVelocity * b.escapeVelocity);
    assert('ejecta cannot exceed what the impact could lift',
      hit.ejectedMass <= budget, `${hit.ejectedMass.toExponential(2)} kg against ${budget.toExponential(2)} possible`);
  }

  // A giant impact melts the planet, and a molten planet is a fluid: it sorts
  // itself by density, and it freezes from the outside in. None of that is
  // scripted — it falls out of the material properties.
  {
    const b = earth();
    const f = b.ensureField();
    f.shock(1, 3000, 0.4, () => 0.5);
    assert('a giant impact melts the whole planet', f.moltenFraction > 0.9,
      `${(f.moltenFraction * 100).toFixed(0)}% molten`);
    assert('and does not heat it past boiling', f.meanTemperature() < 4200,
      `${f.meanTemperature().toFixed(0)} K`);

    // Scramble the layering, then let it settle: the iron has to find its way
    // back down on its own.
    const scrambled = earth().ensureField();
    scrambled.shock(1, 3000, 0, () => 0.5);
    for (let k = 0; k < scrambled.n * scrambled.n; k++) {
      if (scrambled.mat[k] === EMPTY) continue;
      if ((k % 7) === 0) scrambled.mat[k] = matIndex('iron');
      else if ((k % 7) === 1) scrambled.mat[k] = matIndex('silicate');
    }
    const before = (ringOf(scrambled, 0, 0.35).iron || 0);
    for (let i = 0; i < 220; i++) {
      scrambled.relax(YEAR * 5, { equilibriumT: 288, coolSeconds: YEAR * 400 });
    }
    const after = (ringOf(scrambled, 0, 0.35).iron || 0);
    assert('iron sinks through melt without being told to',
      after > before + 0.02, `core went from ${(before * 100).toFixed(0)}% to ${(after * 100).toFixed(0)}% iron`);

    // And it freezes.
    let steps = 0;
    while (f.relax(YEAR * 8, { equilibriumT: 288, coolSeconds: YEAR * 40 }) && steps < 1200) steps++;
    assert('a magma ocean freezes in finite time', steps < 1200 || f.moltenFraction < 0.05,
      `${steps} steps, ${(f.moltenFraction * 100).toFixed(1)}% molten left`);
    assert('and everything in it stays finite',
      [...f.temp].every(isFinite) && [...f.relief].every(isFinite));
  }

  // The body's own numbers come back from the field, so a planet cannot look
  // half ice and still claim to be dry rock.
  {
    const b = earth();
    const f = b.ensureField();
    for (let k = 0; k < f.n * f.n; k++) {
      if (f.mat[k] !== EMPTY && Math.random() < 0) f.mat[k] = matIndex('water');
    }
    // Deterministically: make the outer third ice.
    for (let j = 0; j < f.n; j++) {
      for (let i = 0; i < f.n; i++) {
        const k = f.idx(i, j);
        if (f.mat[k] === EMPTY) continue;
        if (Math.hypot(f.u(i), f.u(j)) > 0.72) f.mat[k] = matIndex('water');
      }
    }
    b.syncFromField();
    // The outer 28% of the radius is 48% of the area, but composition is by
    // mass and water is a third the density of silicate and an eighth that of
    // iron, so it is about 15% of the body. Reading 48% here would mean the
    // field was reporting volume and calling it mass.
    assert('the body reads its composition off its own material',
      (b.composition.water || 0) > 0.1 && (b.composition.water || 0) < 0.25,
      `${((b.composition.water || 0) * 100).toFixed(0)}% water by mass, from 48% by volume`);
    assert('and its surface separately from its bulk',
      (b.crust.water || 0) > (b.composition.water || 0),
      `crust ${((b.crust.water || 0) * 100).toFixed(0)}% vs bulk ${((b.composition.water || 0) * 100).toFixed(0)}%`);
  }

  // A field has to survive a save.
  {
    const b = earth();
    const f = b.ensureField();
    b.takeImpact(1, 0, { vImp: 20000, projMass: 1e21, projComp: { carbon: 1 }, craterSize: 0.25, rng: () => 0.5 });
    const round = Body.fromJSON(JSON.parse(JSON.stringify(b.toJSON())));
    assert('a damaged planet survives a save and load',
      round.field && round.field.filled === b.field.filled
      && JSON.stringify(round.field.composition()) === JSON.stringify(b.field.composition()),
      `${b.field.filled} cells -> ${round.field ? round.field.filled : 'none'}`);
  }

  // And the renderer draws the material, not a guess at it.
  {
    const plain = earth();
    const cratered = earth();
    const f = cratered.ensureField();
    for (let q = 0; q < 5; q++) {
      f.excavate({
        cu: Math.cos(q * 1.2) * 0.7, cv: Math.sin(q * 1.2) * 0.7, craterR: 0.16,
        specificEnergy: 0.5 * 16000 * 16000, escapeEnergy: 0.5 * 11200 * 11200,
        projMassFraction: 2e-5, rng: () => 0.5,
      });
    }
    cratered.syncFromField();
    const a = texturePixels(plain, 96), c = texturePixels(cratered, 96);
    let diff = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 128 && c[i + 3] < 128) continue;
      n++;
      diff += (Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2])) / 3;
    }
    assert('a bombarded planet does not look like a pristine one',
      diff / n > 10, `${(diff / n).toFixed(1)}/255 per channel`);
  }
}

section('A giant impact makes a moon, at any time scale');
{
  // The whole point, end to end: something Mars-sized hits a proto-Earth off
  // centre, the planet melts, and what it throws off ends up in orbit as a
  // moon. And the answer must not depend on how fast the clock was running.
  //
  // It used to. The step chooser knew only about the local gravitational field,
  // which says nothing about contact, so at a large time scale the held step
  // grew until a body could cross a neighbour in one go. The swept test still
  // found the contact, but everything downstream saw an interpenetration
  // instead of a touch, and a debris disc that settled into a moon when stepped
  // finely came apart into 282 fragments when stepped coarsely.
  const comp = { iron: 0.32, silicate: 0.68 };
  const run = (chunkDays) => {
    const w = new World({ frameBudgetMs: 1e9, maxSubsteps: 400 });
    const t = new Body({
      name: 'Proto-Earth', mass: M_EARTH * 0.9, composition: comp,
      differentiation: 1, temperature: 900, seed: 7,
    });
    t.ensureField();
    const pm = M_EARTH * 0.13;
    const probe = new Body({ mass: pm, composition: { iron: 0.25, silicate: 0.75 } });
    const rs = t.radius + probe.radius;
    const vEsc = Math.sqrt((2 * G * (t.mass + pm)) / rs);
    const b = 0.72;
    w.add(t);
    w.add(new Body({
      name: 'Theia', mass: pm, composition: { iron: 0.25, silicate: 0.75 },
      temperature: 900, seed: 8,
      x: Math.sqrt(1 - b * b) * rs * 1.02, y: b * rs * 1.02,
      vx: -1.08 * vEsc * Math.sqrt(1 - b * b), vy: -1.08 * vEsc * b,
    }));
    let shattered = 0;
    w.on('collision', (e) => {
      if (e.regime === 'supercatastrophic' || e.regime === 'disruption') shattered++;
    });
    while (w.time < 3000 * DAY) w.advance(DAY * chunkDays);
    const planet = w.bodies.slice().sort((x, y) => y.mass - x.mass)[0];
    const rest = w.bodies.filter((x) => x !== planet);
    const moon = rest.sort((x, y) => y.mass - x.mass)[0] || null;
    let bound = false;
    if (moon) {
      const d = Math.hypot(moon.x - planet.x, moon.y - planet.y);
      const v = Math.hypot(moon.vx - planet.vx, moon.vy - planet.vy);
      bound = v < Math.sqrt((2 * G * planet.mass) / d);
    }
    return {
      bodies: w.bodies.length, planet: planet.mass / M_EARTH,
      moon: moon ? moon.mass / M_MOON : 0, bound, shattered,
      molten: planet.field ? planet.field.moltenFraction : 0,
    };
  };

  const fine = run(5);
  assert('the impact melts the planet', fine.molten > 0.5,
    `${(fine.molten * 100).toFixed(0)}% molten`);
  check('and leaves an Earth', fine.planet, 1.017, 0.02, ' M_E');
  assert('and a moon of about a lunar mass', fine.moon > 0.4 && fine.moon < 2.5,
    `${fine.moon.toFixed(2)} lunar masses`);
  assert('in orbit rather than leaving', fine.bound, `${fine.bound}`);
  assert('and nothing was shattered getting there', fine.shattered === 0,
    `${fine.shattered} disruptive events`);

  const coarse = run(200);
  assert('a forty-times coarser clock gives the same planet',
    Math.abs(coarse.planet - fine.planet) / fine.planet < 0.02,
    `${fine.planet.toFixed(3)} vs ${coarse.planet.toFixed(3)} M_E`);
  assert('and the same moon',
    coarse.moon > 0.4 && coarse.moon < 2.5
      && Math.abs(coarse.moon - fine.moon) / fine.moon < 0.35,
    `${fine.moon.toFixed(2)} vs ${coarse.moon.toFixed(2)} lunar masses`);
  assert('and does not shatter the debris either', coarse.shattered === 0,
    `${coarse.shattered} disruptive events at 200-day chunks`);
}

section('Save and load are exact');
{
  const w = new World({ frameBudgetMs: 1e9 });
  loadPreset(w, 'solar-system');
  w.advance(30 * DAY);
  const e0 = w.totalEnergy();
  const n0 = w.bodies.length;
  const snap = w.snapshot();
  w.restore(snap);
  assert('body count survives a round-trip', w.bodies.length === n0);
  assert('total energy survives a round-trip', Math.abs((w.totalEnergy() - e0) / e0) < 1e-12);
  assert('and so does the snapshot itself', w.snapshot().length > 0 && JSON.parse(snap).bodies.length === n0);
}

section('The numbers the README quotes');
{
  // The README prints a table of Barnes-Hut force errors. It is quoted from
  // this measurement, so the two cannot drift apart, and the table's whole
  // point -- that the per-body and scene-normalised figures differ by four
  // orders of magnitude for the same tree -- is asserted rather than asserted
  // in prose. An earlier README compared one scene's global figure against
  // another scene's per-body figure and made the tree look ten thousand times
  // better than it is.
  const treeError = (w, theta) => {
    w.settings.theta = 0;
    w.computeAccelerations();
    const exact = w.bodies.map((b) => [b.ax, b.ay]);
    w.settings.theta = theta;
    w.computeAccelerations();
    const mag = exact.map(([x, y]) => Math.hypot(x, y));
    const aRms = Math.sqrt(mag.reduce((t, v) => t + v * v, 0) / mag.length);
    let perBody2 = 0, worst = 0, global2 = 0;
    w.bodies.forEach((b, i) => {
      const d = Math.hypot(b.ax - exact[i][0], b.ay - exact[i][1]);
      const rel = d / (mag[i] || Number.MIN_VALUE);
      perBody2 += rel * rel;
      if (rel > worst) worst = rel;
      global2 += (d / aRms) ** 2;
    });
    const n = w.bodies.length;
    return {
      perBody: Math.sqrt(perBody2 / n),
      worst,
      global: Math.sqrt(global2 / n),
    };
  };

  // Every cell of the table, including the worst-body column: the one cell the
  // suite did not assert is the one that was wrong in the README (0.0006%
  // against a real 0.0013%).
  const sol = new World();
  loadPreset(sol, 'solar-system');
  const s5 = treeError(sol, 0.5);
  check('Solar System per-body rms at theta 0.5', s5.perBody, 5.5e-6, 0.3);
  check('Solar System worst body at theta 0.5', s5.worst * 100, 0.0013, 0.3, '%');
  check('Solar System scene-normalised rms at theta 0.5', s5.global, 9.4e-9, 0.3);
  const s1 = treeError(sol, 1.0);
  check('Solar System per-body rms at theta 1', s1.perBody, 2.8e-3, 0.3);
  check('Solar System worst body at theta 1', s1.worst * 100, 0.63, 0.3, '%');
  check('Solar System scene-normalised rms at theta 1', s1.global, 3.9e-6, 0.3);

  const cloud = new World();
  let seed = 12345;
  const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 800; i++) {
    const r = 6e10 * Math.cbrt(rng()), th = rng() * Math.PI * 2;
    cloud.add(new Body({
      name: `c${i}`, mass: 1e24, radius: 1e6,
      x: Math.cos(th) * r, y: Math.sin(th) * r,
    }));
  }
  const c5 = treeError(cloud, 0.5);
  check('cloud per-body rms at theta 0.5', c5.perBody, 4.7e-2, 0.3);
  check('cloud worst body at theta 0.5', c5.worst * 100, 114, 0.3, '%');
  check('cloud scene-normalised rms at theta 0.5', c5.global, 1.8e-4, 0.3);
  const c1 = treeError(cloud, 1.0);
  check('cloud per-body rms at theta 1', c1.perBody, 1.9e-1, 0.3);
  check('cloud worst body at theta 1', c1.worst * 100, 312, 0.3, '%');
  check('cloud scene-normalised rms at theta 1', c1.global, 1.2e-3, 0.3);
  assert('a cancelling cloud is far worse per body than per scene',
    c5.perBody / c5.global > 100,
    `ratio ${(c5.perBody / c5.global).toFixed(0)}x`);
  assert('and its worst single body is well over 100% off',
    c5.worst > 1, `worst ${(c5.worst * 100).toFixed(0)}%`);

  // The disc preset's profile, also quoted in the README.
  const disc = new World();
  loadPreset(disc, 'protoplanetary');
  const a = disc.bodies.filter((b) => b.mass < 1e28)
    .map((b) => Math.hypot(b.x, b.y) / AU).sort((x, y) => x - y);
  assert('the disc preset has 160 planetesimals', a.length === 160, `${a.length}`);
  check('inner edge', a[0], 0.75, 0.08, ' AU');
  check('outer edge', a[a.length - 1], 1.7, 0.08, ' AU');
  {
    // The sampler draws a^(-1/2) uniformly, so dN/da is exactly a^-1.5 and the
    // surface density a^-2.5 — analytic, not measured. A six-bin histogram fit
    // of 160 samples gave -1.38, which is what the README used to quote and
    // what this used to assert to 25%; with a 1-sigma of +/-0.33 on that fit it
    // would have passed for any sampler between -1.03 and -1.73. It locked in
    // one realisation of the binning noise and constrained nothing.
    //
    // Kolmogorov-Smirnov against the exact CDF instead. F(a) is linear in
    // a^(-1/2) between the edges, and D > 1.36/sqrt(n) rejects at p = 0.05 —
    // 0.108 for 160 planetesimals. This does discriminate: a uniform-in-a
    // sampler over the same range gives D = 0.16 and fails.
    const inner = a[0], outer = a[a.length - 1];
    const lo = Math.pow(inner, -0.5), hi = Math.pow(outer, -0.5);
    let D = 0;
    for (let i = 0; i < a.length; i++) {
      const F = (Math.pow(a[i], -0.5) - lo) / (hi - lo);
      D = Math.max(D, Math.abs(F - i / a.length), Math.abs((i + 1) / a.length - F));
    }
    assert('the disc follows dN/da = a^-1.5 exactly, not approximately',
      D < 1.36 / Math.sqrt(a.length),
      `KS D = ${D.toFixed(4)}, reject above ${(1.36 / Math.sqrt(a.length)).toFixed(4)}`);
    // And the same statistic on a distribution the sampler is not, so a test
    // that would pass for anything is visibly not what this is.
    let Dflat = 0;
    for (let i = 0; i < a.length; i++) {
      const F = (a[i] - inner) / (outer - inner);
      Dflat = Math.max(Dflat, Math.abs(F - i / a.length));
    }
    assert('and the test can tell that from a flat one',
      Dflat > 1.36 / Math.sqrt(a.length),
      `uniform-in-a would give D = ${Dflat.toFixed(4)}`);
  }
}

section('Fields and settings reach the simulation');
{
  // Attract and repel are a hand reaching into the scene, not extra gravity:
  // the impulse has to be the same for two bodies at the same distance
  // whatever their mass, and it has to scale with wall-clock time rather than
  // with however much simulated time the current speed setting buys.
  const w = new World({ frameBudgetMs: 1e9 });
  const sun = new Body({ name: 'S', mass: M_SUN, radius: 7e8, fixed: true });
  w.add(sun);
  const light = new Body({ name: 'L', mass: 1e18, radius: 1e5, x: AU, vy: 29780 });
  const heavy = new Body({ name: 'H', mass: 1e24, radius: 1e6, x: AU + 1e9, vy: 29780 });
  w.add(light); w.add(heavy);
  w.computeAccelerations();

  // The attract radius is 26 + 70*intensity screen pixels, so a camera scale of
  // one pixel per 4e7 m puts a 4e9 m field around the cursor at intensity 1.
  const fakeApp = (world) => ({
    world, camera: { scale: 1 / 4.16e7 }, effects: { pulse() {} },
    toast() {}, select() {}, markDirty() {}, emit() {},
  });
  const tools = new ToolController(fakeApp(w));
  tools.tool = 'attract';
  tools.intensity = 1;
  tools.world = { x: AU + 5e8, y: 0 };
  const before = [light, heavy].map((b) => [b.vx, b.vy]);
  tools.applyField(0.1, +1);
  const dv = [light, heavy].map((b, i) =>
    Math.hypot(b.vx - before[i][0], b.vy - before[i][1]));
  assert('attract gives the same kick to a light and a heavy body',
    Math.abs(dv[0] - dv[1]) / Math.max(dv[0], dv[1]) < 0.35,
    `light ${dv[0].toExponential(2)} m/s, heavy ${dv[1].toExponential(2)} m/s`);
  assert('and the kick is not zero', dv[0] > 0);

  // Twice the time held, twice the impulse.
  //
  // An earlier version of this also claimed to prove the kick was independent
  // of the simulation's speed setting, by writing `w2.timeScale` -- a property
  // World does not have and nothing reads. The two calls it compared ran
  // identical code with identical arguments and could only return bit-identical
  // values, which is why the assertion needed a 1e-9 tolerance and printed the
  // same number twice. It asserted nothing at all.
  //
  // The coupling that actually matters is at the call site: App.update passes
  // the wall-clock delta, not the simulated one. That is a browser-side fact,
  // so it is checked in test/browser.test.mjs, where it can be observed rather
  // than assumed. What is testable here is the shape of the field itself.
  const kick = (dtReal, targetMass) => {
    const w2 = new World({ frameBudgetMs: 1e9 });
    w2.add(new Body({ name: 'S', mass: M_SUN, radius: 7e8, fixed: true }));
    const t = new Body({ name: 'T', mass: targetMass, radius: 1e5, x: AU, vy: 29780 });
    w2.add(t);
    w2.computeAccelerations();
    const t2 = new ToolController(fakeApp(w2));
    t2.tool = 'attract';
    t2.intensity = 1;
    t2.world = { x: AU + 2e8, y: 0 };
    t2.applyField(dtReal, +1);
    return Math.hypot(t.vx, t.vy - 29780);
  };
  const k1 = kick(0.1, 1e20), k2 = kick(0.2, 1e20), k3 = kick(0.1, 1e26);
  check('the field impulse is linear in the time held', k2 / k1, 2, 0.02);
  assert('and a million times the mass takes the same kick',
    Math.abs(k3 - k1) / k1 < 0.02,
    `${k1.toExponential(3)} vs ${k3.toExponential(3)} m/s at 1e20 and 1e26 kg`);
  // Repel is attract with the sign flipped, and nothing checked that either.
  const away = (() => {
    const w3 = new World({ frameBudgetMs: 1e9 });
    w3.add(new Body({ name: 'S', mass: M_SUN, radius: 7e8, fixed: true }));
    const t = new Body({ name: 'T', mass: 1e20, radius: 1e5, x: AU, vy: 29780 });
    w3.add(t);
    w3.computeAccelerations();
    const t3 = new ToolController(fakeApp(w3));
    t3.tool = 'repel';
    t3.intensity = 1;
    t3.world = { x: AU + 2e8, y: 0 };
    t3.applyField(0.1, -1);
    return t.vx;
  })();
  assert('repel pushes away from the cursor', away < 0, `${away.toExponential(2)} m/s`);

  // Energy bookkeeping costs an O(N^2) pass, so the world skips it unless the
  // diagnostics readout is on -- and the settings layer has to actually say so.
  const wd = new World();
  loadPreset(wd, 'solar-system');
  applyToWorld({ ...defaultSettings(), showDiagnostics: false }, wd);
  assert('diagnostics off reaches the world', wd.settings.wantDiagnostics === false);
  wd._frame = 0;
  wd.measureEnergy();
  assert('and the world then skips the energy pass',
    wd.energySteps === 0 && wd._energyRef === null);
  applyToWorld({ ...defaultSettings(), showDiagnostics: true }, wd);
  assert('diagnostics on reaches the world', wd.settings.wantDiagnostics === true);
  wd.measureEnergy();
  assert('and the world then takes a reference', wd._energyRef !== null);
}

// ──────────────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
