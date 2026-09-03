/**
 * Pitch following the speed.
 *
 * `preservesPitch` defaults to true everywhere, which is why 1.5x sounds like
 * the same voices talking faster rather than like a tape being wound on.
 * Turning it off gives the tape behaviour: slower is deeper, faster is higher.
 *
 * Two things are worth pinning. The preference has to survive a reload and
 * default to what browsers already do, or the setting is a surprise; and the
 * flag has to be written under every spelling, because the prefixed ones are
 * still the only ones some browsers understand and setting the wrong one means
 * the toggle silently does nothing.
 *
 * Run: node tests/pitch.test.mjs
 */
import { FIELDS, DEFAULTS, normaliseDevicePrefs } from '../public/js/device-prefs.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nthe preference');

check('exists', 'pitchFollowsSpeed' in FIELDS);
// Off by default: every browser preserves pitch on its own, and a media player
// that pitch-shifted at 1.5x without being asked would read as a bug.
check('is off by default', DEFAULTS.pitchFollowsSpeed === false);

check('reads back on', normaliseDevicePrefs({ pitchFollowsSpeed: true }).pitchFollowsSpeed === true);
check('reads back off', normaliseDevicePrefs({ pitchFollowsSpeed: false }).pitchFollowsSpeed === false);
// localStorage holds strings, and a value written by an older version has to
// become something usable rather than reaching the player as-is.
check('accepts the string it was stored as',
  normaliseDevicePrefs({ pitchFollowsSpeed: 'true' }).pitchFollowsSpeed === true);
check('anything else is off',
  normaliseDevicePrefs({ pitchFollowsSpeed: 'yes please' }).pitchFollowsSpeed === false);
check('and so is an absent value', normaliseDevicePrefs({}).pitchFollowsSpeed === false);
check('it does not disturb the other settings',
  normaliseDevicePrefs({ pitchFollowsSpeed: true }).seekSeconds === DEFAULTS.seekSeconds);

console.log('\nwhat gets written to the element');

/*
 * The three spellings are load-bearing rather than decoration: Safari knows
 * only `webkitPreservesPitch` before 17 and Firefox only `mozPreservesPitch`
 * before 116. The player writes whichever the element actually has.
 */
const SPELLINGS = ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch'];

/** The same loop the player runs, against a stand-in for a video element. */
function applyTo(element, pitchFollowsSpeed) {
  const preserve = !pitchFollowsSpeed;
  for (const key of SPELLINGS) {
    if (key in element) element[key] = preserve;
  }
  return element;
}

{
  // A modern browser: the unprefixed property only.
  const modern = applyTo({ preservesPitch: true }, true);
  check('following the speed means not preserving the pitch', modern.preservesPitch === false);
  check('and the reverse', applyTo({ preservesPitch: false }, false).preservesPitch === true);
}

{
  // Older Safari and older Firefox, each with only their own spelling.
  const safari = applyTo({ webkitPreservesPitch: true }, true);
  check('writes the webkit spelling', safari.webkitPreservesPitch === false);

  const firefox = applyTo({ mozPreservesPitch: true }, true);
  check('writes the moz spelling', firefox.mozPreservesPitch === false);
}

{
  // A browser carrying more than one: all of them are set, because which one
  // is honoured is not knowable from here.
  const both = applyTo({ preservesPitch: true, webkitPreservesPitch: true }, true);
  check('writes every spelling the element has',
    both.preservesPitch === false && both.webkitPreservesPitch === false);
}

{
  // A property a browser does not have must not be invented: `in` is what
  // stops the player creating a field nothing reads.
  const bare = applyTo({}, true);
  check('invents nothing on an element with none of them',
    Object.keys(bare).length === 0);
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
