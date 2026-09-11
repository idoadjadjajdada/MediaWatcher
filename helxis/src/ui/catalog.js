import {
  M_SUN, R_SUN, M_EARTH, R_EARTH, M_JUP, R_JUP, M_MOON, R_MOON, DAY, AU,
} from '../core/const.js';
import { Body, compactRadius } from '../core/body.js';
import { hashSeed } from '../core/rng.js';

/**
 * The body picker's contents.
 *
 * Where a real object exists, its mass, radius, rotation period, temperature
 * and composition are the measured ones. The generic types are built from the
 * same fields, so a "super-Earth" is a real point in the same parameter space
 * rather than a special case.
 *
 * `spin` is given as a rotation period in seconds and converted on placement.
 */

const spinFrom = (periodSeconds) => (periodSeconds ? (Math.PI * 2) / periodSeconds : 0);

export const CATEGORIES = [
  { id: 'all', label: 'All objects' },
  { id: 'star', label: 'Stars' },
  { id: 'rocky', label: 'Rocky worlds' },
  { id: 'giant', label: 'Gas & ice giants' },
  { id: 'moon', label: 'Moons' },
  { id: 'small', label: 'Small bodies' },
  { id: 'exotic', label: 'Exotic' },
];

export const CATALOG = [
  // --- Stars ---------------------------------------------------------------
  {
    id: 'sun', name: 'Sun', category: 'star', kind: 'star',
    mass: M_SUN, radius: R_SUN, temperature: 5772, period: 25.4 * DAY,
    composition: { hydrogen: 0.7346, helium: 0.2483, carbon: 0.0029, silicate: 0.0142 },
    note: 'G2V main sequence. 1 L☉, 5772 K effective.',
  },
  {
    id: 'red-dwarf', name: 'Red dwarf', category: 'star', kind: 'star',
    mass: 0.122 * M_SUN, radius: 0.154 * R_SUN, temperature: 3042, period: 82.6 * DAY,
    composition: { hydrogen: 0.75, helium: 0.245, silicate: 0.005 },
    note: 'M5.5V, modelled on Proxima Centauri. Burns for a trillion years.',
  },
  {
    id: 'orange-dwarf', name: 'Orange dwarf', category: 'star', kind: 'star',
    mass: 0.79 * M_SUN, radius: 0.793 * R_SUN, temperature: 5260, period: 35 * DAY,
    composition: { hydrogen: 0.73, helium: 0.26, silicate: 0.01 },
    note: 'K1V, after Alpha Centauri B.',
  },
  {
    id: 'blue-giant', name: 'Blue giant', category: 'star', kind: 'star',
    mass: 17.5 * M_SUN, radius: 7.4 * R_SUN, temperature: 26000, period: 2.1 * DAY,
    composition: { hydrogen: 0.70, helium: 0.28, carbon: 0.02 },
    note: 'B0V. Around 40 000 L☉, and only a few million years of it.',
  },
  {
    id: 'red-giant', name: 'Red giant', category: 'star', kind: 'star',
    mass: 1.2 * M_SUN, radius: 44 * R_SUN, temperature: 4300, period: 300 * DAY,
    evolved: true,
    composition: { hydrogen: 0.66, helium: 0.32, carbon: 0.02 },
    note: 'A Sun-like star after the main sequence. 44 R☉ and about 600 L☉.',
  },
  {
    id: 'white-dwarf', name: 'White dwarf', category: 'star', kind: 'wd',
    mass: 0.6 * M_SUN, temperature: 25000, period: 3600,
    composition: { carbon: 0.5, degenerate: 0.5 },
    note: 'Electron-degenerate carbon-oxygen core. Earth-sized, half a solar mass.',
  },

  // --- Rocky worlds --------------------------------------------------------
  {
    id: 'mercury', name: 'Mercury', category: 'rocky', kind: 'planet',
    mass: 3.3011e23, radius: 2.4397e6, temperature: 440, period: 58.646 * DAY,
    composition: { iron: 0.70, silicate: 0.30 },
    crust: { silicate: 0.62, regolith: 0.30, sulfur: 0.08 },
    note: 'An iron core under a thin silicate shell — 70% of its mass is metal.',
  },
  {
    id: 'venus', name: 'Venus', category: 'rocky', kind: 'planet',
    mass: 4.8675e24, radius: 6.0518e6, temperature: 737, period: -243.025 * DAY,
    composition: { iron: 0.31, silicate: 0.69 },
    // The ground, not the cloud deck. Venus is the brightest object in the sky
    // because of sulfuric acid clouds at around 250 K, and a body here carries
    // one temperature — so it is drawn as the basalt and iron oxide the Venera
    // landers photographed, not as the white disc from outside.
    crust: { basalt: 0.50, hematite: 0.30, feldspar: 0.20 },
    note: 'Retrograde, 737 K under 92 bar of CO₂. Drawn as the surface, not the clouds.',
  },
  {
    id: 'earth', name: 'Earth', category: 'rocky', kind: 'planet',
    mass: 5.97217e24, radius: 6.371e6, temperature: 288, period: 0.99727 * DAY,
    composition: { iron: 0.323, silicate: 0.6765, water: 0.0005 },
    crust: { silicate: 0.42, feldspar: 0.20, granite: 0.08, water: 0.30 },
    note: 'The only one where the water is liquid at the surface.',
  },
  {
    id: 'mars', name: 'Mars', category: 'rocky', kind: 'planet',
    mass: 6.4171e23, radius: 3.3895e6, temperature: 210, period: 1.02595 * DAY,
    composition: { iron: 0.24, silicate: 0.75, ice: 0.01 },
    crust: { hematite: 0.38, basalt: 0.42, regolith: 0.12, ice: 0.08 },
    note: 'Iron oxide dust over basalt. Water ice at the poles and under it.',
  },
  {
    id: 'super-earth', name: 'Super-Earth', category: 'rocky', kind: 'planet',
    mass: 5.5 * M_EARTH, temperature: 290, period: 1.4 * DAY,
    composition: { iron: 0.30, silicate: 0.68, water: 0.02 },
    crust: { basalt: 0.40, silicate: 0.20, water: 0.40 },
    note: 'Five Earth masses. Surface gravity around 1.7 g.',
  },
  {
    id: 'lava-world', name: 'Lava world', category: 'rocky', kind: 'planet',
    mass: 1.4 * M_EARTH, temperature: 2100, period: 0.6 * DAY,
    composition: { iron: 0.33, silicate: 0.67 },
    crust: { basalt: 0.7, silicate: 0.3 },
    note: 'Tide-locked and molten. A magma ocean on the day side.',
  },
  {
    id: 'ocean-world', name: 'Ocean world', category: 'rocky', kind: 'planet',
    mass: 2.1 * M_EARTH, temperature: 291, period: 1.1 * DAY,
    composition: { iron: 0.18, silicate: 0.52, water: 0.30 },
    crust: { water: 0.92, silicate: 0.08 },
    note: 'A hundred-kilometre ocean over a high-pressure ice mantle.',
  },
  {
    id: 'desert-world', name: 'Desert world', category: 'rocky', kind: 'planet',
    mass: 0.82 * M_EARTH, temperature: 330, period: 1.3 * DAY,
    composition: { iron: 0.30, silicate: 0.70 },
    crust: { regolith: 0.55, feldspar: 0.25, hematite: 0.20 },
    note: 'Dry, dusty, and thin-aired. What Mars would be at 1 AU.',
  },
  {
    id: 'ice-world', name: 'Ice world', category: 'rocky', kind: 'planet',
    mass: 0.6 * M_EARTH, temperature: 140, period: 1.8 * DAY,
    composition: { iron: 0.16, silicate: 0.44, ice: 0.40 },
    crust: { ice: 0.88, silicate: 0.12 },
    note: 'Frozen to the core. Any ocean is kilometres down.',
  },
  {
    id: 'iron-world', name: 'Iron world', category: 'rocky', kind: 'planet',
    mass: 1.1 * M_EARTH, temperature: 420, period: 0.9 * DAY,
    composition: { iron: 0.82, nickel: 0.10, silicate: 0.08 },
    crust: { iron: 0.7, nickel: 0.2, hematite: 0.1 },
    note: 'A stripped planetary core — the mantle was blasted off.',
  },
  {
    id: 'rogue-planet', name: 'Rogue planet', category: 'rocky', kind: 'planet',
    mass: 1.0 * M_EARTH, temperature: 32, period: 2.4 * DAY,
    composition: { iron: 0.32, silicate: 0.66, nitrogen: 0.02 },
    crust: { nitrogen: 0.6, ice: 0.3, silicate: 0.1 },
    note: 'Ejected from its system. Nitrogen snow, lit only by starlight.',
  },

  // --- Gas and ice giants --------------------------------------------------
  {
    id: 'jupiter', name: 'Jupiter', category: 'giant', kind: 'gasgiant',
    mass: M_JUP, radius: R_JUP, temperature: 165, period: 0.41354 * DAY,
    composition: { hydrogen: 0.71, helium: 0.24, silicate: 0.04, ice: 0.01 },
    crust: { hydrogen: 0.52, helium: 0.16, ammonia: 0.24, sulfur: 0.08 },
    note: '318 Earth masses. Its barycentre with the Sun is outside the Sun.',
  },
  {
    id: 'saturn', name: 'Saturn', category: 'giant', kind: 'gasgiant',
    mass: 5.6834e26, radius: 5.8232e7, temperature: 134, period: 0.44401 * DAY,
    composition: { hydrogen: 0.73, helium: 0.25, silicate: 0.02 },
    crust: { hydrogen: 0.60, helium: 0.18, ammonia: 0.22 },
    note: 'Less dense than water — 687 kg/m³.',
  },
  {
    id: 'uranus', name: 'Uranus', category: 'giant', kind: 'gasgiant',
    mass: 8.6810e25, radius: 2.5362e7, temperature: 76, period: -0.71833 * DAY,
    composition: { hydrogen: 0.18, helium: 0.14, ice: 0.60, ammonia: 0.05, methane: 0.03 },
    crust: { methane: 0.62, hydrogen: 0.26, helium: 0.12 },
    note: 'An ice giant on its side. Methane haze is what makes it cyan.',
  },
  {
    id: 'neptune', name: 'Neptune', category: 'giant', kind: 'gasgiant',
    mass: 1.02413e26, radius: 2.4622e7, temperature: 72, period: 0.6713 * DAY,
    composition: { hydrogen: 0.19, helium: 0.13, ice: 0.60, ammonia: 0.05, methane: 0.03 },
    crust: { methane: 0.72, hydrogen: 0.19, helium: 0.09 },
    note: 'The fastest winds in the solar system, above 2 000 km/h.',
  },
  {
    id: 'hot-jupiter', name: 'Hot Jupiter', category: 'giant', kind: 'gasgiant',
    mass: 1.3 * M_JUP, radius: 1.4 * R_JUP, temperature: 1400, period: 2.2 * DAY,
    composition: { hydrogen: 0.72, helium: 0.26, silicate: 0.02 },
    crust: { hydrogen: 0.74, helium: 0.24, silicate: 0.02 },
    note: 'Inflated by the star it nearly touches. Silicate clouds.',
  },
  {
    id: 'sub-neptune', name: 'Sub-Neptune', category: 'giant', kind: 'gasgiant',
    // 8 M⊕ at 2.7 R⊕, after K2-18b. The 2.4 R⊕ this used to carry implied a
    // bulk density its own composition could not reach.
    mass: 8 * M_EARTH, radius: 2.7 * R_EARTH, temperature: 320, period: 0.8 * DAY,
    composition: { hydrogen: 0.08, helium: 0.04, ice: 0.5, silicate: 0.38 },
    crust: { hydrogen: 0.6, helium: 0.2, water: 0.2 },
    note: 'The commonest kind of planet in the galaxy, and absent from ours.',
  },
  {
    id: 'brown-dwarf', name: 'Brown dwarf', category: 'giant', kind: 'gasgiant',
    mass: 45 * M_JUP, radius: 0.9 * R_JUP, temperature: 1100, period: 0.2 * DAY,
    composition: { hydrogen: 0.73, helium: 0.26, silicate: 0.01 },
    crust: { hydrogen: 0.74, helium: 0.25, sulfur: 0.01 },
    note: 'Too light to fuse hydrogen. Fuses deuterium for a while, then cools.',
  },

  // --- Moons ---------------------------------------------------------------
  {
    id: 'luna', name: 'The Moon', category: 'moon', kind: 'moon',
    mass: M_MOON, radius: R_MOON, temperature: 250, period: 27.3217 * DAY,
    composition: { iron: 0.08, silicate: 0.92 },
    crust: { regolith: 0.55, feldspar: 0.30, basalt: 0.15 },
    note: 'Almost no iron core — it formed from a mantle, not a whole planet.',
  },
  {
    id: 'io', name: 'Io', category: 'moon', kind: 'moon',
    mass: 8.931938e22, radius: 1.8216e6, temperature: 110, period: 1.769 * DAY,
    composition: { iron: 0.20, silicate: 0.78, sulfur: 0.02 },
    crust: { sulfur: 0.55, basalt: 0.35, silicate: 0.10 },
    note: 'The most volcanic body known. Tidally kneaded by Jupiter.',
  },
  {
    id: 'europa', name: 'Europa', category: 'moon', kind: 'moon',
    mass: 4.799844e22, radius: 1.5608e6, temperature: 102, period: 3.551 * DAY,
    composition: { iron: 0.11, silicate: 0.81, ice: 0.08 },
    crust: { ice: 0.94, sulfur: 0.06 },
    note: 'A salt ocean under 15-25 km of ice, with twice Earth’s water.',
  },
  {
    id: 'ganymede', name: 'Ganymede', category: 'moon', kind: 'moon',
    mass: 1.4819e23, radius: 2.6341e6, temperature: 110, period: 7.155 * DAY,
    composition: { iron: 0.13, silicate: 0.42, ice: 0.45 },
    crust: { ice: 0.85, silicate: 0.15 },
    note: 'Bigger than Mercury, and the only moon with its own magnetic field.',
  },
  {
    id: 'callisto', name: 'Callisto', category: 'moon', kind: 'moon',
    mass: 1.075938e23, radius: 2.4103e6, temperature: 134, period: 16.689 * DAY,
    composition: { silicate: 0.55, ice: 0.45 },
    crust: { ice: 0.60, silicate: 0.25, carbon: 0.15 },
    note: 'Undifferentiated and saturated with craters — nothing has resurfaced it.',
  },
  {
    id: 'titan', name: 'Titan', category: 'moon', kind: 'moon',
    mass: 1.3452e23, radius: 2.5747e6, temperature: 94, period: 15.945 * DAY,
    composition: { silicate: 0.52, ice: 0.45, methane: 0.03 },
    crust: { tholin: 0.45, ice: 0.40, methane: 0.15 },
    note: 'A thick nitrogen atmosphere, and rain, rivers and seas of methane.',
  },
  {
    id: 'enceladus', name: 'Enceladus', category: 'moon', kind: 'moon',
    mass: 1.08022e20, radius: 2.521e5, temperature: 75, period: 1.370 * DAY,
    composition: { silicate: 0.43, ice: 0.57 },
    crust: { ice: 0.97, silicate: 0.03 },
    note: 'Albedo 0.81, the most reflective body in the solar system.',
  },
  {
    id: 'triton', name: 'Triton', category: 'moon', kind: 'moon',
    mass: 2.139e22, radius: 1.3534e6, temperature: 38, period: -5.877 * DAY,
    composition: { silicate: 0.65, ice: 0.30, nitrogen: 0.05 },
    crust: { nitrogen: 0.55, ice: 0.30, methane: 0.10, co2: 0.05 },
    note: 'Retrograde: a captured Kuiper belt object. Nitrogen geysers.',
  },
  {
    id: 'phobos', name: 'Phobos', category: 'moon', kind: 'moon',
    mass: 1.0659e16, radius: 1.1267e4, temperature: 233, period: 0.31891 * DAY,
    composition: { carbon: 0.3, silicate: 0.7 },
    crust: { regolith: 0.7, carbon: 0.3 },
    note: 'Spiralling in. In 50 Myr it hits Mars or becomes a ring.',
  },
  {
    id: 'charon', name: 'Charon', category: 'moon', kind: 'moon',
    mass: 1.586e21, radius: 6.06e5, temperature: 53, period: 6.387 * DAY,
    composition: { silicate: 0.55, ice: 0.45 },
    crust: { ice: 0.82, tholin: 0.18 },
    note: 'Half Pluto’s diameter. The barycentre is between the two.',
  },

  // --- Small bodies --------------------------------------------------------
  {
    id: 'ceres', name: 'Ceres', category: 'small', kind: 'asteroid',
    mass: 9.3835e20, radius: 4.696e5, temperature: 168, period: 0.3781 * DAY,
    composition: { silicate: 0.75, ice: 0.25 },
    crust: { ice: 0.30, silicate: 0.5, carbon: 0.2 },
    note: 'A quarter of the asteroid belt’s mass, and a quarter water ice.',
  },
  {
    id: 'vesta', name: 'Vesta', category: 'small', kind: 'asteroid',
    mass: 2.59076e20, radius: 2.626e5, temperature: 170, period: 0.2226 * DAY,
    composition: { iron: 0.18, silicate: 0.82 },
    crust: { basalt: 0.75, olivine: 0.25 },
    note: 'Differentiated, with an iron core — a protoplanet that never grew.',
  },
  {
    id: 'pluto', name: 'Pluto', category: 'small', kind: 'asteroid',
    mass: 1.303e22, radius: 1.1883e6, temperature: 44, period: -6.387 * DAY,
    composition: { silicate: 0.65, ice: 0.33, nitrogen: 0.02 },
    crust: { nitrogen: 0.45, ice: 0.25, tholin: 0.20, methane: 0.10 },
    note: 'Nitrogen glaciers flowing across a plain of frozen nitrogen.',
  },
  {
    id: 'eris', name: 'Eris', category: 'small', kind: 'asteroid',
    mass: 1.6466e22, radius: 1.163e6, temperature: 30, period: 15.786 * DAY,
    composition: { silicate: 0.7, ice: 0.3 },
    crust: { methane: 0.6, ice: 0.4 },
    note: 'More massive than Pluto, and the reason Pluto was reclassified.',
  },
  {
    id: 'c-asteroid', name: 'C-type asteroid', category: 'small', kind: 'asteroid',
    mass: 4.2e17, radius: 3.4e4, temperature: 180, period: 0.35 * DAY,
    composition: { carbon: 0.25, silicate: 0.65, ice: 0.10 },
    crust: { carbon: 0.6, regolith: 0.4 },
    note: 'Carbonaceous, dark as charcoal, and three-quarters of all asteroids.',
  },
  {
    id: 's-asteroid', name: 'S-type asteroid', category: 'small', kind: 'asteroid',
    mass: 6.7e17, radius: 3.6e4, temperature: 200, period: 0.28 * DAY,
    composition: { iron: 0.15, silicate: 0.85 },
    crust: { olivine: 0.5, silicate: 0.35, regolith: 0.15 },
    note: 'Stony. Olivine and pyroxene, from the inner belt.',
  },
  {
    id: 'm-asteroid', name: 'M-type asteroid', category: 'small', kind: 'asteroid',
    // Psyche: 2.29e19 kg at a volume-equivalent radius of 111 km, which is
    // 3400 kg/m³. The pair this used to carry worked out at 18 400 — over twice
    // the density of solid iron.
    mass: 2.29e19, radius: 1.11e5, temperature: 190, period: 0.19 * DAY,
    composition: { iron: 0.75, nickel: 0.15, silicate: 0.10 },
    crust: { iron: 0.8, nickel: 0.2 },
    note: 'Nickel-iron: the exposed core of a shattered protoplanet.',
  },
  {
    id: 'rubble-pile', name: 'Rubble pile', category: 'small', kind: 'asteroid',
    // Bennu: the mass is right, but its volume-equivalent radius is 245 m, not
    // its 163 m polar one — which gives the 1190 kg/m³ that makes it a rubble
    // pile rather than something denser than basalt.
    mass: 7.33e10, radius: 2.45e2, temperature: 255, period: 4.3 * 3600,
    composition: { silicate: 0.8, carbon: 0.2 },
    crust: { regolith: 0.9, carbon: 0.1 },
    note: 'Loose gravel held together by almost nothing, after Bennu.',
  },
  {
    id: 'comet', name: 'Comet', category: 'small', kind: 'comet',
    mass: 1.0e13, radius: 2.0e3, temperature: 150, period: 12.4 * 3600,
    composition: { ice: 0.50, co2: 0.12, carbon: 0.18, silicate: 0.20 },
    crust: { carbon: 0.45, ice: 0.35, tholin: 0.20 },
    note: 'A dirty snowball with a dark crust of processed organics.',
  },
  {
    id: 'halley', name: "Halley's Comet", category: 'small', kind: 'comet',
    mass: 2.2e14, radius: 5.5e3, temperature: 150, period: 2.2 * DAY,
    composition: { ice: 0.45, co2: 0.10, carbon: 0.25, silicate: 0.20 },
    crust: { carbon: 0.6, ice: 0.25, tholin: 0.15 },
    note: 'Period 75 years, retrograde, and blacker than coal.',
  },

  // --- Exotic --------------------------------------------------------------
  {
    id: 'black-hole', name: 'Black hole', category: 'exotic', kind: 'bh',
    mass: 10 * M_SUN, temperature: 0, period: 0.01,
    composition: { degenerate: 1 },
    note: 'Ten solar masses inside a 30 km horizon. The shadow is 2.6 r_s wide.',
  },
  {
    id: 'smbh', name: 'Supermassive black hole', category: 'exotic', kind: 'bh',
    mass: 4.297e6 * M_SUN, temperature: 0, period: 60,
    composition: { degenerate: 1 },
    note: 'Sagittarius A*: 4.3 million solar masses, a 12-million-km horizon.',
  },
  {
    id: 'neutron-star', name: 'Neutron star', category: 'exotic', kind: 'ns',
    mass: 1.4 * M_SUN, temperature: 6e5, period: 1.4,
    composition: { neutronium: 1 },
    note: '1.4 M☉ in 12 km. A teaspoon weighs as much as a mountain range.',
  },
  {
    id: 'pulsar', name: 'Pulsar', category: 'exotic', kind: 'ns',
    mass: 1.44 * M_SUN, temperature: 8e5, period: 0.0334,
    composition: { neutronium: 1 },
    note: 'The Crab pulsar, turning 30 times a second.',
  },
  {
    id: 'magnetar', name: 'Magnetar', category: 'exotic', kind: 'ns',
    mass: 1.6 * M_SUN, temperature: 1e6, period: 5.2,
    composition: { neutronium: 1 },
    note: 'A 10¹¹ T field. It would wipe a credit card from halfway to the Moon.',
  },
  {
    id: 'planetesimal', name: 'Planetesimal', category: 'exotic', kind: 'planet',
    mass: 0.05 * M_EARTH, temperature: 900, period: 0.4 * DAY,
    composition: { iron: 0.28, silicate: 0.72 },
    crust: { basalt: 0.6, olivine: 0.4 },
    note: 'A protoplanet still hot from accretion. Build a system out of these.',
  },
  {
    id: 'dust-grain', name: 'Dust cloud seed', category: 'exotic', kind: 'debris',
    mass: 1e15, radius: 5e3, temperature: 120, period: 900,
    composition: { silicate: 0.7, carbon: 0.2, ice: 0.1 },
    note: 'Scatter a few hundred and watch them accrete into something.',
  },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

export function categoryCount(id) {
  if (id === 'all') return CATALOG.length;
  return CATALOG.filter((e) => e.category === id).length;
}

export function searchCatalog(query, category) {
  const q = (query || '').trim().toLowerCase();
  return CATALOG.filter((e) => {
    if (category && category !== 'all' && e.category !== category) return false;
    if (!q) return true;
    return e.name.toLowerCase().includes(q)
      || e.id.includes(q)
      || (e.note || '').toLowerCase().includes(q)
      || Object.keys(e.composition || {}).some((k) => k.includes(q));
  });
}

/**
 * Build a body from a catalogue entry.
 *
 * `massScale` is the picker's mass slider: it scales the mass and, for anything
 * whose radius is not a measured value, lets the radius follow from the
 * composition rather than being scaled independently.
 */
export function instantiate(entry, opts = {}) {
  const massScale = opts.massScale != null ? opts.massScale : 1;
  const mass = entry.mass * massScale;
  const seed = opts.seed != null ? opts.seed : hashSeed(entry.id, Date.now(), Math.random());

  let radius;
  if (entry.kind === 'bh' || entry.kind === 'ns' || entry.kind === 'wd') {
    radius = compactRadius(entry.kind, mass);
  } else if (entry.radius != null && Math.abs(massScale - 1) < 1e-9) {
    // Only trust the measured radius at the measured mass.
    radius = entry.radius;
  } else {
    radius = undefined;
  }

  const body = new Body({
    name: opts.name || entry.name,
    kind: entry.kind,
    evolved: !!entry.evolved,
    catalogId: entry.id,
    mass,
    radius,
    composition: entry.composition,
    crust: entry.crust,
    temperature: entry.temperature != null ? entry.temperature : 255,
    spin: spinFrom(entry.period),
    seed,
    x: opts.x || 0, y: opts.y || 0,
    vx: opts.vx || 0, vy: opts.vy || 0,
  });
  // Anything hot enough to have melted has already sorted itself by density.
  if (entry.kind === 'star' || (entry.temperature || 0) > 1200) body.differentiation = 1;
  else if (entry.kind === 'planet' || entry.kind === 'gasgiant') body.differentiation = 0.85;
  else if (entry.kind === 'moon') body.differentiation = 0.5;
  else body.differentiation = 0.15;
  body.refresh();
  return body;
}

/** A cheap stand-in body used only to draw the picker thumbnails. */
const thumbCache = new Map();
export function thumbnailBody(entry) {
  let b = thumbCache.get(entry.id);
  if (!b) {
    b = instantiate(entry, { seed: hashSeed(entry.id, 'thumb') });
    thumbCache.set(entry.id, b);
  }
  return b;
}
