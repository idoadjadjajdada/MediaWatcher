/**
 * Subtitle appearance.
 *
 * The failure this guards against is the one picture.js already hit once: a
 * stored null coerces to 0 through Number(), 0 is finite, and the clamp then
 * pins it to the minimum instead of falling back to the default. A viewer
 * whose storage holds a null would open the player with 50% subtitles and no
 * way to tell why.
 *
 * The other is silent: `::cue` cannot move a subtitle, so a position control
 * that only writes CSS would look implemented and do nothing. Position has to
 * come out as a WebVTT line value.
 *
 * Run: node tests/subtitle-style.test.mjs
 */
import {
  clampSize, clampOpacity, clampPosition, clampColour, normaliseStyle,
  cueCss, positionToLine, applyCuePosition,
  COLOURS, SIZE_DEFAULT, SIZE_MIN, SIZE_MAX,
  OPACITY_DEFAULT, POSITION_DEFAULT, POSITION_MAX
} from '../public/js/subtitle-style.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nclamping');
check('a normal size passes through', clampSize(150) === 150);
check('too large is capped', clampSize(9000) === SIZE_MAX);
check('too small is floored', clampSize(1) === SIZE_MIN);
check('a fraction is rounded', clampSize(120.4) === 120);
// The trap picture.js fell into.
check('null falls back rather than flooring', clampSize(null) === SIZE_DEFAULT);
check('undefined falls back', clampSize(undefined) === SIZE_DEFAULT);
check('empty string falls back', clampSize('') === SIZE_DEFAULT);
check('nonsense falls back', clampSize('big') === SIZE_DEFAULT);
check('a numeric string is accepted', clampSize('130') === 130);
check('zero opacity is a real value, not a fallback', clampOpacity(0) === 0);
check('null opacity falls back', clampOpacity(null) === OPACITY_DEFAULT);
check('zero position is a real value', clampPosition(0) === 0);
check('null position falls back', clampPosition(null) === POSITION_DEFAULT);
check('position is capped', clampPosition(999) === POSITION_MAX);

console.log('\ncolour');
check('a known colour passes through', clampColour('yellow') === 'yellow');
check('an unknown colour falls back', clampColour('hotpink') === 'white');
// Anything reaching CSS has to come from the table, never from storage.
check('an injection attempt falls back', clampColour('red; } body { display:none') === 'white');
check('a prototype key is not a colour', clampColour('constructor') === 'white');
check('null falls back', clampColour(null) === 'white');

console.log('\nnormaliseStyle');
const clean = normaliseStyle({ size: 300, colour: 'nope', opacity: -5, position: 99 });
check('every field is clamped at once',
  clean.size === SIZE_MAX && clean.colour === 'white' && clean.opacity === 0 && clean.position === POSITION_MAX);
check('an empty object yields the defaults',
  normaliseStyle({}).size === SIZE_DEFAULT && normaliseStyle({}).opacity === OPACITY_DEFAULT);
check('no argument at all is safe', normaliseStyle().colour === 'white');

console.log('\ncueCss');
const css = cueCss({ size: 140, colour: 'yellow', opacity: 80 });
check('the size reaches the rule', css.includes('font-size: 140%'));
check('the colour is resolved to a hex value', css.includes(COLOURS.yellow));
check('opacity becomes a background alpha', css.includes('rgba(0, 0, 0, 0.80)'));
check('a solid background drops the shadow', css.includes('text-shadow: none'));
// With no box behind it, white text over a white shot needs the outline.
check('a transparent background keeps a shadow',
  cueCss({ opacity: 0 }).includes('rgba(0,0,0,.95)'));
check('the selector is applied', css.startsWith('.player__video::cue'));
check('an override selector is honoured',
  cueCss({}, '.x').startsWith('.x::cue'));
check('a bad stored colour cannot reach the rule',
  !cueCss({ colour: 'red; }' }).includes('red;'));

console.log('\npositionToLine');
// line is measured from the top, so lifting subtitles lowers the number.
check('the default sits near the bottom', positionToLine(POSITION_DEFAULT) === 87);
check('no lift is lower on screen than a lift',
  positionToLine(0) > positionToLine(20));
check('the maximum lift is still on screen', positionToLine(POSITION_MAX) > 0);
check('an unusable position falls back to the default line',
  positionToLine(null) === positionToLine(POSITION_DEFAULT));

console.log('\napplyCuePosition');
const cue = () => ({ snapToLines: true, line: 'auto' });
const track = { cues: [cue(), cue(), cue()] };
check('every cue is repositioned', applyCuePosition(track, { position: 10 }) === 3);
check('cues stop snapping to lines', track.cues.every((c) => c.snapToLines === false));
check('the line is the computed one', track.cues.every((c) => c.line === positionToLine(10)));
check('a track with no cues is handled', applyCuePosition({ cues: null }, {}) === 0);
check('no track at all is handled', applyCuePosition(null, {}) === 0);

// A cue that refuses assignment must not take the rest of the track with it.
const hostile = { cues: [cue(), Object.freeze({ snapToLines: true, line: 'auto' }), cue()] };
let survived = 0;
try {
  survived = applyCuePosition(hostile, { position: 10 });
} catch {
  survived = -1;
}
check('one unassignable cue does not abort the pass', survived === 2);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
