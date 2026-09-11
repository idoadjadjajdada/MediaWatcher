import { G, C, TAU, clamp, rocheLimit } from './const.js';
import { Body, resetIds } from './body.js';
import { Quadtree } from './quadtree.js';
import { resolveCollision, sweptContactDisp, tidallyDisrupt } from './collide.js';
import { dominantAttractor } from './kepler.js';

// How many powers of two the individual timesteps may span. Eight levels lets
// the fastest body take 256 steps while the slowest takes one.
const MAX_LEVELS = 8;

// Yoshida (1990) fourth-order composition weights. The middle step runs
// backwards in time, which is what cancels the second-order error term.
const YOSHIDA_W1 = 1 / (2 - Math.cbrt(2));
const YOSHIDA_W0 = -Math.cbrt(2) / (2 - Math.cbrt(2));

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
  eta: 0.06,               // timestep accuracy parameter
  integrator: 'yoshida4',  // 'yoshida4' (4th order) or 'verlet' (2nd, cheaper)
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
    this._accel = [0, 0, Infinity];
    this._treeFresh = false;
    this._neighbors = [];
    this._energyRef = null;
    this.energyDrift = 0;
    this.listeners = {};
    this._frame = 0;
    this._dt = 0;      // the held integration step, see chooseDt
  }

  on(evt, fn) { (this.listeners[evt] || (this.listeners[evt] = [])).push(fn); }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }

  clear() {
    this.bodies.length = 0;
    this.time = 0;
    this.steps = 0;
    this._dt = 0;
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
      // Debris first; if there is none, the least massive of anything, because
      // refusing the new body loses its mass with no record of it.
      let worstDebris = -1, worstDebrisMass = Infinity;
      let worstAny = -1, worstAnyMass = Infinity;
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (b === body) continue;
        if (b.kind === 'debris' && b.mass < worstDebrisMass) { worstDebrisMass = b.mass; worstDebris = i; }
        if (b.mass < worstAnyMass) { worstAnyMass = b.mass; worstAny = i; }
      }
      const victim = worstDebris >= 0 ? worstDebris : worstAny;
      if (victim < 0) return null;
      // Go through remove() so the evicted body is marked dead and every
      // cached derivative is invalidated, exactly as any other removal.
      this.evictedMass = (this.evictedMass || 0) + this.bodies[victim].mass;
      this.remove(this.bodies[victim]);
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
      b.nearest = out[2];
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
      const primary = this.attractorOf(b);
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
  /**
   * The step each body would need on its own, from the local dynamical time.
   *
   * `sqrt(r/|a|)` is P/2π on a circular orbit, and depends only on
   * frame-invariant quantities. The obvious alternative, `eta·|v|/|a|`, is not
   * frame-invariant: |v| depends on which frame you picked, and a body whose
   * speed passes through zero in that frame drives the step to nothing. Started
   * with the Sun at rest, a Sun-Earth system did exactly that once per orbit,
   * and answered with steps of a few microseconds.
   */
  bodyStep(b) {
    const a = Math.hypot(b.ax, b.ay);
    if (!(a > 0)) return Infinity;
    const scale = (b.nearest != null && isFinite(b.nearest) && b.nearest > 0)
      ? b.nearest
      : Math.max(b.radius, 1);
    return this.settings.eta * Math.sqrt(scale / a);
  }

  /**
   * The system step: how much time one call to `step` covers.
   *
   * Bodies that need less than this sub-cycle inside it, so this is set by the
   * *slowest* body, not the fastest — bounded so that the fastest body still
   * gets a step it can live with after the maximum number of subdivisions.
   */
  chooseDt(limit) {
    let minNeed = Infinity, maxNeed = 0;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      const need = this.bodyStep(b);
      if (!isFinite(need)) continue;
      if (need < minNeed) minNeed = need;
      if (need > maxNeed) maxNeed = need;
    }
    if (!isFinite(minNeed)) return limit;

    const span = 1 << MAX_LEVELS;
    let dt = Math.min(maxNeed, minNeed * span);

    // Hold the step until it is genuinely unsafe, and only grow it once it is
    // four times more cautious than it needs to be. Velocity Verlet — and the
    // composition built on it — is symplectic at a *fixed* step; a step that
    // wanders continuously turns a bounded energy oscillation into a secular
    // drift, so it is worth keeping constant for thousands of steps at a time.
    let held = this._dt;
    if (!(held > 0) || !isFinite(held)) held = Math.pow(2, Math.floor(Math.log2(dt)));
    while (held > dt) held /= 2;
    while (held * 4 <= dt) held *= 2;
    this._dt = held;

    return Math.max(Math.min(held, limit), 1e-6);
  }

  /** How many sub-cycles a system step of `dt` would need. */
  subCyclesFor(dt) {
    let sub = 1;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      const need = this.bodyStep(b);
      if (!isFinite(need) || !(need > 0)) continue;
      const k = clamp(Math.ceil(Math.log2(dt / need)), 0, MAX_LEVELS);
      if ((1 << k) > sub) sub = 1 << k;
    }
    return sub;
  }

  /**
   * One kick-drift-kick step with individual timesteps.
   *
   * Every body is assigned a stride: a power-of-two fraction of the system step
   * that it actually needs. Positions are drifted for everyone at the finest
   * cadence, which is cheap and involves no forces, but a body is only kicked
   * at its own step boundary, using forces evaluated then.
   *
   * The alternative — one global step, set by whichever body needs the
   * smallest — means every other body pays for it. In a protoplanetary disc a
   * single fragment left orbiting a merged planetesimal wanted a step eleven
   * hundred times finer than the median body in the scene, and the whole
   * simulation slowed by that factor to accommodate it. Here it sub-cycles
   * alone and nobody else notices.
   *
   * KDK is symmetric and symplectic, which is what lets the caller compose
   * three of these into a fourth-order scheme.
   */
  blockStep(dt, sub) {
    const bodies = this.bodies;
    const n = bodies.length;
    const h = dt / sub;

    this.computeAccelerations();
    for (let m = 0; m < sub; m++) {
      // Opening half-kick for every body whose own step starts here.
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        if (b.fixed || m % b._stride !== 0) continue;
        const H = b._stride * h;
        b.vx += 0.5 * b.ax * H;
        b.vy += 0.5 * b.ay * H;
      }
      // Drift everyone. No forces, so this is the cheap part.
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        if (b.fixed) continue;
        b.x += b.vx * h;
        b.y += b.vy * h;
      }
      // Only the bodies whose step ends here need a fresh acceleration.
      this.computeAccelerations((m + 1) % (1 << MAX_LEVELS));
      // Closing half-kick for every body whose own step ends here.
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        if (b.fixed || (m + 1) % b._stride !== 0) continue;
        const H = b._stride * h;
        b.vx += 0.5 * b.ax * H;
        b.vy += 0.5 * b.ay * H;
      }
    }
  }

  /**
   * One integration step.
   *
   * Velocity Verlet is second order, and second order is not enough to see
   * small effects. Mercury's relativistic perihelion advance is 43 arcseconds
   * per century; second order at four hundred steps per orbit produces a
   * *spurious* advance of thirty-eight thousand, and only gets under two
   * arcseconds at about twenty-five thousand steps per orbit. The signal is
   * buried in truncation error at any step you would want to run at.
   *
   * Yoshida's fourth-order composition fixes that: three symmetric symplectic
   * steps with weights w1, w0, w1 summing to one, where the negative middle
   * step cancels the leading error term. It applies to any symmetric symplectic
   * base method, so it composes over the block scheme above just as it would
   * over a plain Verlet step.
   */
  step(dt) {
    const bodies = this.bodies;
    const n = bodies.length;

    for (let i = 0; i < n; i++) { bodies[i].x0 = bodies[i].x; bodies[i].y0 = bodies[i].y; }

    // Assign strides once for the whole composite step, so all three stages
    // agree on who is fast.
    let sub = 1;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.fixed) { b._stride = 1; continue; }
      const need = this.bodyStep(b);
      const k = isFinite(need) && need > 0
        ? clamp(Math.ceil(Math.log2(dt / need)), 0, MAX_LEVELS)
        : 0;
      b._level = k;
      if ((1 << k) > sub) sub = 1 << k;
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b._stride = b.fixed ? sub : (sub >> (b._level || 0)) || 1;
    }
    this.subCycles = sub;

    // Time the integration alone. The collision pass that follows is charged by
    // its own deadline, and folding it into the per-micro-step estimate makes a
    // busy frame look as though sub-cycling were unaffordable — which then
    // collapses the step back to a uniform one and undoes the whole scheme.
    const blockStart = now();
    if (this.settings.integrator === 'verlet') {
      this.blockStep(dt, sub);
    } else {
      this.blockStep(YOSHIDA_W1 * dt, sub);
      this.blockStep(YOSHIDA_W0 * dt, sub);
      this.blockStep(YOSHIDA_W1 * dt, sub);
    }
    this.blockMs = now() - blockStart;

    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.fixed) continue;
      b.rotation += b.spin * dt;
      if (b.rotation > TAU || b.rotation < -TAU) b.rotation %= TAU;
      b.age += dt;
    }

    this.time += dt;
    this.steps++;
    this.lastDt = dt;

    if (this.settings.collisions) this.resolveContacts(dt);
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

    this._frame++;
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
    // Cost per micro-step, measured. A system step with many sub-cycles is an
    // atomic unit — it cannot be abandoned half way without leaving bodies at
    // different times — so the budget has to be respected by choosing a smaller
    // step up front rather than by breaking out of a large one.
    let perMicro = this._perMicroMs || 0.05;
    while (remaining > 1e-9 && taken < cap) {
      // A collision at the end of the previous step added and removed bodies,
      // which leaves every acceleration stale — and a body a merge just created
      // has a = 0, so the step chooser would see no acceleration at all and
      // take the entire remaining interval as one ballistic drift. That turned
      // a 49-second step into a sixteen-thousand-year one and threw the
      // giant-impact disc a light-year clear of the planet.
      if (this._accelDirty) this.computeAccelerations();
      let dt = Math.min(remaining, this.chooseDt(remaining));

      // How many micro-steps this would cost, and how many are left in budget.
      const left = budgetMs - (now() - started);
      if (left <= 0) break;
      const affordable = Math.max(1, left / perMicro);
      while (this.subCyclesFor(dt) > affordable && dt > 2e-6) dt /= 2;

      this.step(dt);
      if (this.subCycles > 0 && this.blockMs >= 0) {
        // Exponential average, so one slow frame does not dominate the estimate.
        perMicro += ((this.blockMs / this.subCycles) - perMicro) * 0.25;
        this._perMicroMs = Math.max(perMicro, 1e-4);
      }

      remaining -= dt;
      taken++;
      if (now() - started > budgetMs) break;
    }
    if (remaining > 1e-9) this.throttled = true;

    // Tides act on orbital timescales, so checking them once per frame rather
    // than once per substep costs nothing physically and used to cost 43% of
    // the frame budget.
    if (this.settings.tidalDisruption) this.checkTides(seconds - remaining);

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

    // Each pair gets resolved at most once per step. A cluster settling under
    // its own gravity has many pairs in contact simultaneously, and stopping
    // after the first left the rest interpenetrating — but simply looping until
    // no contact is found never terminates, because a pair that has just
    // bounced is still touching and is found again immediately.
    const done = this._doneContacts || (this._doneContacts = new Set());
    done.clear();

    let passes = 0;
    let resolvedAny = false;
    // Enough passes to clear a genuine pile-up, bounded so a pathological
    // frame degrades the clock rather than stopping the program.
    const budget = Math.max(16, Math.min(96, bodies.length));
    // And a wall-clock deadline on top. A dense debris disc can disrupt
    // fragments into more fragments faster than the pass counter notices: one
    // step produced four thousand bodies and never returned, which no substep
    // limit outside this loop could have caught.
    const deadline = now() + Math.max(4, (this.settings.frameBudgetMs || 11) * 1.5);

    while (passes++ < budget) {
      if (passes > 4 && now() > deadline) break;
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
          const key = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`;
          if (done.has(key)) continue;
          const t = sweptContactDisp(a, b);
          if (t === null) continue;
          if (!best || t < best.t) best = { t, a, b, key };
        }
      }
      if (!best) break;
      done.add(best.key);
      resolvedAny = true;

      // Roll the pair back to the instant of contact. The impact parameter is
      // read off that geometry, so resolving from an already-overlapped state
      // would report every impact as more head-on than it was.
      rollback(best.a, best.t);
      rollback(best.b, best.t);

      // Taper fragmentation as the scene fills up. Shattering a body into
      // fifty pieces when there is room for ten produces fifty, evicts forty,
      // and loses their mass; letting the outcome know the budget keeps the
      // books straight and stops a cascade from running away.
      const room = this.settings.maxBodies - bodies.length;
      const result = resolveCollision(best.a, best.b, {
        maxFragments: clamp(Math.floor(room / 3), 2, this.settings.maxFragments),
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
    }

    if (resolvedAny) this._accelDirty = true;
  }

  applyResult(result) {
    if (!result) return;
    for (const b of result.removed || []) this.remove(b);
    for (const b of result.added || []) this.add(b);
    this._treeFresh = false;
    for (const e of result.events || []) this.events.push(e);
    if (result.regime) this.emit('collision', result);
    // An inelastic collision really does change the total energy, so the drift
    // reference has to be re-taken rather than reported as integrator error.
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
      const primary = this.attractorOf(b);
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

  /**
   * Which body is pulling hardest on this one.
   *
   * It is an O(N) scan, and both the tide check and the orbit overlay want it
   * for many bodies, so the answer is cached for the current frame. Dominance
   * changes on orbital timescales; a frame is nowhere near one.
   */
  attractorOf(body) {
    if (body._attractorFrame === this._frame) return body._attractor;
    const a = dominantAttractor(body, this.bodies);
    body._attractor = a;
    body._attractorFrame = this._frame;
    return a;
  }

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

  /**
   * Integrator energy drift, measured since the last time the body set changed.
   *
   * A collision genuinely changes the total mechanical energy — that is what
   * being inelastic means — so drift across one is not a meaningful number and
   * the reference is re-taken. `energySteps` says how much integration the
   * figure covers, so a drift of zero over two steps cannot be mistaken for a
   * drift of zero over a million.
   */
  measureEnergy() {
    if (this._frame % 4 !== 0) return;
    const e = this.totalEnergy();
    if (e === null) {
      this.energyDrift = NaN;
      this.energySteps = 0;
      return;
    }
    if (this._energyRef === null || !isFinite(this._energyRef)) {
      this._energyRef = e;
      this._energyRefStep = this.steps;
      this.energyDrift = 0;
      this.energySteps = 0;
      return;
    }
    this.energySteps = this.steps - this._energyRefStep;
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
