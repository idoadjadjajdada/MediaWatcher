/**
 * How each search source has actually been behaving.
 *
 * One search reports which sources answered and how long each took, and then
 * throws it away. So `SEARCH_SOURCE_TIMEOUT_MS` is a guess nobody can check: a
 * source that times out on half of all searches, or answers in four seconds
 * when the ceiling is twenty, or reliably returns nothing at all, looks from
 * the outside exactly like a source that is working.
 *
 * A rolling window per source, kept in app_state so it survives a restart.
 * Deliberately bounded and deliberately small — this is a diagnostic, not a
 * metrics system, and the useful question is "lately", not "ever".
 */
import { readState, writeState } from '../db/index.js';
import { createLogger } from '../config/index.js';

const log = createLogger('search-stats');

const STATE_KEY = 'search.sources';

/** Runs kept per source. A hundred searches is weeks of ordinary use. */
export const WINDOW = 100;

/* --------------------------------------------------------------------------
 * Recording
 * ----------------------------------------------------------------------- */

/**
 * Fold one search's outcomes into the window.
 *
 * `settled` is what search() already builds for its response, so recording
 * costs nothing beyond the write: no source has to be asked anything extra.
 */
export function record(settled, now = Date.now()) {
  if (!Array.isArray(settled) || settled.length === 0) return;

  const stored = readState(STATE_KEY) || {};
  for (const entry of settled) {
    if (!entry?.id) continue;
    const runs = stored[entry.id]?.runs || [];
    runs.push({
      at: now,
      ok: Boolean(entry.ok),
      ms: Number(entry.ms) || 0,
      count: Number(entry.count) || 0,
      // Only the reason, not the whole error: the window is a shape, and one
      // long stack trace per run would make it the largest row in the table.
      error: entry.ok ? null : String(entry.error || '').slice(0, 120)
    });
    stored[entry.id] = {
      label: entry.label || entry.id,
      runs: runs.slice(-WINDOW)
    };
  }

  try {
    writeState(STATE_KEY, stored);
  } catch (error) {
    // A diagnostic must never be able to fail a search.
    log.debug(`could not record source timings: ${error.message}`);
  }
}

/* --------------------------------------------------------------------------
 * Reading
 * ----------------------------------------------------------------------- */

/**
 * The value below which `fraction` of the runs fall.
 *
 * A median and a p95 rather than a mean: response times have a long tail, and
 * a mean over one twenty-second timeout and nine fast answers describes
 * neither. The p95 is the one to set a timeout from.
 */
export function percentile(values, fraction) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** One source's window, as the numbers worth acting on. */
export function summarise(entry) {
  const runs = entry?.runs || [];
  if (runs.length === 0) return null;

  const ok = runs.filter((run) => run.ok);
  const timings = ok.map((run) => run.ms);
  const failures = runs.filter((run) => !run.ok);

  return {
    label: entry.label,
    searches: runs.length,
    // Two different failures worth separating: a source that answers slowly
    // and gets cut off is a timeout to raise, a source that errors is broken.
    failed: failures.length,
    timedOut: failures.filter((run) => /timed out/i.test(run.error || '')).length,
    // A source that answers, quickly, with nothing is the quiet failure: it
    // never appears in an error and never contributes a result either.
    empty: ok.filter((run) => run.count === 0).length,
    medianMs: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    slowestMs: timings.length > 0 ? Math.max(...timings) : null,
    resultsPerSearch: ok.length === 0
      ? 0
      : Number((ok.reduce((sum, run) => sum + run.count, 0) / ok.length).toFixed(1)),
    lastError: failures.length > 0 ? failures[failures.length - 1].error : null,
    lastAt: runs[runs.length - 1].at
  };
}

/** Every source with history, worst first — the one to look at is at the top. */
export function summary() {
  const stored = readState(STATE_KEY) || {};
  return Object.entries(stored)
    .map(([id, entry]) => ({ id, ...summarise(entry) }))
    .filter((entry) => entry.searches > 0)
    .sort((a, b) => (b.failed / b.searches) - (a.failed / a.searches));
}

/** Forget the history. Exposed so a source that has been fixed can start clean. */
export function reset() {
  writeState(STATE_KEY, {});
}

export default { record, summary, summarise, percentile, reset, WINDOW };
