import { G, C, TAU, clamp, rocheLimit, SIGMA_SB, T_CMB } from './const.js';
import { Body, resetIds } from './body.js';
import { Quadtree } from './quadtree.js';
import { resolveCollision, sweptContactDisp, tidallyDisrupt } from './collide.js';
import { dominantAttractor } from './kepler.js';
import { GrainSystem } from './grains.js';
import { radiusFromMass } from './materials.js';

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
    this._energyRefStep = 0;
    this.energyDrift = 0;
    this.energySteps = 0;
    this.listeners = {};
    this._frame = 0;
    this._dt = 0;      // the held integration step, see chooseDt
  }

  on(evt, fn) { (this.listeners[evt] || (this.listeners[evt] = [])).push(fn); }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }

  clear() {
    // Mark them dead first: anything still holding a reference — the grab tool,
    // the camera's follow target — otherwise sees a live-looking orphan that is
    // no longer in the world.
    for (const b of this.bodies) b.alive = false;
    this.bodies.length = 0;
    this.time = 0;
    this.steps = 0;
    this._dt = 0;
    this.events.length = 0;
    this.collisionCount = 0;
    this.mergeCount = 0;
    this._energyRef = null;
    this._energyRefStep = 0;
    this.energyDrift = 0;
    this.energySteps = 0;
    resetIds(1);
  }

  add(body) {
    if (this.bodies.length >= this.settings.maxBodies) {
      // Shed the least interesting thing rather than refusing the new body.
      // Debris first; if there is none, the least massive of anything, because
      // refusing the new body loses its mass with no record of it.
      let worstDebris = -1, worstDebrisMass = Infinity;
      let worstAny = -1, worstAnyMass = Infinity;
      // The incoming body is not in the array yet, so it cannot be evicted and
      // does not need excluding here.
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
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

  /**
   * The smallest mass worth tracking as its own body in this scene, taken as a
   * fraction of the largest body present. Without a scene-wide floor, debris
   * sheds debris without limit — a gate expressed as a fraction of the pair
   * that produced it shrinks exactly as fast as the pieces do.
   */
  fragmentFloor() {
    if (this._floorFrame === this._frame && this._floor != null) return this._floor;
    let biggest = 0;
    for (const b of this.bodies) if (b.mass > biggest) biggest = b.mass;
    this._floor = biggest * 1e-6;
    this._floorFrame = this._frame;
    return this._floor;
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

      // How long until this body reaches the surface of its nearest neighbour,
      // if both keep going. The step chooser caps on it so that a contact is
      // always resolved from a touch rather than from an overlap.
      // Only for a neighbour it is actually closing on, and only while there
      // is still a gap. Using the full relative speed instead of the radial
      // part capped the step for every body merely *near* another one, which in
      // a debris disc is all of them all the time, and the simulation slowed by
      // a factor of three thousand. Two bodies passing each other at speed are
      // not on their way to a contact.
      b.closeTime = Infinity;
      const j = out[4];
      const gap = out[3];
      if (this.settings.collisions !== false && j >= 0 && j < n && gap > 0 && isFinite(gap)) {
        const o = this.bodies[j];
        if (o) {
          const dx = o.x - b.x, dy = o.y - b.y;
          const d = Math.hypot(dx, dy);
          if (d > 0) {
            // Positive when the separation is shrinking.
            const closing = ((b.vx - o.vx) * dx + (b.vy - o.vy) * dy) / d;
            if (closing > 0) b.closeTime = gap / closing;
          }
        }
      }
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
    const eta = this.settings.relativity
      ? Math.min(this.settings.eta, 0.012)
      : this.settings.eta;
    const dyn = eta * Math.sqrt(scale / a);

    // And never long enough to pass through the thing it is approaching.
    //
    // The dynamical criterion knows nothing about contact: it is a statement
    // about the local gravitational field, and two bodies closing at 5 km/s
    // across a gap of a hundred kilometres are in no hurry by that measure. So
    // at large time scales, where the requested chunk lets the held step grow,
    // a step could carry a body deep inside another before anything looked. The
    // swept test still finds the contact, but everything downstream then sees
    // an interpenetration rather than a touch — which is why a gentle encounter
    // could come out looking like a violent one, and why a debris disc that
    // settles into a moon at one time scale came apart into 282 fragments at
    // another.
    const close = b.closeTime;
    if (close != null && isFinite(close) && close > 0) {
      // Floored against the dynamical step: an approach can be arbitrarily slow
      // across an arbitrarily small gap, and letting that drive the step to
      // zero trades one failure for a worse one.
      return Math.max(Math.min(dyn, close * 0.35), dyn / 48);
    }
    return dyn;
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
    // The relativity cap on eta lives in bodyStep, which is the only place the
    // step is actually computed; it was duplicated here into two variables that
    // nothing read.
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
   * One kick-drift-kick velocity Verlet step: a half kick folded into the
   * position update, the force evaluation, then the second half kick.
   * Accelerations must be current on entry, and are current again on exit.
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
    // Not `bodies.length === 0`: during a collision every scrap of matter in
    // the scene can be parcels, and returning early there froze the clock at
    // the exact moment there was something to watch.
    const hasGrains = !!(this.grains && this.grains.n > 0);
    if (seconds <= 0 || (this.bodies.length === 0 && !hasGrains)) return 0;
    if (this.bodies.length === 0) {
      // Parcels only: no orbits to integrate, so hand the whole step to them.
      this._frame++;
      const used = this.stepGrains(seconds) || 0;
      this.throttled = used < seconds - 1e-9;
      this.time += used;
      this.substepsTaken = this.grainSubsteps || 0;
      this.updateTrails();
      return used;
    }
    // A body added or removed since the last step leaves every acceleration
    // stale, and the first drift of the next step would use it.
    if (this.steps === 0 || this._accelDirty) this.computeAccelerations();
    // Before anything else: a body handed to us non-finite (a tool, a restored
    // snapshot, a hand-edited value) must not reach the tree.
    if (this.cullNonFinite()) this.computeAccelerations();

    this._frame++;
    // Parcels resolve on a scale of seconds. If a collision is in flight, the
    // clock comes down to meet it rather than skipping past it: at a megayear
    // a second there is no step that both advances the orbit and resolves a
    // contact, and the honest answer is that the interesting thing is the
    // collision. The status line says TIME LIMITED while this holds.
    if (this.grains && this.grains.n > 0) {
      // The bodies advance by however much the parcels manage, so the two never
      // drift apart. That does mean the clock slows to collision speed while a
      // collision is happening, which is the point of watching one.
      const cap = this.grainCapacity(this.grains);
      if (seconds > cap) { seconds = cap; this.throttled = true; }
    }
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
    // One deadline for the whole frame, shared with the contact solver, which
    // used to take its own now() + 1.5x budget on every substep. On the discs
    // measured here contacts cost 1.4 ms a frame and never came near either
    // figure, so this bought nothing today; it bounds the pathological case,
    // where a pile-up late in a frame could otherwise spend the whole budget
    // again after the integrator had already spent it.
    this._frameDeadline = started + budgetMs * 1.35;
    while (remaining > 1e-9 && taken < cap) {
      // A collision at the end of the previous step added and removed bodies,
      // which leaves every acceleration stale — and a body a merge just created
      // has a = 0, so the step chooser would see no acceleration at all and
      // take the entire remaining interval as one ballistic drift. That turned
      // a 49-second step into a sixteen-thousand-year one and threw the
      // giant-impact disc a light-year clear of the planet.
      if (this._accelDirty) this.computeAccelerations();
      // Between the tree and the step: a body that arrived non-finite, or that
      // an acceleration pass has just made non-finite, is removed before it can
      // be integrated and smear across the scene.
      if (this.cullNonFinite()) this.computeAccelerations();
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
    if (this.grains && this.grains.n > 0) this.stepGrains(seconds - remaining);
    this.relaxFields(seconds - remaining);
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
    // The frame's deadline, not a fresh one per substep -- but never less than
    // 4 ms from here, so a contact pass that starts late still makes some
    // progress rather than bouncing straight off an expired clock.
    const deadline = Math.max(now() + 4, this._frameDeadline
      || now() + (this.settings.frameBudgetMs || 11) * 1.35);

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

      // Big enough to be worth watching? Then stop treating it as an event with
      // an outcome and let the material sort it out. Everything below the
      // threshold — a pebble cratering a planet, two grains of debris settling
      // — still goes through the analytic path, because shattering an Earth
      // into thousands of parcels to resolve a crater would be absurd.
      if (this.settings.grainCollisions !== false && this.worthShattering(best.a, best.b)) {
        if (this.shatterInto(best.a, best.b)) {
          this.emit('collision', {
            regime: 'shatter', x: best.a.x, y: best.a.y,
            vImp: Math.hypot(best.b.vx - best.a.vx, best.b.vy - best.a.vy),
            energy: 0, scale: best.a.radius + best.b.radius,
          });
          continue;
        }
      }

      // Taper fragmentation as the scene fills up. Shattering a body into
      // fifty pieces when there is room for ten produces fifty, evicts forty,
      // and loses their mass; letting the outcome know the budget keeps the
      // books straight and stops a cascade from running away.
      const room = this.settings.maxBodies - bodies.length;
      const result = resolveCollision(best.a, best.b, {
        maxFragments: clamp(Math.floor(room / 3), 2, this.settings.maxFragments),
        allowBounce: this.settings.bounce !== false,
        // Scene-wide, so it does not shrink along with the debris it bounds.
        minFragmentMass: this.fragmentFloor(),
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
      if (t.length < 2) {
        // The first point has nothing to compare against. Comparing anyway gave
        // NaN, every comparison against NaN is false, the negated guard was
        // therefore always true, and the trail never got its first point — so
        // it never got a second one either. Trails have never drawn a pixel.
        t.push(b.x, b.y);
        continue;
      }
      const lastX = t[t.length - 2];
      const lastY = t[t.length - 1];
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
   * spreads through the tree into every force in the scene within one step:
   * the root bounding box goes NaN, and with it every acceleration.
   *
   * This used to run only at the end of advance(), which is one step too late
   * to contain anything. Injecting a NaN velocity into one body of the twelve
   * in the Solar System preset and calling advance() once left *zero* bodies,
   * with all twelve reported culled — the comment here claimed containment and
   * the code delivered a total loss. It now runs before the substep loop and
   * again after every acceleration pass, so the infected body is the only one
   * that goes.
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
        if (!(d > 0)) continue;
        // The potential has to match the force the tree actually applies, or
        // the drift figure measures the disagreement between the two models
        // rather than the integrator -- and it does so precisely in the scenes
        // where someone would be watching it, since overlapping pairs are what
        // a collision is. Inside contact the force falls linearly to zero
        // (shell theorem, quadtree.js), whose potential is
        // -Gm1m2(3R^2 - d^2)/(2R^3), continuous with -Gm1m2/d at d = R.
        const reach = a.radius + b.radius;
        if (d < reach && reach > 0) {
          pe -= (G * a.mass * b.mass * (3 * reach * reach - d * d)) / (2 * reach * reach * reach);
        } else {
          pe -= (G * a.mass * b.mass) / d;
        }
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
    // An exact O(N²) pairwise sum: 21 ms at nine hundred bodies. Worth paying
    // when someone is reading the number, not otherwise.
    if (!this.settings.wantDiagnostics) return;
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

  // --- matter in flight -----------------------------------------------------

  /**
   * Is this collision worth simulating parcel by parcel?
   *
   * Two tests. The smaller body has to be a real fraction of the larger, since
   * a projectile a millionth of the target's mass cannot deform it in any way
   * a few thousand parcels could resolve. And the impact has to be energetic
   * enough to do something: below the pair's escape velocity they are simply
   * going to settle together, which the analytic path already does correctly
   * and far more cheaply.
   */
  worthShattering(a, b) {
    if (a.kind === 'bh' || b.kind === 'bh') return false;
    if (a.kind === 'star' || b.kind === 'star') return false;
    const big = a.mass >= b.mass ? a : b;
    const small = a.mass >= b.mass ? b : a;
    if (small.mass < big.mass * 0.02) return false;
    const rs = a.radius + b.radius;
    const vEsc = Math.sqrt((2 * G * (a.mass + b.mass)) / Math.max(rs, 1));
    const vImp = Math.hypot(b.vx - a.vx, b.vy - a.vy);
    if (vImp < vEsc * 0.55) return false;
    // One event at a time. Condensing part of a collision while the rest is
    // still in flight puts a solid body inside a cloud of parcels it is
    // overlapping, which re-collides, re-shatters, and runs away: parcels went
    // from 1558 to 4161 and bodies to 278 inside three frames.
    const g = this.grains;
    if (g && g.n > 0) return false;
    // And both have to be big enough that a few hundred parcels can say
    // anything useful about them.
    if (Math.min(a.mass, b.mass) < (this.settings.grainMinMass || 1e21)) return false;
    // Not in a crowd. A protoplanetary disc is a hundred and sixty bodies
    // grinding against each other for thousands of collisions, and resolving
    // each one parcel by parcel is both unwatchable and beside the point —
    // there the interesting thing is the population, not any one impact. The
    // analytic path is the right level of detail for that, and this is the
    // right level for the collision you are actually looking at.
    return this.bodies.length <= (this.settings.grainMaxScene || 24);
  }

  /**
   * Turn two bodies about to collide into the material they are made of.
   *
   * From here until it settles, there are no bodies involved — only parcels
   * pulling on each other, hitting each other, and sticking or not depending on
   * how hot they are. What comes out is not chosen: it is however many clumps
   * the parcels end up in.
   *
   * Only worth doing for a collision big enough to watch. A pebble hitting a
   * planet is still handled analytically, because shattering an Earth into six
   * thousand parcels to resolve a crater would be absurd.
   */
  shatterInto(a, b) {
    if (!this.grains) this.grains = new GrainSystem({ cap: this.settings.grainCap || 4200 });
    const g = this.grains;
    const total = a.mass + b.mass;
    const room = g.cap - g.n;
    if (room < 200) return false;

    // Parcels split between the two in proportion to mass, but never so few for
    // the smaller one that it is a single blob.
    const budget = Math.min(room, this.settings.grainCount || 1600);
    const share = clamp(b.mass / total, 0.06, 0.5);
    const nb = Math.max(40, Math.round(budget * share));
    const na = Math.max(60, budget - nb);

    const before = g.n;
    if (!g.addBody(a, na)) return false;
    if (!g.addBody(b, nb)) { g.n = before; return false; }

    this.remove(a);
    this.remove(b);
    this._grainAge = 0;
    this.grainsActive = true;
    this._accelDirty = true;
    this.emit('shatter', { x: a.x, y: a.y, mass: total, parcels: g.n - before });
    return true;
  }

  /**
   * Step the parcels, and let go of any clump that has finished being one.
   *
   * A cluster becomes a body again when it is cold enough to hold together and
   * its parcels have stopped moving relative to each other — not after a fixed
   * time, and not because anything decided it should. Until then it stays
   * parcels, which is why a planet mid-impact is the wrong shape.
   */
  stepGrains(dt) {
    const g = this.grains;
    if (!g || g.n === 0) { this.grainsActive = false; return; }

    // The rest of the universe still pulls on the debris.
    const bodies = this.bodies;
    const external = (gs) => {
      for (let i = 0; i < gs.n; i++) {
        let ax = 0, ay = 0;
        for (let k = 0; k < bodies.length; k++) {
          const o = bodies[k];
          const dx = o.x - gs.x[i], dy = o.y - gs.y[i];
          const d2 = dx * dx + dy * dy;
          const reach = o.radius + gs.r[i];
          const d = Math.sqrt(d2);
          if (d <= 0) continue;
          const f = d < reach
            ? (G * o.mass * d) / (reach * reach * reach)
            : (G * o.mass) / (d2 * d);
          ax += f * dx; ay += f * dy;
        }
        gs._ax[i] += ax; gs._ay[i] += ay;
      }
    };

    // Sub-stepped: the parcels need a finer step than the orbital one, and the
    // budget decides how much of it they get.
    // The step the parcels can take, and never more: dividing a large frame
    // into a bounded number of substeps let h exceed it, and a parcel that
    // crosses more than its own radius in one step arrives already deep inside
    // its neighbour and is thrown out at enormous speed. Two rocky worlds
    // meeting at 1.7 escape velocities blew apart into a cloud that left the
    // screen, when the same collision run at a safe step accretes.
    const h = this.grainStep(g);
    const deadline = now() + Math.max(3, (this.settings.frameBudgetMs || 11) * 0.9);
    // Bounded, like the body integrator's own substep cap. A test that hands
    // out an effectively unlimited frame budget would otherwise ask for the
    // whole five days in one call — 54,000 parcel steps, three minutes of wall
    // clock, and no way to see it was progressing.
    const want = Math.max(1, Math.min(
      Math.ceil(dt / h), this.settings.maxGrainSubsteps || 600,
    ));
    let taken = 0;
    for (let s = 0; s < want; s++) {
      g.step(h, { external, equilibriumT: 2.725 });
      taken++;
      if (now() > deadline) break;
    }
    this.grainSubsteps = taken;
    // However much of the frame the parcels actually got through is how much
    // time passed. Anything else desynchronises the clock from the matter.
    this.grainSeconds = taken * h;
    // A collision that will not settle still has to end. The guard is generous
    // — thousands of parcel steps — and exists so a pathological scene degrades
    // into bodies rather than holding the clock down for ever.
    this._grainAge = (this._grainAge || 0) + taken;
    const stuck = this._grainAge > (this.settings.grainMaxSteps || 12000);
    // Clustering is a union-find over every parcel and costs as much as a
    // contact pass, so it runs a few times a second rather than every substep.
    this._sinceCluster = (this._sinceCluster || 0) + taken;
    if (stuck || this._sinceCluster >= 30) {
      this._sinceCluster = 0;
      this.condenseGrains(stuck);
      if (this.grains.n === 0) this._grainAge = 0;
    }
    return this.grainSeconds;
  }

  /** How much simulated time the parcels can cover in one frame's budget. */
  grainCapacity(g) {
    const per = Math.max(g.n, 1) * 3e-3;           // ms per substep, measured
    const budget = Math.max(3, (this.settings.frameBudgetMs || 11) * 0.9);
    return this.grainStep(g) * Math.max(1, Math.floor(budget / Math.max(per, 1e-3)));
  }

  /** The largest step the parcels can take without passing through each other. */
  grainStep(g) {
    // A quarter of a radius per parcel per step, not half.
    //
    // Two parcels approaching each other each move by this much, so the gap
    // closes at twice the rate: at half a radius apiece they can go from
    // touching to fully overlapped between one step and the next, and the
    // contact pass then has to undo a whole radius of interpenetration in one
    // go. That correction is a velocity, and it is enormous — an Earth-scale
    // impact at eleven kilometres a second tore itself into 305 pieces at 2.6
    // km/s, which is the numerics, not the physics.
    let worst = Infinity;
    for (let i = 0; i < g.n; i++) {
      const v = Math.hypot(g.vx[i], g.vy[i]);
      if (v > 0) worst = Math.min(worst, (g.r[i] * 0.25) / v);
    }
    return isFinite(worst) && worst > 0 ? worst : 1;
  }

  /**
   * Any cluster that has settled becomes a body again.
   *
   * "Settled" means its parcels have stopped moving relative to each other
   * compared with the speed it takes to escape it, and it is not still molten
   * through. A clump that is still churning stays parcels.
   */
  condenseGrains(force = false) {
    const g = this.grains;
    if (!g || g.n === 0) return;
    const groups = g.clusters();

    // All or nothing. A collision resolves into bodies when the whole scene has
    // stopped being a collision, not cluster by cluster: releasing one clump
    // early drops a solid body into the parcels it is still overlapping.
    if (!force) {
      for (const list of groups) {
        const s = g.summarise(list);
        if (!s) continue;
        if (list.length < 3) continue;
        const vEsc = Math.sqrt((2 * G * s.mass) / Math.max(radiusFromMass(s.mass, s.composition), 1));
        if (s.dispersion >= vEsc * 0.22 || s.molten >= 0.45) return;
      }
    }

    const keep = [];
    let condensed = 0;

    for (const list of groups) {
      const s = g.summarise(list);
      if (!s) continue;
      const vEsc = Math.sqrt((2 * G * s.mass) / Math.max(radiusFromMass(s.mass, s.composition), 1));
      // A lone parcel has nothing to be in equilibrium with, so it is settled
      // by definition — it is a rock flying through space. Requiring three of
      // them meant every scrap thrown clear stayed a parcel for ever, which
      // kept the whole system live and, because the clock is held down to
      // collision timescales while it is, stopped time permanently.
      const settled = force || list.length < 3
        || (s.dispersion < vEsc * 0.22 && s.molten < 0.45);
      if (!settled) { keep.push(...list); continue; }

      const body = new Body({
        name: 'Body', kind: s.mass > 3e22 ? 'planet' : (s.mass > 1e18 ? 'asteroid' : 'debris'),
        mass: s.mass, composition: s.composition, temperature: s.temperature,
        x: s.x, y: s.y, vx: s.vx, vy: s.vy, spin: s.spin,
        differentiation: clamp(s.molten * 1.4 + 0.25, 0, 1),
      });
      body.name = this.nameFor(body);
      this.add(body);
      condensed++;
    }

    if (condensed === 0) return;
    // Repack the parcels that are still in flight.
    const kx = keep.map((i) => [g.x[i], g.y[i], g.vx[i], g.vy[i], g.mass[i], g.mat[i], g.temp[i], g.r[i]]);
    g.clear();
    for (const [x, y, vx, vy, m, mat, t, r] of kx) g.add(x, y, vx, vy, m, mat, t, r);
    this.grainsActive = g.n > 0;
    this._accelDirty = true;
    this.emit('condense', { count: condensed, left: g.n });
  }

  nameFor(body) {
    this._condensedCount = (this._condensedCount || 0) + 1;
    const n = this._condensedCount;
    if (body.mass > 3e22) return `Accreted world ${n}`;
    return body.mass > 1e18 ? `Fragment ${n}` : `Debris ${n}`;
  }

  /**
   * Let molten interiors flow, mix and freeze.
   *
   * Only bodies that are actually molten cost anything: a solid planet's field
   * is skipped on a flag, which is most of them most of the time. The ones that
   * are molten are the ones something just happened to, and there are never
   * many at once, so a hard cap keeps a bad frame bounded rather than never
   * arriving.
   */
  relaxFields(dt) {
    if (!(dt > 0)) return;
    // A relaxation pass costs about a millisecond for a planet-sized field, so
    // this gets a budget of its own rather than being allowed to add eight of
    // them to a frame that has already spent eleven. Bodies are taken in mass
    // order so that when there is not enough time for all of them, it is the
    // one you are most likely to be looking at that keeps moving.
    const deadline = now() + Math.max(2, (this.settings.frameBudgetMs || 11) * 0.35);
    const hot = [];
    for (const b of this.bodies) {
      if (b.field && b.field.moltenFraction > 0.004) hot.push(b);
    }
    if (!hot.length) return;
    if (hot.length > 1) hot.sort((a, b) => b.mass - a.mass);
    for (const b of hot) {
      const f = b.field;
      if (now() > deadline) break;

      // What the surface is radiating into, and how long this body takes to
      // give up its heat. Both are the body's own numbers, so a small hot moon
      // freezes quickly and an Earth-sized magma ocean does not.
      const area = 4 * Math.PI * b.radius * b.radius;
      const eq = Math.pow(
        (b.insolation * (1 - b.albedo)) / (4 * SIGMA_SB) + Math.pow(T_CMB, 4), 0.25,
      );
      const t = Math.max(f.meanTemperature(), 1);
      const power = SIGMA_SB * area * t * t * t * t;
      const heat = b.mass * b.specificHeat * Math.max(t - eq, 1);
      const coolSeconds = power > 0 ? Math.max(heat / power, 1) : 1e12;

      if (!f.relax(dt, { equilibriumT: eq, coolSeconds })) {
        // Frozen. Take the final arrangement back into the body's own numbers
        // — this is the moment the terrain it ended up with becomes what the
        // body is made of.
        b.syncFromField();
        continue;
      }
      // Still moving: the surface is changing, so the sprite has to.
      b.revision++;
      b.refresh();
    }
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
    // Deliberately *not* Object.assign(this.settings, data.settings): a scene
    // file is untrusted input, and letting it set maxBodies, the substep
    // ceiling or the frame budget hands it the engine's limits. The UI reapplies
    // the user's own settings after loading.
    for (const o of data.bodies || []) this.add(Body.fromJSON(o));
    this.time = data.time || 0;
    this.computeAccelerations();
  }

  snapshot() { return JSON.stringify(this.toJSON()); }
  restore(snap) { this.loadJSON(JSON.parse(snap)); }
}
