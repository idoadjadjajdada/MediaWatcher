/**
 * Apparent size.
 *
 * At a scale that fits Jupiter's orbit on screen the Sun is a third of a pixel
 * across and the Earth is a thousandth of one. Drawn honestly, a solar system
 * is an empty screen — so bodies get a floor on their apparent radius, blended
 * in by a single setting.
 *
 * This affects only what is drawn and what you can click. Gravity, collisions
 * and every number in the inspector use the real radius; nothing in `core/`
 * imports this file.
 */

const FLOOR_PX = {
  star: 6.0,
  gasgiant: 4.0,
  planet: 3.2,
  moon: 2.4,
  asteroid: 1.8,
  comet: 1.8,
  debris: 0.9,
  bh: 3.0,
  ns: 2.6,
  wd: 2.6,
};

/** Apparent radius in buffer pixels, honouring the size-boost setting. */
export function displayRadiusPx(body, camera, settings) {
  const trueR = body.radius * camera.scale;
  const boost = settings && settings.bodyScale != null ? settings.bodyScale : 0;
  if (boost <= 0) return trueR;
  const floor = FLOOR_PX[body.kind] != null ? FLOOR_PX[body.kind] : 2.5;
  // Lerp from the honest radius to a floored one, so turning the setting down
  // walks smoothly back to true scale rather than snapping.
  return trueR + (Math.max(trueR, floor) - trueR) * boost;
}

/** The same, in metres — for anything that works in world space. */
export function displayRadius(body, camera, settings) {
  return displayRadiusPx(body, camera, settings) / camera.scale;
}

/** True when a body is being drawn larger than it really is. */
export function isExaggerated(body, camera, settings) {
  return displayRadiusPx(body, camera, settings) > body.radius * camera.scale * 1.05;
}
