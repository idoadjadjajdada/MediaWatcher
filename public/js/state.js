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
    results: [],
    sources: [],
    status: 'idle',           // idle | loading | done | error
    error: null,
    filters: { quality: 'all', hideUpscaled: true }
  },
  player: { open: false, src: '', subs: null, resumeAt: 0 },

  // UI bookkeeping
  loading: true,
  error: null,
  lastScanAt: null,
  scanning: false,
  drawerOpen: false
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
export function nextEpisode(show, seasonNumber, episodeNumber) {
  const flat = [];
  for (const season of show.seasons) {
    for (const episode of season.episodes) {
      if (episode.files && episode.files.length > 0) {
        flat.push({ season: season.number, episode });
      }
    }
  }
  const index = flat.findIndex(
    (entry) => entry.season === seasonNumber && entry.episode.episode_number === episodeNumber
  );
  if (index === -1 || index === flat.length - 1) return null;
  return flat[index + 1];
}

export function activeJobCount() {
  return state.jobs.filter((job) => job.status === 'downloading' || job.status === 'queued').length;
}

export default { state, subscribe, setState, patchSlice };
