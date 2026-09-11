import { G, C, AU, M_SUN, TAU, clamp, rocheLimit } from './const.js';
import { Body, resetIds } from './body.js';
import { Quadtree } from './quadtree.js';
import { resolveCollision, sweptContactDisp, tidallyDisrupt } from './collide.js';
import { dominantAttractor } from './kepler.js';

/** A monotonic clock that works in the browser and under Node alike. */
const now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Move a body back to the fraction `t` of the step it just took. */
function rollback(b, t) {
  if (b.x0 == null || t >= 1) return;
  b.x = b.x0 + (b.x - b.x0) * t;
  b.y = b.y0 + (b.y - b.y0) * t;
}

const DEFAULTS = {
  theta: 0.5,              // Barnes-Hut opening angle
  softeningFraction: 0.0,  // Plummer softening, as a fraction of mean radius
  eta: 0.018,              // timestep accuracy parameter
  maxSubsteps: 600,        // hard ceiling on substeps in one advance()
  frameBudgetMs: 11,       // wall-clock spend per advance(), before we stop
  collisions: true,
  tidalDisruption: true,
  relativity: false,       // 1PN perihelion precession
  thermal: true,
  trailLength: 260,
  maxBodies: 3000,
  maxFragments: 48,
};

export class World {
  constructor(settings = {}) {
    this.bodies = [];
    this.settings = { ...DEFAULTS, ...settings };
    this.tree = new Quadtree();
    this.time = 0;              // simulated seconds since the scene was loaded
    this.steps = 0;
    this.events = [];           // consumed by the renderer each frame
    this.collisionCount = 0;
    this.mergeCount = 0;
    this.lastDt = 0;
    this.throttled = false;
    this.achievedRate = 0;      // simulated seconds per real second, measured
    this._accel = [0, 0];
    this._treeFresh = false;
    this._neighbors = [];
    this._energyRef = null;
    this.energyDrift = 0;
    this.listeners = {};
    this.trailStride = 0;
    this._trailAccum = 0;
  }

  on(evt, fn) { (this.listeners[evt] || (this.listeners[evt] = [])).push(fn); }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }

  clear() {
    this.bodies.length = 0;
    this.time = 0;
    this.steps = 0;
    this.events.length = 0;
    this.collisionCount = 0;
    this.mergeCount = 0;
    this._energyRef = null;
    this.energyDrift = 0;
    resetIds(1);
  }

  add(body) {
    if (this.bodies.length >= this.settings.maxBodies) {
      // Shed the least interesting thing rather than refusing the new body.
      let worst = -1, worstMass = Infinity;
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (b.kind === 'debris' && b.mass < worstMass) { worstMass = b.mass; worst = i; }
      }
      if (worst >= 0) this.bodies.splice(worst, 1);
      else return null;
    }
    this.bodies.push(body);
    this._energyRef = null;
    this._accelDirty = true;
    return body;
  }

  addAll(list) { for (const b of list) this.add(b); return list; }

  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) {
      this.bodies.splice(i, 1);
      body.alive = false;
      this._energyRef = null;
      this._accelDirty = true;
    }
  }

  byId(id) { return this.bodies.find((b) => b.id === id) || null; }

  get mostMassive() {
    let best = null;
    for (const b of this.bodies) if (!best || b.mass > best.mass) best = b;
    return best;
  }

  /** Mean softening length, in metres. Zero unless the user asks for it. */
  get softening() {
    const f = this.settings.softeningFraction;
    if (f <= 0) return 0;
    let sum = 0;
    for (const b of this.bodies) sum += b.radius;
    return (sum / Math.max(1, this.bodies.length)) * f;
  }

  // --- Forces ---------------------------------------------------------------

  computeAccelerations() {
    const n = this.bodies.length;
    if (n === 0) return;
    this.tree.build(this.bodies);
    const soft = this.softening;
    const theta = this.settings.theta;
    const out = this._accel;

    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      // A pinned body still *exerts* gravity, it just does not respond to any.
      // That is deliberate — it is what makes it useful as an anchor — but it
      // does mean momentum is not conserved while anything is pinned.
      if (b.fixed) { b.ax = 0; b.ay = 0; continue; }
      this.tree.accelerate(i, G, theta, soft, out);
      b.ax = out[0];
      b.ay = out[1];
    }
    this._accelDirty = false;

    if (this.settings.relativity) this.applyRelativity();
    if (this.externalForce) this.externalForce(this.bodies);
  }

  /**
   * First post-Newtonian correction from the dominant attractor.
   *
   * The Schwarzschild term  a = (GM/r²)(3h²/c²r²) r̂  reproduces the observed
   * perihelion advance — 43″/century for Mercury — without the cost of a full
   * PN expansion over every pair.
   */
  applyRelativity() {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.fixed) continue;
      const primary = dominantAttractor(b, bodies);
      if (!primary) continue;
      const dx = b.x - primary.x, dy = b.y - primary.y;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2);
      if (r <= 0) continue;
      const vx = b.vx - primary.vx, vy = b.vy - primary.vy;
      const h = dx * vy - dy * vx;
      const mu = G * primary.mass;
      // a = -(GM/r²)(3h²/c²r²) r̂ , expanded so the unit vector costs nothing.
      const corr = (3 * mu * h * h) / (C * C * r2 * r2 * r);
      b.ax -= corr * dx;
      b.ay -= corr * dy;
    }
  }

  // --- Time integration -----------------------------------------------------

  /**
   * Timestep from the standard velocity-change criterion, dt = eta |v|/|a|.
   * For a circular orbit that is eta·P/2π, so eta = 0.018 puts roughly 350
   * steps in an orbit — comfortably inside velocity Verlet's accurate range.
   */
  chooseDt(limit) {
    let dt = limit;
    const eta = this.settings.eta;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      const a = Math.hypot(b.ax, b.ay);
      if (a <= 0) continue;
      const v = Math.hypot(b.vx, b.vy);
      // Two bounds: how fast the velocity is turning, and — for a body at rest
      // in a strong field — how fast it is about to start moving.
      const dtV = v > 0 ? (eta * v) / a : Infinity;
      const dtA = Math.sqrt((eta * Math.max(b.radius, 1)) / a);
      const d = Math.min(dtV, dtA);
      if (d < dt) dt = d;
    }
    return Math.max(dt, 1e-6);
  }

  /** One velocity-Verlet step. Accelerations must already be current. */
  step(dt) {
    const bodies = this.bodies;
    const n = bodies.length;

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      // Where the step started. The collision pass sweeps this segment, and a
      // fixed body still needs one so pairs involving it test correctly.
      b.x0 = b.x; b.y0 = b.y;
      if (b.fixed) continue;
      b.x += b.vx * dt + 0.5 * b.ax * dt * dt;
      b.y += b.vy * dt + 0.5 * b.ay * dt * dt;
      // Keep the old acceleration for the velocity half-kick.
      b.pax = b.ax; b.pay = b.ay;
    }

    this.computeAccelerations();

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.fixed) continue;
      b.vx += 0.5 * (b.pax + b.ax) * dt;
      b.vy += 0.5 * (b.pay + b.ay) * dt;
      b.rotation += b.spin * dt;
      if (b.rotation > TAU || b.rotation < -TAU) b.rotation %= TAU;
      b.age += dt;
    }

    this.time += dt;
    this.steps++;
    this.lastDt = dt;

    if (this.settings.collisions) this.resolveContacts(dt);
    if (this.settings.tidalDisruption) this.checkTides(dt);
  }

  /**
   * Advance up to `seconds` of simulated time, and report how much actually
   * happened. When accuracy demands more substeps than the frame budget allows
   * we advance less rather than taking a step we know is wrong — the HUD then
   * shows the real rate instead of a requested one the physics never delivered.
   */
  advance(seconds) {
    if (seconds <= 0 || this.bodies.length === 0) return 0;
    // A body added or removed since the last step leaves every acceleration
    // stale, and the first drift of the next step would use it.
    if (this.steps === 0 || this._accelDirty) this.computeAccelerations();

    let remaining = seconds;
    let taken = 0;
    const cap = this.settings.maxSubsteps;
    const budgetMs = this.settings.frameBudgetMs || 11;
    this.throttled = false;

    // Two limits, and the wall clock is the one that usually bites. Capping by
    // substep count alone means a heavy scene either runs at 6 fps or takes
    // steps too large to be right; capping by time keeps the frame rate and
    // slows the clock instead, which the status line then says out loud.
    const started = now();
    while (remaining > 1e-9 && taken < cap) {
      const dt = Math.min(remaining, this.chooseDt(remaining));
      this.step(dt);
      remaining -= dt;
      taken++;
      if ((taken & 3) === 0 && now() - started > budgetMs) break;
    }
    if (remaining > 1e-9) this.throttled = true;

    this.substepsTaken = taken;
    if (this.settings.thermal) this.thermalPass(seconds - remaining);
    this.updateTrails();
    this.measureEnergy();
    return seconds - remaining;
  }

  // --- Collisions -----------------------------------------------------------

  /**
   * Broad phase over the tree, then an exact swept narrow phase. Contacts are
   * resolved earliest-first, and the pass restarts whenever the body set
   * changes, because a disruption can put new bodies straight into contact.
   */
  resolveContacts(dt) {
    const bodies = this.bodies;
    if (bodies.length < 2) return;

    let passes = 0;
    let changed = true;
    while (changed && passes++ < 8) {
      changed = false;
      if (this._treeFresh) this._treeFresh = false;
      else this.tree.build(bodies);
      let best = null;

      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        if (!a.alive) continue;
        const nb = this.tree.queryNeighbors(i, this._neighbors);
        for (let k = 0; k < nb.length; k++) {
          const j = nb[k];
          if (j <= i) continue;
          const b = bodies[j];
          if (!b.alive) continue;
          const t = sweptContactDisp(a, b);
          if (t === null) continue;
          if (!best || t < best.t) best = { t, a, b };
        }
      }
      if (!best) break;

      // Roll the pair back to the instant of contact. The impact parameter is
      // read off that geometry, so resolving from an already-overlapped state
      // would report every impact as more head-on than it was.
      rollback(best.a, best.t);
      rollback(best.b, best.t);

      const result = resolveCollision(best.a, best.b, {
        maxFragments: this.settings.maxFragments,
        allowBounce: this.settings.bounce !== false,
      });
      this.applyResult(result);
      this.collisionCount++;
      if (result.regime === 'merge' || result.regime === 'graze-and-merge') this.mergeCount++;

      // Everything the collision produced starts life at the contact instant;
      // let it finish the rest of the step so it is in sync with the others.
      const catchUp = (1 - best.t) * dt;
      for (const b of result.added || []) {
        b.x0 = b.x; b.y0 = b.y;
        b.x += b.vx * catchUp;
        b.y += b.vy * catchUp;
      }
      for (const b of [best.a, best.b]) {
        if (!b.alive) continue;
        b.x0 = b.x; b.y0 = b.y;
        b.x += b.vx * catchUp;
        b.y += b.vy * catchUp;
      }

      changed = (result.removed && result.removed.length > 0) || (result.added && result.added.length > 0);
    }
  }

  applyResult(result) {
    if (!result) return;
    for (const b of result.removed || []) this.remove(b);
    for (const b of result.added || []) this.add(b);
    this._treeFresh = false;
    for (const e of result.events || []) this.events.push(e);
    if (result.regime) this.emit('collision', result);
    this._energyRef = null;
  }

  /**
   * Roche-limit check. A body whose own gravity is all that holds it together
   * comes apart when the tide from a nearby primary exceeds it.
   */
  checkTides(dt) {
    const bodies = this.bodies;
    this._treeFresh = false;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.alive || b.isCompact || b.kind === 'star') continue;
      // Small, strong bodies are held by material strength, not gravity.
      if (b.radius < 3e5) continue;
      const primary = dominantAttractor(b, bodies);
      if (!primary || primary.mass < 20 * b.mass) continue;
      const d = Math.hypot(b.x - primary.x, b.y - primary.y);
      const limit = rocheLimit(primary.radius, primary.density, b.density);
      if (d < limit && d > primary.radius) {
        // Give it a moment inside the limit before it shreds, so a fast
        // hyperbolic pass does not instantly explode.
        b.tidalStress = (b.tidalStress || 0) + dt * (limit / Math.max(d, 1) - 1);
        const orbitTime = TAU * Math.sqrt(Math.pow(d, 3) / (G * primary.mass));
        if (b.tidalStress > orbitTime * 0.15) {
          this.applyResult(tidallyDisrupt(b, primary, {}));
          return;
        }
      } else if (b.tidalStress) {
        b.tidalStress = Math.max(0, b.tidalStress - dt);
      }
    }
  }

  // --- Thermal --------------------------------------------------------------

  /**
   * Irradiation from every star, then radiative relaxation. Run once per frame
   * on the whole elapsed interval rather than per substep: thermal timescales
   * are enormous next to dynamical ones, and resolving them per substep would
   * cost everything and change nothing.
   */
  thermalPass(dt) {
    if (dt <= 0) return;
    const stars = this.bodies.filter((b) => b.luminosity > 0);
    for (const b of this.bodies) {
      if (b.kind === 'bh') continue;
      let flux = 0;
      for (const s of stars) {
        if (s === b) continue;
        const dx = s.x - b.x, dy = s.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, s.radius * s.radius);
        flux += s.luminosity / (4 * Math.PI * d2);
      }
      b.insolation = flux;
      b.thermalStep(dt);
    }
  }

  // --- Trails and diagnostics ----------------------------------------------

  updateTrails() {
    const cap = this.settings.trailLength;
    if (cap <= 0) return;
    for (const b of this.bodies) {
      if (!b.trail) b.trail = [];
      const t = b.trail;
      const lastX = t.length >= 2 ? t[t.length - 2] : NaN;
      const lastY = t.length >= 2 ? t[t.length - 1] : NaN;
      // Only record when the body has actually moved somewhere new, so a
      // paused or slow body does not fill its trail with duplicate points.
      if (!(Math.abs(b.x - lastX) + Math.abs(b.y - lastY) > b.radius * 0.25)) continue;
      t.push(b.x, b.y);
      if (t.length > cap * 2) t.splice(0, t.length - cap * 2);
    }
  }

  clearTrails() { for (const b of this.bodies) b.trail = null; }

  /** Barycentre of the whole system. */
  barycenter() {
    let m = 0, x = 0, y = 0, vx = 0, vy = 0;
    for (const b of this.bodies) {
      m += b.mass; x += b.mass * b.x; y += b.mass * b.y;
      vx += b.mass * b.vx; vy += b.mass * b.vy;
    }
    if (m === 0) return { x: 0, y: 0, vx: 0, vy: 0, mass: 0 };
    return { x: x / m, y: y / m, vx: vx / m, vy: vy / m, mass: m };
  }

  totalMomentum() {
    let px = 0, py = 0;
    for (const b of this.bodies) { px += b.mass * b.vx; py += b.mass * b.vy; }
    return { px, py };
  }

  /**
   * Total mechanical energy. Exact pairwise sum — O(n²) — so it is only run on
   * modest systems and only every so often; it exists to show the integrator's
   * drift honestly, and an approximate answer would defeat that.
   */
  totalEnergy() {
    const n = this.bodies.length;
    if (n > 900) return null;
    let ke = 0, pe = 0;
    for (let i = 0; i < n; i++) {
      const a = this.bodies[i];
      ke += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy);
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[j];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d > 0) pe -= (G * a.mass * b.mass) / d;
      }
    }
    return ke + pe;
  }

  measureEnergy() {
    if (this.steps % 30 !== 0) return;
    const e = this.totalEnergy();
    if (e === null) { this.energyDrift = NaN; return; }
    if (this._energyRef === null || !isFinite(this._energyRef)) {
      this._energyRef = e;
      this.energyDrift = 0;
      return;
    }
    this.energyDrift = Math.abs(this._energyRef) > 0
      ? (e - this._energyRef) / Math.abs(this._energyRef)
      : 0;
  }

  // --- Serialisation --------------------------------------------------------

  toJSON() {
    return {
      version: 1,
      time: this.time,
      settings: this.settings,
      bodies: this.bodies.map((b) => b.toJSON()),
    };
  }

  loadJSON(data) {
    this.clear();
    if (data.settings) Object.assign(this.settings, data.settings);
    for (const o of data.bodies || []) this.add(Body.fromJSON(o));
    this.time = data.time || 0;
    this.computeAccelerations();
  }

  snapshot() { return JSON.stringify(this.toJSON()); }
  restore(snap) { this.loadJSON(JSON.parse(snap)); }
}
