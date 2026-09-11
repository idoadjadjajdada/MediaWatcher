/**
 * The settings panel's contents.
 *
 * Declared as data so the panel builds itself and so a saved scene can carry
 * the whole state without the UI and the simulation drifting apart. Anything
 * tagged `world: true` is forwarded to the simulation; everything else is only
 * ever read by the renderer.
 */

export const SETTING_GROUPS = [
  {
    id: 'display',
    label: 'Display',
    items: [
      { id: 'pixelScale', label: 'Pixel size', type: 'range', min: 1, max: 6, step: 1, value: 3, format: (v) => `${v}×` },
      { id: 'starfield', label: 'Starfield', type: 'toggle', value: true },
      { id: 'starDensity', label: 'Star density', type: 'range', min: 0, max: 1.5, step: 0.05, value: 1, format: (v) => `${Math.round(v * 100)}%`, depends: 'starfield' },
      { id: 'nebula', label: 'Nebula', type: 'toggle', value: true },
      { id: 'nebulaIntensity', label: 'Nebula strength', type: 'range', min: 0, max: 1, step: 0.05, value: 0.45, format: (v) => `${Math.round(v * 100)}%`, depends: 'nebula' },
      { id: 'grid', label: 'Reference grid', type: 'toggle', value: true },
      { id: 'scaleBar', label: 'Scale bar', type: 'toggle', value: true },
      { id: 'bodyScale', label: 'Body size boost', type: 'range', min: 0, max: 1, step: 0.05, value: 0.8, format: (v) => (v === 0 ? 'true scale' : `${Math.round(v * 100)}%`), note: 'Draws small bodies larger so they stay visible at system scale. Physics is unaffected.' },
      { id: 'labels', label: 'Body names', type: 'toggle', value: true },
      { id: 'labelDebris', label: 'Name debris too', type: 'toggle', value: false, depends: 'labels' },
      { id: 'scanlines', label: 'Scanlines', type: 'toggle', value: false },
    ],
  },
  {
    id: 'lighting',
    label: 'Lighting',
    items: [
      { id: 'shading', label: 'Day and night sides', type: 'toggle', value: true },
      { id: 'shadeBands', label: 'Shading steps', type: 'range', min: 2, max: 12, step: 1, value: 5, format: (v) => `${v}`, depends: 'shading' },
      { id: 'ambient', label: 'Ambient light', type: 'range', min: 0, max: 0.6, step: 0.02, value: 0.14, format: (v) => `${Math.round(v * 100)}%`, depends: 'shading' },
      { id: 'glow', label: 'Stellar glow', type: 'toggle', value: true },
      { id: 'lensing', label: 'Gravitational lensing', type: 'toggle', value: true, note: 'Bends the background around black holes.' },
    ],
  },
  {
    id: 'overlays',
    label: 'Overlays',
    items: [
      { id: 'trails', label: 'Motion trails', type: 'toggle', value: true },
      { id: 'trailFade', label: 'Fade trails', type: 'toggle', value: true, depends: 'trails' },
      { id: 'trailLength', label: 'Trail length', type: 'range', min: 20, max: 900, step: 20, value: 260, world: true, format: (v) => `${v}`, depends: 'trails' },
      { id: 'orbits', label: 'Predicted orbits', type: 'toggle', value: true, note: 'Two-body path about the dominant attractor.' },
      { id: 'orbitsSelectedOnly', label: 'Only the selection', type: 'toggle', value: false, depends: 'orbits' },
      { id: 'orbitsDebris', label: 'Include debris', type: 'toggle', value: false, depends: 'orbits' },
      { id: 'velocityVectors', label: 'Velocity vectors', type: 'toggle', value: false },
      { id: 'forceVectors', label: 'Acceleration vectors', type: 'toggle', value: false },
      { id: 'vectorsSelectedOnly', label: 'Vectors: selection only', type: 'toggle', value: false },
      { id: 'hillSpheres', label: 'Hill spheres', type: 'toggle', value: false, note: 'Where a body can keep a moon.' },
      { id: 'rocheLimits', label: 'Roche limits', type: 'toggle', value: false, note: 'Inside this, tides win.' },
      { id: 'radiiSelectedOnly', label: 'Radii: selection only', type: 'toggle', value: true },
      { id: 'barycenter', label: 'System barycentre', type: 'toggle', value: false },
    ],
  },
  {
    id: 'physics',
    label: 'Physics',
    items: [
      { id: 'collisions', label: 'Collisions', type: 'toggle', value: true, world: true },
      { id: 'bounce', label: 'Allow bouncing', type: 'toggle', value: true, world: true, depends: 'collisions', note: 'Small strong bodies rebound instead of sticking.' },
      { id: 'maxFragments', label: 'Fragment cap', type: 'range', min: 4, max: 120, step: 4, value: 48, world: true, format: (v) => `${v}`, depends: 'collisions' },
      { id: 'tidalDisruption', label: 'Tidal disruption', type: 'toggle', value: true, world: true, note: 'Bodies shred inside the Roche limit.' },
      { id: 'thermal', label: 'Thermal evolution', type: 'toggle', value: true, world: true, note: 'Irradiation, radiative cooling, melting.' },
      { id: 'relativity', label: 'Relativistic precession', type: 'toggle', value: false, world: true, note: 'First post-Newtonian term. Mercury gains 43″/century.' },
      { id: 'theta', label: 'Barnes-Hut θ', type: 'range', min: 0, max: 1.2, step: 0.05, value: 0.5, world: true, format: (v) => (v === 0 ? 'exact' : v.toFixed(2)), note: '0 is an exact N² sum.' },
      { id: 'eta', label: 'Integrator accuracy', type: 'range', min: 0.004, max: 0.08, step: 0.002, value: 0.018, world: true, format: (v) => v.toFixed(3) },
      { id: 'softeningFraction', label: 'Softening', type: 'range', min: 0, max: 1, step: 0.05, value: 0, world: true, format: (v) => (v === 0 ? 'none' : `${v.toFixed(2)} R`) },
      { id: 'frameBudgetMs', label: 'Physics time budget', type: 'range', min: 3, max: 32, step: 1, value: 11, world: true, format: (v) => `${v} ms/frame`, note: 'Raise for faster clocks, lower for a steadier frame rate.' },
      { id: 'maxSubsteps', label: 'Substep ceiling', type: 'range', min: 20, max: 2000, step: 20, value: 600, world: true, format: (v) => `${v}` },
      { id: 'maxBodies', label: 'Body limit', type: 'range', min: 200, max: 6000, step: 200, value: 3000, world: true, format: (v) => `${v}` },
    ],
  },
  {
    id: 'feel',
    label: 'Feel',
    items: [
      { id: 'effects', label: 'Impact effects', type: 'toggle', value: true },
      { id: 'shake', label: 'Screen shake', type: 'toggle', value: true },
      { id: 'smoothCamera', label: 'Smooth camera', type: 'toggle', value: true },
      { id: 'autoOrbit', label: 'Auto-orbit on placement', type: 'toggle', value: true, note: 'New bodies get the velocity for a circular orbit.' },
      { id: 'showDiagnostics', label: 'Show diagnostics', type: 'toggle', value: false, note: 'Substeps, energy drift, texture cache.' },
    ],
  },
];

export const SETTING_DEFS = new Map();
for (const g of SETTING_GROUPS) for (const i of g.items) SETTING_DEFS.set(i.id, i);

export function defaultSettings() {
  const out = {};
  for (const [id, def] of SETTING_DEFS) out[id] = def.value;
  return out;
}

/** Push the world-facing settings into the simulation. */
export function applyToWorld(settings, world) {
  for (const [id, def] of SETTING_DEFS) {
    if (def.world && settings[id] !== undefined) world.settings[id] = settings[id];
  }
  if (settings.trails === false) world.settings.trailLength = 0;
  else world.settings.trailLength = settings.trailLength;
}

export function loadSettings(storageKey) {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    for (const k in saved) if (k in base) base[k] = saved[k];
  } catch (e) {
    // A corrupt or blocked store is not a reason to refuse to start.
  }
  return base;
}

export function saveSettings(storageKey, settings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch (e) {
    // Private browsing, or the quota is full. Nothing here is worth an error.
  }
}
