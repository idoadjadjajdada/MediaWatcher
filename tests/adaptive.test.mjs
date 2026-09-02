/**
 * Dropping quality when the connection cannot keep up.
 *
 * The failure this is designed against is not "fails to adapt" — it is
 * adapting too eagerly. Every level change restarts the stream, which means a
 * visible pause. A rule that fires on one stall turns a single hiccup into a
 * stutter of its own, and an eager recovery produces a loop: step up, stall,
 * step down, step up again.
 *
 * So most of what follows asserts that nothing happens. One stall, a stall
 * just after a change, a stall at the bottom rung, a viewer who picked a level
 * by hand — all of them are no-ops, and each has its own case because each is
 * a different reason.
 *
 * Run: node tests/adaptive.test.mjs
 */
import {
  LADDER, STALL_WINDOW_MS, RECOVERY_MS,
  newAdaptiveState, stepDown, stepUp, recordStall, decide, applyDecision, pin
} from '../public/js/adaptive.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

const T0 = 1_000_000;

console.log('\nthe ladder');
check('it runs worst to best', LADDER[0] === 'low' && LADDER[LADDER.length - 1] === 'original');
check('down from high is medium', stepDown('high') === 'medium');
check('up from medium is high', stepUp('medium') === 'high');
check('there is nothing below low', stepDown('low') === null);
check('there is nothing above original', stepUp('original') === null);
check('an unknown level has no neighbours', stepDown('auto') === null && stepUp('auto') === null);

console.log('\nstarting state');
const fresh = newAdaptiveState('high');
check('it starts where it was told', fresh.current === 'high');
check('and remembers that as the ceiling', fresh.ceiling === 'high');
check('nothing is pinned yet', fresh.pinned === false);
// 'auto' is a request to the server, not a rung, so there is nothing to adapt.
check('auto is not a rung', newAdaptiveState('auto').current === null);
check('and so nothing happens', decide(newAdaptiveState('auto'), { now: T0 }) === null);

console.log('\none stall is not a pattern');
let state = newAdaptiveState('high');
recordStall(state, T0);
check('a single stall changes nothing', decide(state, { now: T0 + 1000 }) === null);

console.log('\ntwo stalls close together are');
recordStall(state, T0 + 2000);
const drop = decide(state, { now: T0 + 3000 });
check('a second stall drops a rung', drop?.level === 'medium', drop);
check('and says which way it went', drop?.direction === 'down');
check('and why', /keeping up/.test(drop?.reason || ''));

console.log('\nstalls fall out of the window');
let spread = newAdaptiveState('high');
recordStall(spread, T0);
recordStall(spread, T0 + STALL_WINDOW_MS + 5000);
// Two stalls a minute apart is a stream that is basically fine.
check('two stalls far apart are not a pattern',
  decide(spread, { now: T0 + STALL_WINDOW_MS + 6000 }) === null);
check('and the old one is forgotten', spread.stalls.length === 1);

console.log('\nnot immediately after a change');
let justChanged = newAdaptiveState('high');
applyDecision(justChanged, { level: 'medium', direction: 'down' }, T0);
recordStall(justChanged, T0 + 1000);
recordStall(justChanged, T0 + 2000);
// Restarting the stream causes a stall of its own; reacting to it would drop
// another rung for a problem the switch itself created.
check('stalls right after a switch do not trigger another',
  decide(justChanged, { now: T0 + 3000 }) === null);
check('the switch cleared the previous stalls', justChanged.stalls.length === 2);

console.log('\nthe bottom of the ladder');
let bottom = newAdaptiveState('low');
recordStall(bottom, T0);
recordStall(bottom, T0 + 1000);
// Stalling at the lowest level is not a bitrate problem any more.
check('there is nothing below low to drop to', decide(bottom, { now: T0 + 2000 }) === null);

console.log('\nclimbing back');
let recovered = newAdaptiveState('original');
applyDecision(recovered, { level: 'high', direction: 'down' }, T0);
check('too soon to climb', decide(recovered, { now: T0 + 30_000 }) === null);
check('still too soon', decide(recovered, { now: T0 + RECOVERY_MS - 1000 }) === null);

const up = decide(recovered, { now: T0 + RECOVERY_MS + 1000 });
check('a long clean stretch climbs a rung', up?.level === 'original', up);
check('and says which way', up?.direction === 'up');
check('and why', /settled/.test(up?.reason || ''));

// Buffering right now is not a settled connection, however long it has been.
check('it does not climb while buffering',
  decide(recovered, { now: T0 + RECOVERY_MS + 1000, buffering: true }) === null);

let stalled = newAdaptiveState('original');
applyDecision(stalled, { level: 'high', direction: 'down' }, T0);
recordStall(stalled, T0 + RECOVERY_MS);
check('a recent stall stops it climbing',
  decide(stalled, { now: T0 + RECOVERY_MS + 1000 }) === null);

console.log('\nit never climbs above where it started');
let capped = newAdaptiveState('medium');
applyDecision(capped, { level: 'low', direction: 'down' }, T0);
const backToStart = decide(capped, { now: T0 + RECOVERY_MS + 1000 });
check('it returns to the starting level', backToStart?.level === 'medium');

applyDecision(capped, backToStart, T0 + RECOVERY_MS + 1000);
check('and then stops, rather than climbing past it',
  decide(capped, { now: T0 + RECOVERY_MS * 3 }) === null);

console.log('\na level chosen by hand is left alone');
let chosen = newAdaptiveState('original');
pin(chosen, 'low');
recordStall(chosen, T0);
recordStall(chosen, T0 + 1000);
// An explicit choice is not a suggestion to be overridden.
check('pinning stops it adapting down', decide(chosen, { now: T0 + 2000 }) === null);
check('the pinned level is what is current', chosen.current === 'low');
check('and becomes the new ceiling', chosen.ceiling === 'low');

let pinnedHigh = newAdaptiveState('low');
pin(pinnedHigh, 'original');
check('pinning upward is honoured too', pinnedHigh.current === 'original');
check('and still does not adapt', decide(pinnedHigh, { now: T0 + RECOVERY_MS * 2 }) === null);

console.log('\nrobustness');
check('no state decides nothing', decide(null, { now: T0 }) === null);
check('recording against no state is safe', recordStall(null, T0) === null);
check('applying nothing is safe', applyDecision(fresh, null) === fresh);
check('pinning no state is safe', pin(null, 'low') === null);
check('pinning an unknown level does not corrupt the state',
  pin(newAdaptiveState('high'), 'nonsense').current === 'high');

console.log(`\n${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
