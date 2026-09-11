import { G, C, M_SUN, TAU, clamp, schwarzschild, escapeVelocity } from '../core/const.js';
import { Body, classifyCompact, compactRadius } from '../core/body.js';
import { compositionProperty } from '../core/materials.js';
import { makeRng, hashSeed, gaussian, powerLawSample } from '../core/rng.js';
import { radiusFromMass } from '../core/materials.js';
import { displayRadiusPx } from '../render/scale.js';

const rng = makeRng(0xbeef);

/**
 * The tool set.
 *
 * Two of these — attract and repel — are openly unphysical: they are a hand
 * reaching into the simulation. The rest are held to the same standard as the
 * rest of the engine. The laser really does deposit joules and really does take
 * the recoil; explode really does compare its energy to a body's binding
 * energy before deciding whether it comes apart; collapse really does check the
 * Chandrasekhar and TOV limits before deciding what is left behind.
 */

export const TOOLS = [
  { id: 'select', label: 'Select', key: '1', hint: 'Click a body to inspect it · drag to pan' },
  { id: 'laser', label: 'Laser', key: '2', hint: 'Hold to burn · heats, melts and boils off the surface' },
  { id: 'attract', label: 'Attract', key: '3', hint: 'Hold to pull everything toward the cursor' },
  { id: 'repel', label: 'Repel', key: '4', hint: 'Hold to push everything away' },
  { id: 'explode', label: 'Explode', key: '5', hint: 'Click to detonate · enough energy shatters a body' },
  { id: 'collapse', label: 'Collapse', key: '6', hint: 'Hold on a body to crush it past degeneracy' },
  { id: 'grab', label: 'Grab', key: '7', hint: 'Drag a body · release to throw it' },
  { id: 'delete', label: 'Delete', key: '8', hint: 'Click to remove · drag to sweep' },
];

export const TOOL_IDS = TOOLS.map((t) => t.id);

/** Radius of the tool's field, in buffer pixels, for the cursor ring. */
export function toolRadiusPixels(tool, intensity, camera) {
  switch (tool) {
    case 'attract': case 'repel': return 26 + intensity * 70;
    case 'explode': return 16 + intensity * 46;
    case 'collapse': return 20 + intensity * 40;
    case 'delete': return 14 + intensity * 26;
    default: return 0;
  }
}

const RING_COLORS = {
  attract: 'rgba(122,200,255,0.55)',
  repel: 'rgba(255,150,110,0.55)',
  explode: 'rgba(255,120,90,0.7)',
  collapse: 'rgba(190,140,255,0.65)',
  delete: 'rgba(255,90,110,0.6)',
};

export function toolRingColor(tool) { return RING_COLORS[tool] || 'rgba(127,240,216,0.5)'; }

/** The body under a world-space point, preferring the smallest one hit. */
export function pickBody(world, wx, wy, camera, slopPixels = 6, settings = null) {
  const slop = slopPixels / camera.scale;
  let best = null, bestScore = Infinity;
  for (const b of world.bodies) {
    const d = Math.hypot(b.x - wx, b.y - wy);
    // Hit-test against the drawn size, not the true one: a planet rendered as
    // a four-pixel dot has to be clickable as a four-pixel dot.
    const drawn = settings ? displayRadiusPx(b, camera, settings) / camera.scale : b.radius;
    const reach = Math.max(b.radius, drawn) + slop;
    if (d > reach) continue;
    // Prefer the body whose edge is nearest: clicking a moon in front of a
    // planet should select the moon.
    const score = d - reach;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  return best;
}

/** First body along a ray, for the laser. */
function raycast(world, ox, oy, dx, dy, maxDist) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  let best = null, bestT = maxDist;
  for (const b of world.bodies) {
    const px = b.x - ox, py = b.y - oy;
    const t = px * ux + py * uy;              // projection onto the ray
    if (t < 0 || t > bestT) continue;
    const perp = Math.abs(px * uy - py * ux);
    if (perp > b.radius) continue;
    // Step back to the near surface rather than the closest-approach point.
    const back = Math.sqrt(Math.max(0, b.radius * b.radius - perp * perp));
    const hit = t - back;
    if (hit < 0 || hit > bestT) continue;
    bestT = hit;
    best = b;
  }
  return best ? { body: best, t: bestT, x: ox + ux * bestT, y: oy + uy * bestT } : null;
}

// ---------------------------------------------------------------------------

export class ToolController {
  constructor(app) {
    this.app = app;
    this.tool = 'select';
    this.intensity = 1;
    this.active = false;
    this.world = { x: 0, y: 0 };
    this.downWorld = { x: 0, y: 0 };
    this.grabbed = null;
    this.grabHistory = [];
    this.collapsing = null;
    this.collapseProgress = 0;
    this.dragging = false;
  }

  setTool(id) {
    if (!TOOL_IDS.includes(id)) return;
    this.releaseGrab();
    this.tool = id;
    this.app.emit('toolchange', id);
  }

  get hint() {
    const t = TOOLS.find((x) => x.id === this.tool);
    return t ? t.hint : '';
  }

  // --- pointer --------------------------------------------------------------

  down(worldPos, evt) {
    this.active = true;
    this.dragging = false;
    this.downWorld = { ...worldPos };
    this.world = { ...worldPos };
    const { world, camera } = this.app;

    switch (this.tool) {
      case 'select': {
        const b = pickBody(world, worldPos.x, worldPos.y, camera, 6, this.app.settings);
        this.app.select(b);
        break;
      }
      case 'grab': {
        const b = pickBody(world, worldPos.x, worldPos.y, camera, 6, this.app.settings);
        if (b) {
          this.grabbed = b;
          this.grabOffset = { x: b.x - worldPos.x, y: b.y - worldPos.y };
          this.grabHistory.length = 0;
          // Remember whether it was already pinned: several presets anchor a
          // star, and releasing a grab used to un-pin it for good.
          this.grabWasFixed = b.fixed;
          b.fixed = true;
          this.app.select(b);
        }
        break;
      }
      case 'explode':
        this.explode(worldPos);
        break;
      case 'delete':
        this.deleteAt(worldPos);
        break;
      case 'collapse': {
        this.collapsing = pickBody(world, worldPos.x, worldPos.y, camera, 6, this.app.settings);
        this.collapseProgress = 0;
        if (this.collapsing) this.app.select(this.collapsing);
        break;
      }
      default:
        break;
    }
  }

  move(worldPos) {
    this.world = { ...worldPos };
    if (!this.active) return;
    const d = Math.hypot(worldPos.x - this.downWorld.x, worldPos.y - this.downWorld.y);
    if (d * this.app.camera.scale > 3) this.dragging = true;

    if (this.tool === 'grab' && this.grabbed) {
      const b = this.grabbed;
      const now = performance.now() / 1000;
      b.x = worldPos.x + this.grabOffset.x;
      b.y = worldPos.y + this.grabOffset.y;
      this.grabHistory.push({ t: now, x: b.x, y: b.y });
      // Keep about a fifth of a second of history: enough to measure a throw,
      // short enough that a pause before release means a gentle placement.
      while (this.grabHistory.length > 2 && now - this.grabHistory[0].t > 0.2) {
        this.grabHistory.shift();
      }
    }
    if (this.tool === 'delete' && this.dragging) this.deleteAt(worldPos);
  }

  up() {
    this.active = false;
    if (this.tool === 'grab') this.releaseGrab();
    this.collapsing = null;
    this.collapseProgress = 0;
    this._warnedCollapse = false;
  }

  releaseGrab() {
    const b = this.grabbed;
    if (!b) return;
    b.fixed = !!this.grabWasFixed;
    // Throw velocity from the tail of the drag.
    const h = this.grabHistory;
    if (h.length >= 2) {
      const a = h[0], z = h[h.length - 1];
      const dt = Math.max(1e-3, z.t - a.t);
      b.vx = (z.x - a.x) / dt;
      b.vy = (z.y - a.y) / dt;
      // A throw faster than light is the one thing this engine will not do.
      const s = Math.hypot(b.vx, b.vy);
      if (s > 0.1 * C) { b.vx *= (0.1 * C) / s; b.vy *= (0.1 * C) / s; }
    }
    // No movement means a click, not a throw. Leave the velocity alone rather
    // than bringing a planet to a dead stop because the pointer did not move.
    this.grabbed = null;
    this.grabHistory.length = 0;
    this.app.world._accelDirty = true;
  }

  // --- per-frame, for the held tools ---------------------------------------

  /**
   * `dtReal` is wall-clock seconds and `dtSim` is simulated seconds. Field
   * tools act on wall-clock time — holding the laser for one second should burn
   * the same amount whether the clock is paused or running at a megayear a
   * second, or the tool would be unusable at either end.
   */
  update(dtReal, dtSim) {
    if (!this.active) return;
    switch (this.tool) {
      case 'laser': this.fireLaser(dtReal); break;
      case 'attract': this.applyField(dtReal, 1); break;
      case 'repel': this.applyField(dtReal, -1); break;
      case 'collapse': this.applyCollapse(dtReal); break;
      default: break;
    }
  }

  // --- laser ----------------------------------------------------------------

  /**
   * A beam that deposits real energy.
   *
   * Power scales with the intensity slider. What it does on arrival depends on
   * the material: it warms it, then spends latent heat melting it, then boils
   * it off. Boiled-off mass leaves at its thermal speed and the body takes the
   * recoil, which is how laser ablation propulsion actually works.
   */
  fireLaser(dt) {
    const { world, camera, effects } = this.app;
    const target = this.world;

    // The beam arrives from off-screen, so it reads as a strike rather than a
    // cursor effect. Direction is fixed in screen space.
    const reach = (Math.max(camera.width, camera.height) * 1.4) / camera.scale;
    const ang = -0.7 - camera.rotation;
    const ox = target.x - Math.cos(ang) * reach;
    const oy = target.y - Math.sin(ang) * reach;

    const hit = raycast(world, ox, oy, Math.cos(ang), Math.sin(ang), reach * 1.2);
    const endX = hit ? hit.x : target.x;
    const endY = hit ? hit.y : target.y;
    effects.beam(ox + Math.cos(ang) * reach * 0.55, oy + Math.sin(ang) * reach * 0.55, endX, endY, 1, '#ff5f7a');

    if (!hit) return;
    const b = hit.body;
    if (b.kind === 'bh') return;

    // The beam has to span a sandbox's worth of targets: a kilometre of rubble
    // and a planet with a 10^31 J heat capacity. At intensity 1 this is 10^30 W,
    // which warms an Earth by a couple of hundred kelvin a second — fast enough
    // to see the surface change, slow enough to aim.
    const power = 1e27 * Math.pow(10, this.intensity * 3);
    const energy = power * dt;

    const boil = compositionProperty(b.composition, 'boil') || 3000;
    const vapour = compositionProperty(b.composition, 'vapour') || 5e6;
    const cp = b.specificHeat;

    if (b.temperature < boil) {
      b.addHeat(energy);
    } else {
      // At the boiling point every extra joule goes into vaporising material.
      const dm = energy / (vapour + cp * 200);
      const lost = Math.min(dm, b.mass * 0.02);
      if (lost > 0 && b.mass - lost > 1e6) {
        // Thermal speed of the escaping vapour, from 3kT/m for a ~30 amu
        // molecule. The body takes the equal and opposite momentum.
        const vTh = Math.sqrt((3 * 1.380649e-23 * b.temperature) / (30 * 1.66054e-27));
        const nx = (hit.x - b.x) / (b.radius || 1);
        const ny = (hit.y - b.y) / (b.radius || 1);
        const p = lost * vTh;
        b.vx -= (nx * p) / b.mass;
        b.vy -= (ny * p) / b.mass;
        b.mass -= lost;
        b.refresh();
        this.app.world._accelDirty = true;
        effects.ablate(hit.x, hit.y, nx, ny, vTh * 0.25, b.temperature);
      }
    }

    // A shallow, hot scar where the beam lands.
    if (rng() < dt * 3) {
      // The beam excavates as if a small, very fast projectile had struck.
      b.addCrater(hit.x - b.x, hit.y - b.y, Math.max(1, energy / 1e12), b.radius * 0.02, 1e4, rng);
    }
    this.app.markDirty(b);
  }

  // --- attract / repel ------------------------------------------------------

  /**
   * The one honestly unphysical pair. It is a uniform acceleration field inside
   * a radius, so it moves a moon and a star at the same rate — which is what
   * makes it useful as a hand rather than as a mass you have to place.
   */
  applyField(dt, sign) {
    const { world, camera, effects } = this.app;
    const radiusPx = toolRadiusPixels(this.tool, this.intensity, camera);
    const R = radiusPx / camera.scale;
    // Scale the strength to the view, so the tool feels the same at every zoom.
    const accel = sign * 2.2 * Math.pow(10, this.intensity * 1.2) * (R / 60) * camera.scale * 0.6;

    for (const b of world.bodies) {
      if (b.fixed) continue;
      const dx = this.world.x - b.x, dy = this.world.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d > R || d < 1e-9) continue;
      // Falls off to nothing at the edge of the ring, so there is no visible
      // discontinuity when a body crosses it.
      const falloff = 1 - (d / R) * (d / R);
      const a = accel * falloff;
      b.vx += (dx / d) * a * dt;
      b.vy += (dy / d) * a * dt;
    }
    if (rng() < dt * 9) effects.pulse(this.world.x, this.world.y, R, sign);
    world._accelDirty = true;
  }

  // --- explode --------------------------------------------------------------

  /**
   * A point detonation.
   *
   * The yield is compared against each body's own gravitational binding energy:
   * a bomb that cannot beat it delivers a kick and a crater, one that can takes
   * the body apart into fragments whose mass distribution follows the same
   * power law the collision code uses.
   */
  explode(pos) {
    const { world, camera, effects } = this.app;
    const R = toolRadiusPixels('explode', this.intensity, camera) / camera.scale;
    // Yield spans 100 megatons to roughly the Sun's output for a second.
    const yieldJ = 4.184e17 * Math.pow(10, this.intensity * 6);

    const affected = [];
    for (const b of world.bodies) {
      const d = Math.hypot(b.x - pos.x, b.y - pos.y);
      if (d > R + b.radius) continue;
      affected.push({ b, d });
    }

    for (const { b, d } of affected) {
      if (b.kind === 'bh') continue;
      // Share of the yield intercepted: solid angle subtended at this distance.
      const dd = Math.max(d, b.radius);
      const share = clamp(Math.pow(b.radius / (2 * dd), 2), 0, 1) * yieldJ;
      if (share <= 0) continue;

      const binding = b.bindingEnergy + b.strengthEnergy;
      const dx = (b.x - pos.x) / (d || 1), dy = (b.y - pos.y) / (d || 1);

      if (share > binding * 1.2 && b.mass > 0) {
        this.fragment(b, pos, share, binding);
      } else {
        // Impulse from the fraction of the yield that becomes momentum.
        const dv = Math.sqrt((2 * share * 0.25) / b.mass);
        b.vx += dx * dv;
        b.vy += dy * dv;
        b.addHeat(share * 0.55);
        b.addCrater(-dx, -dy, Math.max(1, share / 5e6), b.radius * 0.08, Math.sqrt(2 * share / Math.max(b.mass, 1)) + 1e3, rng);
        this.app.markDirty(b);
      }
    }

    effects.shatter(pos.x, pos.y, R * 0.35, yieldJ, R * 0.8);
    camera.addShake(clamp(0.3 + this.intensity * 0.5, 0, 1.2));
    world._accelDirty = true;
    this.app.toast(`Detonation · ${formatYield(yieldJ)}`);
  }

  /** Break a body apart, conserving mass and momentum exactly. */
  fragment(b, origin, energy, binding) {
    const { world } = this.app;
    const surplus = Math.max(0, energy - binding);
    const n = clamp(Math.round(6 + Math.log10(1 + surplus / Math.max(binding, 1)) * 9), 4, 40);

    const pieces = [];
    let remaining = b.mass;
    const minM = b.mass / (n * 8);
    for (let i = 0; i < n - 1 && remaining > minM * 1.5; i++) {
      let m = powerLawSample(rng, minM, remaining * 0.55, 1.83);
      if (m > remaining - minM) m = remaining - minM;
      pieces.push(m);
      remaining -= m;
    }
    pieces.push(remaining);

    // Dispersal speed from equipartition of whatever the blast had left over.
    const vChar = Math.max(
      escapeVelocity(b.mass, b.radius) * 1.1,
      Math.sqrt((2 * surplus) / b.mass)
    );

    // The ring has to be large enough that the pieces do not start off inside
    // one another; otherwise the contact pass immediately shatters them again.
    const pieceRadii = pieces.map((m) => radiusFromMass(m, b.composition));
    let sumRadii = 0, maxRadius = 0;
    for (const r of pieceRadii) { sumRadii += r; if (r > maxRadius) maxRadius = r; }
    // The swarm occupies 2·Σr of arc; a ring of Σr/π has exactly that
    // circumference, so 1.4x leaves room and nothing starts inside anything.
    const ringR = Math.max((sumRadii * 1.4) / Math.PI, b.radius * 0.6 + maxRadius);
    const arcTotal = sumRadii * 2;

    const made = [];
    const baseAng = Math.atan2(b.y - origin.y, b.x - origin.x);
    let arc = 0;
    for (let i = 0; i < pieces.length; i++) {
      const m = pieces[i];
      // Arc proportional to size, so a power-law swarm packs without overlaps.
      const ang = baseAng + ((arc + pieceRadii[i]) / arcTotal) * TAU;
      arc += pieceRadii[i] * 2;
      const speed = vChar * (0.4 + Math.abs(gaussian(rng)) * 0.7);
      const launchR = ringR;
      made.push(new Body({
        name: 'Fragment', kind: 'debris',
        x: b.x + Math.cos(ang) * launchR,
        y: b.y + Math.sin(ang) * launchR,
        vx: b.vx + Math.cos(ang) * speed,
        vy: b.vy + Math.sin(ang) * speed,
        mass: m,
        composition: rng() < 0.35 ? b.coreComposition : b.composition,
        crust: rng() < 0.5 ? b.crust : null,
        temperature: b.temperature + 700,
        seed: hashSeed(b.seed, i, 'blast'),
        spin: gaussian(rng) * 1e-3,
      }));
    }

    // Correct the swarm's net momentum back to what the body carried, plus the
    // blast impulse it received.
    const p0x = b.mass * b.vx, p0y = b.mass * b.vy;
    let sx = 0, sy = 0, sm = 0;
    for (const f of made) { sx += f.mass * f.vx; sy += f.mass * f.vy; sm += f.mass; }
    const cvx = (sx - p0x) / sm, cvy = (sy - p0y) / sm;
    for (const f of made) { f.vx -= cvx; f.vy -= cvy; }

    world.remove(b);
    for (const f of made) world.add(f);
    if (this.app.state.selected === b) this.app.select(made[0] || null);
  }

  // --- collapse -------------------------------------------------------------

  /**
   * Crush a body.
   *
   * The radius is driven down toward its degenerate value, and what it becomes
   * is decided by the real mass limits: below 1.4 M☉ electron degeneracy holds
   * and you get a white dwarf, below about 2.9 M☉ neutron degeneracy holds, and
   * above that nothing does. Compression work is real work, so the body heats
   * up as it shrinks.
   */
  applyCollapse(dt) {
    const { world, camera, effects } = this.app;
    const b = this.collapsing;

    if (!b || !b.alive) {
      // No body under the cursor: pull loose matter into a heap instead.
      const R = toolRadiusPixels('collapse', this.intensity, camera) / camera.scale;
      let cx = 0, cy = 0, cm = 0;
      for (const o of world.bodies) {
        const d = Math.hypot(o.x - this.world.x, o.y - this.world.y);
        if (d > R) continue;
        cx += o.x * o.mass; cy += o.y * o.mass; cm += o.mass;
      }
      if (cm <= 0) return;
      cx /= cm; cy /= cm;
      for (const o of world.bodies) {
        if (o.fixed) continue;
        const dx = cx - o.x, dy = cy - o.y;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 1e-9) continue;
        const pull = 4 * Math.pow(10, this.intensity) * camera.scale * (R / 60) * 0.5;
        o.vx += (dx / d) * pull * dt;
        o.vy += (dy / d) * pull * dt;
        // Bleed off the orbital motion, or it just forms a disc and stays there.
        const damp = Math.exp(-dt * 1.6 * this.intensity);
        const vr = (o.vx * dx + o.vy * dy) / d;
        const tx = -dy / d, ty = dx / d;
        const vt = o.vx * tx + o.vy * ty;
        const vtd = vt * damp;
        o.vx = (dx / d) * vr + tx * vtd;
        o.vy = (dy / d) * vr + ty * vtd;
      }
      world._accelDirty = true;
      if (rng() < dt * 8) effects.pulse(cx, cy, R, 1);
      return;
    }

    if (b.kind === 'bh') return;

    this.collapseProgress += dt * (0.25 + this.intensity * 0.55);
    const kind = classifyCompact(b.mass);
    const floor = kind === 'bh' ? schwarzschild(b.mass) : compactRadius(kind, b.mass);

    // A degenerate remnant has to be *smaller* than what it came from. Below
    // roughly a tenth of a solar mass the electron-degenerate radius is larger
    // than the body itself, so there is nothing to collapse — the tool used to
    // announce the Earth as a white dwarf two and a half times its own size.
    if (floor >= b.radius) {
      if (!this._warnedCollapse) {
        this._warnedCollapse = true;
        this.app.toast(
          `${b.name} is too light to collapse — degeneracy already supports it at this size`
        );
      }
      this.collapsing = null;
      return;
    }

    // Within a tenth of the degenerate radius there is nothing left to squeeze;
    // waiting for exact convergence just makes the tool feel broken.
    if (b.radius <= floor * 1.1) {
      this.finishCollapse(b, kind);
      return;
    }

    const before = b.radius;
    // Shrink geometrically toward the floor.
    const k = Math.exp(-dt * (3.0 + this.intensity * 6.0));
    const after = Math.max(floor, floor + (before - floor) * k);
    b.explicitRadius = true;
    b.radius = after;
    b.density = b.mass / ((4 / 3) * Math.PI * Math.pow(after, 3));

    // Work done against gravity in shrinking from `before` to `after` — the
    // difference in binding energy — comes out as heat.
    const dU = (3 * G * b.mass * b.mass) / 5 * (1 / after - 1 / before);
    b.addHeat(Math.min(dU, b.mass * 1e9));

    effects.pulse(b.x, b.y, b.radius * 6, 1);
    this.app.markDirty(b);
    if (b.radius <= floor * 1.1) this.finishCollapse(b, kind);
  }

  finishCollapse(b, kind) {
    if (b.kind === kind) { this.collapsing = null; return; }
    b.kind = kind;
    b.name = kind === 'bh' ? 'Black hole' : kind === 'ns' ? 'Neutron star' : 'White dwarf';
    b.composition = kind === 'bh' ? { degenerate: 1 }
      : kind === 'ns' ? { neutronium: 1 }
        : { carbon: 0.5, degenerate: 0.5 };
    b.crust = null;
    b.explicitRadius = kind !== 'bh';
    b.radius = kind === 'bh' ? schwarzschild(b.mass) : compactRadius(kind, b.mass);
    b.temperature = kind === 'bh' ? 0 : kind === 'ns' ? 6e5 : 3e4;
    b.differentiation = 1;
    b.luminosity = 0;
    b.craters.length = 0;
    b.mixes.length = 0;
    b.refresh();
    this.app.markDirty(b);
    this.app.toast(
      kind === 'bh' ? `${(b.mass / M_SUN).toFixed(2)} M☉ passed its Schwarzschild radius`
        : kind === 'ns' ? 'Neutron degeneracy pressure holds — neutron star'
          : 'Electron degeneracy pressure holds — white dwarf'
    );
    this.collapsing = null;
  }

  // --- delete ---------------------------------------------------------------

  deleteAt(pos) {
    const { world, camera } = this.app;
    if (this.dragging) {
      const R = toolRadiusPixels('delete', this.intensity, camera) / camera.scale;
      const doomed = world.bodies.filter((b) => Math.hypot(b.x - pos.x, b.y - pos.y) <= R + b.radius);
      for (const b of doomed) {
        if (this.app.state.selected === b) this.app.select(null);
        world.remove(b);
      }
      return;
    }
    const b = pickBody(world, pos.x, pos.y, camera, 6, this.app.settings);
    if (!b) return;
    if (this.app.state.selected === b) this.app.select(null);
    world.remove(b);
    this.app.toast(`Removed ${b.name}`);
  }
}

function formatYield(j) {
  const mt = j / 4.184e15;
  if (mt >= 1e9) return `${(mt / 1e9).toExponential(2)} Gt·10⁹ TNT`;
  if (mt >= 1) return `${mt.toExponential(2)} Mt TNT`;
  return `${(mt * 1e3).toFixed(1)} kt TNT`;
}
