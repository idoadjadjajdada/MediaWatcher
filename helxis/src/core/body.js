import {
  G, SIGMA_SB, T_CMB, M_SUN, R_SUN, L_SUN,
  schwarzschild, escapeVelocity, TAU, clamp,
} from './const.js';
import {
  MATERIALS, normalizeComposition, radiusFromMass, mixCompositions,
  differentiate, dominantMaterial, compositionProperty,
} from './materials.js';
import { hashSeed } from './rng.js';

/** `opts.x ?? fallback`, but rejecting NaN as well as undefined. */
function num(v, fallback) {
  return (v != null && isFinite(v)) ? v : fallback;
}

/** The logarithmic temperature bucket the sprite cache is keyed on. */
function bucketOf(t) {
  return Math.round(Math.log2(Math.max(1, t)) * 8);
}

let NEXT_ID = 1;
export const resetIds = (n = 1) => { NEXT_ID = n; };

/**
 * A celestial body.
 *
 * State is SI throughout. Anything derived — radius, density, escape velocity,
 * how molten the surface is — is recomputed from mass, composition and thermal
 * energy rather than stored independently, so a body cannot drift into a state
 * where its parts disagree with each other.
 */
export class Body {
  constructor(opts = {}) {
    this.id = opts.id != null ? opts.id : NEXT_ID++;
    if (this.id >= NEXT_ID) NEXT_ID = this.id + 1;

    this.name = opts.name || `Body ${this.id}`;
    this.kind = opts.kind || 'planet';   // star|planet|gasgiant|moon|asteroid|comet|debris|wd|ns|bh
    this.catalogId = opts.catalogId || null;

    // `!= null` rather than `||` throughout: a body at the origin, at rest, is
    // an entirely ordinary thing to ask for, and `||` silently replaced every
    // legitimate zero with a default.
    this.x = num(opts.x, 0);
    this.y = num(opts.y, 0);
    this.vx = num(opts.vx, 0);
    this.vy = num(opts.vy, 0);
    this.ax = 0;
    this.ay = 0;

    // A mass that was *given* must be usable. Only an absent one gets a default;
    // NaN is a bug upstream and swallowing it would hide where it came from.
    const mass = opts.mass === undefined ? 1e20 : opts.mass;
    if (!(mass > 0) || !isFinite(mass)) {
      throw new RangeError(`Body ${this.name}: mass must be finite and positive, got ${opts.mass}`);
    }
    this.mass = mass;
    this.composition = normalizeComposition(opts.composition || { silicate: 0.68, iron: 0.32 });

    // Thermal state. Temperature is the primary variable; thermal energy is
    // derived, because specific heat changes as composition changes.
    this.temperature = Math.max(T_CMB, num(opts.temperature, 255));
    // Fraction of the interior that has melted and re-sorted by density.
    this.differentiation = opts.differentiation != null ? opts.differentiation : 0;

    this.seed = opts.seed != null ? opts.seed : hashSeed(this.name, this.id, Math.random());
    // Derived from the seed, not from Math.random(): a body has to look the
    // same after a save and load, and that includes which way it is facing.
    this.rotation = opts.rotation != null
      ? opts.rotation
      : ((this.seed % 65536) / 65536) * TAU;
    this.spin = num(opts.spin, 0);   // rad/s
    // Impact record. Each entry is a crater in body-local polar coordinates,
    // so the surface remembers what hit it and from where.
    this.craters = opts.craters ? opts.craters.slice() : [];
    // Merge record: which parent surfaces mixed, how much of each, and along
    // what axis. This is what makes a merged planet look like its history.
    this.mixes = opts.mixes ? opts.mixes.map((m) => ({ ...m })) : [];

    // The outermost layer. A body's face is not its bulk: Earth's oceans are
    // two ten-thousandths of its mass and most of what you see. When the
    // surface melts the crust is stirred back into the differentiated mixture,
    // so a world that becomes a lava world stops looking like an ocean one.
    this.crust = opts.crust ? normalizeComposition(opts.crust) : null;

    this.luminosity = opts.luminosity || 0;  // W, non-zero for stars
    this.fixed = !!opts.fixed;               // held in place by the user
    this.alive = true;
    this.age = 0;                            // seconds of simulated existence
    this.selected = false;

    // Irradiation received from all stars, W/m^2. Recomputed each thermal tick.
    this.insolation = 0;
    this.trail = null;
    this.textureKey = '';
    this.texture = null;

    if (opts.radius !== undefined && opts.radius !== null) {
      if (!(opts.radius > 0) || !isFinite(opts.radius)) {
        throw new RangeError(`Body ${this.name}: radius must be finite and positive, got ${opts.radius}`);
      }
      this.radius = opts.radius;
      this.explicitRadius = true;
    } else {
      this.radius = radiusFromMass(this.mass, this.composition);
      this.explicitRadius = false;
    }
    // Bumped by anything that changes how the body looks. Counting craters and
    // merges was not enough: both lists are capped, so past the cap the key
    // stopped changing and a new impact never reached the screen.
    this.revision = num(opts.revision, 0);
    this.refresh();
  }

  /** Recompute everything that follows from mass, composition and temperature. */
  refresh() {
    if (this.kind === 'bh') {
      this.radius = schwarzschild(this.mass);
      this.density = this.mass / ((4 / 3) * Math.PI * Math.pow(this.radius, 3));
      this.luminosity = 0;
      // A horizon has no surface, but everything downstream still expects
      // these to exist rather than to be checked for.
      this.coreComposition = { degenerate: 1 };
      this.surfaceComposition = { degenerate: 1 };
      this.textureKey = `bh:${this.id}`;
      return;
    }
    if (!this.explicitRadius) {
      this.radius = radiusFromMass(this.mass, this.composition);
    }
    this.density = this.mass / ((4 / 3) * Math.PI * Math.pow(this.radius, 3));

    const { core, surface } = differentiate(this.composition, this.differentiation);
    this.coreComposition = core;
    if (this.crust) {
      const melt = compositionProperty(this.crust, 'melt') || 1400;
      const molten = Math.max(0, Math.min(1, (this.temperature - melt * 0.9) / (melt * 0.25)));
      this.surfaceComposition = molten > 0.001
        ? mixCompositions(this.crust, 1 - molten, surface, molten)
        : this.crust;
    } else {
      this.surfaceComposition = surface;
    }

    if (this.kind === 'star') {
      // Mass-luminosity relation, piecewise over the main sequence.
      const m = this.mass / M_SUN;
      let l;
      if (m < 0.43) l = 0.23 * Math.pow(m, 2.3);
      else if (m < 2) l = Math.pow(m, 4);
      else if (m < 55) l = 1.4 * Math.pow(m, 3.5);
      else l = 32000 * m;
      this.luminosity = l * L_SUN;
      if (!this.explicitRadius) {
        // Main-sequence mass-radius relation.
        this.radius = R_SUN * (m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57));
      }
      // Effective temperature from Stefan-Boltzmann, given L and R.
      this.temperature = Math.pow(
        this.luminosity / (4 * Math.PI * this.radius * this.radius * SIGMA_SB), 0.25
      );
      this.density = this.mass / ((4 / 3) * Math.PI * Math.pow(this.radius, 3));
    }

    // A short key: the texture cache invalidates when anything visible changes.
    // Temperature is bucketed logarithmically: regenerating a sprite for every
    // fractional kelvin would defeat the cache, and nothing visible changes.
    const tBucket = Math.round(Math.log2(Math.max(1, this.temperature)) * 8);
    this.textureKey = `${this.id}:${this.kind}:${this.seed}:${tBucket}:${this.revision}:${Math.round(this.differentiation * 16)}`;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get escapeVelocity() { return escapeVelocity(this.mass, this.radius); }
  get surfaceGravity() { return (G * this.mass) / (this.radius * this.radius); }
  get volume() { return (4 / 3) * Math.PI * Math.pow(this.radius, 3); }
  get isStar() { return this.kind === 'star'; }
  get isCompact() { return this.kind === 'bh' || this.kind === 'ns' || this.kind === 'wd'; }
  get specificHeat() {
    return Math.max(100, compositionProperty(this.composition, 'cp'));
  }
  get albedo() {
    return clamp(compositionProperty(this.surfaceComposition, 'albedo'), 0.02, 0.95);
  }

  /**
   * Gravitational binding energy of a uniform sphere, 3GM²/5R. The threshold a
   * collision has to beat to take the body apart.
   */
  get bindingEnergy() {
    return (3 * G * this.mass * this.mass) / (5 * this.radius);
  }

  /**
   * Material strength contribution to binding, which dominates below about a
   * kilometre. Above that, gravity wins by orders of magnitude.
   */
  get strengthEnergy() {
    return compositionProperty(this.composition, 'strength') * this.volume;
  }

  /** Kinetic energy in the current frame. */
  kineticEnergy() { return 0.5 * this.mass * (this.vx * this.vx + this.vy * this.vy); }

  /** Momentum. */
  get px() { return this.mass * this.vx; }
  get py() { return this.mass * this.vy; }

  /**
   * Add heat. Melting and vaporisation absorb latent heat, so a body sitting at
   * its melting point stays there until enough energy has gone in to finish the
   * phase change — which is why a laser flattens out at 1811 K on iron before
   * the temperature climbs again.
   */
  addHeat(joules) {
    if (this.kind === 'bh' || this.mass <= 0 || !joules) return;
    const tBefore = this.temperature;
    const cp = this.specificHeat;
    const melt = compositionProperty(this.composition, 'melt');
    const latent = compositionProperty(this.composition, 'latent');
    const capacity = this.mass * cp;
    if (!(capacity > 0)) return;

    let remaining = joules;

    // Heating goes in three stages, and the middle one is why a body sitting at
    // its melting point stays there: every joule is buying the phase change,
    // not a temperature. Point a laser at iron and it flattens out at 1811 K
    // until enough energy has gone in to finish melting, then climbs again.
    if (remaining > 0 && melt > 0) {
      if (this.temperature < melt) {
        const toMelt = (melt - this.temperature) * capacity;
        if (remaining <= toMelt) {
          this.temperature += remaining / capacity;
          if (bucketOf(tBefore) !== bucketOf(this.temperature)) this.revision++;
          this.refresh();
          return;
        }
        remaining -= toMelt;
        this.temperature = melt;
      }

      if (latent > 0 && this.differentiation < 1) {
        const budget = this.mass * latent * (1 - this.differentiation);
        if (remaining <= budget) {
          // Melting is also what lets a body sort itself by density, so the
          // latent heat and the differentiation are the same bookkeeping.
          this.differentiation = clamp(this.differentiation + remaining / (this.mass * latent), 0, 1);
          this.temperature = melt;
          this.revision++;
          this.refresh();
          return;
        }
        remaining -= budget;
        this.differentiation = 1;
      }
    }

    this.temperature = Math.max(T_CMB, this.temperature + remaining / capacity);
    if (bucketOf(tBefore) !== bucketOf(this.temperature)) this.revision++;
    this.refresh();
  }

  /**
   * Radiative cooling and stellar heating over `dt`.
   *
   * Cooling is Stefan-Boltzmann off the whole surface; heating is the absorbed
   * fraction of the insolation across the cross-section. The two balance at the
   * equilibrium temperature, which is why an airless rock at 1 AU settles near
   * 255 K without that number appearing anywhere.
   */
  thermalStep(dt) {
    if (this.kind === 'bh' || this.kind === 'star' || this.mass <= 0) return;
    const area = 4 * Math.PI * this.radius * this.radius;
    const cp = this.specificHeat;
    const heatCapacity = this.mass * cp;
    if (heatCapacity <= 0) return;

    const absorbed = this.insolation * (1 - this.albedo) * Math.PI * this.radius * this.radius;
    const emitted = SIGMA_SB * area * (Math.pow(this.temperature, 4) - Math.pow(T_CMB, 4));
    const net = absorbed - emitted;

    // Setting absorbed equal to emitted gives T⁴ = absorbed/(σA) + T_cmb⁴.
    const equilibrium = Math.pow((absorbed / (SIGMA_SB * area)) + Math.pow(T_CMB, 4), 0.25);
    const gap = equilibrium - this.temperature;
    if (Math.abs(gap) < 1e-9) { this.temperature = equilibrium; return; }

    // Relax toward equilibrium on a timescale chosen so the instantaneous rate
    // is exactly the physical one, net/(m·c). For a small step that reproduces
    // plain forward Euler; for a large one it approaches equilibrium and stops,
    // instead of overshooting it and ringing. Thermal timescales here run to
    // millions of years, so steps *are* large, and a forward Euler that jumped
    // a rock from 200 K to 334 K past a 268 K equilibrium is exactly what this
    // replaced.
    const rate = net / heatCapacity;              // K/s, exact at this instant
    if (rate === 0) return;
    const tau = gap / rate;
    // A negative tau would mean the flux points away from equilibrium, which
    // cannot happen physically; if rounding produces one, go straight there.
    const f = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
    const before = this.temperature;
    const target = Math.max(T_CMB, before + gap * f);

    // Route warming through addHeat so insolation buys latent heat and drives
    // differentiation exactly as impact heating does. Without this, a planet
    // dragged next to a star got hotter but never melted, never re-sorted its
    // interior, and — because the sprite cache is keyed on what refresh()
    // computes — never stopped looking cold.
    if (target > before) {
      this.addHeat((target - before) * heatCapacity);
    } else {
      this.temperature = target;
      // Cooling past the melting point freezes the surface back up.
      if (bucketOf(before) !== bucketOf(target)) this.revision++;
      this.refresh();
    }
  }

  /**
   * Stamp a crater from an impact arriving along the world-space direction
   * (dx, dy), made by a body of mass `impactorMass` and radius `impactorRadius`
   * arriving at `vImp`.
   *
   * Gravity-regime pi-group scaling (Schmidt & Housen):
   *
   *   pi_D = K1 · pi_2^(−mu/(2+mu)),   pi_D = D (rho_t/m_i)^(1/3),
   *                                     pi_2 = g L / v²
   *
   * with mu ≈ 0.55 for competent rock. Written this way the groups really are
   * dimensionless — an earlier version raised E/(rho·g) to the 1/3.4, and
   * E/(rho·g) has dimensions of m⁴, so the result was not a length at all and
   * the dependence on target gravity and density was wrong by construction.
   * This form tracks both Meteor Crater and Chicxulub across eight orders of
   * magnitude in energy.
   */
  addCrater(dx, dy, impactorMass, impactorRadius, vImp, rng) {
    const angle = Math.atan2(dy, dx) - this.rotation;
    const g = this.surfaceGravity;
    const L = Math.max(impactorRadius * 2, 1e-3);
    const v = Math.max(vImp, 1);
    let d;
    if (g > 0 && impactorMass > 0) {
      const MU = 0.55;
      const pi2 = (g * L) / (v * v);
      const piD = 1.6 * Math.pow(Math.max(pi2, 1e-30), -MU / (2 + MU));
      const transient = piD * Math.cbrt(impactorMass / Math.max(this.density, 1));

      // Small craters keep their bowl; past a transition diameter the walls
      // slump and the rim runs outward, so a big crater ends up much wider than
      // the hole the impact dug. The transition scales inversely with gravity —
      // about 3.2 km on Earth, and tens of kilometres on the Moon.
      const Dc = 3.2e3 * (9.81 / Math.max(g, 1e-6));
      d = transient < Dc
        ? transient * 1.25
        : 1.17 * Math.pow(transient, 1.13) / Math.pow(Dc, 0.13);
    } else {
      d = L * 10;
    }
    const size = d / this.radius;
    // Below about a percent of the disc a crater is smaller than the texels it
    // would be drawn into. Recording it would cost a texture regeneration and
    // change nothing on screen.
    if (!(size > 0.012)) return;
    const clamped = clamp(size, 0.012, 1.4);
    this.craters.push({
      a: angle,
      // Where on the visible disc: impacts near the limb are foreshortened.
      size: clamped,
      depth: clamp(0.3 + rng() * 0.5, 0.1, 0.9),
      age: 0,
      // Deep enough to expose the interior?
      exposesCore: clamped > 0.45,
    });
    if (this.craters.length > 48) this.craters.shift();
    this.revision++;
    this.refresh();
  }

  /** Serialisable snapshot, used for save/load and for undo. */
  toJSON() {
    return {
      id: this.id, name: this.name, kind: this.kind, catalogId: this.catalogId,
      x: this.x, y: this.y, vx: this.vx, vy: this.vy,
      mass: this.mass, radius: this.explicitRadius ? this.radius : undefined,
      composition: this.composition, temperature: this.temperature,
      differentiation: this.differentiation, rotation: this.rotation, spin: this.spin,
      seed: this.seed, craters: this.craters, mixes: this.mixes, crust: this.crust,
      revision: this.revision,
      luminosity: this.luminosity, fixed: this.fixed,
    };
  }

  static fromJSON(o) { return new Body(o); }

  /** Human-readable phase of the surface, for the inspector. */
  describeState() {
    if (this.kind === 'bh') return 'Singularity';
    if (this.kind === 'ns') return 'Neutron-degenerate';
    if (this.kind === 'wd') return 'Electron-degenerate';
    if (this.kind === 'star') return 'Plasma';
    const dom = dominantMaterial(this.surfaceComposition);
    const m = MATERIALS[dom];
    if (!m) return 'Solid';
    if (this.temperature >= m.boil) return `Vapour (${m.name.toLowerCase()})`;
    if (this.temperature >= m.melt) return `Molten ${m.name.toLowerCase()}`;
    if (this.temperature >= m.melt * 0.85) return `Softening ${m.name.toLowerCase()}`;
    return `Solid ${m.name.toLowerCase()}`;
  }
}

/**
 * Build a compact remnant. Collapse past electron degeneracy gives a white
 * dwarf, past neutron degeneracy a neutron star, past the Schwarzschild radius
 * a black hole. The thresholds are the real ones.
 */
export function classifyCompact(mass) {
  const m = mass / M_SUN;
  if (m >= 2.9) return 'bh';    // TOV limit, upper end
  if (m >= 1.4) return 'ns';    // Chandrasekhar limit
  return 'wd';
}

export function compactRadius(kind, mass) {
  if (kind === 'bh') return schwarzschild(mass);
  if (kind === 'ns') {
    // Neutron star radii are nearly mass-independent, ~11-12 km.
    return 1.15e4 * Math.pow(M_SUN / Math.max(mass, 0.1 * M_SUN), 1 / 3) * 0.99;
  }
  // White dwarf: the non-relativistic degenerate relation, R ∝ M^(−1/3),
  // anchored at 0.6 M☉ ≈ 7000 km. Left unclamped deliberately: for a body too
  // light to be degenerate it returns a radius larger than the body, and that
  // is exactly the signal a caller needs to refuse the collapse rather than
  // produce a "white dwarf" bigger than the planet it came from.
  return 7.0e6 * Math.pow((M_SUN * 0.6) / Math.max(mass, 1), 1 / 3);
}
