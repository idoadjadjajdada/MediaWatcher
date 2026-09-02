/**
 * Which episodes a season is missing.
 *
 * The scanner builds the library from files on disk and then annotates what it
 * found with TMDB titles - `if (!entry) continue`, so an episode that exists
 * on TMDB and not on disk is simply absent from the library. Gaps are
 * invisible, which is why a season can be quietly half-downloaded and look
 * complete.
 *
 * The distinction that matters here is missing versus not yet aired. An
 * episode that has not been broadcast is not something you failed to get, and
 * counting it as missing turns every currently-running show into a permanent
 * warning that can never be cleared. So air dates decide, and an episode with
 * no air date at all is treated as unaired rather than missing: TMDB carries
 * announced-but-unscheduled episodes, and calling those missing is the same
 * false alarm.
 */

/** Start of today, local time — an episode airing today counts as aired. */
function startOfToday(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Has this episode aired?
 *
 * A malformed date is treated as unaired for the same reason a missing one is:
 * the cost of a false "missing" is a permanent nag, and the cost of a false
 * "unaired" is one episode you have to notice yourself.
 */
export function hasAired(airDate, now = Date.now()) {
  if (!airDate) return false;
  const parsed = Date.parse(`${airDate}T00:00:00`);
  if (Number.isNaN(parsed)) return false;
  return parsed <= startOfToday(now);
}

/**
 * Compare one season's TMDB episode list to what the library holds.
 *
 * `libraryEpisodes` is the season's entry from the scanner's library; only
 * episodes carrying at least one file count as held, because an entry with an
 * empty file list is a gap that something else already created.
 */
export function compareSeason(tmdbEpisodes, libraryEpisodes, { now = Date.now() } = {}) {
  const held = new Set(
    (libraryEpisodes || [])
      .filter((episode) => (episode.files || []).length > 0)
      .map((episode) => Number(episode.episode_number))
      .filter(Number.isInteger)
  );

  const missing = [];
  const unaired = [];

  for (const episode of tmdbEpisodes || []) {
    const number = Number(episode.episode_number);
    if (!Number.isInteger(number) || held.has(number)) continue;

    const entry = {
      episode_number: number,
      title: episode.name || null,
      air_date: episode.air_date || null,
      overview: episode.overview || ''
    };
    (hasAired(episode.air_date, now) ? missing : unaired).push(entry);
  }

  const byNumber = (a, b) => a.episode_number - b.episode_number;
  missing.sort(byNumber);
  unaired.sort(byNumber);

  return {
    held: held.size,
    // What TMDB says the season contains, which is not always what it shipped.
    total: (tmdbEpisodes || []).filter((e) => Number.isInteger(Number(e.episode_number))).length,
    missing,
    unaired,
    // Complete means nothing aired is absent. An unaired episode does not stop
    // a season being complete as far as anyone can currently be.
    complete: missing.length === 0
  };
}

/**
 * Should this season be checked at all?
 *
 * Season 0 is TMDB's bucket for specials, recaps and behind-the-scenes
 * featurettes. Almost nobody considers those missing, and including them makes
 * every show look incomplete forever.
 */
export const isRealSeason = (number) => Number.isInteger(Number(number)) && Number(number) > 0;

/**
 * Roll several season comparisons into one answer for a show.
 *
 * Seasons the library has no files for at all are skipped rather than reported
 * as entirely missing: a show you have one season of is not "missing" the
 * other four, it is a show you have one season of.
 */
export function summariseShow(seasons) {
  const withGaps = seasons.filter((season) => season.missing.length > 0);
  return {
    seasons,
    missingCount: seasons.reduce((sum, season) => sum + season.missing.length, 0),
    unairedCount: seasons.reduce((sum, season) => sum + season.unaired.length, 0),
    seasonsWithGaps: withGaps.length,
    complete: withGaps.length === 0
  };
}

export default { hasAired, compareSeason, isRealSeason, summariseShow };
