import { clamp, TAU } from '../core/const.js';
import { incandescence } from '../core/materials.js';
import { makeRng, gaussian } from '../core/rng.js';

/**
 * Visual effects live in world space and in *simulated* time, so an explosion
 * at a thousand years per second does not sit frozen on screen while the
 * planets tear past it. Their lifetimes are expressed as a fraction of the
 * local dynamical time of the event that spawned them.
 */

const rng = makeRng(0xc0ffee);

export class Effects {
  constructor() {
    this.particles = [];   // flat records, pooled
    this.rings = [];
    this.beams = [];
    this.flashes = [];
    this.maxParticles = 2600;
    // Rings, flashes and beams were uncapped: one explosion at high intensity
    // put nearly four thousand live objects on screen and halved the frame rate.
    this.maxRings = 220;
    this.maxFlashes = 160;
    this.maxBeams = 24;
    // Seconds of wall time an effect is guaranteed to remain visible for.
    this.minVisible = 1.1;
  }

  /**
   * Make room for `n` more particles by dropping the oldest.
   *
   * The spawners used to `break` when the list was full, so once saturated the
   * oldest particles held the slots and a fresh impact produced nothing at all.
   */
  room(n) {
    const over = this.particles.length + n - this.maxParticles;
    if (over > 0) this.particles.splice(0, over);
  }

  /** Drop the oldest entries when a list is over its ceiling. */
  cap() {
    if (this.rings.length > this.maxRings) this.rings.splice(0, this.rings.length - this.maxRings);
    if (this.flashes.length > this.maxFlashes) this.flashes.splice(0, this.flashes.length - this.maxFlashes);
    if (this.beams.length > this.maxBeams) this.beams.splice(0, this.beams.length - this.maxBeams);
  }

  clear() {
    this.particles.length = 0;
    this.rings.length = 0;
    this.beams.length = 0;
    this.flashes.length = 0;
  }

  get count() {
    return this.particles.length + this.rings.length + this.flashes.length + this.beams.length;
  }

  /**
   * Spawn the debris cloud for an impact.
   *
   * `scale` is a length in metres and `energy` is in joules; together they set
   * both how far the sparks fly and what colour they are, so a gentle bump and
   * a planet-shattering hit do not produce the same puff.
   */
  impact(x, y, scale, energy, vImp, opts = {}) {
    const n = clamp(Math.round(12 + Math.log10(Math.max(energy, 1)) * 2.2), 8, 90);
    // Characteristic ejection speed: a fraction of the impact speed.
    const v0 = Math.max(vImp * 0.22, scale * 0.4);
    const temp = opts.temperature || clamp(1200 + Math.log10(Math.max(energy, 1)) * 260, 900, 9000);
    const col = incandescence(temp) || [255, 170, 80];
    const dirx = opts.nx || 0, diry = opts.ny || 0;
    const biased = (dirx !== 0 || diry !== 0);

    this.room(n);
    for (let i = 0; i < n; i++) {
      let ang = rng() * TAU;
      if (biased) {
        // Ejecta cones open away from the impact normal.
        const base = Math.atan2(-diry, -dirx);
        ang = base + gaussian(rng) * 0.75;
      }
      const speed = v0 * (0.35 + Math.abs(gaussian(rng)) * 0.85);
      const life = (scale * 5) / Math.max(speed, 1e-6);
      this.particles.push({
        x, y,
        vx: (opts.vx || 0) + Math.cos(ang) * speed,
        vy: (opts.vy || 0) + Math.sin(ang) * speed,
        life, age: 0,
        r: col[0], g: col[1], b: col[2],
        size: 1 + (rng() < 0.25 ? 1 : 0),
        drag: 0,
        cool: 1,
      });
    }

    this.rings.push({
      x, y, r: scale * 0.2, vr: Math.max(v0 * 0.7, scale),
      life: (scale * 9) / Math.max(v0, 1e-6), age: 0,
      r0: col[0], g0: col[1], b0: col[2], width: 1,
    });
    this.flashes.push({
      x, y, radius: scale * 2.2, life: (scale * 4) / Math.max(v0, 1e-6), age: 0,
      r: col[0], g: col[1], b: col[2],
    });
  }

  /** A merge: a hot flash and a slow expanding shell rather than a spray. */
  merge(x, y, scale, energy) {
    const temp = clamp(1400 + Math.log10(Math.max(energy, 1)) * 200, 900, 6000);
    const col = incandescence(temp) || [255, 190, 110];
    this.flashes.push({ x, y, radius: scale * 3, life: scale * 4e-4 + 0.6, age: 0, r: col[0], g: col[1], b: col[2] });
    this.rings.push({
      x, y, r: scale, vr: scale * 1.4, life: 2.2, age: 0,
      r0: col[0], g0: col[1], b0: col[2], width: 2,
    });
    this.room(26);
    for (let i = 0; i < 26; i++) {
      const ang = rng() * TAU;
      const speed = scale * (0.5 + rng());
      this.particles.push({
        x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: 1.6 + rng(), age: 0, r: col[0], g: col[1], b: col[2],
        size: 1, drag: 0.6, cool: 1,
      });
    }
  }

  /** Catastrophic disruption: a big shell, lots of embers, a long-lived glow. */
  shatter(x, y, scale, energy, vImp) {
    const col = incandescence(clamp(2000 + Math.log10(Math.max(energy, 1)) * 300, 1200, 12000)) || [255, 220, 170];
    const v0 = Math.max(vImp * 0.3, scale * 0.5);
    this.room(120);
    for (let i = 0; i < 120; i++) {
      const ang = rng() * TAU;
      const speed = v0 * (0.2 + Math.abs(gaussian(rng)) * 1.1);
      this.particles.push({
        x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: (scale * 8) / Math.max(speed, 1e-6), age: 0,
        r: col[0], g: col[1], b: col[2],
        size: rng() < 0.35 ? 2 : 1, drag: 0, cool: 1,
      });
    }
    for (let k = 0; k < 3; k++) {
      this.rings.push({
        x, y, r: scale * 0.1 * (k + 1), vr: v0 * (0.9 - k * 0.22),
        life: (scale * 12) / Math.max(v0, 1e-6), age: 0,
        r0: col[0], g0: col[1], b0: col[2], width: 2 - k * 0.5,
      });
    }
    this.flashes.push({ x, y, radius: scale * 4, life: (scale * 6) / Math.max(v0, 1e-6), age: 0, r: col[0], g: col[1], b: col[2] });
  }

  /** Matter crossing a horizon: a brief, very blue flare. */
  accretion(x, y, scale, energy) {
    this.flashes.push({ x, y, radius: scale, life: 1.1, age: 0, r: 190, g: 220, b: 255 });
    this.room(40);
    for (let i = 0; i < 40; i++) {
      const ang = rng() * TAU;
      const speed = scale * (0.6 + rng() * 1.4);
      this.particles.push({
        x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        life: 0.6 + rng() * 0.8, age: 0, r: 170, g: 210, b: 255,
        size: 1, drag: 1.4, cool: 0,
      });
    }
  }

  /** The laser's visible beam, refreshed every frame it is held. */
  beam(x0, y0, x1, y1, width, hue) {
    this.beams.push({ x0, y0, x1, y1, width, hue, age: 0, life: 0.06 });
  }

  /** Vaporised surface streaming off a body under the laser. */
  ablate(x, y, nx, ny, speed, temperature) {
    const col = incandescence(temperature) || [255, 200, 120];
    this.room(3);
    for (let i = 0; i < 3; i++) {
      const ang = Math.atan2(ny, nx) + gaussian(rng) * 0.5;
      const s = speed * (0.5 + rng());
      this.particles.push({
        x, y, vx: Math.cos(ang) * s, vy: Math.sin(ang) * s,
        life: 0.8 + rng() * 1.2, age: 0,
        r: col[0], g: col[1], b: col[2], size: 1, drag: 0.35, cool: 1,
      });
    }
  }

  /** Field pulse for attract/repel, drawn as a travelling ring. */
  pulse(x, y, radius, sign) {
    this.rings.push({
      x, y,
      r: sign > 0 ? radius : radius * 0.05,
      vr: sign > 0 ? -radius * 1.6 : radius * 1.6,
      life: 0.55, age: 0,
      r0: sign > 0 ? 120 : 255, g0: sign > 0 ? 220 : 140, b0: sign > 0 ? 255 : 120,
      width: 1,
    });
  }

  /**
   * Step every effect.
   *
   * Effects are built from real quantities — an ejecta curtain expands at the
   * speed the impact actually threw material — so they run on simulated time.
   * But a planetary impact is over in minutes, and at a megayear a second that
   * is a fraction of one frame: the burst would exist only between two images
   * and never be seen. So each effect's clock is capped to a rate that keeps it
   * on screen for at least `minVisible` seconds of wall time. At ordinary
   * speeds the cap never binds and the motion is the honest one.
   *
   * Particles do not feel gravity — they are visual, not physical, and giving
   * them mass would be both slower and a lie about what the simulation tracks.
   */
  update(dtSim, dtReal = 1 / 60) {
    if (!(dtSim > 0)) dtSim = 0;
    if (!(dtReal > 0)) dtReal = 1 / 60;
    const minVisible = this.minVisible || 1.1;
    const step = (life) => Math.min(dtSim, (life / minVisible) * dtReal);

    const ps = this.particles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const dt = step(p.life);
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vy *= k;
      }
      ps[w++] = p;
    }
    ps.length = w;

    w = 0;
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      const dt = step(r.life);
      r.age += dt;
      if (r.age >= r.life) continue;
      r.r = Math.max(0, r.r + r.vr * dt);
      this.rings[w++] = r;
    }
    this.rings.length = w;

    w = 0;
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      f.age += step(f.life);
      if (f.age >= f.life) continue;
      this.flashes[w++] = f;
    }
    this.flashes.length = w;

    this.cap();

    // Beams are re-emitted each frame they are active, so they expire on real
    // time rather than simulated time.
    w = 0;
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      b.age += dtReal;
      if (b.age >= b.life) continue;
      this.beams[w++] = b;
    }
    this.beams.length = w;
  }

  /** Translate a world event from the simulation into something to look at. */
  consume(event, camera) {
    switch (event.type) {
      case 'impact':
        this.impact(event.x, event.y, event.scale, event.energy, event.vImp, { nx: event.nx, ny: event.ny });
        if (camera) camera.addShake(clamp(Math.log10(Math.max(event.energy, 1)) / 30, 0, 0.5));
        break;
      case 'merge':
        this.merge(event.x, event.y, event.scale, event.energy);
        if (camera) camera.addShake(0.25);
        break;
      case 'disrupt':
      case 'shatter':
        this.shatter(event.x, event.y, event.scale, event.energy, event.vImp || event.scale);
        if (camera) camera.addShake(event.type === 'shatter' ? 0.9 : 0.55);
        break;
      case 'bounce':
        this.impact(event.x, event.y, event.scale, event.energy, event.vImp, { temperature: 800 });
        break;
      case 'accretion':
        this.accretion(event.x, event.y, event.scale, event.energy);
        if (camera) camera.addShake(0.35);
        break;
      case 'tidal':
        this.shatter(event.x, event.y, event.scale, event.energy, event.scale * 0.4);
        if (camera) camera.addShake(0.4);
        break;
      default:
        break;
    }
  }
}
