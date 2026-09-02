/**
 * Device settings and the settings page's formatting.
 *
 * Two things worth guarding. The first is the coercion trap that picture.js
 * and subtitle-style.js both hit: a stored `null` coerces to 0 through
 * Number(), 0 is finite, and a clamp pins it to the minimum instead of falling
 * back. localStorage survives across versions and is user-writable, so every
 * field has to survive a value that was valid two releases ago.
 *
 * The second is that `autoplayNext: false` must round-trip. A boolean default
 * of `true` combined with a truthiness check reads a deliberate `false` as
 * "not set" and turns the setting back on - the exact bug that makes a
 * preference feel like it did not save.
 *
 * Run: node tests/settings.test.mjs
 */
import {
  DEFAULTS, normaliseDevicePrefs
} from '../public/js/device-prefs.js';
import { formatBytes, formatUptime, formatWhen } from '../public/js/settings.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\ndefaults');
check('autoplay is on by default', DEFAULTS.autoplayNext === true);
check('the resume prompt is on by default', DEFAULTS.resumePrompt === true);
check('skip intro is offered, not taken', DEFAULTS.introBehaviour === 'offer');
check('the seek step is 10s', DEFAULTS.seekSeconds === 10);
check('every field has a default',
  Object.values(DEFAULTS).every((value) => value !== undefined));

console.log('\nnormaliseDevicePrefs');
check('an empty object yields the defaults',
  JSON.stringify(normaliseDevicePrefs({})) === JSON.stringify(DEFAULTS));
check('no argument at all is safe',
  normaliseDevicePrefs().autoplayNext === true);
check('null is safe', normaliseDevicePrefs(null).seekSeconds === 10);

// The bug this is here to prevent: a deliberate false read as "unset".
check('autoplay false survives a round trip',
  normaliseDevicePrefs({ autoplayNext: false }).autoplayNext === false);
check('resumePrompt false survives a round trip',
  normaliseDevicePrefs({ resumePrompt: false }).resumePrompt === false);
check('a stored string "false" is honoured, not treated as truthy',
  normaliseDevicePrefs({ autoplayNext: 'false' }).autoplayNext === false);
check('a stored string "true" is honoured',
  normaliseDevicePrefs({ autoplayNext: 'true' }).autoplayNext === true);
// Anything else is not a boolean, so it takes the safe reading rather than
// whatever JS truthiness would say about it.
check('a nonsense value is not truthy-cast',
  normaliseDevicePrefs({ autoplayNext: 'yes please' }).autoplayNext === false);

console.log('\nnumeric coercion');
check('a valid value passes through', normaliseDevicePrefs({ seekSeconds: 30 }).seekSeconds === 30);
check('too large is capped', normaliseDevicePrefs({ seekSeconds: 9999 }).seekSeconds === 60);
check('too small is floored', normaliseDevicePrefs({ seekSeconds: 1 }).seekSeconds === 5);
check('null falls back rather than flooring',
  normaliseDevicePrefs({ seekSeconds: null }).seekSeconds === 10);
check('an empty string falls back',
  normaliseDevicePrefs({ seekSeconds: '' }).seekSeconds === 10);
check('nonsense falls back',
  normaliseDevicePrefs({ seekSeconds: 'ten' }).seekSeconds === 10);
check('a numeric string is accepted',
  normaliseDevicePrefs({ seekSeconds: '15' }).seekSeconds === 15);
check('a fraction is rounded',
  normaliseDevicePrefs({ nextUpLeadSeconds: 30.6 }).nextUpLeadSeconds === 31);

console.log('\nenumerated coercion');
check('a known value passes through',
  normaliseDevicePrefs({ introBehaviour: 'auto' }).introBehaviour === 'auto');
check('an unknown value falls back',
  normaliseDevicePrefs({ introBehaviour: 'sometimes' }).introBehaviour === 'offer');
check('null falls back',
  normaliseDevicePrefs({ introBehaviour: null }).introBehaviour === 'offer');

console.log('\nunknown keys');
const withJunk = normaliseDevicePrefs({ autoplayNext: false, somethingRemoved: 42 });
check('a field removed in a later version is dropped',
  !Object.prototype.hasOwnProperty.call(withJunk, 'somethingRemoved'));
check('and the fields around it still load', withJunk.autoplayNext === false);

console.log('\nformatBytes');
check('zero', formatBytes(0) === '0 B');
check('bytes stay bytes', formatBytes(512) === '512 B');
check('kilobytes', formatBytes(2400) === '2.4 KB');
check('gigabytes keep one decimal below ten', formatBytes(1_400_000_000) === '1.4 GB');
check('and drop it above ten', formatBytes(45_000_000_000) === '45 GB');
check('terabytes', formatBytes(2_000_000_000_000) === '2.0 TB');
check('negative is not rendered as a size', formatBytes(-5) === '0 B');
check('nonsense is not rendered as a size', formatBytes('lots') === '0 B');
check('null is safe', formatBytes(null) === '0 B');

console.log('\nformatUptime');
check('seconds', formatUptime(45) === '45s');
check('minutes', formatUptime(300) === '5m');
check('hours and minutes', formatUptime(7860) === '2h 11m');
check('days and hours', formatUptime(200000) === '2d 7h');
check('zero', formatUptime(0) === '0s');
check('nonsense is zero, not NaN', formatUptime('a while') === '0s');

console.log('\nformatWhen');
check('a timestamp renders', formatWhen(Date.now()).length > 0);
check('no timestamp renders a dash', formatWhen(null) === '—');
check('zero renders a dash', formatWhen(0) === '—');
check('nonsense renders a dash', formatWhen('yesterday') === '—');

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
