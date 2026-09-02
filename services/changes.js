/**
 * What has changed in the library since this device last looked.
 *
 * The library page shows what is there, which is the wrong question after the
 * first week: what you want to know on opening the app is what is *new*, and
 * "sorted by date added" only answers half of it. Something that was replaced
 * by a better release, or that quietly disappeared when a drive was
 * reorganised, is invisible in a list of what exists.
 *
 * So each device keeps a snapshot of what it last saw, and the difference is
 * computed against it. Per device rather than per install, because "since you
 * last looked" is a fact about a person at a screen — the television catching
 * up after a fortnight and the phone that was used an hour ago have different
 * answers, and one shared marker would give them both the phone's.
 */
import { readState, writeState } from '../db/index.js';
import { createLogger } from '../config/index.js';

const log = createLogger('changes');

/** Where one device's snapshot lives. */
const stateKey = (deviceId) => `changes.${deviceId || 'shared'}`;

/**
 * How many changed items are worth naming.
 *
 * A first scan of a whole library is thousands of additions, and a list of
 * thousands is not something anyone reads. The count is always exact; the
 * naming stops here.
 */
export const MAX_LISTED = 40;

/* --------------------------------------------------------------------------
 * Snapshots
 * ----------------------------------------------------------------------- */

/**
 * Every file in the library, as path to size.
 *
 * Size is in there because it is what distinguishes an upgrade from nothing
 * happening: a title replaced in place by a bigger release keeps its path, and
 * a snapshot of paths alone would call that no change at all.
 */
export function snapshot(library) {
  const files = {};

  const add = (list, label, extra = {}) => {
    for (const file of list || []) {
      if (!file?.file_path) continue;
      files[file.file_path] = { size: Number(file.size) || 0, label, ...extra };
    }
  };

  for (const movie of library?.movies || []) {
    add(movie.files, movie.title, { type: 'movie' });
  }
  for (const show of library?.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        add(episode.files, show.title, {
          type: 'episode',
          season: season.season_number,
          episode: episode.episode_number
        });
      }
    }
  }

  return { at: Date.now(), files };
}

/** How an episode or a film is named in a list of changes. */
function describe(entry) {
  if (entry.type === 'episode' && entry.season != null && entry.episode != null) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${entry.label} S${pad(entry.season)}E${pad(entry.episode)}`;
  }
  return entry.label;
}

/**
 * The difference between two snapshots.
 *
 * Three outcomes rather than two. A path that is gone and a path that is new
 * are the obvious pair, but the interesting third case is a title that has
 * both — the same episode at a different path, or the same path at a very
 * different size — which is a replacement, and reporting it as a loss and an
 * unrelated gain would be technically true and useless.
 */
export function diff(previous, current) {
  const before = previous?.files || {};
  const after = current?.files || {};

  const added = [];
  const removed = [];
  const upgraded = [];

  /*
   * Ten percent, because the same file re-scanned should never register and a
   * different release always will. Sizes move slightly for reasons that are
   * not a new file - a remux, a container rewrite - and a stricter threshold
   * would report those as upgrades every time.
   */
  const MEANINGFUL_GROWTH = 1.1;

  for (const [path, entry] of Object.entries(after)) {
    const was = before[path];
    if (!was) {
      added.push({ path, name: describe(entry), bytes: entry.size });
    } else if (entry.size >= was.size * MEANINGFUL_GROWTH) {
      upgraded.push({ path, name: describe(entry), bytes: entry.size, wasBytes: was.size });
    }
  }

  for (const [path, entry] of Object.entries(before)) {
    if (!after[path]) removed.push({ path, name: describe(entry), bytes: entry.size });
  }

  /*
   * A title that lost one path and gained another is one replacement, not a
   * removal plus an addition. Matched on the name rather than the path,
   * because changing the path is exactly what happened.
   */
  const addedByName = new Map(added.map((entry) => [entry.name, entry]));
  const genuinelyRemoved = [];
  for (const entry of removed) {
    const replacement = addedByName.get(entry.name);
    if (!replacement) {
      genuinelyRemoved.push(entry);
      continue;
    }
    upgraded.push({ ...replacement, wasBytes: entry.bytes });
    addedByName.delete(entry.name);
  }

  return {
    added: [...addedByName.values()],
    removed: genuinelyRemoved,
    upgraded
  };
}

/* --------------------------------------------------------------------------
 * The device's own view
 * ----------------------------------------------------------------------- */

/**
 * What this device has not seen yet.
 *
 * A device with no snapshot has never looked, and answering with the whole
 * library would be a wall of "new" on a first visit. It gets nothing, and its
 * snapshot is taken so the next visit is a real answer.
 */
export function changesFor(deviceId, library) {
  const current = snapshot(library);
  const previous = readState(stateKey(deviceId));

  if (!previous) {
    writeState(stateKey(deviceId), current);
    return { first: true, since: null, added: [], removed: [], upgraded: [], total: 0 };
  }

  const changed = diff(previous, current);
  const total = changed.added.length + changed.removed.length + changed.upgraded.length;

  return {
    first: false,
    since: previous.at,
    total,
    added: changed.added.slice(0, MAX_LISTED),
    removed: changed.removed.slice(0, MAX_LISTED),
    upgraded: changed.upgraded.slice(0, MAX_LISTED),
    counts: {
      added: changed.added.length,
      removed: changed.removed.length,
      upgraded: changed.upgraded.length
    }
  };
}

/** Mark everything as seen. Called when the list has actually been shown. */
export function markSeen(deviceId, library) {
  const current = snapshot(library);
  writeState(stateKey(deviceId), current);
  log.debug(`${deviceId || 'shared'} caught up at ${Object.keys(current.files).length} files`);
  return current.at;
}

export default { snapshot, diff, changesFor, markSeen, MAX_LISTED };
