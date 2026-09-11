import { fbm, ridged, valueNoise2, makeRng } from '../core/rng.js';
import {
  MATERIALS, surfaceColor, incandescence, compositionProperty, dominantMaterial,
} from '../core/materials.js';
import { clamp, lerp, smoothstep, TAU, T_SUN } from '../core/const.js';

// Bodies are drawn from pre-rendered square sprites at power-of-two sizes. A
// body picks the smallest sprite that covers it on screen, which keeps the
// texel grid visible — the pixels are the point.
export const SIZES = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];

export function pickSize(pixelRadius) {
  const want = Math.ceil(pixelRadius * 2);
  for (const s of SIZES) if (s >= want) return s;
  return SIZES[SIZES.length - 1];
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// 4x4 ordered dither. Posterising without this gives flat banded discs; with
// it, the same small palette reads as a gradient the way real pixel art does.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const LEVELS = 22;   // colour steps per channel after quantisation

function quantize(v, x, y) {
  const d = (BAYER[y & 3][x & 3] / 16 - 0.5) * (255 / LEVELS);
  const q = clamp(v + d, 0, 255);
  return clamp(Math.round((q * LEVELS) / 255) * (255 / LEVELS), 0, 255);
}

// ---------------------------------------------------------------------------
// Cache

const cache = new Map();
// Bound the cache by the memory it actually holds, not by how many entries it
// has: 900 sprites is a few megabytes at 16×16 and a quarter of a gigabyte at
// 256×256, and a count-based limit cannot tell those apart.
const CACHE_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) {
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key, value) {
  cache.set(key, value);
  cacheBytes += value.width * value.height * 4;
  while (cacheBytes > CACHE_BYTES && cache.size > 1) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cacheBytes -= oldest.width * oldest.height * 4;
    cache.delete(oldestKey);
  }
  return value;
}

export function clearTextureCache() { cache.clear(); cacheBytes = 0; }
export function textureCacheSize() { return cache.size; }
export function textureCacheBytes() { return cacheBytes; }

// ---------------------------------------------------------------------------
// Mixing

/**
 * How much of the pixel at (u, v) is material from the impactor recorded in
 * `mix`, in [0, 1].
 *
 * The boundary starts as a plane perpendicular to the impact axis, cutting off
 * the fraction of the disc the impactor contributed. It is then warped by noise
 * and twisted by a radial swirl, both scaled by how violent the impact was — a
 * gentle merge leaves a clean seam, a fast one stirs the two into a marble.
 */
function mixMask(u, v, mix, seed) {
  const stir = 1 - mix.sharpness;                 // 0 clean seam, 1 fully stirred
  const r = Math.hypot(u, v);

  // Differential rotation: the interior turns further than the surface, which
  // is what draws the spiral.
  const swirl = stir * 3.4 * (1 - r) * (1 - r);
  const ca = Math.cos(mix.angle + swirl), sa = Math.sin(mix.angle + swirl);
  let axis = u * ca + v * sa;

  // Warp the boundary. Low frequency for the big lobes, higher for the fringe.
  const w1 = fbm(u * 2.1 + 11, v * 2.1 - 7, seed ^ 0x5bf03635, 4) - 0.5;
  const w2 = fbm(u * 6.5 - 3, v * 6.5 + 5, seed ^ 0x1b873593, 3) - 0.5;
  axis += (w1 * 1.5 + w2 * 0.55) * (0.12 + stir * 1.25);

  // Place the cut so the impactor covers roughly its mass fraction of the face.
  const cut = 1 - 2 * mix.fracB;
  // A stirred mix has a broad transition; a clean one is nearly a step.
  const width = 0.04 + stir * 0.55;
  return smoothstep(clamp((axis - cut) / width * 0.5 + 0.5, 0, 1));
}

// ---------------------------------------------------------------------------
// Rocky, icy and molten worlds

function renderTerrestrial(body, size, data) {
  const n = size;
  const half = n / 2;
  const seed = body.seed >>> 0;

  const surf = body.surfaceComposition;
  const coreComp = body.coreComposition;
  const base = surfaceColor(surf, body.temperature);
  const coreCol = surfaceColor(coreComp, Math.max(body.temperature, body.temperature * 1.4));
  const glow = incandescence(body.temperature);

  // How molten the surface is, from the melting point of what is actually on it.
  const melt = compositionProperty(surf, 'melt') || 1400;
  const molten = clamp((body.temperature - melt * 0.86) / (melt * 0.3), 0, 1);

  // Water and ice coverage. Oceans only exist between freezing and boiling.
  const waterFrac = (surf.water || 0) + (surf.ice || 0);
  const liquid = body.temperature > 268 && body.temperature < 400 ? clamp(waterFrac * 2.2, 0, 0.82) : 0;
  const frozen = body.temperature <= 268 ? clamp(waterFrac * 2.0, 0, 0.9) : 0;

  // Terrain roughness: a big, hot, differentiated body is smoother than a cold
  // rubble pile that never relaxed.
  const rough = clamp(1.15 - body.differentiation * 0.45 - molten * 0.5, 0.25, 1.3);

  const dom = MATERIALS[dominantMaterial(surf)] || MATERIALS.silicate;
  const rng = makeRng(seed ^ 0x9e3779b9);
  // A handful of large surface features, drawn as low-frequency blobs.
  const features = [];
  const nFeat = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < nFeat; i++) {
    features.push({
      x: (rng() * 2 - 1) * 0.7, y: (rng() * 2 - 1) * 0.7,
      r: 0.18 + rng() * 0.42, s: rng() < 0.5 ? -1 : 1,
    });
  }

  let p = 0;
  for (let py = 0; py < n; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < n; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }

      // --- elevation ------------------------------------------------------
      // Domain warp first: it turns smooth blobs into something with coastline.
      const wx = fbm(u * 2.3 + 4.2, v * 2.3 - 1.7, seed ^ 0x2545f491, 3) - 0.5;
      const wy = fbm(u * 2.3 - 9.1, v * 2.3 + 6.3, seed ^ 0x27d4eb2d, 3) - 0.5;
      const su = u + wx * 0.55 * rough;
      const sv = v + wy * 0.55 * rough;

      let h = fbm(su * 3.1, sv * 3.1, seed, 5, 2.05, 0.52);
      h = h * 0.72 + ridged(su * 5.4, sv * 5.4, seed ^ 0x165667b1, 4) * 0.28 * rough;
      for (const f of features) {
        const d = Math.hypot(u - f.x, v - f.y);
        if (d < f.r) h += f.s * 0.16 * smoothstep(1 - d / f.r);
      }
      h = clamp(h, 0, 1);

      // --- base colour ----------------------------------------------------
      let cr = base[0], cg = base[1], cb = base[2];

      // Mixed-in material from every merge this body remembers, oldest first,
      // so a recent impact paints over an older seam.
      for (let mi = 0; mi < body.mixes.length; mi++) {
        const mix = body.mixes[mi];
        const m = mixMask(u, v, mix, seed ^ (mi * 0x9e3779b1));
        if (m <= 0.002) continue;
        const other = surfaceColor(mix.compB || surf, body.temperature);
        cr = lerp(cr, other[0], m);
        cg = lerp(cg, other[1], m);
        cb = lerp(cb, other[2], m);
      }

      // Elevation shading. Highlands catch light, basins hold shadow.
      const shade = 0.74 + h * 0.52;
      cr *= shade; cg *= shade; cb *= shade;

      // --- water and ice ---------------------------------------------------
      if (liquid > 0) {
        const seaLevel = 1 - liquid;
        if (h < seaLevel) {
          const depth = clamp((seaLevel - h) / Math.max(seaLevel, 0.001), 0, 1);
          const w = MATERIALS.water.cold;
          cr = lerp(cr, lerp(96, w[0] * 0.55, depth), 0.86);
          cg = lerp(cg, lerp(168, w[1] * 0.6, depth), 0.86);
          cb = lerp(cb, lerp(200, w[2] * 0.85, depth), 0.86);
        } else if (h < seaLevel + 0.035) {
          // Surf line.
          cr = lerp(cr, 208, 0.5); cg = lerp(cg, 224, 0.5); cb = lerp(cb, 228, 0.5);
        }
      }
      if (frozen > 0) {
        // Frost settles on the high ground and in the basins, patchily.
        const patch = fbm(su * 4.6 - 21, sv * 4.6 + 13, seed ^ 0x85ebca6b, 3);
        const cover = clamp((frozen * 1.3 - 0.25) + (h - 0.5) * 0.7 + (patch - 0.5) * 0.55, 0, 1);
        const ic = MATERIALS.ice.cold;
        cr = lerp(cr, ic[0], cover * 0.9);
        cg = lerp(cg, ic[1], cover * 0.9);
        cb = lerp(cb, ic[2], cover * 0.9);
      }

      // --- melt ------------------------------------------------------------
      if (molten > 0 && glow) {
        // Fissures open along the ridges of a second noise field; the hotter it
        // gets, the more of the surface is incandescent rather than cracked.
        const crack = ridged(su * 7.2 + 31, sv * 7.2 - 17, seed ^ 0xc2b2ae35, 4);
        const open = clamp((crack - (1 - molten * 0.92) * 0.86) * 6, 0, 1);
        const pool = clamp((molten - 0.55) * 2.2, 0, 1);
        const lava = Math.max(open * (0.35 + molten * 0.65), pool);
        if (lava > 0) {
          const flick = 0.82 + valueNoise2(su * 9 + 100, sv * 9, seed ^ 0x1b56) * 0.36;
          cr = lerp(cr, glow[0] * flick, lava);
          cg = lerp(cg, glow[1] * flick, lava);
          cb = lerp(cb, glow[2] * flick, lava);
        }
      }

      // --- craters ---------------------------------------------------------
      for (let ci = 0; ci < body.craters.length; ci++) {
        const c = body.craters[ci];
        // A 2D world is seen from above, so an impact arriving from direction
        // `a` lands on the rim at that bearing, not at a random spot.
        const cx = Math.cos(c.a) * (1 - c.size * 0.55);
        const cy = Math.sin(c.a) * (1 - c.size * 0.55);
        const cr2 = c.size * 0.9;
        const d = Math.hypot(u - cx, v - cy);
        if (d > cr2 * 1.45) continue;

        if (d < cr2 * 0.82) {
          // Floor: darker, and flooded with core material if it dug deep enough.
          const f = 1 - d / (cr2 * 0.82);
          const dark = 1 - c.depth * 0.45 * smoothstep(f);
          cr *= dark; cg *= dark; cb *= dark;
          if (c.exposesCore) {
            const e = smoothstep(f) * 0.75;
            cr = lerp(cr, coreCol[0], e);
            cg = lerp(cg, coreCol[1], e);
            cb = lerp(cb, coreCol[2], e);
          }
        } else if (d < cr2 * 1.05) {
          // Raised rim.
          const f = 1 - Math.abs(d - cr2 * 0.93) / (cr2 * 0.12);
          const bright = 1 + 0.34 * clamp(f, 0, 1);
          cr *= bright; cg *= bright; cb *= bright;
        } else {
          // Ejecta blanket, streaked outward.
          const ang = Math.atan2(v - cy, u - cx);
          const ray = valueNoise2(Math.cos(ang) * 5, Math.sin(ang) * 5, seed ^ (ci * 7919));
          const f = 1 - (d - cr2 * 1.05) / (cr2 * 0.4);
          const amt = clamp(f, 0, 1) * ray * 0.4;
          cr = lerp(cr, cr * 1.35 + 22, amt);
          cg = lerp(cg, cg * 1.35 + 22, amt);
          cb = lerp(cb, cb * 1.35 + 22, amt);
        }
      }

      // --- limb -------------------------------------------------------------
      // A thin darkening at the edge reads as curvature without costing a
      // normal map, and an atmosphere adds a rim of scattered light.
      const limb = smoothstep(clamp((r - 0.78) / 0.22, 0, 1));
      cr *= 1 - limb * 0.42; cg *= 1 - limb * 0.42; cb *= 1 - limb * 0.38;

      const atmos = clamp(((surf.hydrogen || 0) + (surf.helium || 0) + (surf.water || 0) * 0.4) * 2, 0, 0.8);
      if (atmos > 0.05 && r > 0.86) {
        const a = smoothstep((r - 0.86) / 0.14) * atmos;
        cr = lerp(cr, 150, a * 0.5); cg = lerp(cg, 190, a * 0.5); cb = lerp(cb, 235, a * 0.6);
      }

      data[p] = quantize(cr, px, py);
      data[p + 1] = quantize(cg, px, py);
      data[p + 2] = quantize(cb, px, py);
      // Antialias the silhouette by one texel so small bodies do not look like
      // squares, but keep it hard enough to stay pixel art.
      data[p + 3] = r > 0.94 ? Math.round(255 * clamp((1 - r) / 0.06, 0, 1)) : 255;
    }
  }
}

// ---------------------------------------------------------------------------
// Gas and ice giants
//
// Seen from directly above, a rotating fluid planet's bands are concentric, not
// horizontal — differential rotation runs around the axis, and the axis points
// at the viewer. Drawing them as rings is the correct projection here, and it
// happens to look far better than stripes.

function renderGiant(body, size, data) {
  const n = size;
  const half = n / 2;
  const seed = body.seed >>> 0;
  const surf = body.surfaceComposition;
  const base = surfaceColor(surf, body.temperature);
  const rng = makeRng(seed ^ 0x7f4a7c15);

  // Band structure: a handful of jets at different radii, alternating sense.
  const bandCount = 5 + Math.floor(rng() * 7);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    bands.push({
      r: (i + 0.5) / bandCount,
      w: 0.5 / bandCount + rng() * 0.35 / bandCount,
      tone: (rng() * 2 - 1) * 0.32,
      shear: (rng() * 2 - 1) * 5.5,
    });
  }
  // Storm ovals, anchored between jets.
  const storms = [];
  const nStorm = Math.floor(rng() * 4);
  for (let i = 0; i < nStorm; i++) {
    storms.push({
      a: rng() * TAU, r: 0.25 + rng() * 0.6,
      rx: 0.08 + rng() * 0.16, ry: 0.05 + rng() * 0.09,
      tone: rng() < 0.5 ? -0.45 : 0.45, spin: rng() * TAU,
    });
  }

  let p = 0;
  for (let py = 0; py < n; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < n; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }
      const theta = Math.atan2(v, u);

      let tone = 0;
      // Turbulence is sampled in a sheared frame, so each band's clouds get
      // dragged around at that band's own rate.
      for (const band of bands) {
        const d = Math.abs(r - band.r);
        if (d > band.w * 2.4) continue;
        const w = Math.exp(-(d * d) / (2 * band.w * band.w));
        const sx = Math.cos(theta + band.shear * r) * r * 5.5;
        const sy = Math.sin(theta + band.shear * r) * r * 5.5;
        const turb = fbm(sx, sy, seed ^ Math.round(band.r * 1e4), 4, 2.1, 0.55) - 0.5;
        tone += w * (band.tone + turb * 0.85);
      }

      for (const s of storms) {
        const sx2 = Math.cos(s.a) * s.r, sy2 = Math.sin(s.a) * s.r;
        let dx = u - sx2, dy = v - sy2;
        const c = Math.cos(-s.a), si = Math.sin(-s.a);
        const rx = dx * c - dy * si, ry = dx * si + dy * c;
        const d = Math.hypot(rx / s.rx, ry / s.ry);
        if (d < 1.35) {
          const swirlAng = Math.atan2(ry, rx) + (1 - clamp(d, 0, 1)) * 4.5;
          const spiral = valueNoise2(Math.cos(swirlAng) * 4 + d * 5, Math.sin(swirlAng) * 4, seed ^ 0x51) - 0.5;
          tone = lerp(tone, s.tone + spiral * 0.5, clamp(1.35 - d, 0, 1));
        }
      }

      const k = 1 + tone;
      let cr = base[0] * k, cg = base[1] * k, cb = base[2] * k;

      // Merged material shows as a great scar of foreign cloud.
      for (let mi = 0; mi < body.mixes.length; mi++) {
        const mix = body.mixes[mi];
        const m = mixMask(u, v, mix, seed ^ (mi * 0x9e3779b1)) * 0.8;
        if (m <= 0.002) continue;
        const other = surfaceColor(mix.compB || surf, body.temperature);
        cr = lerp(cr, other[0] * k, m);
        cg = lerp(cg, other[1] * k, m);
        cb = lerp(cb, other[2] * k, m);
      }

      const glow = incandescence(body.temperature);
      if (glow && body.temperature > 900) {
        const hot = clamp((body.temperature - 900) / 1600, 0, 0.85);
        cr = lerp(cr, glow[0], hot); cg = lerp(cg, glow[1], hot); cb = lerp(cb, glow[2], hot);
      }

      const limb = smoothstep(clamp((r - 0.7) / 0.3, 0, 1));
      cr *= 1 - limb * 0.5; cg *= 1 - limb * 0.5; cb *= 1 - limb * 0.42;
      // Scattered light in the upper haze.
      const rim = smoothstep(clamp((r - 0.9) / 0.1, 0, 1));
      cr = lerp(cr, base[0] * 1.5, rim * 0.35);
      cg = lerp(cg, base[1] * 1.5, rim * 0.35);
      cb = lerp(cb, base[2] * 1.6, rim * 0.4);

      data[p] = quantize(cr, px, py);
      data[p + 1] = quantize(cg, px, py);
      data[p + 2] = quantize(cb, px, py);
      data[p + 3] = r > 0.94 ? Math.round(255 * clamp((1 - r) / 0.06, 0, 1)) : 255;
    }
  }
}

// ---------------------------------------------------------------------------
// Stars

/** Blackbody colour, from a fit to the Planck locus over 1000-40000 K. */
export function blackbodyColor(T) {
  const t = clamp(T, 1000, 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = clamp(99.4708025861 * Math.log(t) - 161.1195681661, 0, 255);
    b = t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307, 0, 255);
  } else {
    r = clamp(329.698727446 * Math.pow(t - 60, -0.1332047592), 0, 255);
    g = clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492), 0, 255);
    b = 255;
  }
  return [r, g, b];
}

function renderStar(body, size, data) {
  const n = size;
  const half = n / 2;
  const seed = body.seed >>> 0;
  const col = blackbodyColor(body.temperature || T_SUN);
  const rng = makeRng(seed ^ 0x4f1bbcdd);

  // Spots: cooler magnetic regions, more of them on cooler stars.
  const spots = [];
  const nSpots = body.temperature < 5000 ? 3 + Math.floor(rng() * 5) : Math.floor(rng() * 3);
  for (let i = 0; i < nSpots; i++) {
    spots.push({ x: (rng() * 2 - 1) * 0.72, y: (rng() * 2 - 1) * 0.72, r: 0.07 + rng() * 0.15 });
  }

  let p = 0;
  for (let py = 0; py < n; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < n; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }

      // Granulation: convective cells, small and high-contrast.
      const gran = fbm(u * 9.5, v * 9.5, seed, 4, 2.2, 0.5);
      const supergran = fbm(u * 3.1 + 17, v * 3.1 - 9, seed ^ 0x33, 3);
      let k = 0.86 + gran * 0.3 + (supergran - 0.5) * 0.14;

      // Limb darkening. The classic linear law, u ≈ 0.6 in the visible.
      const mu = Math.sqrt(clamp(1 - r * r, 0, 1));
      k *= 1 - 0.62 * (1 - mu);

      for (const s of spots) {
        const d = Math.hypot(u - s.x, v - s.y);
        if (d < s.r) {
          const f = smoothstep(1 - d / s.r);
          k *= 1 - f * 0.55;                       // umbra
        } else if (d < s.r * 1.5) {
          k *= 1 - smoothstep(1 - (d - s.r) / (s.r * 0.5)) * 0.18;  // penumbra
        }
      }

      // Saturate toward white in the core the way a bright source does.
      const boost = clamp(k * 1.35, 0, 1.9);
      const cr = clamp(col[0] * boost + 60 * Math.max(0, boost - 1), 0, 255);
      const cg = clamp(col[1] * boost + 60 * Math.max(0, boost - 1), 0, 255);
      const cb = clamp(col[2] * boost + 60 * Math.max(0, boost - 1), 0, 255);

      data[p] = quantize(cr, px, py);
      data[p + 1] = quantize(cg, px, py);
      data[p + 2] = quantize(cb, px, py);
      data[p + 3] = r > 0.95 ? Math.round(255 * clamp((1 - r) / 0.05, 0, 1)) : 255;
    }
  }
}

function renderCompact(body, size, data) {
  const n = size;
  const half = n / 2;
  const seed = body.seed >>> 0;
  // A white dwarf is hot and white; a neutron star is hotter still and shows
  // magnetic structure rather than granulation.
  const T = body.kind === 'ns' ? 6e5 : 2.5e4;
  const col = blackbodyColor(Math.min(T, 40000));

  let p = 0;
  for (let py = 0; py < n; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < n; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }
      const mu = Math.sqrt(clamp(1 - r * r, 0, 1));
      let k = 1.15 * (1 - 0.3 * (1 - mu));
      if (body.kind === 'ns') {
        // Field-aligned hot spots at the magnetic poles.
        const ang = Math.atan2(v, u);
        k *= 0.75 + 0.6 * Math.pow(Math.abs(Math.cos(ang * 1)), 6);
        k += fbm(u * 6, v * 6, seed, 3) * 0.12;
      }
      const cr = clamp(col[0] * k + 70 * Math.max(0, k - 1), 0, 255);
      const cg = clamp(col[1] * k + 70 * Math.max(0, k - 1), 0, 255);
      const cb = clamp(col[2] * k + 60 * Math.max(0, k - 1), 0, 255);
      data[p] = quantize(cr, px, py);
      data[p + 1] = quantize(cg, px, py);
      data[p + 2] = quantize(cb, px, py);
      data[p + 3] = r > 0.95 ? Math.round(255 * clamp((1 - r) / 0.05, 0, 1)) : 255;
    }
  }
}

/**
 * A black hole's sprite: the shadow, and the photon ring around it. The shadow
 * a distant observer sees is √27/2 ≈ 2.6 Schwarzschild radii across, so the
 * sprite is drawn to that radius and the horizon itself sits well inside it.
 */
function renderHorizon(body, size, data) {
  const n = size, half = n / 2;
  let p = 0;
  for (let py = 0; py < n; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < n; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }
      if (r > 0.88) {
        // The ring: light that orbited the hole before escaping toward us.
        const f = 1 - Math.abs(r - 0.94) / 0.06;
        const k = clamp(f, 0, 1);
        data[p] = 255 * k; data[p + 1] = 214 * k; data[p + 2] = 150 * k;
        data[p + 3] = Math.round(255 * clamp(k * 1.2, 0, 1));
      } else {
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 255;
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** The sprite for a body at a given size, generated on first use and cached. */
export function bodyTexture(body, size) {
  const key = `${body.textureKey}@${size}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: false });
  const img = ctx.createImageData(size, size);
  const data = img.data;

  if (body.kind === 'bh') renderHorizon(body, size, data);
  else if (body.kind === 'star') renderStar(body, size, data);
  else if (body.kind === 'ns' || body.kind === 'wd') renderCompact(body, size, data);
  else if (body.kind === 'gasgiant') renderGiant(body, size, data);
  else renderTerrestrial(body, size, data);

  ctx.putImageData(img, 0, 0);
  return cacheSet(key, c);
}

/**
 * The shading overlay: a quantised terminator, lit from +x, shared by every
 * body of the same size. Drawing it rotated to the star direction gives phases
 * for free, and quantising it into bands keeps the look consistent with the
 * dithered sprites underneath.
 */
export function shadeMask(size, bands = 5, ambient = 0.16) {
  const key = `shade@${size}:${bands}:${ambient}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size / 2;

  let p = 0;
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < size; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const r = Math.hypot(u, v);
      if (r > 1) { data[p + 3] = 0; continue; }
      // Lambert on a sphere seen face-on: the surface normal's x-component is
      // just u, so the lit fraction runs with the horizontal coordinate.
      const nz = Math.sqrt(clamp(1 - r * r, 0, 1));
      const lambert = clamp(u * 0.82 + nz * 0.35, -1, 1);
      let lit = clamp(lambert, 0, 1);
      lit = Math.round(lit * bands) / bands;
      const shadow = clamp(1 - (ambient + (1 - ambient) * lit), 0, 1);
      data[p] = 4; data[p + 1] = 2; data[p + 2] = 10;
      data[p + 3] = Math.round(shadow * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cacheSet(key, c);
}

/** Additive glow sprite for stars and hot bodies. */
export function glowSprite(size, r, g, b, power = 2.4) {
  const key = `glow@${size}:${Math.round(r)},${Math.round(g)},${Math.round(b)}:${power}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size / 2;
  let p = 0;
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < size; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const d = Math.hypot(u, v);
      if (d > 1) { data[p + 3] = 0; continue; }
      const f = Math.pow(1 - d, power);
      data[p] = clamp(r, 0, 255);
      data[p + 1] = clamp(g, 0, 255);
      data[p + 2] = clamp(b, 0, 255);
      data[p + 3] = Math.round(clamp(f, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cacheSet(key, c);
}

/** A small pixel disc, used for debris too small to deserve a full sprite. */
export function dotSprite(size, r, g, b) {
  const key = `dot@${size}:${Math.round(r)},${Math.round(g)},${Math.round(b)}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const half = size / 2;
  let p = 0;
  for (let py = 0; py < size; py++) {
    const v = (py + 0.5) / half - 1;
    for (let px = 0; px < size; px++, p += 4) {
      const u = (px + 0.5) / half - 1;
      const d = Math.hypot(u, v);
      if (d > 1) { data[p + 3] = 0; continue; }
      const k = 1 - d * 0.45;
      data[p] = quantize(r * k, px, py);
      data[p + 1] = quantize(g * k, px, py);
      data[p + 2] = quantize(b * k, px, py);
      data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cacheSet(key, c);
}

/**
 * The thumbnail used by the body picker and the inspector.
 *
 * Drawn by the same generator as the real thing, from a body built from the
 * same catalogue entry — so it shows the *type* faithfully. The one you place
 * gets its own seed, so its continents will not match the picture; two Earths
 * should not be identical twins.
 */
export function thumbnail(body, size = 40) {
  const key = `thumb:${body.textureKey}@${size}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const src = bodyTexture(body, 48);
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, size, size);
  const mask = shadeMask(size, 5, 0.34);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-0.6);
  ctx.translate(-size / 2, -size / 2);
  if (body.kind !== 'star' && body.kind !== 'bh') ctx.drawImage(mask, 0, 0, size, size);
  ctx.restore();
  return cacheSet(key, c);
}
