import { MATERIALS, normalizeComposition } from './materials.js';
import { G, clamp, T_CMB, SIGMA_SB } from './const.js';
import { makeRng, hashSeed } from './rng.js';
import { MATERIAL_KEYS, matIndex, matKey } from './cells.js';

/**
 * Matter, as parcels, in world coordinates.
 *
 * The cell field in `cells.js` gave a body an interior, but it was still an
 * interior *of a body*: a lattice locked to a disc, which meant a planet could
 * be damaged but not deformed, and two of them could still only resolve into
 * one new sphere. Bodies appeared and disappeared by decree.
 *
 * A GrainSystem has no bodies in it. It has parcels — position, velocity, mass,
 * material, temperature — that pull on each other by gravity, push on each
 * other on contact, stick to each other while they are cold enough, and stop
 * sticking when they melt. A planet is a few thousand of them held together by
 * their own gravity. A collision is those parcels hitting other parcels. A moon
 * is what you get when some of them end up in orbit and find each other.
 *
 * Nothing in here knows what a planet is, and nothing decides an outcome. The
 * shape during an impact is whatever the parcels are doing, which is the point:
 * a body being hit is not a sphere, and should not look like one.
 */

const RHO = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].rho));
const MELT = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].melt));
const CP = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].cp));
const STRENGTH = new Float32Array(MATERIAL_KEYS.map((k) => MATERIALS[k].strength));

/**
 * How hard parcels hold on to each other, relative to the material's bulk
 * strength.
 *
 * Real rock is far stronger than this per unit area, but a parcel is a
 * kilometres-wide chunk rather than a laboratory sample, and rubble at that
 * scale is held together mostly by gravity. Tuned so that a body survives its
 * own weight and a hypervelocity impact takes it apart.
 */
const COHESION_SCALE = 4e-9;

export class GrainSystem {
  constructor(opts = {}) {
    this.cap = opts.cap || 6000;
    const c = this.cap;
    this.x = new Float64Array(c);
    this.y = new Float64Array(c);
    this.vx = new Float64Array(c);
    this.vy = new Float64Array(c);
    this.mass = new Float64Array(c);
    this.r = new Float64Array(c);
    this.mat = new Uint8Array(c);
    this.temp = new Float32Array(c);
    this.melt = new Float32Array(c);
    this.cluster = new Int32Array(c);
    this.n = 0;

    // Uniform hash grid for contacts. Parcels in one event are all much the
    // same size, which is exactly when a grid beats a tree.
    this._cellSize = 0;
    this._heads = null;
    this._next = new Int32Array(c);
    this._parent = new Int32Array(c);   // union-find, for clustering
    this._seen = new Int32Array(c);
  }

  clear() { this.n = 0; }

  add(px, py, pvx, pvy, m, matIdx, temperature, radius) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.x[i] = px; this.y[i] = py;
    this.vx[i] = pvx; this.vy[i] = pvy;
    this.mass[i] = m; this.mat[i] = matIdx;
    this.temp[i] = temperature; this.r[i] = radius;
    this.melt[i] = meltOf(matIdx, temperature);
    this.cluster[i] = -1;
    return i;
  }

  remove(i) {
    const last = --this.n;
    if (i !== last) {
      this.x[i] = this.x[last]; this.y[i] = this.y[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
      this.mass[i] = this.mass[last]; this.r[i] = this.r[last];
      this.mat[i] = this.mat[last]; this.temp[i] = this.temp[last];
      this.melt[i] = this.melt[last]; this.cluster[i] = this.cluster[last];
    }
  }

  totalMass() {
    let m = 0;
    for (let i = 0; i < this.n; i++) m += this.mass[i];
    return m;
  }

  /**
   * Fill a disc with parcels laid out on a hexagonal lattice.
   *
   * Hexagonal rather than square because a square lattice has preferred shear
   * directions, and a body shattered on one comes apart along the axes in a way
   * you can see. The layering follows the body's own differentiation, so an
   * impact that digs deep enough exposes core material because the core
   * material is actually down there.
   */
  addBody(body, count) {
    const R = body.radius;
    const wanted = clamp(Math.round(count), 24, this.cap - this.n);
    if (wanted < 4) return 0;

    // Lattice spacing that puts roughly `wanted` parcels in the disc. A hex
    // lattice packs pi/(2*sqrt(3)) of the plane, so this is the spacing whose
    // cells tile the area.
    const spacing = R * Math.sqrt((2 * Math.PI) / (Math.sqrt(3) * wanted));
    const rp = spacing * 0.5;
    const rows = Math.ceil((2 * R) / (spacing * 0.8660254)) + 1;

    const core = normalizeComposition(body.coreComposition || body.composition);
    const shell = normalizeComposition(body.surfaceComposition || body.composition);
    const rng = makeRng(hashSeed(body.seed, 'grains'));
    const coreFrac = clamp(body.differentiation * 0.42, 0, 0.62);
    const rCore = Math.sqrt(clamp(coreFrac, 0, 0.8));
    const corePick = picker(core, rng);
    const shellPick = picker(shell, rng);

    const cosR = Math.cos(body.rotation), sinR = Math.sin(body.rotation);
    const placed = [];
    for (let row = 0; row < rows; row++) {
      const ly = -R + row * spacing * 0.8660254;
      const offset = (row & 1) ? spacing * 0.5 : 0;
      for (let lx = -R + offset; lx <= R; lx += spacing) {
        const d = Math.hypot(lx, ly);
        if (d > R - rp * 0.4) continue;
        placed.push([lx, ly, d / R]);
      }
    }
    if (!placed.length) return 0;

    const each = body.mass / placed.length;
    let added = 0;
    for (const [lx, ly, frac] of placed) {
      const m = frac < rCore ? corePick() : shellPick();
      // Rotate into world space, and carry the body's spin as a real velocity
      // so a spinning body shatters into parcels that are still spinning.
      const wx = body.x + lx * cosR - ly * sinR;
      const wy = body.y + lx * sinR + ly * cosR;
      const rx = wx - body.x, ry = wy - body.y;
      const t = body.temperature + (1 - frac) * (1 - frac) * Math.max(0, body.temperature * 0.3 + 200);
      const i = this.add(
        wx, wy,
        body.vx - body.spin * ry, body.vy + body.spin * rx,
        each, m, t, rp,
      );
      if (i < 0) break;
      added++;
    }
    return added;
  }

  // --- the step -------------------------------------------------------------

  /**
   * Gravity, contact, cohesion, heat.
   *
   * `external` is called for each parcel to add whatever the rest of the
   * universe is doing to it, so distant bodies still pull on debris without
   * this having to know they exist.
   */
  step(dt, opts = {}) {
    const n = this.n;
    if (n === 0 || !(dt > 0)) return;
    const softening = opts.softening || 0;

    // --- self-gravity, direct-summed over a coarse grid ---------------------
    // Parcels are all much the same mass and clumped together, so a plain
    // Barnes-Hut is overkill and a uniform grid of monopoles is not: distant
    // cells contribute as a point, near ones parcel by parcel.
    //
    // Not every substep. Contacts need a step short enough that a parcel cannot
    // cross its own radius; gravity needs nothing of the sort, and recomputing
    // it at the contact cadence was two thirds of the entire cost. Held for a
    // few substeps it is the same field to well within what anything here can
    // notice.
    const every = opts.gravityEvery || 4;
    this._sinceGravity = (this._sinceGravity || 0) + 1;
    if (this._sinceGravity >= every || !this._ax || this._gravN !== n) {
      this._sinceGravity = 0;
      this._gravN = n;
      this.gravity(softening);
      if (opts.external) opts.external(this);
    }

    // Kick, drift.
    for (let i = 0; i < n; i++) {
      this.vx[i] += this._ax[i] * dt;
      this.vy[i] += this._ay[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
    }

    // --- contact ------------------------------------------------------------
    // Resolved by projection and impulse rather than by a stiff spring, so it
    // is stable at whatever step the rest of the simulation wants to take. A
    // spring's stable step goes as sqrt(m/k), which for rock is microseconds,
    // and no sandbox is going to run at microseconds.
    this.buildGrid();
    const passes = opts.passes || 4;
    for (let pass = 0; pass < passes; pass++) this.contacts(dt / passes, opts);

    // --- thermal ------------------------------------------------------------
    this.thermal(dt, opts);
  }

  /** Accelerations from the parcels' own gravity. */
  gravity(softening) {
    const n = this.n;
    if (!this._ax || this._ax.length < n) {
      this._ax = new Float64Array(this.cap);
      this._ay = new Float64Array(this.cap);
    }
    const ax = this._ax, ay = this._ay;
    ax.fill(0, 0, n); ay.fill(0, 0, n);
    if (n < 2) return;

    // A grid whose cells hold a handful of parcels each. Within a cell and its
    // neighbours, exact; beyond, the cell's monopole.
    const { minX, minY, cols, rows, size } = this.gravGrid();
    const cells = cols * rows;
    if (!this._gm || this._gm.length < cells) {
      this._gm = new Float64Array(cells);
      this._gx = new Float64Array(cells);
      this._gy = new Float64Array(cells);
    }
    const gm = this._gm, gx = this._gx, gy = this._gy;
    gm.fill(0, 0, cells); gx.fill(0, 0, cells); gy.fill(0, 0, cells);
    // Most cells are empty — a disc in a square grid leaves the corners bare,
    // and debris leaves most of it bare — so the far-field sum walks a list of
    // the occupied ones rather than all of them.
    if (!this._occ || this._occ.length < cells) this._occ = new Int32Array(cells);
    const occ = this._occ;
    let nOcc = 0;

    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const ci = clamp(Math.floor((this.x[i] - minX) / size), 0, cols - 1);
      const cj = clamp(Math.floor((this.y[i] - minY) / size), 0, rows - 1);
      const c = cj * cols + ci;
      cellOf[i] = c;
      gm[c] += this.mass[i];
      gx[c] += this.mass[i] * this.x[i];
      gy[c] += this.mass[i] * this.y[i];
    }
    for (let c = 0; c < cells; c++) {
      if (gm[c] <= 0) continue;
      gx[c] /= gm[c]; gy[c] /= gm[c];
      occ[nOcc++] = c;
    }

    const eps2 = softening * softening;

    // The far field, once per cell instead of once per parcel.
    //
    // Every parcel in a cell sees very nearly the same field from cells far
    // away — that is what makes the approximation an approximation — so
    // computing it per parcel was doing the same sum four or five times over.
    // At 1560 parcels this was 390,000 evaluations a step and the dominant
    // cost of the whole simulation; per cell it is 60,000.
    if (!this._fx || this._fx.length < cells) {
      this._fx = new Float64Array(cells);
      this._fy = new Float64Array(cells);
    }
    const fx = this._fx, fy = this._fy;
    for (let q = 0; q < nOcc; q++) {
      const c = occ[q];
      const cx = c % cols, cy = (c - cx) / cols;
      let sx = 0, sy = 0;
      for (let p = 0; p < nOcc; p++) {
        const o = occ[p];
        if (o === c) continue;
        const ox = o % cols, oy = (o - ox) / cols;
        if (Math.abs(ox - cx) <= 1 && Math.abs(oy - cy) <= 1) continue;
        const dx = gx[o] - gx[c], dy = gy[o] - gy[c];
        const d2 = dx * dx + dy * dy + eps2;
        const inv = 1 / (d2 * Math.sqrt(d2));
        const f = G * gm[o] * inv;
        sx += f * dx; sy += f * dy;
      }
      fx[c] = sx; fy[c] = sy;
    }

    for (let i = 0; i < n; i++) {
      const xi = this.x[i], yi = this.y[i];
      const ci = cellOf[i] % cols, cj = (cellOf[i] - (cellOf[i] % cols)) / cols;
      let axi = fx[cellOf[i]], ayi = fy[cellOf[i]];
      // The nine cells around this one, exactly.
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = ci + ox, ny = cj + oy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          for (let j = this._heads[ny * cols + nx]; j !== -1; j = this._next[j]) {
            if (j === i) continue;
            const dx = this.x[j] - xi, dy = this.y[j] - yi;
            let d2 = dx * dx + dy * dy + eps2;
            // Inside contact the field falls off linearly rather than blowing
            // up, the same shell-theorem treatment the body-level tree uses.
            const reach = this.r[i] + this.r[j];
            const d = Math.sqrt(d2);
            if (d < reach && reach > 0) {
              const f = (G * this.mass[j] * d) / (reach * reach * reach);
              if (d > 0) { axi += (f * dx) / d; ayi += (f * dy) / d; }
            } else {
              const inv = 1 / (d2 * d);
              const f = G * this.mass[j] * inv;
              axi += f * dx; ayi += f * dy;
            }
          }
        }
      }
      ax[i] = axi; ay[i] = ayi;
    }
  }

  gravGrid() {
    const n = this.n;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, rMax = 0;
    for (let i = 0; i < n; i++) {
      if (this.x[i] < minX) minX = this.x[i];
      if (this.y[i] < minY) minY = this.y[i];
      if (this.x[i] > maxX) maxX = this.x[i];
      if (this.y[i] > maxY) maxY = this.y[i];
      if (this.r[i] > rMax) rMax = this.r[i];
    }
    const span = Math.max(maxX - minX, maxY - minY, rMax * 4) * 1.02 + rMax;
    // Aim for a handful of parcels per cell.
    const target = Math.max(4, Math.ceil(Math.sqrt(n / 4)));
    const cols = clamp(target, 1, 96), rows = cols;
    const size = span / cols || 1;
    this.buildGrid(size, minX - rMax, minY - rMax, cols, rows);
    return { minX: minX - rMax, minY: minY - rMax, cols, rows, size };
  }

  /** Bucket parcels into the hash grid used by both gravity and contact. */
  buildGrid(size, minX, minY, cols, rows) {
    const n = this.n;
    if (size === undefined) {
      // Contact pass: cells one parcel-diameter across.
      let rMax = 0, mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      for (let i = 0; i < n; i++) {
        if (this.r[i] > rMax) rMax = this.r[i];
        if (this.x[i] < mnX) mnX = this.x[i];
        if (this.y[i] < mnY) mnY = this.y[i];
        if (this.x[i] > mxX) mxX = this.x[i];
        if (this.y[i] > mxY) mxY = this.y[i];
      }
      size = Math.max(rMax * 2.2, 1e-9);
      cols = clamp(Math.ceil((mxX - mnX) / size) + 1, 1, 512);
      rows = clamp(Math.ceil((mxY - mnY) / size) + 1, 1, 512);
      minX = mnX; minY = mnY;
    }
    const cells = cols * rows;
    if (!this._heads || this._heads.length < cells) this._heads = new Int32Array(cells);
    this._heads.fill(-1, 0, cells);
    for (let i = 0; i < n; i++) {
      const ci = clamp(Math.floor((this.x[i] - minX) / size), 0, cols - 1);
      const cj = clamp(Math.floor((this.y[i] - minY) / size), 0, rows - 1);
      const c = cj * cols + ci;
      this._next[i] = this._heads[c];
      this._heads[c] = i;
    }
    this._grid = { minX, minY, cols, rows, size };
  }

  /**
   * One pass of contact resolution.
   *
   * Overlapping parcels are pushed apart and given an impulse. What the impulse
   * does depends on whether they are stuck together: cold parcels of the same
   * material resist being pulled apart up to a limit and then break, which is
   * where fragmentation comes from. Molten ones do not resist at all, they just
   * lose energy to each other, which is what makes melt behave like a liquid.
   */
  contacts(dt, opts) {
    const g = this._grid;
    if (!g) return;
    const { minX, minY, cols, rows, size } = g;
    const restitutionSolid = opts.restitution != null ? opts.restitution : 0.12;
    let heat = this._heat;
    if (!heat || heat.length < this.cap) heat = this._heat = new Float64Array(this.cap);
    heat.fill(0, 0, this.n);

    for (let cj = 0; cj < rows; cj++) {
      for (let ci = 0; ci < cols; ci++) {
        for (let i = this._heads[cj * cols + ci]; i !== -1; i = this._next[i]) {
          for (let oy = 0; oy <= 1; oy++) {
            for (let ox = (oy === 0 ? 0 : -1); ox <= 1; ox++) {
              const nx = ci + ox, ny = cj + oy;
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
              let j = this._heads[ny * cols + nx];
              if (oy === 0 && ox === 0) j = this._next[i];
              for (; j !== -1; j = this._next[j]) {
                this.pair(i, j, restitutionSolid, heat, dt);
              }
            }
          }
        }
      }
    }

    // Spend the collision losses as heat.
    for (let i = 0; i < this.n; i++) {
      if (heat[i] === 0) continue;
      const cp = CP[this.mat[i]] || 1000;
      this.temp[i] += heat[i] / Math.max(this.mass[i] * cp, 1e-9);
      this.melt[i] = meltOf(this.mat[i], this.temp[i]);
    }
  }

  pair(i, j, restitutionSolid, heat, dt) {
    const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
    const rsum = this.r[i] + this.r[j];
    const d2 = dx * dx + dy * dy;
    // Cohesion reaches a little past contact, so a body does not shed its
    // surface the moment anything jostles it.
    const bondReach = rsum * 1.18;
    if (d2 > bondReach * bondReach || d2 === 0) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    const mi = this.mass[i], mj = this.mass[j];
    const inv = 1 / (mi + mj);

    const rvx = this.vx[j] - this.vx[i], rvy = this.vy[j] - this.vy[i];
    const vn = rvx * nx + rvy * ny;      // < 0 approaching

    const soft = Math.max(this.melt[i], this.melt[j]);
    const overlap = rsum - d;

    if (overlap > 0) {
      // Separate them. Molten parcels are allowed to stay closer together —
      // liquid does not hold its neighbours at arm's length.
      // Enough of the overlap to hold a body up against its own gravity — a
      // gentler correction let a rubble world quietly compact from 773 km to
      // 745 km and cook itself to 739 K — but never so much in one pass that
      // undoing a deep interpenetration becomes a launch. The cap is a quarter
      // of a parcel per pass; four passes clear the rest.
      const raw = overlap * (soft > 0.5 ? 0.3 : 0.85);
      const push = Math.min(raw, Math.min(this.r[i], this.r[j]) * 0.25);
      this.x[i] -= nx * push * (mj * inv);
      this.y[i] -= ny * push * (mj * inv);
      this.x[j] += nx * push * (mi * inv);
      this.y[j] += ny * push * (mi * inv);
    }

    if (vn < 0) {
      // Approaching: an inelastic impulse, and the energy it removes becomes
      // heat in both parcels. This is the only place impact heating comes from,
      // and it is the same arithmetic whether it is two grains settling or a
      // planet arriving at 20 km/s.
      const e = soft > 0.4 ? 0.02 : restitutionSolid;
      const jimp = (-(1 + e) * vn) / (1 / mi + 1 / mj);
      this.vx[i] -= (jimp * nx) / mi; this.vy[i] -= (jimp * ny) / mi;
      this.vx[j] += (jimp * nx) / mj; this.vy[j] += (jimp * ny) / mj;

      // Only a real impact heats. A contact network under its own weight is
      // always resolving tiny approach velocities, and counting those as
      // impact energy cooked a cold rubble pile to 739 K while it sat still.
      // The floor is the speed a parcel picks up falling across its own radius
      // in this pair's gravity, which is the scale of settling jitter.
      const gFloor = Math.sqrt((2 * G * (mi + mj)) / Math.max(this.r[i] + this.r[j], 1)) * 0.35;
      if (-vn > gFloor) {
        const eff = -vn - gFloor;
        const lost = 0.5 * ((mi * mj) * inv) * eff * eff * (1 - e * e);
        heat[i] += lost * (mj * inv);
        heat[j] += lost * (mi * inv);
      }

      // Tangential friction, which is what lets a heap have a slope instead of
      // spreading out flat.
      const tvx = rvx - vn * nx, tvy = rvy - vn * ny;
      const ts = Math.hypot(tvx, tvy);
      if (ts > 0) {
        const mu = soft > 0.4 ? 0.02 : 0.35;
        const jt = Math.min(mu * Math.abs(jimp), ts / (1 / mi + 1 / mj));
        const ux = tvx / ts, uy = tvy / ts;
        this.vx[i] += (jt * ux) / mi; this.vy[i] += (jt * uy) / mi;
        this.vx[j] -= (jt * ux) / mj; this.vy[j] -= (jt * uy) / mj;
      }
    } else if (overlap <= 0 && soft < 0.35 && vn > 0) {
      // Separating, still cold, still within reach: they are bonded. The bond
      // resists being pulled apart, up to a limit, and past that limit it
      // breaks. Fragmentation is that limit being exceeded — nothing decides
      // a body has come apart.
      //
      // As a constraint on the separation, not as a force. An earlier version
      // added `force / mass` straight to the velocity with no dt anywhere, four
      // times a step, which is not a bond but an energy source: two rocky
      // worlds meeting at 1.7 escape velocities blew themselves to dust.
      const strength = Math.min(STRENGTH[this.mat[i]], STRENGTH[this.mat[j]]) * COHESION_SCALE;
      const area = Math.min(this.r[i], this.r[j]) * 2;
      const reduced = (mi * mj) * inv;
      // The impulse that would stop them separating, and what the bond has.
      const needed = reduced * vn;
      const maxImpulse = strength * area * area * dt;
      const applied = Math.min(needed, maxImpulse);
      if (applied > 0) {
        this.vx[i] += (applied * nx) / mi; this.vy[i] += (applied * ny) / mi;
        this.vx[j] -= (applied * nx) / mj; this.vy[j] -= (applied * ny) / mj;
      }
    }
  }

  /** Radiate from the outside, conduct inside, and melt or freeze. */
  thermal(dt, opts) {
    const eq = opts.equilibriumT || T_CMB;
    const n = this.n;
    if (!this._nbCount || this._nbCount.length < this.cap) this._nbCount = new Int32Array(this.cap);
    const cnt = this._nbCount;
    cnt.fill(0, 0, n);

    const g = this._grid;
    if (g) {
      const { minX, minY, cols, rows, size } = g;
      for (let i = 0; i < n; i++) {
        const ci = clamp(Math.floor((this.x[i] - minX) / size), 0, cols - 1);
        const cj = clamp(Math.floor((this.y[i] - minY) / size), 0, rows - 1);
        let c = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = ci + ox, ny = cj + oy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            for (let j = this._heads[ny * cols + nx]; j !== -1; j = this._next[j]) {
              if (j === i) continue;
              const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
              const rr = (this.r[i] + this.r[j]) * 1.25;
              if (dx * dx + dy * dy < rr * rr) c++;
            }
          }
        }
        cnt[i] = c;
      }
    }

    for (let i = 0; i < n; i++) {
      // A parcel with few neighbours is on the outside and can see the sky.
      const exposed = clamp(1 - cnt[i] / 6, 0, 1);
      if (exposed > 0.01) {
        const area = 2 * Math.PI * this.r[i] * this.r[i];
        const t = this.temp[i];
        const cp = CP[this.mat[i]] || 1000;
        const loss = SIGMA_SB * area * exposed * (t * t * t * t - eq * eq * eq * eq) * dt;
        const drop = loss / Math.max(this.mass[i] * cp, 1e-9);
        this.temp[i] = Math.max(eq, t - clamp(drop, 0, Math.max(t - eq, 0) * 0.5));
      }
      this.melt[i] = meltOf(this.mat[i], this.temp[i]);
    }
  }

  // --- clustering -----------------------------------------------------------

  /**
   * Label parcels that are touching, transitively.
   *
   * This is the only place anything resembling a "body" appears, and it is a
   * result rather than a decision: a cluster is a set of parcels in contact,
   * and a moon is a cluster that happens to be somewhere else.
   */
  clusters() {
    const n = this.n;
    const parent = this._parent;
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    this.buildGrid();
    const g = this._grid;
    if (g) {
      const { minX, minY, cols, rows, size } = g;
      for (let i = 0; i < n; i++) {
        const ci = clamp(Math.floor((this.x[i] - minX) / size), 0, cols - 1);
        const cj = clamp(Math.floor((this.y[i] - minY) / size), 0, rows - 1);
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = ci + ox, ny = cj + oy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            for (let j = this._heads[ny * cols + nx]; j !== -1; j = this._next[j]) {
              if (j <= i) continue;
              const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
              const rr = (this.r[i] + this.r[j]) * 1.25;
              if (dx * dx + dy * dy < rr * rr) union(i, j);
            }
          }
        }
      }
    }

    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      let list = groups.get(root);
      if (!list) { list = []; groups.set(root, list); }
      list.push(i);
      this.cluster[i] = root;
    }
    return [...groups.values()];
  }

  /** Bulk properties of a set of parcel indices. */
  summarise(list) {
    let m = 0, cx = 0, cy = 0, px = 0, py = 0, t = 0, molten = 0;
    const comp = {};
    for (const i of list) {
      const mi = this.mass[i];
      m += mi;
      cx += mi * this.x[i]; cy += mi * this.y[i];
      px += mi * this.vx[i]; py += mi * this.vy[i];
      t += mi * this.temp[i];
      molten += mi * this.melt[i];
      const key = matKey(this.mat[i]);
      comp[key] = (comp[key] || 0) + mi;
    }
    if (m <= 0) return null;
    for (const key in comp) comp[key] /= m;
    // Angular momentum about the centre of mass, so a cluster that condenses
    // into a body keeps the spin its parcels were carrying.
    const vxm = px / m, vym = py / m, xm = cx / m, ym = cy / m;
    let L = 0, I = 0;
    for (const i of list) {
      const rx = this.x[i] - xm, ry = this.y[i] - ym;
      L += this.mass[i] * (rx * (this.vy[i] - vym) - ry * (this.vx[i] - vxm));
      I += this.mass[i] * (rx * rx + ry * ry);
    }
    // Velocity dispersion says whether this is a settled object or a mid-air
    // collection of debris that has not decided yet.
    let disp = 0;
    for (const i of list) {
      disp += this.mass[i] * ((this.vx[i] - vxm) ** 2 + (this.vy[i] - vym) ** 2);
    }
    return {
      mass: m, x: xm, y: ym, vx: vxm, vy: vym,
      temperature: t / m, molten: molten / m,
      composition: comp, spin: I > 0 ? L / I : 0,
      dispersion: Math.sqrt(disp / m), count: list.length,
    };
  }
}

// --- helpers ---------------------------------------------------------------

function meltOf(matIdx, t) {
  const tm = MELT[matIdx] || 1500;
  return clamp((t - tm * 0.86) / (tm * 0.28), 0, 1);
}

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
    const v = rng() * acc;
    for (let i = 0; i < keys.length; i++) if (v <= cum[i]) return keys[i];
    return keys[keys.length - 1];
  };
}

export { RHO, MELT, CP, STRENGTH };
