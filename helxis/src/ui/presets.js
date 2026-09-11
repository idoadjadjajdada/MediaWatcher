import {
  G, AU, M_SUN, M_EARTH, M_JUP, R_SUN, M_MOON, DAY, YEAR, TAU, clamp,
} from '../core/const.js';
import { Body } from '../core/body.js';
import { stateFromElements, trueAnomalyFromMean, circularOrbitState } from '../core/kepler.js';
import { instantiate, CATALOG_BY_ID } from './catalog.js';
import { makeRng, hashSeed, gaussian } from '../core/rng.js';

const deg = (d) => (d * Math.PI) / 180;

/**
 * Preset systems.
 *
 * The real ones are built from published orbital elements at J2000 — semi-major
 * axis, eccentricity, longitude of perihelion and mean longitude — rather than
 * from positions someone eyeballed. Feed those elements to the integrator and
 * the planets end up where they actually were, which is the whole point of
 * having an integrator that conserves energy to fourteen digits.
 */

/** Place a catalogue body on an orbit about `primary`. */
function orbit(world, primary, entryId, el, opts = {}) {
  const entry = CATALOG_BY_ID.get(entryId);
  if (!entry) throw new Error(`unknown catalogue entry: ${entryId}`);
  const body = instantiate(entry, { massScale: opts.massScale || 1, name: opts.name, seed: opts.seed });
  const nu = el.M != null ? trueAnomalyFromMean(el.M, el.e || 0) : (el.nu || 0);
  const s = stateFromElements(G * primary.mass, el.a, el.e || 0, el.argP || 0, nu, body.mass);
  body.x = primary.x + s.x;
  body.y = primary.y + s.y;
  body.vx = primary.vx + (el.retrograde ? -s.vx : s.vx);
  body.vy = primary.vy + (el.retrograde ? -s.vy : s.vy);
  world.add(body);
  return body;
}

function place(world, entryId, opts = {}) {
  const entry = CATALOG_BY_ID.get(entryId);
  if (!entry) throw new Error(`unknown catalogue entry: ${entryId}`);
  const body = instantiate(entry, opts);
  world.add(body);
  return body;
}

/**
 * Re-centre a system on its barycentre and zero the net momentum, so the whole
 * thing does not drift off screen. Nothing about the dynamics changes: it is a
 * change of inertial frame.
 */
function recenter(world) {
  const bc = world.barycenter();
  for (const b of world.bodies) {
    b.x -= bc.x; b.y -= bc.y;
    b.vx -= bc.vx; b.vy -= bc.vy;
  }
}

// ---------------------------------------------------------------------------

export const PRESETS = [
  {
    id: 'solar-system',
    name: 'Solar System',
    blurb: 'All eight planets plus Ceres, Pluto and Halley, at their J2000 positions.',
    build(world) {
      const sun = place(world, 'sun');
      // a (AU), e, longitude of perihelion, mean longitude — J2000.
      const planets = [
        ['mercury', 0.38709927, 0.20563593, 77.45779628, 252.25032350],
        ['venus', 0.72333566, 0.00677672, 131.60246718, 181.97909950],
        ['earth', 1.00000261, 0.01671123, 102.93768193, 100.46457166],
        ['mars', 1.52371034, 0.09339410, -23.94362959, -4.55343205],
        ['jupiter', 5.20288700, 0.04838624, 14.72847983, 34.39644051],
        ['saturn', 9.53667594, 0.05386179, 92.59887831, 49.95424423],
        ['uranus', 19.18916464, 0.04725744, 170.95427630, 313.23810451],
        ['neptune', 30.06992276, 0.00859048, 44.96476227, -55.12002969],
      ];
      for (const [id, a, e, peri, L] of planets) {
        orbit(world, sun, id, {
          a: a * AU, e, argP: deg(peri), M: deg(L - peri),
        });
      }
      orbit(world, sun, 'ceres', { a: 2.7658 * AU, e: 0.0785, argP: deg(73.6), M: deg(95.99) });
      orbit(world, sun, 'pluto', { a: 39.482 * AU, e: 0.2488, argP: deg(224.07), M: deg(14.86) });
      orbit(world, sun, 'halley', { a: 17.834 * AU, e: 0.96714, argP: deg(111.33), M: deg(38.38), retrograde: true });
      recenter(world);
      return { focus: sun, zoom: 6.4 * AU, speed: 86400 * 7 };
    },
  },
  {
    id: 'inner-system',
    name: 'Inner system',
    blurb: 'Mercury through Mars, with the Moon — close enough to watch the months go by.',
    build(world) {
      const sun = place(world, 'sun');
      orbit(world, sun, 'mercury', { a: 0.387098 * AU, e: 0.205630, argP: deg(77.46), M: deg(174.8) });
      orbit(world, sun, 'venus', { a: 0.723332 * AU, e: 0.006772, argP: deg(131.53), M: deg(50.4) });
      const earth = orbit(world, sun, 'earth', { a: 1.000001 * AU, e: 0.016708, argP: deg(102.95), M: deg(357.5) });
      orbit(world, earth, 'luna', { a: 3.84399e8, e: 0.0549, argP: 0, M: deg(135) });
      orbit(world, sun, 'mars', { a: 1.523679 * AU, e: 0.093400, argP: deg(336.04), M: deg(19.4) });
      recenter(world);
      return { focus: sun, zoom: 0.55 * AU, speed: 86400 };
    },
  },
  {
    id: 'earth-moon',
    name: 'Earth and Moon',
    blurb: 'The real pair, to scale. The barycentre is inside the Earth, but only just.',
    build(world) {
      const earth = place(world, 'earth');
      orbit(world, earth, 'luna', { a: 3.84399e8, e: 0.0549, argP: 0, M: 0 });
      recenter(world);
      return { focus: earth, zoom: 5.2e8, speed: 86400 };
    },
  },
  {
    id: 'jupiter-system',
    name: 'Jovian system',
    blurb: 'Jupiter and the Galilean moons. Io, Europa and Ganymede are locked 1:2:4.',
    build(world) {
      const j = place(world, 'jupiter');
      orbit(world, j, 'io', { a: 4.217e8, e: 0.0041, M: deg(0) });
      orbit(world, j, 'europa', { a: 6.71034e8, e: 0.009, M: deg(118) });
      orbit(world, j, 'ganymede', { a: 1.070412e9, e: 0.0013, M: deg(233) });
      orbit(world, j, 'callisto', { a: 1.882709e9, e: 0.0074, M: deg(41) });
      recenter(world);
      return { focus: j, zoom: 2.4e9, speed: 3600 * 6 };
    },
  },
  {
    id: 'saturn-rings',
    name: 'Saturn and its rings',
    blurb: 'A ring of rubble inside the Roche limit, and Titan and Enceladus outside it.',
    build(world) {
      const s = place(world, 'saturn');
      const rng = makeRng(0x5a7c);
      const R = s.radius;
      // The main rings run from about 1.2 to 2.3 Saturn radii — inside the
      // fluid Roche limit, which is why they are rubble and not a moon.
      for (let i = 0; i < 260; i++) {
        const a = R * (1.24 + Math.pow(rng(), 0.8) * 1.06);
        // The Cassini division, at the 2:1 resonance with Mimas.
        if (a > R * 1.95 && a < R * 2.03) continue;
        const th = rng() * TAU;
        const v = Math.sqrt((G * s.mass) / a) * (1 + gaussian(rng) * 0.0015);
        world.add(new Body({
          name: 'Ring particle', kind: 'debris',
          x: s.x + Math.cos(th) * a, y: s.y + Math.sin(th) * a,
          vx: s.vx - Math.sin(th) * v, vy: s.vy + Math.cos(th) * v,
          mass: 1e12 * (0.2 + rng() * 3),
          composition: { ice: 0.93, silicate: 0.07 },
          temperature: 90,
          seed: hashSeed('ring', i),
        }));
      }
      orbit(world, s, 'enceladus', { a: 2.37948e8, e: 0.0047, M: rng() * TAU });
      orbit(world, s, 'titan', { a: 1.22187e9, e: 0.0288, M: rng() * TAU });
      recenter(world);
      return { focus: s, zoom: 4.2e8, speed: 3600 };
    },
  },
  {
    id: 'trappist',
    name: 'TRAPPIST-1',
    blurb: 'Seven Earth-sized worlds around a red dwarf, all inside Mercury’s orbit.',
    build(world) {
      const star = place(world, 'red-dwarf', { massScale: 0.0898 / 0.122 });
      star.name = 'TRAPPIST-1';
      star.refresh();
      // Semi-major axes in AU and masses in Earth masses, from the 2021 solution.
      const worlds = [
        ['b', 0.01154, 1.374, 'lava-world', 400],
        ['c', 0.01580, 1.308, 'lava-world', 342],
        ['d', 0.02227, 0.388, 'desert-world', 288],
        ['e', 0.02925, 0.692, 'ocean-world', 251],
        ['f', 0.03849, 1.039, 'ocean-world', 219],
        ['g', 0.04683, 1.321, 'ice-world', 199],
        ['h', 0.06189, 0.326, 'ice-world', 173],
      ];
      const rng = makeRng(0x7a11);
      for (const [letter, a, mEarth, type, temp] of worlds) {
        const entry = CATALOG_BY_ID.get(type);
        const b = instantiate(entry, {
          massScale: (mEarth * M_EARTH) / entry.mass,
          name: `TRAPPIST-1${letter}`,
          seed: hashSeed('trappist', letter),
        });
        b.temperature = temp;
        b.refresh();
        const nu = rng() * TAU;
        const s = stateFromElements(G * star.mass, a * AU, 0.006, 0, nu, b.mass);
        b.x = s.x; b.y = s.y; b.vx = s.vx; b.vy = s.vy;
        world.add(b);
      }
      recenter(world);
      return { focus: star, zoom: 0.14 * AU, speed: 3600 * 6 };
    },
  },
  {
    id: 'alpha-centauri',
    name: 'Alpha Centauri',
    blurb: 'A real binary: 80-year period, eccentricity 0.52, 23 AU apart on average.',
    build(world) {
      const a = place(world, 'sun', { massScale: 1.0788, name: 'Alpha Centauri A' });
      const b = instantiate(CATALOG_BY_ID.get('orange-dwarf'), {
        massScale: 0.9092 / 0.79, name: 'Alpha Centauri B',
      });
      // Relative orbit, then split about the barycentre so both move.
      const s = stateFromElements(G * (a.mass + b.mass), 23.52 * AU, 0.5179, 0, Math.PI);
      const total = a.mass + b.mass;
      b.x = s.x * (a.mass / total); b.y = s.y * (a.mass / total);
      b.vx = s.vx * (a.mass / total); b.vy = s.vy * (a.mass / total);
      a.x = -s.x * (b.mass / total); a.y = -s.y * (b.mass / total);
      a.vx = -s.vx * (b.mass / total); a.vy = -s.vy * (b.mass / total);
      world.add(b);
      // Proxima is 13 000 AU out on a 550 000-year orbit; include it for scale.
      orbit(world, a, 'red-dwarf', { a: 8700 * AU, e: 0.5, M: 0.6 }).name = 'Proxima Centauri';
      recenter(world);
      return { focus: a, zoom: 34 * AU, speed: 3.15576e8 };
    },
  },
  {
    id: 'pluto-charon',
    name: 'Pluto and Charon',
    blurb: 'A true double: the barycentre sits in the space between them.',
    build(world) {
      const p = place(world, 'pluto');
      orbit(world, p, 'charon', { a: 1.9591e7, e: 0.0002, M: 0 });
      recenter(world);
      return { focus: p, zoom: 3.2e7, speed: 3600 * 6 };
    },
  },
  {
    id: 'giant-impact',
    name: 'Giant impact',
    blurb: 'A Mars-sized body onto the young Earth at 4 km/s. This is where the Moon came from.',
    build(world) {
      const earth = place(world, 'earth', { name: 'Proto-Earth' });
      earth.temperature = 1600;
      earth.crust = null;
      earth.differentiation = 0.9;
      earth.refresh();

      const theia = instantiate(CATALOG_BY_ID.get('planetesimal'), {
        massScale: (0.13 * M_EARTH) / (0.05 * M_EARTH),
        name: 'Theia',
      });
      // Aim for an impact parameter of 0.7 *at contact*. Gravity focuses the
      // trajectory on the way in, so the offset it needs to start with is much
      // larger than the offset it will arrive with. Angular momentum is
      // conserved — b·v is constant — which gives the offset directly.
      const Rsum = earth.radius + theia.radius;
      const d = Rsum * 12;
      const v0 = 4000;
      const mu = G * (earth.mass + theia.mass);
      const vContact = Math.sqrt(v0 * v0 + 2 * mu * (1 / Rsum - 1 / d));
      const bWanted = 0.7 * Rsum;
      const offset = (bWanted * vContact) / v0;

      theia.x = earth.x + d;
      theia.y = earth.y + offset;
      theia.vx = -v0;
      theia.vy = 0;
      world.add(theia);
      recenter(world);
      return { focus: earth, zoom: 1.1e8, speed: 60, hint: 'Impact in about half an hour of simulated time.' };
    },
  },
  {
    id: 'protoplanetary',
    name: 'Protoplanetary disc',
    blurb: '400 planetesimals around a young star. Leave it running and watch planets form.',
    build(world) {
      const star = place(world, 'sun', { massScale: 0.95, name: 'Protostar' });
      const rng = makeRng(0xd15c);
      const inner = 0.35 * AU, outer = 3.2 * AU;
      for (let i = 0; i < 400; i++) {
        // Surface density ~ r^-1.5, the minimum-mass solar nebula profile.
        const u = rng();
        const a = Math.pow(
          Math.pow(inner, -0.5) + u * (Math.pow(outer, -0.5) - Math.pow(inner, -0.5)), -2
        );
        const th = rng() * TAU;
        const e = Math.abs(gaussian(rng)) * 0.03;
        const body = new Body({
          name: 'Planetesimal', kind: 'asteroid',
          mass: 2e22 * Math.pow(rng(), 2.2) + 4e20,
          composition: a > 1.6 * AU
            ? { iron: 0.2, silicate: 0.5, ice: 0.3 }    // beyond the snow line
            : { iron: 0.3, silicate: 0.7 },
          temperature: clamp(280 * Math.sqrt(AU / a), 40, 1200),
          seed: hashSeed('ppd', i),
          spin: gaussian(rng) * 2e-4,
        });
        const s = stateFromElements(G * star.mass, a, e, rng() * TAU, th, body.mass);
        body.x = s.x; body.y = s.y; body.vx = s.vx; body.vy = s.vy;
        world.add(body);
      }
      recenter(world);
      return { focus: star, zoom: 3.6 * AU, speed: 3.15576e10, hint: 'Accretion takes a few thousand years — try 10 kyr/s.' };
    },
  },
  {
    id: 'figure-eight',
    name: 'Figure-eight choreography',
    blurb: 'Three equal masses chasing each other around one curve. A real, exact solution.',
    build(world) {
      // Chenciner & Montgomery (2000), in units where G = m = 1. Scaled here to
      // solar masses and astronomical units; it is stable to the fourteenth
      // digit, so it doubles as a test of the integrator.
      const L = AU;
      const M = M_SUN;
      const T = Math.sqrt((L * L * L) / (G * M));   // time unit
      const V = L / T;
      const r = [[0.97000436, -0.24308753], [-0.97000436, 0.24308753], [0, 0]];
      const v3 = [-0.93240737, -0.86473146];
      const v = [[-v3[0] / 2, -v3[1] / 2], [-v3[0] / 2, -v3[1] / 2], v3];
      const names = ['Alpha', 'Beta', 'Gamma'];
      for (let i = 0; i < 3; i++) {
        world.add(new Body({
          name: names[i], kind: 'star',
          mass: M,
          x: r[i][0] * L, y: r[i][1] * L,
          vx: v[i][0] * V, vy: v[i][1] * V,
          composition: { hydrogen: 0.74, helium: 0.25, carbon: 0.01 },
          seed: hashSeed('fig8', i),
        }));
      }
      return { focus: null, zoom: 1.6 * AU, speed: 2.628e6, hint: 'Period is 6.33 time units ≈ 1.01 years here.' };
    },
  },
  {
    id: 'binary-bh',
    name: 'Binary black holes',
    blurb: 'Two stellar-mass holes 3 000 km apart, with a star close enough to lose.',
    build(world) {
      const a = place(world, 'black-hole', { name: 'Primary' });
      const b = instantiate(CATALOG_BY_ID.get('black-hole'), { massScale: 0.7, name: 'Secondary' });
      const sep = 3.0e6;
      const total = a.mass + b.mass;
      const vrel = Math.sqrt((G * total) / sep);
      a.x = -sep * (b.mass / total); a.vy = -vrel * (b.mass / total);
      b.x = sep * (a.mass / total); b.vy = vrel * (a.mass / total);
      world.add(b);
      orbit(world, a, 'red-dwarf', { a: 9.0e8, e: 0.42, M: 0 }).name = 'Doomed companion';
      recenter(world);
      return { focus: a, zoom: 1.4e9, speed: 60 };
    },
  },
  {
    id: 'roche-shred',
    name: 'Roche limit',
    blurb: 'A moon dropped inside the limit. It comes apart into a ring, as Shoemaker-Levy did.',
    build(world) {
      const j = place(world, 'jupiter');
      const moon = instantiate(CATALOG_BY_ID.get('europa'), { name: 'Doomed moon' });
      // Just inside the fluid Roche limit for its density.
      const limit = 2.44 * j.radius * Math.pow(j.density / moon.density, 1 / 3);
      const d = limit * 0.82;
      const v = Math.sqrt((G * j.mass) / d) * 0.98;
      moon.x = j.x + d; moon.y = j.y;
      moon.vx = j.vx; moon.vy = j.vy + v;
      world.add(moon);
      recenter(world);
      return { focus: j, zoom: 6e8, speed: 3600 };
    },
  },
  {
    id: 'rogue-star',
    name: 'Rogue star flyby',
    blurb: 'A red dwarf cuts through a planetary system at 30 km/s. Very little survives.',
    build(world) {
      const sun = place(world, 'sun');
      for (const [id, a, e] of [
        ['earth', 1.0, 0.017], ['mars', 1.524, 0.093],
        ['jupiter', 5.204, 0.049], ['saturn', 9.537, 0.054],
      ]) {
        orbit(world, sun, id, { a: a * AU, e, M: Math.random() * TAU });
      }
      const rogue = instantiate(CATALOG_BY_ID.get('red-dwarf'), { massScale: 3.1, name: 'Intruder' });
      rogue.x = -42 * AU;
      rogue.y = -9 * AU;
      rogue.vx = 30000;
      rogue.vy = 6500;
      world.add(rogue);
      recenter(world);
      return { focus: sun, zoom: 16 * AU, speed: 3.15576e7, hint: 'Closest approach in about 6 years.' };
    },
  },
  {
    id: 'empty',
    name: 'Empty space',
    blurb: 'Nothing at all. Build something.',
    build(world) {
      return { focus: null, zoom: 2 * AU, speed: 86400 };
    },
  },
];

export const PRESETS_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function loadPreset(world, id) {
  const preset = PRESETS_BY_ID.get(id);
  if (!preset) return null;
  world.clear();
  const info = preset.build(world) || {};
  world.computeAccelerations();
  return { ...info, preset };
}
