import { MATERIALS, normalizeComposition } from './materials.js';
import { clamp, SIGMA_SB, T_CMB } from './const.js';
import { makeRng, fbm, hashSeed } from './rng.js';

/**
 * A body's interior, as cells.
 *
 * Everything above this file treats a planet as a point with a composition
 * attached, which is why a collision could only ever be a swap: the target's
 * numbers were replaced with different numbers and a sprite was regenerated
 * from a seed. Nothing was ever *damaged*, because there was nothing there to
 * damage.
 *
 * A MaterialField is the thing there is to damage. It is a square lattice in
 * body-local coordinates, masked to a disc, one material per cell plus its
 * temperature, how much of it has melted, and — once it has — which way it is
 * flowing. An impact digs a bowl in it, heats what it did not throw away, and
 * injects the projectile as molten material at the bottom. What happens next
 * is not scripted: molten cells sink or rise by density, get carried around by
 * the swirl the impact left behind, and cool from the surface inward. When the
 * last of it freezes, the surface you are looking at is wherever the two
 * bodies' materials actually ended up.
 *
 * Coordinates: cell (i, j) sits at u = (i + 0.5) / N * 2 - 1 and likewise v,
 * so the disc is |(u, v)| <= 1 and one cell is 2/N across in units of the
 * body's radius. Local, not world: the field rotates with the body.
 */

/** Material name <-> index, fixed so a saved field reloads correctly. */
export const MATERIAL_KEYS = Object.keys(MATERIALS);
const MATERIAL_INDEX = new Map(MATERIAL_KEYS.map((k, i) => [k, i]));
export const EMPTY = 255;

const RHO = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].rho));
const MELT = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].melt));
const CP = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].cp));
const BOIL = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].boil));
const LATENT = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].latent));

export const matIndex = (key) => (MATERIAL_INDEX.has(key) ? MATERIAL_INDEX.get(key) : MATERIAL_INDEX.get('silicate'));
export const matKey = (i) => MATERIAL_KEYS[i] || 'silicate';

/**
 * Grid size for a body.
 *
 * Bigger bodies get more cells, but not many more: the cost of a relaxation
 * pass is quadratic in this and a magma ocean is relaxed every frame until it
 * freezes. 48 is enough that a crater reads as a crater; 96 is as far as it is
 * worth going for a planet you are looking at closely.
 */
export function gridSizeFor(radius) {
  if (radius > 3e7) return 96;
  if (radius > 3e6) return 72;
  if (radius > 3e5) return 56;
  return 40;
}

export class MaterialField {
  constructor(n, seed = 1) {
    this.n = n;
    this.seed = seed >>> 0;
    const c = n * n;
    this.mat = new Uint8Array(c).fill(EMPTY);
    this.temp = new Float32Array(c);
    this.melt = new Float32Array(c);      // 0 solid, 1 fully liquid
    this.vx = new Float32Array(c);        // local flow, cells per second-ish
    this.vy = new Float32Array(c);
    this.relief = new Float32Array(c);    // surface displacement, -1..1
    this.filled = 0;
    this.cellMass = 0;                    // kg represented by one filled cell
    this.moltenFraction = 0;
    this.revision = 0;
    this._scratch = null;
  }

  idx(i, j) { return j * this.n + i; }
  inside(i, j) { return i >= 0 && j >= 0 && i < this.n && j < this.n; }

  /** Body-local coordinates of a cell centre, in units of the body radius. */
  u(i) { return ((i + 0.5) / this.n) * 2 - 1; }

  /**
   * Build a field for a body that has never been hit.
   *
   * The layering is the body's own differentiation: whatever sank is in the
   * middle, whatever floated is on the outside, with the boundary drawn at the
   * radius that gives each its share of the area rather than at a fixed depth.
   * The boundary is roughened so a later impact does not expose a suspiciously
   * perfect circle of core.
   */
  static build(body, n = gridSizeFor(body.radius)) {
    const f = new MaterialField(n, body.seed);
    const rng = makeRng(hashSeed(body.seed, 'field'));
    const core = normalizeComposition(body.coreComposition || body.composition);
    const shell = normalizeComposition(body.surfaceComposition || body.composition);

    // Where the core ends. Volume fraction in 2D is area fraction, so the
    // radius is the square root of the fraction of mass that sank, corrected
    // for the density difference so a small dense core is not drawn too big.
    const coreRho = mixDensity(core);
    const shellRho = mixDensity(shell);
    const coreMassFrac = clamp(body.differentiation * 0.42, 0, 0.62);
    const volFrac = coreRho > 0
      ? clamp((coreMassFrac / coreRho) / ((coreMassFrac / coreRho) + ((1 - coreMassFrac) / Math.max(shellRho, 1))), 0, 0.85)
      : 0;
    const rCore = Math.sqrt(volFrac);

    const corePick = picker(core, rng);
    const shellPick = picker(shell, rng);

    let filled = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const u = f.u(i), v = f.u(j);
        const r = Math.hypot(u, v);
        if (r > 1) continue;
        const k = f.idx(i, j);
        // A wobble on the core boundary, so it is a boundary and not a circle.
        const wob = (fbm(u * 3.1 + 5, v * 3.1 - 2, f.seed ^ 0x51ab, 3) - 0.5) * 0.12;
        f.mat[k] = (r < rCore + wob ? corePick() : shellPick());
        // A geotherm: hotter with depth, surface at the body's temperature.
        f.temp[k] = body.temperature + (1 - r) * (1 - r) * Math.max(0, body.temperature * 0.35 + 220);
        f.relief[k] = (fbm(u * 4.4 - 3, v * 4.4 + 7, f.seed ^ 0x77c1, 4) - 0.5) * 0.5;
        filled++;
      }
    }
    f.filled = filled;
    f.cellMass = filled > 0 ? body.mass / filled : 0;
    f.syncMelt();
    return f;
  }

  /** Total mass currently in the field. */
  totalMass() { return this.filled * this.cellMass; }

  /** Recompute melt fractions from temperature, and the molten total. */
  syncMelt() {
    const { mat, temp, melt, n } = this;
    let molten = 0, filled = 0;
    for (let k = 0; k < n * n; k++) {
      const m = mat[k];
      if (m === EMPTY) { melt[k] = 0; continue; }
      filled++;
      const tm = MELT[m];
      // A melting range rather than a point: rock does not go from solid to
      // liquid at one temperature, and a hard switch made the fluid step
      // flicker cells in and out of motion.
      const frac = clamp((temp[k] - tm * 0.86) / (tm * 0.28), 0, 1);
      melt[k] = frac;
      molten += frac;
    }
    this.filled = filled;
    this.moltenFraction = filled > 0 ? molten / filled : 0;
    return this.moltenFraction;
  }

  /** Composition of the whole field, by mass. */
  composition() {
    const { mat, n } = this;
    const acc = {};
    let total = 0;
    for (let k = 0; k < n * n; k++) {
      const m = mat[k];
      if (m === EMPTY) continue;
      const w = RHO[m];
      acc[matKey(m)] = (acc[matKey(m)] || 0) + w;
      total += w;
    }
    if (total <= 0) return null;
    for (const key in acc) acc[key] /= total;
    return acc;
  }

  /** Composition of the outer shell only — what a telescope would see. */
  surfaceComposition(depth = 0.22) {
    const { mat, n } = this;
    const acc = {};
    let total = 0;
    const inner = 1 - depth;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = this.idx(i, j);
        const m = mat[k];
        if (m === EMPTY) continue;
        if (Math.hypot(this.u(i), this.u(j)) < inner) continue;
        const w = RHO[m];
        acc[matKey(m)] = (acc[matKey(m)] || 0) + w;
        total += w;
      }
    }
    if (total <= 0) return this.composition();
    for (const key in acc) acc[key] /= total;
    return acc;
  }

  // --- damage ---------------------------------------------------------------

  /**
   * Dig a crater, heat what is left of it, and put the projectile in the hole.
   *
   * `cu, cv` is the contact point in local coordinates, `craterR` the crater's
   * radius in the same units (the caller gets it from the Schmidt-Housen
   * scaling that already exists, so the size of the hole is the size the
   * scaling says). Everything inside is treated as excavated: material above
   * the escape energy leaves and is reported back for the caller to spawn as
   * debris, and what stays is melted and slumped into a bowl.
   *
   * Returns { ejectedCells, ejected: {material: fraction}, swirl }.
   */
  excavate(opts) {
    const {
      cu, cv, craterR, specificEnergy, escapeEnergy,
      projMassFraction = 0, projComp = null, tangential = 0, rng = Math.random,
    } = opts;
    const { n, mat, temp, melt, vx, vy, relief } = this;
    const r2 = craterR * craterR;
    const ejected = {};
    let ejectedCells = 0;

    // Cell window around the contact point, so a 2% crater does not cost a
    // sweep of the whole grid — which is the difference between a planet you
    // can bombard and one you cannot.
    const lo = Math.max(0, Math.floor(((cu - craterR + 1) / 2) * n) - 1);
    const hi = Math.min(n - 1, Math.ceil(((cu + craterR + 1) / 2) * n) + 1);
    const loJ = Math.max(0, Math.floor(((cv - craterR + 1) / 2) * n) - 1);
    const hiJ = Math.min(n - 1, Math.ceil(((cv + craterR + 1) / 2) * n) + 1);

    // Everything the impact disturbs, and how deep each cell sits under the
    // point of contact. Excavating a crater is not the same as losing its
    // contents: a basin-forming impact throws far more material than it loses,
    // and almost all of it comes straight back down as a rim and a fill. Only
    // the part moving faster than the body can hold on to actually leaves.
    // Treating the whole bowl as lost cost the Earth four percent of its mass
    // per 1e20 kg impactor, which is off by about four orders of magnitude.
    const bowl = [];
    for (let j = loJ; j <= hiJ; j++) {
      for (let i = lo; i <= hi; i++) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY) continue;
        const du = this.u(i) - cu, dv = this.u(j) - cv;
        if (du * du + dv * dv > r2) continue;
        bowl.push(k);
      }
    }

    // The impact brought projMass * specificEnergy of kinetic energy, and it is
    // shared over everything the crater disturbed — not applied to each cell in
    // turn. Per-cell deposition put 200,000 K into a bowl from one 20 km/s
    // impact, because it was spending the whole impact's energy on every cell
    // it touched. About half goes to heat; the rest is spent excavating,
    // launching and deforming.
    const bowlMass = Math.max(bowl.length, 1);
    const perCell = bowl.length
      ? (0.5 * projMassFraction * this.filled * specificEnergy) / bowlMass
      : 0;

    for (const k of bowl) {
      const i = k % n, j = (k - i) / n;
      const du = this.u(i) - cu, dv = this.u(j) - cv;
      const d = Math.min(1, Math.hypot(du, dv) / craterR);
      // Energy falls off from the point of contact. The 1 - d^2 profile is
      // what makes the bowl a bowl rather than a cylinder.
      const share = (1 - d * d) * (0.55 + rng() * 0.9);
      // Condensed matter has a ceiling: past its boiling point the next joule
      // makes vapour, not a hotter rock. Without the cap a giant impact read
      // 16,000 K, which is hotter than the photosphere of the star it orbits.
      const ceiling = BOIL[mat[k]] * 1.25;
      temp[k] = Math.min(ceiling, temp[k] + (perCell * share) / Math.max(CP[mat[k]], 1));
      relief[k] = clamp(relief[k] - (1 - d) * 0.75, -1, 1);
      if (tangential !== 0) {
        const s = tangential * (1 - d);
        vx[k] += -dv * s;
        vy[k] += du * s;
      }
    }

    // What escapes. The launch speed of ejecta falls off steeply with the mass
    // launched, so the fraction leaving at more than escape velocity is small
    // and only grows once the impact is well past that speed. Below escape
    // nothing leaves at all, which is why a slow impact only ever makes a hole.
    const over = escapeEnergy > 0 ? specificEnergy / escapeEnergy : 0;
    const escapeFrac = clamp((over - 1) * 0.035, 0, 0.35);
    const injectQueue = [];
    if (escapeFrac > 0 && bowl.length) {
      // It leaves from the surface, not from the bottom of the hole: the
      // deepest material is buried by the impact, not launched by it.
      bowl.sort((a, b) => {
        const ai = a % n, bi = b % n;
        return Math.hypot(this.u(bi), this.u((b - bi) / n))
          - Math.hypot(this.u(ai), this.u((a - ai) / n));
      });
      // And an energy budget on top of the geometry. Lifting mass to escape
      // costs escapeEnergy per kilogram, and the impact only brought
      // projMass * specificEnergy to spend — most of which goes into heat and
      // deformation, not into launching anything. Without this bound the
      // geometry alone had a 1e20 kg impactor throwing 2e22 kg of Earth away,
      // two hundred times its own mass, because the crater it digs is genuinely
      // that wide; the crater being wide is not the same as its contents
      // leaving.
      const budget = this.filled * projMassFraction * 0.1 * over;
      const count = Math.min(bowl.length, Math.round(Math.min(bowl.length * escapeFrac, budget)));
      for (let q = 0; q < count; q++) {
        const k = bowl[q];
        const key = matKey(mat[k]);
        ejected[key] = (ejected[key] || 0) + 1;
        ejectedCells++;
        mat[k] = EMPTY;
        melt[k] = 0;
        vx[k] = 0; vy[k] = 0;
        injectQueue.push(k);
      }
    }

    // The rest of the excavated material lands around the hole. Raising the
    // rim is what makes a crater read as a crater rather than as a dent.
    const rimR = craterR * 1.35, rim2 = rimR * rimR;
    for (let j = Math.max(0, loJ - 2); j <= Math.min(n - 1, hiJ + 2); j++) {
      for (let i = Math.max(0, lo - 2); i <= Math.min(n - 1, hi + 2); i++) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY) continue;
        const du = this.u(i) - cu, dv = this.u(j) - cv;
        const d2 = du * du + dv * dv;
        if (d2 <= r2 || d2 > rim2) continue;
        const t = (Math.sqrt(d2) - craterR) / Math.max(rimR - craterR, 1e-6);
        relief[k] = clamp(relief[k] + (1 - t) * 0.45, -1, 1);
      }
    }

    // The projectile ends up at the bottom of the hole it made, molten. It
    // goes into the cells that were just emptied, deepest first, so the two
    // materials start out in contact rather than side by side.
    if (projMassFraction > 0 && projComp) {
      const pick = picker(normalizeComposition(projComp), rng);
      const want = Math.max(1, Math.round(projMassFraction * this.filled));
      injectQueue.sort((a, b) => {
        const ai = a % n, aj = (a - ai) / n, bi = b % n, bj = (b - bi) / n;
        return Math.hypot(this.u(ai) - cu, this.u(aj) - cv)
          - Math.hypot(this.u(bi) - cu, this.u(bj) - cv);
      });
      let placed = 0;
      for (const k of injectQueue) {
        if (placed >= want) break;
        mat[k] = pick();
        // Hot enough to be liquid: this is the material that took the impact.
        temp[k] = Math.min(BOIL[mat[k]] * 1.25, Math.max(temp[k], MELT[mat[k]] * 1.35));
        melt[k] = 1;
        placed++;
      }
      // Anything that did not fit goes into the nearest solid cells, replacing
      // them — a big impactor buries part of the target rather than sitting on
      // top of it.
      if (placed < want) {
        for (let j = loJ; j <= hiJ && placed < want; j++) {
          for (let i = lo; i <= hi && placed < want; i++) {
            const k = this.idx(i, j);
            if (mat[k] === EMPTY) continue;
            const du = this.u(i) - cu, dv = this.u(j) - cv;
            if (du * du + dv * dv > r2) continue;
            mat[k] = pick();
            temp[k] = Math.min(BOIL[mat[k]] * 1.25, Math.max(temp[k], MELT[mat[k]] * 1.35));
            melt[k] = 1;
            placed++;
          }
        }
      }
    }

    this.revision++;
    this.syncMelt();
    // Normalise the ejecta tally into fractions.
    let tot = 0;
    for (const key in ejected) tot += ejected[key];
    if (tot > 0) for (const key in ejected) ejected[key] /= tot;
    return { ejectedCells, ejected: tot > 0 ? ejected : null };
  }

  /**
   * Melt everything, everywhere — what a giant impact does that a crater does
   * not. `frac` is the fraction of the body that ends up above its melting
   * point, and `swirl` the angular momentum it arrived with.
   */
  shock(frac, extraTemp, swirl, rng = Math.random) {
    const { n, mat, temp, vx, vy } = this;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY) continue;
        const u = this.u(i), v = this.u(j);
        // Shock heating is strongest where the two bodies met and falls off
        // through the target, so a merge leaves a temperature gradient rather
        // than a uniformly molten ball.
        const w = clamp(frac * (0.55 + 0.9 * rng()), 0, 1);
        temp[k] = Math.min(BOIL[mat[k]] * 1.25, temp[k] + extraTemp * w);
        if (swirl !== 0) {
          vx[k] += -v * swirl;
          vy[k] += u * swirl;
        }
      }
    }
    this.revision++;
    this.syncMelt();
  }

  // --- flow -----------------------------------------------------------------

  /**
   * One relaxation pass: conduct, radiate, sink, swirl, and slump.
   *
   * Nothing here is scripted. Iron sinks because it is denser than what is
   * under it, the surface freezes first because that is where the heat leaves,
   * and a crater fills in only if there is enough melt around it to flow —
   * which is why a small impact leaves a hole and a large one does not.
   *
   * Returns true while there is still something happening.
   */
  relax(dt, ctx) {
    if (!(dt > 0)) return this.moltenFraction > 0.01;
    const { n, mat, temp, melt, vx, vy, relief } = this;
    const cells = n * n;
    const surfaceT = ctx.equilibriumT || T_CMB;
    // How much of the body's own thermal timescale this step covers. Capped so
    // one very long step cannot overshoot into nonsense.
    const tau = Math.max(ctx.coolSeconds || 3.15e7, 1);
    const step = clamp(dt / tau, 0, 0.25);

    if (!this._scratch || this._scratch.length !== cells) this._scratch = new Float32Array(cells);
    const next = this._scratch;

    // --- conduction and radiation -------------------------------------------
    // A Jacobi pass toward the neighbour mean, plus a surface term. Cells with
    // fewer than four neighbours are the surface by definition, so the
    // radiating boundary needs no separate bookkeeping.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY) { next[k] = 0; continue; }
        let sum = 0, cnt = 0, exposed = 0;
        for (let d = 0; d < 4; d++) {
          const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (!this.inside(ni, nj) || mat[this.idx(ni, nj)] === EMPTY) { exposed++; continue; }
          sum += temp[this.idx(ni, nj)]; cnt++;
        }
        let t = temp[k];
        // Molten rock convects, and convection moves heat orders of magnitude
        // faster than conduction does. Without this the only transport was a
        // Jacobi pass, which crosses an n-cell body in about n^2 steps: a
        // magma ocean stayed 74% molten after four hundred steps and would
        // have taken thousands to freeze. Scaling the diffusivity with the
        // melt fraction is the cheap stand-in for a convecting cell, and it is
        // the right direction and roughly the right size.
        const mobility = 1.6 + melt[k] * 22;
        if (cnt > 0) t += (sum / cnt - t) * clamp(step * mobility, 0, 0.85);
        if (exposed > 0) {
          // Stefan-Boltzmann, linearised over the step so a very hot cell
          // cannot radiate past its own equilibrium and go negative.
          const target = Math.max(surfaceT, T_CMB);
          const drive = (t * t * t * t - target * target * target * target)
            / Math.max(t * t * t * t + 1, 1);
          t -= (t - target) * clamp(drive * step * exposed * 1.3, 0, 0.6);
        }
        next[k] = Math.max(T_CMB, t);
      }
    }
    for (let k = 0; k < cells; k++) if (mat[k] !== EMPTY) temp[k] = next[k];

    // --- convective overturn --------------------------------------------------
    // A Jacobi pass moves heat one cell per step whatever its coefficient, so a
    // 64-cell body needs 64 steps for the middle to hear about the surface, and
    // the cooling curve stalled: 300 steps took a magma ocean from 3942 K only
    // to 2327 K, with the rate still falling.
    //
    // That is not how a magma ocean cools. A convecting layer overturns as a
    // unit and sits close to isothermal, and the rate is then set by what the
    // surface can radiate rather than by how fast heat crawls outward. So the
    // melt is pulled toward its own mean, in proportion to how molten it is.
    // The solid parts are untouched and still conduct, which is what keeps a
    // frozen lid insulating.
    {
      let hot = 0, w = 0;
      for (let k = 0; k < cells; k++) {
        if (mat[k] === EMPTY || melt[k] < 0.2) continue;
        hot += temp[k] * melt[k]; w += melt[k];
      }
      if (w > 0) {
        const mean = hot / w;
        const mix = clamp(step * 4.5, 0, 0.9);
        for (let k = 0; k < cells; k++) {
          if (mat[k] === EMPTY || melt[k] < 0.2) continue;
          temp[k] += (mean - temp[k]) * mix * melt[k];
        }
      }
    }

    const molten = this.syncMelt();
    if (molten < 0.004) {
      // Frozen. Damp what is left and stop: a solid planet costs nothing.
      for (let k = 0; k < cells; k++) { vx[k] = 0; vy[k] = 0; }
      return false;
    }

    // --- density sorting ------------------------------------------------------
    // Denser material above lighter material, with both soft enough to move,
    // swaps. Repeated over many steps this is differentiation, and after a
    // merge it is what buries the impactor's iron in the target's core.
    const parity = (this.revision++) & 1;
    for (let j = 0; j < n; j++) {
      for (let i = (j + parity) & 1; i < n; i += 2) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY || melt[k] < 0.25) continue;
        const u = this.u(i), v = this.u(j);
        const r = Math.hypot(u, v) || 1e-6;
        // The neighbour one step toward the centre.
        const ii = i - Math.round(u / r), jj = j - Math.round(v / r);
        if (!this.inside(ii, jj)) continue;
        const k2 = this.idx(ii, jj);
        if (mat[k2] === EMPTY || melt[k2] < 0.25) continue;
        if (RHO[mat[k]] > RHO[mat[k2]] * 1.02) {
          const m = mat[k]; mat[k] = mat[k2]; mat[k2] = m;
          const t = temp[k]; temp[k] = temp[k2]; temp[k2] = t;
          const f = melt[k]; melt[k] = melt[k2]; melt[k2] = f;
        }
      }
    }

    // --- swirl ----------------------------------------------------------------
    // Molten cells carry material around with them and lose speed to drag. The
    // exchange is with the neighbour they are heading toward, which mixes the
    // two materials along the flow instead of rotating a rigid pattern.
    let moved = 0;
    for (let j = 0; j < n; j++) {
      for (let i = (j + parity + 1) & 1; i < n; i += 2) {
        const k = this.idx(i, j);
        if (mat[k] === EMPTY || melt[k] < 0.35) continue;
        const sx = vx[k], sy = vy[k];
        const sp = Math.hypot(sx, sy);
        if (sp < 1e-4) continue;
        const ii = i + (Math.abs(sx) > Math.abs(sy) ? Math.sign(sx) : 0);
        const jj = j + (Math.abs(sy) >= Math.abs(sx) ? Math.sign(sy) : 0);
        if (!this.inside(ii, jj)) continue;
        const k2 = this.idx(ii, jj);
        if (mat[k2] === EMPTY || melt[k2] < 0.2) continue;
        if (Math.min(sp, 1) * step * 40 > 0.5) {
          const m = mat[k]; mat[k] = mat[k2]; mat[k2] = m;
          const t = temp[k]; temp[k] = temp[k2]; temp[k2] = t;
          moved++;
        }
        const drag = 1 - clamp(step * 3.5, 0, 0.9);
        vx[k] *= drag; vy[k] *= drag;
      }
    }

    // --- slump ----------------------------------------------------------------
    // Melt flows downhill into holes. A crater in solid rock stays a crater;
    // one in a magma ocean closes, which is the whole difference between a
    // small impact and a large one.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = this.idx(i, j);
        if (mat[k] !== EMPTY) {
          // Relief relaxes toward flat wherever the ground is soft.
          if (melt[k] > 0.3) relief[k] *= 1 - clamp(step * 2.2 * melt[k], 0, 0.5);
          continue;
        }
        const u = this.u(i), v = this.u(j);
        if (Math.hypot(u, v) > 1) continue;
        // An empty cell inside the body pulls in the most molten neighbour.
        let best = -1, bestMelt = 0.3;
        for (let d = 0; d < 4; d++) {
          const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (!this.inside(ni, nj)) continue;
          const k2 = this.idx(ni, nj);
          if (mat[k2] === EMPTY) continue;
          if (melt[k2] > bestMelt) { bestMelt = melt[k2]; best = k2; }
        }
        if (best >= 0) {
          mat[k] = mat[best]; temp[k] = temp[best]; melt[k] = melt[best];
          // Clamped: this runs every step for as long as a hole is being fed,
          // and an unclamped subtraction drove the relief of a small crater to
          // -1.8 over a few hundred steps, well past the -1..1 the renderer
          // reads as a depth.
          relief[k] = clamp(relief[best] - 0.15, -1, 1);
          mat[best] = EMPTY; melt[best] = 0;
          moved++;
        }
      }
    }

    this.syncMelt();
    return true;
  }

  // --- serialisation --------------------------------------------------------

  /**
   * Compact enough to sit in a save file.
   *
   * The material grid run-length encodes well — a planet is large regions of
   * one thing — and temperature is quantised to 4 K, which is far finer than
   * anything downstream distinguishes. Melt and flow are not stored: melt is
   * derived from temperature on load, and a flow field that a reload does not
   * reproduce exactly is not something anyone can perceive.
   */
  toJSON() {
    const runs = [];
    let cur = this.mat[0], len = 0;
    for (let k = 0; k < this.mat.length; k++) {
      if (this.mat[k] === cur) { len++; continue; }
      runs.push(cur, len); cur = this.mat[k]; len = 1;
    }
    runs.push(cur, len);
    const t = new Array(this.temp.length);
    for (let k = 0; k < t.length; k++) t[k] = Math.round(this.temp[k] / 4);
    const rel = new Array(this.relief.length);
    for (let k = 0; k < rel.length; k++) rel[k] = Math.round(this.relief[k] * 100);
    return { n: this.n, seed: this.seed, cellMass: this.cellMass, runs, t, rel };
  }

  static fromJSON(o) {
    if (!o || !o.n) return null;
    const f = new MaterialField(o.n, o.seed);
    let k = 0;
    for (let i = 0; i < o.runs.length; i += 2) {
      const m = o.runs[i], len = o.runs[i + 1];
      for (let q = 0; q < len && k < f.mat.length; q++) f.mat[k++] = m;
    }
    if (o.t) for (let i = 0; i < f.temp.length && i < o.t.length; i++) f.temp[i] = o.t[i] * 4;
    if (o.rel) for (let i = 0; i < f.relief.length && i < o.rel.length; i++) f.relief[i] = o.rel[i] / 100;
    f.cellMass = o.cellMass || 0;
    f.syncMelt();
    return f;
  }

  /** Mass-weighted mean temperature. */
  meanTemperature() {
    const { mat, temp, n } = this;
    let t = 0, c = 0;
    for (let k = 0; k < n * n; k++) {
      if (mat[k] === EMPTY) continue;
      t += temp[k]; c++;
    }
    return c > 0 ? t / c : T_CMB;
  }
}

// --- helpers ---------------------------------------------------------------

function mixDensity(comp) {
  let d = 0, w = 0;
  for (const key in comp) {
    const m = MATERIALS[key];
    if (!m || !(comp[key] > 0)) continue;
    d += m.rho * comp[key];
    w += comp[key];
  }
  return w > 0 ? d / w : 3000;
}

/**
 * A sampler that returns material indices in the proportions of a composition.
 *
 * Drawing independently per cell would give a uniform speckle; real rock is
 * patchy. So the draw is biased by a coarse noise field, which puts each
 * material in coherent regions of a few cells while keeping the totals right.
 */
function picker(comp, rng) {
  const keys = [], cum = [];
  let acc = 0;
  for (const key in comp) {
    if (!(comp[key] > 0) || !MATERIALS[key]) continue;
    acc += comp[key];
    keys.push(matIndex(key));
    cum.push(acc);
  }
  if (!keys.length) return () => matIndex('silicate');
  return () => {
    const x = rng() * acc;
    for (let i = 0; i < keys.length; i++) if (x <= cum[i]) return keys[i];
    return keys[keys.length - 1];
  };
}

export { mixDensity, RHO, MELT, CP, LATENT, SIGMA_SB };
