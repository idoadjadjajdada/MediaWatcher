// Deterministic randomness. Every body carries a seed, so its surface is a pure
// function of its history: the same body regenerates the same texture after a
// reload, and a merged body's texture depends only on what actually hit it.

// mulberry32 — small, fast, good enough for texture noise and debris jitter.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

// Integer hash used by the value-noise lattice. Keeping the lattice hash
// separate from the stream PRNG means noise is position-addressable: we can
// sample any point without walking a sequence.
function hash2(x, y, seed) {
  let h = seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x3f4a7c15);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

// Value noise in [0,1]. Cheaper than gradient noise and, once you stack four
// octaves and domain-warp it, visually indistinguishable at texture sizes.
export function valueNoise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

// Fractal Brownian motion. `lacunarity` and `gain` are exposed because the
// difference between rock and cloud is mostly the gain.
export function fbm(x, y, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + i * 7919);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Ridged noise — sharp crests, used for mountain chains and lava fissures.
export function ridged(x, y, seed, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 6151) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// Gaussian pair via Box-Muller, for debris velocity dispersion.
export function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Draw from a power law  p(m) ∝ m^-alpha  on [lo, hi]. Collisional fragment
// mass distributions follow one of these (Dohnanyi 1969 gives alpha ≈ 11/6).
export function powerLawSample(rng, lo, hi, alpha) {
  const u = rng();
  if (Math.abs(alpha - 1) < 1e-6) return lo * Math.pow(hi / lo, u);
  const e = 1 - alpha;
  return Math.pow(Math.pow(lo, e) + u * (Math.pow(hi, e) - Math.pow(lo, e)), 1 / e);
}
