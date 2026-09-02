/**
 * ASS/SSA parsing.
 *
 * The format has three traps that produce plausible-looking wrong output
 * rather than an error, so each gets its own case:
 *
 *   colours are &HAABBGGRR - byte-reversed from CSS, with an INVERTED alpha,
 *   so reading one as #RRGGBB gives a confidently wrong colour;
 *
 *   dialogue text contains commas and is the last field, so a naive split
 *   truncates every line at its first comma;
 *
 *   field order is declared per-section by a Format: line and is not fixed,
 *   so reading positionally works on most files and silently mangles the rest.
 *
 * Run: node tests/ass.test.mjs
 */
import {
  parseAss, parseAssTime, parseAssColour, alignmentToAnchor, legacyAlignment,
  renderAssText, eventsAt
} from '../public/js/ass.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const SAMPLE = `[Script Info]
; a comment that must be ignored
Title: Something
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00202020,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,25,1
Style: Sign,Verdana,72,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,3,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, world, with commas
Dialogue: 0,0:00:04.00,0:00:06.00,Sign,,0,0,0,,{\\an8\\pos(960,120)}A sign
Dialogue: 1,0:00:04.50,0:00:05.00,Default,,0,0,0,,{\\i1}Overlapping{\\i0} line
Comment: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,This must not appear
`;

const doc = parseAss(SAMPLE);

console.log('\nparseAssTime');
check('a normal timestamp', parseAssTime('0:00:01.50') === 1.5);
check('hours are counted', parseAssTime('1:02:03.00') === 3723);
check('centiseconds, not milliseconds', parseAssTime('0:00:00.05') === 0.05);
check('a single fractional digit is padded, not read as centis',
  parseAssTime('0:00:00.5') === 0.5);
check('a colon before the fraction is accepted', parseAssTime('0:00:01:50') === 1.5);
check('nonsense is rejected rather than becoming 0', parseAssTime('later') === null);
check('an empty value is rejected', parseAssTime('') === null);

console.log('\nparseAssColour');
// &H00FFFFFF: alpha 00 (opaque), blue FF, green FF, red FF.
check('opaque white', parseAssColour('&H00FFFFFF') === 'rgba(255, 255, 255, 1.000)');
// The trap: read as #RRGGBB this would be blue, not red.
check('bytes are reversed, so &H000000FF is red',
  parseAssColour('&H000000FF') === 'rgba(255, 0, 0, 1.000)');
check('and &H00FF0000 is blue', parseAssColour('&H00FF0000') === 'rgba(0, 0, 255, 1.000)');
check('alpha is inverted: FF means transparent',
  parseAssColour('&HFF000000') === 'rgba(0, 0, 0, 0.000)');
check('a short form is opaque, not transparent',
  parseAssColour('&HFFFFFF') === 'rgba(255, 255, 255, 1.000)');
check('a trailing ampersand is tolerated', parseAssColour('&H00FFFF&') !== null);
check('garbage is rejected', parseAssColour('&Hzzz') === null);

console.log('\nscript info');
check('the play resolution is read', doc.playResX === 1920 && doc.playResY === 1080);
check('comments do not become styles or events', doc.styles.size === 2);

console.log('\nstyles');
const def = doc.styles.get('Default');
const sign = doc.styles.get('Sign');
check('a style is found by name', Boolean(def) && Boolean(sign));
check('the font is read', def.font === 'Arial' && sign.font === 'Verdana');
check('the size is a number', def.size === 48 && sign.size === 72);
check('the primary colour is converted', def.primary === 'rgba(255, 255, 255, 1.000)');
check('the outline colour is converted', def.outlineColour === 'rgba(32, 32, 32, 1.000)');
// -1 is true in ASS, not "minus one".
check('-1 means bold', sign.bold === true);
check('0 means not bold', def.bold === false);
check('-1 means italic', sign.italic === true);
check('the alignment is read', def.alignment === 2 && sign.alignment === 8);
check('margins are read', def.marginV === 25);
check('outline width is read', def.outline === 2 && sign.outline === 3);

console.log('\nevents');
check('comment lines are excluded', doc.events.length === 3);
// The trap: a naive split on commas truncates this at "Hello".
check('commas inside dialogue survive',
  doc.events[0].text === 'Hello, world, with commas');
check('times are parsed', doc.events[0].start === 1 && doc.events[0].end === 3.5);
check('the style name is kept', doc.events[1].style === 'Sign');
check('the layer is read', doc.events[2].layer === 1);
check('events are in time order',
  doc.events.every((e, i, all) => i === 0 || all[i - 1].start <= e.start));
check('a zero-length event is dropped',
  parseAss(`[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:01.00,D,x`).events.length === 0);

console.log('\nfield order is not assumed');
// Text before Effect - legal, and fatal to a positional reader.
const reordered = parseAss(`[Events]
Format: Layer, Start, End, Text, Style
Dialogue: 0,0:00:01.00,0:00:02.00,the text goes here,Default
`);
check('a reordered Format line is honoured',
  reordered.events[0].text === 'the text goes here' && reordered.events[0].style === 'Default');

console.log('\nalignmentToAnchor');
check('2 is bottom centre',
  alignmentToAnchor(2).vertical === 'bottom' && alignmentToAnchor(2).horizontal === 'center');
check('8 is top centre',
  alignmentToAnchor(8).vertical === 'top' && alignmentToAnchor(8).horizontal === 'center');
check('1 is bottom left', alignmentToAnchor(1).horizontal === 'left');
check('9 is top right',
  alignmentToAnchor(9).vertical === 'top' && alignmentToAnchor(9).horizontal === 'right');
check('5 is middle centre',
  alignmentToAnchor(5).vertical === 'middle' && alignmentToAnchor(5).horizontal === 'center');
check('an invalid alignment falls back to bottom centre',
  alignmentToAnchor(99).vertical === 'bottom' && alignmentToAnchor(null).horizontal === 'center');

console.log('\nlegacy \\a alignment');
// SSA packs the vertical into bits; 5 is top-left there, not middle-centre.
check('\\a5 is top left, not middle centre', legacyAlignment(5) === 7);
check('\\a1 stays bottom left', legacyAlignment(1) === 1);
check('\\a2 stays bottom centre', legacyAlignment(2) === 2);
check('\\a9 is middle left', legacyAlignment(9) === 4);
check('nonsense falls back', legacyAlignment('x') === 2);

console.log('\nrenderAssText');
const plain = renderAssText('Hello, world', def);
check('plain text survives', plain.html.includes('Hello, world'));
check('no alignment override is reported', plain.alignment === null);
check('no position override is reported', plain.position === null);

const italic = renderAssText('{\\i1}yes{\\i0}no', def);
check('italic opens', italic.html.includes('font-style:italic'));
check('and closes: the text after \\i0 is in a new span',
  italic.html.lastIndexOf('font-style:italic') < italic.html.lastIndexOf('no'));

const coloured = renderAssText('{\\c&H0000FF&}red', def);
check('an inline colour is converted from ASS byte order',
  coloured.html.includes('rgba(255, 0, 0'));

check('\\an is reported as an alignment override',
  renderAssText('{\\an8}top', def).alignment === 8);
check('\\a is translated from the legacy scheme',
  renderAssText('{\\a5}top left', def).alignment === 7);
const positioned = renderAssText('{\\pos(960,120)}x', def);
check('\\pos is reported', positioned.position.x === 960 && positioned.position.y === 120);
check('several tags in one block all apply',
  renderAssText('{\\an8\\i1\\fs72}x', def).alignment === 8
  && renderAssText('{\\an8\\i1\\fs72}x', def).html.includes('font-size:72px'));

check('\\N is a line break', renderAssText('a\\Nb', def).html.includes('<br>'));
check('\\h is a hard space', renderAssText('a\\hb', def).html.includes('&nbsp;'));

// The overlay writes this into innerHTML, so tags in the dialogue are text.
check('HTML in dialogue is escaped',
  renderAssText('<img src=x onerror=alert(1)>', def).html.includes('&lt;img'));
check('a quote in dialogue cannot break out of the style attribute',
  !renderAssText('{\\fnArial"><script>}x', def).html.includes('"><script>'));
check('an unclosed brace is treated as text, not swallowed',
  renderAssText('a {b', def).html.includes('{b'));
check('an unknown tag is dropped without losing the text',
  renderAssText('{\\t(0,500,\\fscx120)}kept', def).html.includes('kept'));
check('karaoke timing is dropped without losing the text',
  renderAssText('{\\k50}sung', def).html.includes('sung'));
check('a style with no overrides still carries its own bold',
  renderAssText('x', sign).html.includes('font-weight:700'));
check('\\r resets to the line style',
  !renderAssText('{\\i1}a{\\r}b', def).html.split('</span>').pop().includes('italic'));

console.log('\neventsAt');
check('a time inside an event finds it', eventsAt(doc.events, 2).length === 1);
check('overlapping events both play', eventsAt(doc.events, 4.75).length === 2);
check('the end is exclusive', eventsAt(doc.events, 3.5).length === 0);
check('the start is inclusive', eventsAt(doc.events, 1).length === 1);
check('a gap yields nothing', eventsAt(doc.events, 8).length === 0);
check('a non-array is handled', eventsAt(null, 1).length === 0);

console.log('\nrobustness');
check('an empty file parses to nothing', parseAss('').events.length === 0);
check('a non-string parses to nothing', parseAss(null).events.length === 0);
check('a file with no styles section still yields events',
  parseAss(`[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01.00,0:00:02.00,D,hi`).events.length === 1);
check('a default play resolution exists when none is declared',
  parseAss('[Events]').playResX > 0);

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
