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
import { radiusFromMass } from '../src/core/materials.js';

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
    const made = resolveCollision(t, p, {}).added || [];
    if (made.length < 2) continue;
    events++;
    let ov = 0;
    for (let i = 0; i < made.length; i++) {
      for (let j = i + 1; j < made.length; j++) {
        const a = made[i], b = made[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.radius + b.radius) * 0.98) ov++;
      }
    }
    if (ov > worst) worst = ov;
  }
  assert('no collision product is born inside another', worst === 0,
    `${events} multi-body outcomes, worst ${worst} overlapping pairs`);
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
