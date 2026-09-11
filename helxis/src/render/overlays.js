import { G, AU, TAU, clamp, rocheLimit, hillRadius } from '../core/const.js';
import { orbitalElements, sampleConic } from '../core/kepler.js';

const P = [0, 0];
const Q = [0, 0];

/**
 * Everything drawn on top of the bodies: trails, predicted orbits, vectors,
 * labels and the various physics radii.
 *
 * All of it is optional, all of it is off by default except trails and orbits,
 * and each piece is cheap enough that turning them all on at once is fine.
 */

function arrow(ctx, x0, y0, x1, y1, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5);
  ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const head = 3.5;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x1 - Math.cos(ang - 0.4) * head) + 0.5, Math.round(y1 - Math.sin(ang - 0.4) * head) + 0.5);
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x1 - Math.cos(ang + 0.4) * head) + 0.5, Math.round(y1 - Math.sin(ang + 0.4) * head) + 0.5);
  ctx.stroke();
}

export function drawTrails(ctx, world, camera, settings) {
  if (!settings.trails) return;
  const fade = settings.trailFade !== false;
  for (const b of world.bodies) {
    const t = b.trail;
    if (!t || t.length < 4) continue;
    const n = t.length / 2;
    const col = trailColor(b);
    for (let i = 0; i < n; i++) {
      const age = i / n;                 // 0 oldest, 1 newest
      camera.project(t[i * 2], t[i * 2 + 1], P);
      const x = P[0] | 0, y = P[1] | 0;
      if (x < 0 || y < 0 || x >= camera.width || y >= camera.height) continue;
      const a = fade ? age * age * 0.75 : 0.5;
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

function trailColor(b) {
  switch (b.kind) {
    case 'star': return '#ffd27a';
    case 'gasgiant': return '#c79a6a';
    case 'moon': return '#9aa4bd';
    case 'debris': return '#6d6478';
    case 'bh': return '#b08cff';
    case 'ns': case 'wd': return '#bcd8ff';
    default: return '#7fd8c8';
  }
}

/**
 * The predicted path, from the instantaneous two-body elements about whichever
 * body is pulling hardest. It is honest about being an approximation: the moment
 * a second attractor matters, the drawn ellipse and the actual trail visibly
 * disagree, which is the interesting part.
 */
export function drawOrbits(ctx, world, camera, settings, selected) {
  if (!settings.orbits) return;

  // Which orbits are worth drawing. One path per orbit is cheap; a thousand of
  // them is not, so take the bodies that dominate the picture — plus whatever
  // is selected, which is always worth drawing however small it is.
  let candidates;
  if (settings.orbitsSelectedOnly && selected) {
    candidates = [selected];
  } else {
    candidates = world.bodies.filter((b) => (b.kind !== 'debris' || settings.orbitsDebris));
    const LIMIT = 110;
    if (candidates.length > LIMIT) {
      candidates.sort((a, b) => b.mass - a.mass);
      candidates = candidates.slice(0, LIMIT);
      if (selected && !candidates.includes(selected)) candidates.push(selected);
    }
  }

  const maxR = (Math.max(camera.width, camera.height) * 14) / camera.scale;

  for (const b of candidates) {
    // The world caches this per frame; rescanning every body against every
    // other one here would repeat an O(N²) pass the simulation already did.
    const primary = world.attractorOf(b);
    if (!primary) continue;
    // Skip pairs where the "orbit" is meaningless: a star about its own planet.
    if (primary.mass < b.mass * 3) continue;

    const mu = G * (primary.mass + b.mass);
    const el = orbitalElements(b.x - primary.x, b.y - primary.y, b.vx - primary.vx, b.vy - primary.vy, mu);
    if (!el || !isFinite(el.a) || el.e >= 12) continue;

    // An orbit larger than a few screens tells you nothing useful, and one only
    // a few pixels across is noise.
    if (el.e < 1 && el.apoapsis > maxR) continue;
    const sizePx = (el.e < 1 ? el.a : Math.abs(el.a)) * camera.scale;
    if (sizePx < 3 && b !== selected) continue;

    // Sample density follows apparent size: a small orbit needs far fewer
    // points than a big eccentric one to look smooth at this resolution.
    const samples = clamp(Math.round(sizePx * (el.e > 0.6 ? 1.4 : 0.9)), 28, el.e > 0.85 ? 220 : 150);
    const pts = sampleConic(el, samples, maxR);

    ctx.strokeStyle = b === selected ? '#7ff0d8' : (el.e >= 1 ? '#e08a6a' : '#5a6a8f');
    ctx.globalAlpha = b === selected ? 0.95 : 0.42;
    ctx.lineWidth = 1;
    // A dashed stroke gives the same broken line the old per-pixel plotter did,
    // in one path instead of tens of thousands of rectangles.
    ctx.setLineDash(b === selected ? [2, 2] : [1, 3]);

    ctx.beginPath();
    let pen = false;
    for (const pt of pts) {
      if (!pt) { pen = false; continue; }
      camera.project(primary.x + pt[0], primary.y + pt[1], P);
      const x = Math.round(P[0]) + 0.5, y = Math.round(P[1]) + 0.5;
      if (pen) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (b === selected && el.e < 1 && isFinite(el.a)) {
      // Mark the apsides: the two points on the orbit anyone actually wants.
      const cosW = Math.cos(el.argP), sinW = Math.sin(el.argP);
      camera.project(primary.x + cosW * el.periapsis, primary.y + sinW * el.periapsis, P);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#9effe0';
      ctx.fillRect(Math.round(P[0]) - 1, Math.round(P[1]) - 1, 3, 3);
      camera.project(primary.x - cosW * el.apoapsis, primary.y - sinW * el.apoapsis, Q);
      ctx.fillStyle = '#4f8fa8';
      ctx.fillRect(Math.round(Q[0]) - 1, Math.round(Q[1]) - 1, 3, 3);
    }
  }
  ctx.globalAlpha = 1;
}

export function drawVectors(ctx, world, camera, settings, selected) {
  if (!settings.velocityVectors && !settings.forceVectors) return;
  // Scale the arrows so the fastest body on screen gets a readable one.
  let vMax = 0, aMax = 0;
  for (const b of world.bodies) {
    if (!camera.visible(b.x, b.y, b.radius)) continue;
    vMax = Math.max(vMax, Math.hypot(b.vx, b.vy));
    aMax = Math.max(aMax, Math.hypot(b.ax, b.ay));
  }
  const vLen = 34, aLen = 26;

  for (const b of world.bodies) {
    if (!camera.visible(b.x, b.y, b.radius)) continue;
    if (settings.vectorsSelectedOnly && b !== selected) continue;
    if (b.kind === 'debris' && !settings.orbitsDebris) continue;
    camera.project(b.x, b.y, P);
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation);

    if (settings.velocityVectors && vMax > 0) {
      const k = (Math.hypot(b.vx, b.vy) / vMax) * vLen;
      const ux = b.vx / (Math.hypot(b.vx, b.vy) || 1);
      const uy = b.vy / (Math.hypot(b.vx, b.vy) || 1);
      const rx = ux * c - uy * s, ry = ux * s + uy * c;
      arrow(ctx, P[0], P[1], P[0] + rx * k, P[1] + ry * k, '#68e0c0');
    }
    if (settings.forceVectors && aMax > 0) {
      const a = Math.hypot(b.ax, b.ay);
      if (a <= 0) continue;
      // Logarithmic, because accelerations in one scene span many decades.
      const k = (Math.log10(1 + a) / Math.log10(1 + aMax)) * aLen;
      const ux = b.ax / a, uy = b.ay / a;
      const rx = ux * c - uy * s, ry = ux * s + uy * c;
      arrow(ctx, P[0], P[1], P[0] + rx * k, P[1] + ry * k, '#e0806a');
    }
  }
}

/** Hill spheres and Roche limits: where moons can live, and where they die. */
export function drawRadii(ctx, world, camera, settings, selected) {
  if (!settings.hillSpheres && !settings.rocheLimits) return;
  for (const b of world.bodies) {
    if (settings.radiiSelectedOnly && b !== selected) continue;
    if (b.kind === 'debris') continue;

    if (settings.rocheLimits && (b.kind === 'star' || b.kind === 'gasgiant' || b.mass > 1e23)) {
      // Drawn for a nominal rubble-pile satellite at 2000 kg/m³.
      const r = rocheLimit(b.radius, b.density, 2000);
      const px = r * camera.scale;
      if (px > 6 && px < camera.width * 6) {
        camera.project(b.x, b.y, P);
        ctx.strokeStyle = 'rgba(224,120,106,0.5)';
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5, px, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (settings.hillSpheres) {
      const primary = world.attractorOf(b);
      if (!primary || primary.mass < b.mass * 8) continue;
      const a = Math.hypot(b.x - primary.x, b.y - primary.y);
      const r = hillRadius(a, b.mass, primary.mass);
      const px = r * camera.scale;
      if (px > 8 && px < camera.width * 6) {
        camera.project(b.x, b.y, P);
        ctx.strokeStyle = 'rgba(122,180,255,0.34)';
        ctx.setLineDash([1, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5, px, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }
}

export function drawBarycenter(ctx, world, camera, settings) {
  if (!settings.barycenter) return;
  const bc = world.barycenter();
  camera.project(bc.x, bc.y, P);
  const x = Math.round(P[0]), y = Math.round(P[1]);
  ctx.fillStyle = '#ffd27a';
  ctx.fillRect(x - 3, y, 7, 1);
  ctx.fillRect(x, y - 3, 1, 7);
  ctx.fillStyle = 'rgba(255,210,122,0.4)';
  ctx.fillRect(x - 1, y - 1, 3, 3);
}

/**
 * A reference grid whose spacing snaps to a round physical distance, so it
 * doubles as a scale bar you can read straight off the screen.
 */
export function drawGrid(ctx, camera, settings) {
  if (!settings.grid) return;
  const targetPx = 64;
  const metersPerCell = niceDistance(targetPx / camera.scale);
  const px = metersPerCell * camera.scale;
  if (px < 6) return;

  const w = camera.width, h = camera.height;

  // The grid is drawn in world space, so it rotates and pans with the camera.
  const corners = [
    camera.screenToWorld(0, 0), camera.screenToWorld(w, 0),
    camera.screenToWorld(0, h), camera.screenToWorld(w, h),
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
  }
  const i0 = Math.floor(minX / metersPerCell), i1 = Math.ceil(maxX / metersPerCell);
  const j0 = Math.floor(minY / metersPerCell), j1 = Math.ceil(maxY / metersPerCell);
  if ((i1 - i0) > 400 || (j1 - j0) > 400) return;

  ctx.strokeStyle = 'rgba(128,110,190,0.10)';
  ctx.lineWidth = 1;
  ctx.setLineDash([1, 2]);
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    camera.project(i * metersPerCell, minY, P);
    camera.project(i * metersPerCell, maxY, Q);
    ctx.moveTo(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5);
    ctx.lineTo(Math.round(Q[0]) + 0.5, Math.round(Q[1]) + 0.5);
  }
  for (let j = j0; j <= j1; j++) {
    camera.project(minX, j * metersPerCell, P);
    camera.project(maxX, j * metersPerCell, Q);
    ctx.moveTo(Math.round(P[0]) + 0.5, Math.round(P[1]) + 0.5);
    ctx.lineTo(Math.round(Q[0]) + 0.5, Math.round(Q[1]) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  return { metersPerCell, px };
}

/** Round a distance to 1, 2 or 5 times a power of ten — in AU when large. */
export function niceDistance(m) {
  const useAU = m > 0.02 * AU;
  const unit = useAU ? AU : 1;
  const v = m / unit;
  const e = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, e);
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * Math.pow(10, e) * unit;
}

/** Names, drawn at full device resolution by the caller after upscaling. */
export function collectLabels(world, camera, settings, selected) {
  if (!settings.labels) return [];
  const out = [];
  for (const b of world.bodies) {
    if (b.kind === 'debris' && !settings.labelDebris) continue;
    if (!camera.visible(b.x, b.y, b.radius, 8)) continue;
    const pr = b.radius * camera.scale;
    // Do not label things too small to point at, unless they are selected.
    if (pr < 1.2 && b !== selected && !settings.labelAll) continue;
    camera.project(b.x, b.y, P);
    out.push({
      x: P[0], y: P[1], r: Math.max(pr, 2),
      text: b.name, selected: b === selected, kind: b.kind,
    });
  }
  // Nearest-first so the important things win any collision culling.
  out.sort((a, c) => (c.selected ? 1 : 0) - (a.selected ? 1 : 0) || c.r - a.r);
  return out.slice(0, 40);
}

/** The selection reticle: four corner ticks, never a smooth circle. */
export function drawSelection(ctx, body, camera, pulse, radiusPx) {
  if (!body) return;
  camera.project(body.x, body.y, P);
  const base = radiusPx != null ? radiusPx : body.radius * camera.scale;
  const r = Math.max(base, 4) + 4 + Math.sin(pulse * 3) * 1.2;
  const x = Math.round(P[0]), y = Math.round(P[1]);
  const d = Math.round(r);
  const len = Math.max(3, Math.round(d * 0.34));
  ctx.fillStyle = '#7ff0d8';
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = x + sx * d, cy = y + sy * d;
    ctx.fillRect(cx - (sx < 0 ? 0 : len - 1), cy, len, 1);
    ctx.fillRect(cx, cy - (sy < 0 ? 0 : len - 1), 1, len);
  }
}

/** The placement ghost: where a new body will go, and how fast it will be going. */
export function drawPlacement(ctx, placement, camera) {
  if (!placement) return;
  camera.project(placement.x, placement.y, P);
  const x = Math.round(P[0]), y = Math.round(P[1]);
  const r = Math.max(2, Math.round(placement.radius * camera.scale));

  ctx.strokeStyle = 'rgba(127,240,216,0.8)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.arc(x + 0.5, y + 0.5, r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  if (placement.vx || placement.vy) {
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation);
    const sx = placement.vx * c - placement.vy * s;
    const sy = placement.vx * s + placement.vy * c;
    const mag = Math.hypot(sx, sy) || 1;
    const len = clamp(mag * camera.scale * placement.launchTime, 6, 90);
    arrow(ctx, x, y, x + (sx / mag) * len, y + (sy / mag) * len, '#ffd27a');
  }
}

/** The field radius for attract/repel/explode/collapse, drawn as a pixel ring. */
export function drawToolRing(ctx, x, y, radiusPx, color, dashed = true) {
  const cx = Math.round(x), cy = Math.round(y);
  const r = Math.round(radiusPx);
  if (r < 2 || r > 4000) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(cx + 0.5, cy + 0.5, r, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
}
