import { G, C, TAU, clamp, rocheLimit } from './const.js';
import { Body, resetIds } from './body.js';
import { Quadtree } from './quadtree.js';
import { resolveCollision, sweptContactDisp, tidallyDisrupt } from './collide.js';
import { dominantAttractor } from './kepler.js';

// The finest step the integrator will take. Below this it is no longer
// resolving what it claims to, and `underResolved` is set to say so.
const MIN_DT = 1e-6;

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
      // Mass leaving the simulation at the body cap is still mass leaving the
      // simulation. Record it so the diagnostics can say so.
      this.evictedMass = (this.evictedMass || 0) + this.bodies[victim].mass;
      this.evictedCount = (this.evictedCount || 0) + 1;
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

    let anyFixed = false;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      // A pinned body still *exerts* gravity, it just does not respond to any.
      // That is deliberate — it is what makes it useful as an anchor — but it
      // does mean momentum is not conserved while anything is pinned.
      if (b.fixed) { b.ax = 0; b.ay = 0; anyFixed = true; continue; }
      this.tree.accelerate(i, G, theta, soft, out);
      b.ax = out[0];
      b.ay = out[1];
      b.nearest = out[2];
    }
    this._accelDirty = false;

    if (this.settings.relativity) this.applyRelativity();

    // Barnes-Hut evaluates each body against summarised clusters independently,
    // so its forces are not exactly pairwise antisymmetric: the net
    // acceleration of the system comes out near zero rather than at zero. For a
    // closed system it *must* be zero, so that residual is pure approximation
    // error in the one mode whose true value is known exactly — and it happens
    // to be the mode that integrates straight into a drifting barycentre. Left
    // alone at the default opening angle it puts 4.6 mm/s on the solar system's
    // barycentre over twenty years. Projected out, momentum holds to machine
    // precision at any opening angle.
    //
    // Only valid when nothing is pinned. A pinned body exerts force without
    // accepting any, so the system genuinely is not closed and its momentum
    // genuinely is not conserved; subtracting a mean there would be inventing a
    // reaction the user explicitly asked not to have.
    if (!anyFixed) {
      let px = 0, py = 0, m = 0;
      for (let i = 0; i < n; i++) {
        const b = this.bodies[i];
        px += b.mass * b.ax; py += b.mass * b.ay; m += b.mass;
      }
      if (m > 0) {
        const cx = px / m, cy = py / m;
        for (let i = 0; i < n; i++) { this.bodies[i].ax -= cx; this.bodies[i].ay -= cy; }
      }
    }
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
   * The step a body needs, from the local dynamical time.
   *
   * `sqrt(r/|a|)` is P/2π on a circular orbit, and depends only on
   * frame-invariant quantities. The obvious alternative, `eta·|v|/|a|`, is not
   * frame-invariant: |v| depends on which frame you picked, and a body whose
   * speed passes through zero in that frame drives the step to nothing. Started
   * with the Sun at rest, a Sun-Earth system does exactly that once per orbit,
   * and that criterion answered with steps of a few microseconds.
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
   * The integration step, shared by every body.
   *
   * A previous version gave each body its own power-of-two stride, so that a
   * fast one could sub-cycle without dragging the rest down. It was measured
   * and removed. Two things were wrong with it, and the second is not fixable
   * by tidying:
   *
   *   - A kick applied to a subset of bodies is not a symplectic map, and the
   *     sum of m·a over a subset is not zero, so momentum leaks. Over twenty
   *     years of the solar system it put 2.6 cm/s of spurious velocity on the
   *     barycentre — |ΔP|/Σm|v| of 8 × 10⁻⁴ against 3 × 10⁻¹⁴ for a shared
   *     step, and energy drift 10⁴ times worse. The whole scene slowly
   *     accelerates in a fixed direction.
   *   - It also assigned the *coarsest* stride to the most massive body, since
   *     `bodyStep` scales with acceleration and the dominant mass has the least
   *     of it. The two halves of an action-reaction pair were integrated at
   *     different cadences.
   *
   * Getting the cost benefit it was supposed to deliver needs a neighbour
   * scheme — direct summation over predicted near neighbours, with the distant
   * field refreshed rarely — not merely a stride per body. Until that exists,
   * a shared step is both more accurate and, measured, no slower.
   */
  chooseDt(limit) {
    let dt = Infinity;
    for (const b of this.bodies) {
      if (b.fixed) continue;
      const need = this.bodyStep(b);
      if (need < dt) dt = need;
    }
    if (!isFinite(dt)) return limit;

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

    // Below this the step is no longer resolving what it claims to. Say so
    // rather than quietly stepping too coarsely.
    this.underResolved = held < MIN_DT;
    return Math.max(Math.min(held, limit), MIN_DT);
  }

  /**
   * One drift-kick-drift Verlet step. Accelerations must be current on entry,
   * and are current again on exit.
   */
  verletStep(dt) {
    const bodies = this.bodies;
    const n = bodies.length;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.fixed) continue;
      b.x += b.vx * dt + 0.5 * b.ax * dt * dt;
      b.y += b.vy * dt + 0.5 * b.ay * dt * dt;
      b.pax = b.ax; b.pay = b.ay;
    }
    this.computeAccelerations();
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.fixed) continue;
      b.vx += 0.5 * (b.pax + b.ax) * dt;
      b.vy += 0.5 * (b.pay + b.ay) * dt;
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
   * step cancels the leading error term. Measured convergence is 4.00.
   */
  step(dt) {
    const bodies = this.bodies;
    const n = bodies.length;

    // Where the step began. The collision pass sweeps these segments, and each
    // body also tracks how much of the step it has left, since a body pulled
    // back to a contact instant has less of it remaining than its neighbours.
    for (let i = 0; i < n; i++) {
      bodies[i].x0 = bodies[i].x;
      bodies[i].y0 = bodies[i].y;
      bodies[i]._tLeft = 1;
    }

    if (this.settings.integrator === 'verlet') {
      this.verletStep(dt);
    } else {
      this.verletStep(YOSHIDA_W1 * dt);
      this.verletStep(YOSHIDA_W0 * dt);
      this.verletStep(YOSHIDA_W1 * dt);
    }

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
    while (remaining > 1e-9 && taken < cap) {
      // A collision at the end of the previous step added and removed bodies,
      // which leaves every acceleration stale — and a body a merge just created
      // has a = 0, so the step chooser would see no acceleration at all and
      // take the entire remaining interval as one ballistic drift. That turned
      // a 49-second step into a sixteen-thousand-year one and threw the
      // giant-impact disc a light-year clear of the planet.
      // A collision at the end of the previous step added and removed bodies,
      // which leaves every acceleration stale — and a body a merge just created
      // has a = 0, so the step chooser would see no acceleration at all and
      // take the entire remaining interval as one ballistic drift.
      if (this._accelDirty) this.computeAccelerations();
      const dt = Math.min(remaining, this.chooseDt(remaining));
      this.step(dt);
      remaining -= dt;
      taken++;
      if (now() - started > budgetMs) break;
    }
    if (remaining > 1e-9) this.throttled = true;

    // Tides act on orbital timescales, so checking them once per frame rather
    // than once per substep costs nothing physically and used to cost 43% of
    // the frame budget.
    if (this.settings.tidalDisruption) this.checkTides(seconds - remaining);
    this.cullNonFinite();

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
      this.tree.build(bodies);

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
      // How much of the step these bodies still have left. A body pulled back
      // to an earlier contact already spent part of its step, so the fraction
      // `best.t` is a fraction of *its* remaining interval, not of the whole
      // one — measuring the catch-up against the full dt over-drifts everything
      // involved in a second or later contact by 1/(1 - t_first).
      const wasLeft = Math.min(
        best.a._tLeft != null ? best.a._tLeft : 1,
        best.b._tLeft != null ? best.b._tLeft : 1
      );
      const left = wasLeft * (1 - best.t);
      const catchUp = left * dt;
      for (const b of result.added || []) {
        b.x0 = b.x; b.y0 = b.y;
        b._tLeft = left;
        b.x += b.vx * catchUp;
        b.y += b.vy * catchUp;
      }
      for (const b of [best.a, best.b]) {
        if (!b.alive) continue;
        b.x0 = b.x; b.y0 = b.y;
        b._tLeft = left;
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

  /**
   * Remove any body that has gone non-finite, and report it.
   *
   * Nothing in the engine should produce one — but a NaN that does appear
   * spreads through the tree into every force in the scene within one step, so
   * it is worth one linear scan to contain it at the source instead of
   * debugging its shadow somewhere else.
   */
  cullNonFinite() {
    let removed = 0;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      if (isFinite(b.x) && isFinite(b.y) && isFinite(b.vx) && isFinite(b.vy)
        && b.mass > 0 && isFinite(b.mass) && b.radius > 0 && isFinite(b.radius)) continue;
      this.bodies.splice(i, 1);
      b.alive = false;
      removed++;
    }
    if (removed) {
      this._accelDirty = true;
      this._energyRef = null;
      this.nonFiniteRemoved = (this.nonFiniteRemoved || 0) + removed;
      this.emit('nonfinite', removed);
    }
    return removed;
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
