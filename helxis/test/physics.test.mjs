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
import { resolveCollision } from '../src/core/collide.js';
import {
  orbitalElements, stateFromElements, circularOrbitState,
} from '../src/core/kepler.js';
import { loadPreset, PRESETS } from '../src/ui/presets.js';
import { CATALOG, instantiate } from '../src/ui/catalog.js';
import { radiusFromMass, bulkDensity } from '../src/core/materials.js';

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

section('Kepler round-trip');
{
  const mu = G * M_SUN;
  const s = stateFromElements(mu, 1.00000011 * AU, 0.0167, 0, 0);
  const el = orbitalElements(s.x, s.y, s.vx, s.vy, mu);
  check('eccentricity round-trip', el.e, 0.0167, 1e-9);
  check('orbital period from elements', el.period, 0.99989 * YEAR, 1e-4, ' s');
  check('Earth perihelion speed', Math.hypot(s.vx, s.vy), 30290, 1e-3, ' m/s');
}

section('Relativistic perihelion precession');
{
  // Mercury: a = 0.387 AU, e = 0.2056. General relativity predicts 42.98″ per
  // century; the Newtonian run measures the numerical noise floor.
  const run = (relativity) => {
    const w = new World({ collisions: false, thermal: false, tidalDisruption: false, relativity, eta: 0.012, frameBudgetMs: 1e9 });
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
  assert('Newtonian noise floor is small', Math.abs(newtonian) < 2, `${newtonian.toFixed(2)}″/century`);
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

    const r = resolveCollision(t, p, {});
    const out = [];
    for (const b of [t, p]) if (!(r.removed || []).includes(b)) out.push(b);
    for (const b of (r.added || [])) out.push(b);

    let m1 = 0, px = 0, py = 0, vmax = 0;
    for (const b of out) {
      m1 += b.mass; px += b.mass * b.vx; py += b.mass * b.vy;
      vmax = Math.max(vmax, Math.hypot(b.vx, b.vy));
    }
    seen.add(r.regime);
    assert(`${label}: mass conserved`, Math.abs(m1 - m0) / m0 < 1e-12, `${r.regime}, ${out.length} bodies`);
    assert(`${label}: momentum conserved`, Math.hypot(px - p0x, py - p0y) / scale < 1e-12, r.regime);
    assert(`${label}: nothing goes superluminal`, vmax < C, `${(vmax / C).toExponential(2)} c`);
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

// ──────────────────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
