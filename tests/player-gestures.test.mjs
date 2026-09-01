/**
 * Tap zone classification for the player's double-tap seek.
 *
 * Run: npm test
 */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ canPlayType: () => '' }),
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};

const { classifyTap, tapAction, DOUBLE_TAP_MS } = await import('../public/js/player.js');

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nclassifyTap');
check('far left is left', classifyTap(10, 1000) === 'left');
check('just inside the left third is left', classifyTap(299, 1000) === 'left');
check('exactly a third across is centre', classifyTap(300, 1000) === 'centre');
check('middle is centre', classifyTap(500, 1000) === 'centre');
check('just inside the right third is centre', classifyTap(699, 1000) === 'centre');
check('two thirds across is right', classifyTap(700, 1000) === 'right');
check('far right is right', classifyTap(990, 1000) === 'right');
check('a zero-width surface never throws', classifyTap(0, 0) === 'centre');
check('a negative width never throws', classifyTap(5, -10) === 'centre');

console.log('\nDOUBLE_TAP_MS');
check('double tap window is 300ms', DOUBLE_TAP_MS === 300);

console.log('\ntapAction');
const tap = (over) => tapAction({ chromeHidden: true, zone: 'centre', isDouble: false, ...over });

// A double tap at the edges seeks, and must win over everything else.
check('double tap left seeks', tap({ zone: 'left', isDouble: true }) === 'seek');
check('double tap right seeks', tap({ zone: 'right', isDouble: true }) === 'seek');
check('double tap in the centre does not seek',
  tap({ zone: 'centre', isDouble: true }) !== 'seek');
check('a double tap seeks even when the chrome is up',
  tap({ zone: 'left', isDouble: true, chromeHidden: false }) === 'seek');

/*
 * The point of the change: the tap that reveals the controls must not also act
 * on playback. Tapping a video you cannot see the controls of should show them
 * and nothing else.
 */
check('the first tap only reveals the chrome', tap({ chromeHidden: true }) === 'reveal');
check('revealing happens at the edges too',
  tap({ chromeHidden: true, zone: 'left' }) === 'reveal');
check('a second tap toggles playback', tap({ chromeHidden: false }) === 'toggle');
check('a second tap at the edge also toggles',
  tap({ chromeHidden: false, zone: 'right' }) === 'toggle');

console.log('');
if (failures === 0) { console.log(`${total} checks, all passed\n`); process.exit(0); }
console.log(`${total} checks, ${failures} FAILED\n`); process.exit(1);
