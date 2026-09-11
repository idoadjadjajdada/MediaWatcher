// Physical constants and unit helpers.
// Helxis simulates in raw SI: metres, kilograms, seconds. Everything the user
// sees is converted on the way out, never on the way in, so the integrator
// never has to reason about a display unit.

export const G = 6.6743e-11;          // m^3 kg^-1 s^-2
export const C = 2.99792458e8;        // m/s
export const SIGMA_SB = 5.670374419e-8; // W m^-2 K^-4
export const AU = 1.495978707e11;     // m
export const LY = 9.4607304725808e15; // m
export const PC = 3.0856775814913673e16;
export const R_SUN = 6.957e8;         // m
export const M_SUN = 1.98892e30;      // kg
export const L_SUN = 3.828e26;        // W
export const T_SUN = 5772;            // K
export const R_EARTH = 6.371e6;       // m
export const M_EARTH = 5.97217e24;    // kg
export const R_JUP = 6.9911e7;        // m
export const M_JUP = 1.89813e27;      // kg
export const M_MOON = 7.342e22;       // kg
export const R_MOON = 1.7374e6;       // m
export const DAY = 86400;             // s
export const YEAR = 3.15576e7;        // s (Julian)
export const T_CMB = 2.725;           // K, the floor radiative cooling relaxes to

// Schwarzschild radius, used both for black-hole geometry and for the
// collapse tool's "has this become a singularity" test.
export const schwarzschild = (m) => (2 * G * m) / (C * C);

// Escape velocity from the surface of a sphere.
export const escapeVelocity = (m, r) => Math.sqrt((2 * G * m) / r);

// Circular orbit speed at radius r around total mass m.
export const circularVelocity = (m, r) => Math.sqrt((G * m) / r);

// Vis-viva: speed at radius r on an orbit of semi-major axis a.
export const visViva = (m, r, a) => Math.sqrt(G * m * (2 / r - 1 / a));

// Fluid Roche limit. Rigid bodies survive to ~1.26 planetary radii instead,
// but every body in Helxis is a rubble pile once it is large enough to matter.
export const rocheLimit = (rPrimary, rhoPrimary, rhoSat) =>
  2.44 * rPrimary * Math.pow(rhoPrimary / rhoSat, 1 / 3);

// Hill sphere of a secondary of mass m about a primary of mass M at distance a.
export const hillRadius = (a, m, M, e = 0) => a * (1 - e) * Math.pow(m / (3 * M), 1 / 3);

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const mix = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;

// Formatting. Distances and masses in a sandbox span 24 orders of magnitude,
// so pick the unit that makes the number readable rather than a fixed one.
export function formatDistance(m) {
  const a = Math.abs(m);
  if (a >= 0.5 * LY) return `${(m / LY).toFixed(3)} ly`;
  if (a >= 0.01 * AU) return `${(m / AU).toFixed(4)} AU`;
  if (a >= 1e6) return `${(m / 1e3).toFixed(0)} km`;
  if (a >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(1)} m`;
}

export function formatMass(kg) {
  const a = Math.abs(kg);
  if (a >= 0.05 * M_SUN) return `${(kg / M_SUN).toFixed(3)} M☉`;
  if (a >= 0.05 * M_JUP) return `${(kg / M_JUP).toFixed(3)} M♃`;
  if (a >= 1e-4 * M_EARTH) return `${(kg / M_EARTH).toExponential(3)} M⊕`;
  return `${kg.toExponential(3)} kg`;
}

export function formatSpeed(v) {
  const a = Math.abs(v);
  if (a >= 0.01 * C) return `${(v / C).toFixed(4)} c`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)} km/s`;
  return `${v.toFixed(2)} m/s`;
}

export function formatTime(s) {
  const a = Math.abs(s);
  if (a >= 1e6 * YEAR) return `${(s / YEAR / 1e6).toFixed(3)} Myr`;
  if (a >= 1e3 * YEAR) return `${(s / YEAR / 1e3).toFixed(3)} kyr`;
  if (a >= YEAR) return `${(s / YEAR).toFixed(3)} yr`;
  if (a >= DAY) return `${(s / DAY).toFixed(2)} d`;
  if (a >= 3600) return `${(s / 3600).toFixed(2)} h`;
  if (a >= 60) return `${(s / 60).toFixed(2)} min`;
  return `${s.toFixed(2)} s`;
}

export function formatRate(sPerS) {
  const a = Math.abs(sPerS);
  if (a < 1e-9) return 'paused';
  if (a >= YEAR) return `${(sPerS / YEAR).toFixed(2)} yr/s`;
  if (a >= DAY) return `${(sPerS / DAY).toFixed(2)} d/s`;
  if (a >= 3600) return `${(sPerS / 3600).toFixed(2)} h/s`;
  if (a >= 60) return `${(sPerS / 60).toFixed(2)} min/s`;
  return `${sPerS.toFixed(2)} s/s`;
}

export function formatEnergy(j) {
  const a = Math.abs(j);
  // 1 megaton TNT = 4.184e15 J. Impact energies read better in megatons.
  if (a >= 4.184e15) return `${(j / 4.184e15).toExponential(2)} Mt TNT`;
  return `${j.toExponential(2)} J`;
}
