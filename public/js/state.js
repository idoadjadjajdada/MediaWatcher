/**
 * App state — a plain object plus a subscriber set.
 *
 * setState shallow-merges and notifies everyone. Views re-read what they need
 * from `state`; nothing here knows about the DOM.
 */

export const state = {
  library: { movies: [], shows: [], unknown: [] },
  progress: [],
  jobs: [],
  currentPage: 'home',
  currentItem: null,          // item behind the detail modal
  search: {
    query: '',
    type: 'movie',
    // Torrentio indexes series per episode, so a show search without these
    // returns nothing at all. Only used when type === 'show'.
    season: 1,
    episode: 1,
    // Set when a suggestion is picked. Searching by TMDB id skips title
    // matching altogether, so a typo cannot reach the resolver at all.
    tmdbId: null,
    suggestions: [],
    results: [],
    sources: [],
    status: 'idle',           // idle | loading | done | error
    error: null,
    filters: { quality: 'all', hideUpscaled: true }
  },
  // Browsable titles that are not in the library. Loaded once after the
  // library so Home never blocks on TMDB.
  discover: { rails: [], status: 'idle', error: null },
  player: { open: false, src: '', subs: null, resumeAt: 0, audioOffset: 0 },

  // UI bookkeeping
  loading: true,
  error: null,
  lastScanAt: null,
  scanning: false
};

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function setState(patch) {
  Object.assign(state, patch);
  subscribers.forEach((fn) => {
    try {
      fn(state);
    } catch (error) {
      // A broken subscriber must not stop the others from updating.
      console.error('subscriber failed:', error);
    }
  });
}

/** Merge into a nested slice without clobbering its siblings. */
export function patchSlice(key, patch) {
  setState({ [key]: { ...state[key], ...patch } });
}

/* --------------------------------------------------------------------------
 * Derived selectors
 * ----------------------------------------------------------------------- */

/** Newest first, by file mtime. */
export function recentlyAdded(limit = 16) {
  const stamped = [
    ...state.library.movies.map((movie) => ({ item: movie, type: 'movie', at: addedAt(movie) })),
    ...state.library.shows.map((show) => ({ item: show, type: 'show', at: addedAt(show) }))
  ];
  return stamped.sort((a, b) => b.at - a.at).slice(0, limit);
}

function addedAt(item) {
  let newest = 0;
  for (const file of item.files || []) newest = Math.max(newest, file.added_at || 0);
  for (const season of item.seasons || []) {
    for (const episode of season.episodes) {
      for (const file of episode.files || []) newest = Math.max(newest, file.added_at || 0);
    }
  }
  return newest;
}

export function findMovie(tmdbId) {
  return state.library.movies.find((movie) => movie.tmdb_id === tmdbId) || null;
}

export function findShow(tmdbId) {
  return state.library.shows.find((show) => show.tmdb_id === tmdbId) || null;
}

/** Locate a file path inside the library, with its show/episode context. */
export function locateFile(filePath) {
  for (const movie of state.library.movies) {
    if ((movie.files || []).some((file) => file.file_path === filePath)) {
      return { type: 'movie', item: movie, file: movie.files.find((f) => f.file_path === filePath) };
    }
  }
  for (const show of state.library.shows) {
    for (const season of show.seasons) {
      for (const episode of season.episodes) {
        if ((episode.files || []).some((file) => file.file_path === filePath)) {
          return { type: 'episode', item: show, season: season.number, episode };
        }
      }
    }
  }
  return null;
}

/** The episode after this one, crossing into the next season if needed. */
/** Every playable episode of a show, in order, flattened across seasons. */
function playableEpisodes(show) {
  const flat = [];
  for (const season of show.seasons || []) {
    for (const episode of season.episodes) {
      if (episode.files && episode.files.length > 0) {
        flat.push({ season: season.number, episode });
      }
    }
  }
  return flat;
}

export function nextEpisode(show, seasonNumber, episodeNumber) {
  const flat = playableEpisodes(show);
  const index = flat.findIndex(
    (entry) => entry.season === seasonNumber && entry.episode.episode_number === episodeNumber
  );
  if (index === -1 || index === flat.length - 1) return null;
  return flat[index + 1];
}

/** The episode before this one, crossing back into the previous season. */
export function previousEpisode(show, seasonNumber, episodeNumber) {
  const flat = playableEpisodes(show);
  const index = flat.findIndex(
    (entry) => entry.season === seasonNumber && entry.episode.episode_number === episodeNumber
  );
  if (index <= 0) return null;
  return flat[index - 1];
}

/** Every season number a show has, ascending. */
export function seasonNumbers(show) {
  return (show?.seasons || []).map((season) => season.number).sort((a, b) => a - b);
}

/**
 * Shrink a TMDB still to sidebar size.
 *
 * The scanner builds stills at backdrop size (w1280) because the detail modal
 * wants them big. The sidebar shows them at about 92px, so serving w1280 there
 * would pull several megabytes to draw a list of thumbnails.
 */
export function stillThumb(url) {
  if (!url) return null;
  return String(url).replace(/\/t\/p\/(w\d+|original)\//, '/t/p/w300/');
}

/**
 * One season's episodes, shaped for the sidebar.
 *
 * Episodes with no file are kept rather than filtered: a gap in the library
 * should read as a gap, not silently renumber the list. The caller dims them.
 *
 * `current` matches on season AND episode number - matching on episode number
 * alone would mark S01E01 while S02E01 is playing.
 */
export function episodeRows(show, seasonNumber, currentSeason, currentEpisode) {
  const season = (show?.seasons || []).find((entry) => entry.number === seasonNumber);
  if (!season) return [];

  return [...(season.episodes || [])]
    .sort((a, b) => a.episode_number - b.episode_number)
    .map((episode) => {
      const file = (episode.files || [])[0] || null;
      return {
        season: season.number,
        episode_number: episode.episode_number,
        title: episode.title || '',
        filePath: file ? file.file_path : null,
        playable: Boolean(file),
        current: season.number === currentSeason && episode.episode_number === currentEpisode,
        still: stillThumb(episode.still),
        overview: episode.overview || ''
      };
    });
}

/**
 * Shape one Continue Watching row into everything its card needs.
 *
 * An episode shows its own still, its own description and its own air year -
 * the show's poster and first-aired year say nothing about where you actually
 * are. A movie keeps its poster, because that is how you recognise a film.
 *
 * Returns null when the path is no longer in the library, which happens after
 * a file is moved or deleted between the progress row being written and Home
 * being rendered.
 */
export function continueEntry(row, library) {
  if (!row?.file_path || !library) return null;

  // Against the library passed in rather than module state, so this is
  // testable without standing up the whole app.
  const located = locateIn(library, row.file_path);
  if (!located) return null;

  const duration = Number(row.duration) || 0;
  const position = Number(row.position) || 0;
  const progress = duration > 0 ? position / duration : 0;

  if (located.type === 'episode') {
    const { item: show, season, episode } = located;
    const year = episode.air_date
      ? (Number(String(episode.air_date).slice(0, 4)) || null)
      : (show.year ?? null);

    return {
      type: 'episode',
      tmdb_id: show.tmdb_id,
      filePath: row.file_path,
      art: stillThumb(episode.still) || show.poster || null,
      title: show.title,
      subtitle: `${episodeTagOf(season, episode.episode_number)}${episode.title ? ` · ${episode.title}` : ''}`,
      description: episode.overview || '',
      year,
      progress,
      position
    };
  }

  const movie = located.item;
  return {
    type: 'movie',
    tmdb_id: movie.tmdb_id,
    filePath: row.file_path,
    art: movie.poster || null,
    title: movie.title,
    subtitle: '',
    description: movie.overview || '',
    year: movie.year ?? null,
    progress,
    position
  };
}

/** SxxExx, kept here so state.js does not have to import from views.js. */
function episodeTagOf(season, episode) {
  const pad = (n) => String(n ?? 0).padStart(2, '0');
  return `S${pad(season)}E${pad(episode)}`;
}

/** locateFile against an explicit library rather than the module's state. */
function locateIn(library, filePath) {
  for (const movie of library.movies || []) {
    if ((movie.files || []).some((file) => file.file_path === filePath)) {
      return { type: 'movie', item: movie, file: movie.files.find((f) => f.file_path === filePath) };
    }
  }
  for (const show of library.shows || []) {
    for (const season of show.seasons || []) {
      for (const episode of season.episodes || []) {
        if ((episode.files || []).some((file) => file.file_path === filePath)) {
          return { type: 'episode', item: show, season: season.number, episode };
        }
      }
    }
  }
  return null;
}

export function activeJobCount() {
  return state.jobs.filter((job) => job.status === 'downloading' || job.status === 'queued').length;
}

export default { state, subscribe, setState, patchSlice };
