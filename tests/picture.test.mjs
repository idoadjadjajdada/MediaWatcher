/**
 * Picture controls — clamping, filter string, persistence.
 *
 * Run: node tests/picture.test.mjs
 */
import {
  clampPicture, pictureFilter, loadPicture, savePicture,
  PICTURE_MIN, PICTURE_MAX, PICTURE_DEFAULT
} from '../public/js/picture.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nclampPicture');
check('keeps a value in range', clampPicture(75) === 75);
check('clamps below the minimum', clampPicture(5) === PICTURE_MIN);
check('clamps above the maximum', clampPicture(400) === PICTURE_MAX);
check('accepts the exact minimum', clampPicture(20) === 20);
check('accepts the exact maximum', clampPicture(150) === 150);
check('rounds a fractional value', clampPicture(99.6) === 100);
check('falls back to the default on NaN', clampPicture(NaN) === PICTURE_DEFAULT);
check('falls back to the default on a string', clampPicture('bright') === PICTURE_DEFAULT);
check('falls back to the default on null', clampPicture(null) === PICTURE_DEFAULT);
check('falls back to the default on undefined', clampPicture(undefined) === PICTURE_DEFAULT);
check('falls back to the default on Infinity', clampPicture(Infinity) === PICTURE_DEFAULT);

console.log('\npictureFilter');
check('100/100 is the identity filter',
  pictureFilter({ brightness: 100, contrast: 100 }) === 'brightness(1) contrast(1)');
check('dims correctly',
  pictureFilter({ brightness: 50, contrast: 100 }) === 'brightness(0.5) contrast(1)');
check('boosts correctly',
  pictureFilter({ brightness: 150, contrast: 150 }) === 'brightness(1.5) contrast(1.5)');
check('clamps inside the filter string',
  pictureFilter({ brightness: 9000, contrast: 0 }) === 'brightness(1.5) contrast(0.2)');
check('garbage in gives the identity filter',
  pictureFilter({ brightness: 'x', contrast: undefined }) === 'brightness(1) contrast(1)');

console.log('\nloadPicture / savePicture');

// No localStorage in node at all — this is the private-browsing path.
check('loads defaults with no storage available',
  loadPicture().brightness === PICTURE_DEFAULT && loadPicture().contrast === PICTURE_DEFAULT);
check('saving without storage does not throw', (() => {
  try { savePicture({ brightness: 60, contrast: 60 }); return true; } catch { return false; }
})());

// A minimal stand-in for the browser API.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

check('defaults when nothing is stored', loadPicture().brightness === PICTURE_DEFAULT);
savePicture({ brightness: 60, contrast: 140 });
check('a saved value reads back', loadPicture().brightness === 60 && loadPicture().contrast === 140);
savePicture({ brightness: 9000, contrast: -5 });
check('out-of-range values are clamped on the way in',
  loadPicture().brightness === PICTURE_MAX && loadPicture().contrast === PICTURE_MIN);

store.set('mw.picture', 'not json{');
check('corrupt stored JSON falls back to defaults',
  loadPicture().brightness === PICTURE_DEFAULT && loadPicture().contrast === PICTURE_DEFAULT);

store.set('mw.picture', '{"brightness":70}');
check('a missing field falls back to the default for that field',
  loadPicture().brightness === 70 && loadPicture().contrast === PICTURE_DEFAULT);

globalThis.localStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); }
};
check('storage that throws on read falls back to defaults',
  loadPicture().brightness === PICTURE_DEFAULT);
check('storage that throws on write does not propagate', (() => {
  try { savePicture({ brightness: 60, contrast: 60 }); return true; } catch { return false; }
})());

console.log('');
if (failures === 0) {
  console.log(`${total} checks, all passed\n`);
  process.exit(0);
} else {
  console.log(`${total} checks, ${failures} FAILED\n`);
  process.exit(1);
}
