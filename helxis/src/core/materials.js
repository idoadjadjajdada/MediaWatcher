// The material table. Every body is a mixture of these, and almost every
// visible property — colour, density, what happens when you point a laser at
// it — falls out of the mixture rather than being authored per body.
//
// rho     : uncompressed grain density, kg/m^3
// melt    : melting/softening point, K
// boil    : vaporisation point, K (sublimation for ices)
// cp      : specific heat capacity, J/(kg K)
// latent  : latent heat of fusion, J/kg
// vapour  : latent heat of vaporisation, J/kg
// albedo  : bond albedo, drives equilibrium temperature
// strength: shear strength, Pa — only matters for bodies too small for gravity
//           to dominate their binding energy
// cold/hot: surface palette endpoints (solid, molten)

export const MATERIALS = {
  iron:      { name: 'Iron',      rho: 7874, melt: 1811, boil: 3134, cp: 449,  latent: 2.47e5, vapour: 6.09e6, albedo: 0.18, strength: 1.0e8, cold: [104, 96, 102],  hot: [255, 150, 60] },
  nickel:    { name: 'Nickel',    rho: 8908, melt: 1728, boil: 3186, cp: 445,  latent: 2.98e5, vapour: 6.48e6, albedo: 0.20, strength: 1.1e8, cold: [128, 124, 118], hot: [255, 164, 70] },
  silicate:  { name: 'Silicate',  rho: 3300, melt: 1473, boil: 3200, cp: 1000, latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.14, strength: 3.0e7, cold: [122, 106, 90],  hot: [255, 108, 32] },
  basalt:    { name: 'Basalt',    rho: 2900, melt: 1450, boil: 3100, cp: 840,  latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.09, strength: 2.5e7, cold: [70, 66, 68],    hot: [255, 96, 28] },
  hematite:  { name: 'Hematite',  rho: 5250, melt: 1838, boil: 3400, cp: 650,  latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.12, strength: 4.0e7, cold: [152, 78, 52],   hot: [255, 118, 44] },
  olivine:   { name: 'Olivine',   rho: 3320, melt: 2163, boil: 3400, cp: 815,  latent: 6.0e5,  vapour: 6.0e6,  albedo: 0.16, strength: 4.5e7, cold: [98, 112, 78],   hot: [255, 130, 50] },
  feldspar:  { name: 'Feldspar',  rho: 2620, melt: 1473, boil: 3100, cp: 730,  latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.40, strength: 3.0e7, cold: [198, 190, 176], hot: [255, 150, 72] },
  tholin:    { name: 'Tholin',    rho: 1400, melt: 550,  boil: 900,  cp: 1200, latent: 1.0e5,  vapour: 1.5e6,  albedo: 0.10, strength: 5.0e6, cold: [170, 104, 68],  hot: [230, 150, 80] },
  granite:   { name: 'Granite',   rho: 2700, melt: 1533, boil: 3100, cp: 790,  latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.30, strength: 3.5e7, cold: [168, 146, 128], hot: [255, 128, 48] },
  regolith:  { name: 'Regolith',  rho: 1500, melt: 1400, boil: 3000, cp: 840,  latent: 4.0e5,  vapour: 6.0e6,  albedo: 0.11, strength: 1.0e5, cold: [136, 128, 118], hot: [220, 120, 52] },
  carbon:    { name: 'Carbon',    rho: 2200, melt: 3800, boil: 4300, cp: 710,  latent: 1.0e5,  vapour: 5.9e7,  albedo: 0.04, strength: 2.0e7, cold: [44, 42, 46],    hot: [200, 90, 40] },
  water:     { name: 'Water',     rho: 1000, melt: 273,  boil: 373,  cp: 4184, latent: 3.34e5, vapour: 2.26e6, albedo: 0.06, strength: 0,     cold: [48, 96, 152],   hot: [96, 168, 208] },
  ice:       { name: 'Water ice', rho: 917,  melt: 273,  boil: 373,  cp: 2050, latent: 3.34e5, vapour: 2.83e6, albedo: 0.60, strength: 1.0e6, cold: [206, 226, 240], hot: [140, 190, 220] },
  ammonia:   { name: 'Ammonia',   rho: 817,  melt: 195,  boil: 240,  cp: 4700, latent: 3.32e5, vapour: 1.37e6, albedo: 0.50, strength: 5.0e5, cold: [200, 212, 188], hot: [170, 196, 176] },
  methane:   { name: 'Methane',   rho: 656,  melt: 91,   boil: 112,  cp: 2200, latent: 5.87e4, vapour: 5.1e5,  albedo: 0.30, strength: 2.0e5, cold: [128, 196, 196], hot: [110, 176, 188] },
  nitrogen:  { name: 'Nitrogen',  rho: 1026, melt: 63,   boil: 77,   cp: 2040, latent: 2.57e4, vapour: 1.99e5, albedo: 0.70, strength: 1.0e5, cold: [224, 224, 232], hot: [190, 200, 220] },
  co2:       { name: 'CO₂ ice',   rho: 1562, melt: 195,  boil: 195,  cp: 850,  latent: 1.96e5, vapour: 5.7e5,  albedo: 0.60, strength: 3.0e5, cold: [232, 228, 216], hot: [200, 196, 190] },
  sulfur:    { name: 'Sulfur',    rho: 2070, melt: 388,  boil: 718,  cp: 700,  latent: 5.4e4,  vapour: 1.4e6,  albedo: 0.55, strength: 5.0e6, cold: [224, 196, 92],  hot: [255, 210, 110] },
  hydrogen:  { name: 'Hydrogen',  rho: 88,   melt: 14,   boil: 20,   cp: 14300, latent: 5.86e4, vapour: 4.52e5, albedo: 0.35, strength: 0,    cold: [216, 202, 176], hot: [255, 228, 190] },
  helium:    { name: 'Helium',    rho: 125,  melt: 1,    boil: 4,    cp: 5193, latent: 2.1e4,  vapour: 2.09e4, albedo: 0.35, strength: 0,     cold: [232, 220, 196], hot: [255, 240, 212] },
  plasma:    { name: 'Plasma',    rho: 1408, melt: 0,    boil: 0,    cp: 20000, latent: 0,     vapour: 0,      albedo: 0.00, strength: 0,     cold: [255, 214, 120], hot: [255, 250, 226] },
  degenerate:{ name: 'Degenerate matter', rho: 1e9, melt: 1e9, boil: 1e9, cp: 500, latent: 0,  vapour: 0,      albedo: 0.00, strength: 1e20,  cold: [210, 226, 255], hot: [255, 255, 255] },
  neutronium:{ name: 'Neutronium', rho: 4e17, melt: 1e12, boil: 1e12, cp: 100, latent: 0,      vapour: 0,      albedo: 0.00, strength: 1e30,  cold: [232, 240, 255], hot: [255, 255, 255] },
};

export const MATERIAL_KEYS = Object.keys(MATERIALS);

/** Normalise a composition map so the fractions sum to one. */
export function normalizeComposition(comp) {
  let total = 0;
  for (const k in comp) if (comp[k] > 0) total += comp[k];
  const out = {};
  if (total <= 0) return { silicate: 1 };
  for (const k in comp) if (comp[k] > 0) out[k] = comp[k] / total;
  return out;
}

/** Mass-weighted mean of a scalar material property. */
export function compositionProperty(comp, prop) {
  let sum = 0, total = 0;
  for (const k in comp) {
    const m = MATERIALS[k];
    if (!m) continue;
    sum += comp[k] * m[prop];
    total += comp[k];
  }
  return total > 0 ? sum / total : 0;
}

/**
 * Bulk density of a mixture. Volumes add, not densities, so this is a harmonic
 * mean by mass fraction — the same reason a rock-ice mix is nearer ice than the
 * arithmetic mean suggests.
 */
export function bulkDensity(comp) {
  let invSum = 0, total = 0;
  for (const k in comp) {
    const m = MATERIALS[k];
    if (!m) continue;
    invSum += comp[k] / m.rho;
    total += comp[k];
  }
  if (invSum <= 0) return 3300;
  return total / invSum;
}

/**
 * Self-compression. A body of Earth's mass is denser than its grain density
 * because its own gravity squeezes it. This is a fit, not an equation of state:
 * it tracks the terrestrial planets to a few percent and saturates before it
 * can produce anything unphysical.
 */
export function compressionFactor(massKg) {
  const M_E = 5.97217e24;
  const x = massKg / M_E;
  if (x <= 0) return 1;
  return 1 + 0.55 * Math.pow(x, 0.42) / (1 + 0.35 * Math.pow(x, 0.42));
}

/** Radius implied by mass and composition, including self-compression. */
export function radiusFromMass(massKg, comp) {
  const rho = bulkDensity(comp) * compressionFactor(massKg);
  return Math.cbrt((3 * massKg) / (4 * Math.PI * rho));
}

/** Mix two compositions by mass. Used on every merge and every accretion. */
export function mixCompositions(compA, massA, compB, massB) {
  const out = {};
  const total = massA + massB;
  if (total <= 0) return { silicate: 1 };
  for (const k in compA) out[k] = (out[k] || 0) + (compA[k] * massA) / total;
  for (const k in compB) out[k] = (out[k] || 0) + (compB[k] * massB) / total;
  return normalizeComposition(out);
}

/**
 * Gravitational differentiation. Once a body is hot enough to be partly molten
 * its dense phases sink, so what you see from outside is not the bulk mixture.
 * `progress` runs 0 (undifferentiated rubble) to 1 (fully sorted), and the
 * surface is the buoyant residue.
 */
export function differentiate(comp, progress) {
  const entries = [];
  for (const k in comp) {
    if (!MATERIALS[k] || comp[k] <= 0) continue;
    entries.push([k, comp[k], MATERIALS[k].rho]);
  }
  if (!entries.length) return { core: { silicate: 1 }, surface: { silicate: 1 } };
  entries.sort((a, b) => b[2] - a[2]);

  const core = {}, surface = {};
  const n = entries.length;
  for (let i = 0; i < n; i++) {
    const [k, frac, ] = entries[i];
    // Rank in the density ordering: 0 is the densest phase, 1 the lightest.
    const rank = n === 1 ? 0.5 : i / (n - 1);
    // With no differentiation every phase is evenly present at both depths.
    const toSurface = 0.5 + (rank - 0.5) * progress;
    surface[k] = frac * toSurface;
    core[k] = frac * (1 - toSurface);
  }
  return { core: normalizeComposition(core), surface: normalizeComposition(surface) };
}

/** The single material that dominates a mixture, for labelling. */
export function dominantMaterial(comp) {
  let best = null, bestF = -1;
  for (const k in comp) {
    if (comp[k] > bestF) { bestF = comp[k]; best = k; }
  }
  return best || 'silicate';
}

/**
 * Surface colour of a mixture at temperature T, before any noise is applied.
 * Below the melting point each phase shows its solid colour; above it, the
 * colour shifts toward the melt and then toward blackbody incandescence.
 */
export function surfaceColor(comp, temperature) {
  let r = 0, g = 0, b = 0, total = 0;
  for (const k in comp) {
    const m = MATERIALS[k];
    if (!m || comp[k] <= 0) continue;
    const f = comp[k];
    // Soften the transition over ±12% of the melting point: real rock has a
    // solidus and a liquidus, not a single temperature.
    const t = m.melt > 0 ? (temperature - m.melt * 0.88) / (m.melt * 0.24) : 1;
    const molten = Math.max(0, Math.min(1, t));
    r += f * (m.cold[0] + (m.hot[0] - m.cold[0]) * molten);
    g += f * (m.cold[1] + (m.hot[1] - m.cold[1]) * molten);
    b += f * (m.cold[2] + (m.hot[2] - m.cold[2]) * molten);
    total += f;
  }
  if (total <= 0) return [122, 106, 90];
  return [r / total, g / total, b / total];
}

/**
 * Incandescence. Anything hot glows regardless of what it is made of, and above
 * about 900 K that glow dominates the intrinsic colour entirely.
 */
export function incandescence(temperature) {
  if (temperature < 700) return null;
  const t = Math.min(1, (temperature - 700) / 4300);
  // Rough blackbody ramp: dull red -> orange -> yellow -> white -> blue-white.
  const stops = [
    [0.00, [90, 10, 4]],
    [0.12, [180, 40, 10]],
    [0.28, [244, 108, 24]],
    [0.48, [255, 176, 72]],
    [0.68, [255, 226, 160]],
    [0.85, [255, 248, 232]],
    [1.00, [212, 226, 255]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const u = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return stops[stops.length - 1][1];
}
