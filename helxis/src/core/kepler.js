import { G, TAU } from './const.js';

/**
 * Two-body orbital elements from a state vector, in the plane.
 *
 * Helxis integrates the full N-body problem; these elements exist only so the
 * overlay can draw where a body is *about* to go. They are exact for the
 * two-body case and a good approximation whenever one attractor dominates,
 * which is the only time an orbit line means anything anyway.
 */
export function orbitalElements(rx, ry, vx, vy, mu) {
  const r = Math.hypot(rx, ry);
  const v2 = vx * vx + vy * vy;
  if (r === 0 || mu <= 0) return null;

  // Specific angular momentum (scalar in 2D) and specific orbital energy.
  const h = rx * vy - ry * vx;
  const energy = v2 / 2 - mu / r;

  // Eccentricity vector.
  const rdotv = rx * vx + ry * vy;
  const ex = ((v2 - mu / r) * rx - rdotv * vx) / mu;
  const ey = ((v2 - mu / r) * ry - rdotv * vy) / mu;
  const e = Math.hypot(ex, ey);

  // Semi-major axis. Negative for hyperbolic orbits, infinite for parabolic.
  const a = Math.abs(energy) < 1e-30 ? Infinity : -mu / (2 * energy);

  // Argument of periapsis measured from +x, and the direction of travel.
  const argP = e > 1e-12 ? Math.atan2(ey, ex) : Math.atan2(ry, rx);
  const retrograde = h < 0;

  // a is negative for a hyperbolic orbit, which keeps this positive either way.
  const periapsis = a * (1 - e);
  const apoapsis = e < 1 ? a * (1 + e) : Infinity;
  const period = e < 1 && isFinite(a) && a > 0 ? TAU * Math.sqrt((a * a * a) / mu) : Infinity;

  // True anomaly right now.
  let nu = Math.atan2(ry, rx) - argP;
  nu = ((nu % TAU) + TAU) % TAU;

  return { a, e, argP, h, energy, periapsis, apoapsis, period, nu, retrograde, r, mu };
}

/**
 * Sample the conic for drawing. Returns world-space points relative to the
 * focus. Hyperbolic and near-parabolic orbits are clipped to a sane extent so
 * an unbound body draws an open arc rather than a line to infinity.
 */
export function sampleConic(el, samples = 192, maxR = Infinity) {
  const pts = [];
  const { a, e, argP } = el;
  const cosW = Math.cos(argP), sinW = Math.sin(argP);
  const p = isFinite(a) ? a * (1 - e * e) : el.h * el.h / el.mu;

  if (e < 1) {
    for (let i = 0; i <= samples; i++) {
      const nu = (i / samples) * TAU;
      const r = p / (1 + e * Math.cos(nu));
      if (!isFinite(r) || r <= 0 || r > maxR) { pts.push(null); continue; }
      const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
      pts.push([xp * cosW - yp * sinW, xp * sinW + yp * cosW]);
    }
  } else {
    // Open orbit: sweep true anomaly between the asymptotes.
    const nuMax = Math.acos(Math.max(-1, Math.min(1, -1 / e))) * 0.985;
    for (let i = 0; i <= samples; i++) {
      const nu = -nuMax + (i / samples) * 2 * nuMax;
      const r = p / (1 + e * Math.cos(nu));
      if (!isFinite(r) || r <= 0 || r > maxR) { pts.push(null); continue; }
      const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
      pts.push([xp * cosW - yp * sinW, xp * sinW + yp * cosW]);
    }
  }
  return pts;
}

/**
 * Which body is this one actually orbiting? The one exerting the most
 * acceleration on it, excluding itself — the same test the renderer uses to
 * decide whose focus to draw the ellipse around.
 */
export function dominantAttractor(body, bodies) {
  let best = null, bestA = 0;
  for (const o of bodies) {
    if (o === body || !o.alive || o.mass <= 0) continue;
    const dx = o.x - body.x, dy = o.y - body.y;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0) continue;
    const a = (G * o.mass) / d2;
    if (a > bestA) { bestA = a; best = o; }
  }
  return best;
}

/** Velocity for a circular orbit of radius r around `primary`, at angle theta. */
export function circularOrbitState(primary, r, theta, retrograde = false, satelliteMass = 0) {
  const mu = G * (primary.mass + satelliteMass);
  const v = Math.sqrt(mu / r);
  const x = primary.x + Math.cos(theta) * r;
  const y = primary.y + Math.sin(theta) * r;
  const s = retrograde ? -1 : 1;
  return {
    x, y,
    vx: primary.vx + s * -Math.sin(theta) * v,
    vy: primary.vy + s * Math.cos(theta) * v,
  };
}

/**
 * True anomaly from mean anomaly, by Newton iteration on Kepler's equation.
 * Lets the presets be written with the same mean longitudes the almanacs use.
 */
export function trueAnomalyFromMean(M, e) {
  let m = ((M % TAU) + TAU) % TAU;
  // Starting guess; for small e the mean anomaly itself is already close.
  let E = e < 0.8 ? m : Math.PI;
  for (let i = 0; i < 60; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2)
  );
}

/**
 * State vector from classical elements. Used by the presets, where quoting a
 * planet's real semi-major axis and eccentricity is far more honest than
 * quoting a position and velocity that were only ever true on one date.
 */
export function stateFromElements(muCentral, a, e, argP, nu, satelliteMass = 0) {
  const mu = muCentral + G * satelliteMass;
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  const xp = r * Math.cos(nu);
  const yp = r * Math.sin(nu);
  // Perifocal velocity.
  const k = Math.sqrt(mu / p);
  const vxp = -k * Math.sin(nu);
  const vyp = k * (e + Math.cos(nu));
  const c = Math.cos(argP), s = Math.sin(argP);
  return {
    x: xp * c - yp * s,
    y: xp * s + yp * c,
    vx: vxp * c - vyp * s,
    vy: vxp * s + vyp * c,
  };
}
