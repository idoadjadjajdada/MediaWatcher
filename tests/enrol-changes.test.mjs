/**
 * Enrolment codes, and what changed since a device last looked.
 *
 * The enrolment rules are the security-relevant ones: a code is good once and
 * for five minutes, and every way of failing answers identically — a caller
 * who can tell "expired" from "never existed" learns whether a code ever
 * existed, which is the only interesting thing to learn from outside.
 *
 * Run: node tests/enrol-changes.test.mjs
 */
import * as enrolment from '../services/enrolment.js';
import { snapshot, diff } from '../services/changes.js';

let total = 0;
let failures = 0;
const check = (name, condition) => {
  total += 1;
  console.log(`  ${condition ? '[pass]' : '[FAIL]'} ${name}`);
  if (!condition) failures += 1;
};

console.log('\nenrolment codes');

enrolment.clear();

{
  const { code, expiresAt } = enrolment.create();
  check('mints something long enough to be unguessable', code.length >= 30);
  check('says when it dies', expiresAt > Date.now());
  check('and it is outstanding', enrolment.pending() === 1);

  check('redeems once', enrolment.redeem(code) === true);
  // The property the whole design rests on: a photograph of the screen taken
  // after someone has scanned it is worth nothing.
  check('and never twice', enrolment.redeem(code) === false);
  check('and is no longer outstanding', enrolment.pending() === 0);
}

check('an invented code is refused', enrolment.redeem('not-a-real-code') === false);
check('so is nothing at all', enrolment.redeem('') === false);
check('and undefined', enrolment.redeem(undefined) === false);

{
  // Five minutes: longer than walking to the television, shorter than anything
  // that could be found later.
  const now = Date.now();
  const { code } = enrolment.create({ now });
  check('is still good just before it expires',
    enrolment.redeem(code, now + enrolment.TTL_MS - 1000) === true);

  const second = enrolment.create({ now });
  check('and dead just after', enrolment.redeem(second.code, now + enrolment.TTL_MS + 1) === false);
}

{
  // Two codes outstanding at once is legitimate — a television and a phone in
  // the same sitting — and redeeming one must not touch the other.
  enrolment.clear();
  const first = enrolment.create();
  const second = enrolment.create();
  check('two can be outstanding', enrolment.pending() === 2);
  check('redeeming one leaves the other', enrolment.redeem(first.code) === true);
  check('which still works', enrolment.redeem(second.code) === true);
}

{
  enrolment.clear();
  enrolment.create();
  enrolment.create();
  check('cancelling drops all of them', enrolment.clear() === 2);
  check('and there are none left', enrolment.pending() === 0);
}

console.log('\nwhat changed');

const library = (files) => ({
  movies: [{ title: 'Arrival', files: files.movies || [] }],
  shows: [{
    title: 'Severance',
    seasons: [{
      season_number: 1,
      episodes: (files.episodes || []).map((file, index) => ({
        episode_number: index + 1,
        files: [file]
      }))
    }]
  }]
});

const GB = 1024 ** 3;

{
  const before = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }] }));
  const after = snapshot(library({
    movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }],
    episodes: [{ file_path: 'C:/lib/sev-s01e01.mkv', size: 4 * GB }]
  }));

  const changed = diff(before, after);
  check('sees an addition', changed.added.length === 1);
  check('names it as an episode', changed.added[0].name === 'Severance S01E01');
  check('and nothing was lost', changed.removed.length === 0);
}

{
  const before = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }] }));
  const after = snapshot(library({ movies: [] }));
  const changed = diff(before, after);
  check('sees a removal', changed.removed.length === 1);
  check('and names it', changed.removed[0].name === 'Arrival');
}

{
  // The interesting case: same path, much bigger file. Reporting that as
  // nothing at all is what a snapshot of paths alone would do.
  const before = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }] }));
  const after = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 30 * GB }] }));
  const changed = diff(before, after);
  check('a much bigger file at the same path is an upgrade', changed.upgraded.length === 1);
  check('carrying what it was', changed.upgraded[0].wasBytes === 8 * GB);
  check('and it is not also an addition', changed.added.length === 0);
}

{
  // A file that grew slightly is a remux or a container rewrite, not a new
  // release, and reporting it every scan would make the banner noise.
  const before = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }] }));
  const after = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8.2 * GB }] }));
  check('a small change is not an upgrade', diff(before, after).upgraded.length === 0);
}

{
  // Replaced by a different release: a new path and the old one gone. One
  // replacement, not a loss and an unrelated gain.
  const before = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.720p.mkv', size: 4 * GB }] }));
  const after = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.2160p.mkv', size: 40 * GB }] }));
  const changed = diff(before, after);
  check('a replacement is one upgrade', changed.upgraded.length === 1);
  check('not a removal', changed.removed.length === 0);
  check('and not an addition', changed.added.length === 0);
}

{
  const same = snapshot(library({ movies: [{ file_path: 'C:/lib/arrival.mkv', size: 8 * GB }] }));
  const changed = diff(same, same);
  check('nothing changed reports nothing',
    changed.added.length + changed.removed.length + changed.upgraded.length === 0);
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
