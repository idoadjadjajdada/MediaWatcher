/**
 * Router + bootstrap.
 *
 * One click listener on the document handles every [data-action] in the app.
 * That keeps re-rendering cheap (no listener bookkeeping) and satisfies the
 * CSP, which forbids inline handlers.
 */
import * as api from './api.js';
import { state, setState, subscribe, patchSlice, findMovie, findShow } from './state.js';
import * as views from './views.js';
import * as search from './search.js';
import * as player from './player.js';

const PAGES = ['home', 'movies', 'shows', 'search', 'downloads'];
const JOB_POLL_MS = 3000;

let jobTimer = null;

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

const RENDERERS = {
  home: views.renderHome,
  movies: views.renderMovies,
  shows: views.renderShows,
  search: search.renderSearch,
  downloads: views.renderDownloads
};

function render() {
  const main = document.getElementById('main');
  if (!main) return;

  const renderer = RENDERERS[state.currentPage] || views.renderHome;
  main.innerHTML = `<div class="page">${renderer()}</div>`;
  views.updateShell();
}

/* --------------------------------------------------------------------------
 * Data loading
 * ----------------------------------------------------------------------- */

async function loadLibrary() {
  try {
    const [library, progress] = await Promise.all([
      api.getLibrary(),
      api.getContinueWatching().catch(() => [])
    ]);

    setState({
      library: { movies: library.movies, shows: library.shows, unknown: library.unknown },
      progress,
      lastScanAt: library.last_scan_at,
      scanning: Boolean(library.scanning),
      loading: false,
      error: null
    });

    if (library.unknown.length > 0) {
      console.info(`${library.unknown.length} file(s) could not be identified — see /api/media/library`);
    }
  } catch (error) {
    setState({ loading: false, error: error.message });
    views.toast('error', 'Could not load your library', error.message);
  }
}

async function loadJobs() {
  try {
    const jobs = await api.getJobs();
    const changed = JSON.stringify(jobs) !== JSON.stringify(state.jobs);
    if (changed) setState({ jobs });
    else views.updateShell();
    return jobs;
  } catch {
    return state.jobs;
  }
}

/** Poll only while the Downloads page is open or something is in flight. */
function syncJobPolling() {
  const needed = state.currentPage === 'downloads'
    || state.jobs.some((job) => job.status === 'downloading' || job.status === 'queued');

  if (needed && !jobTimer) {
    jobTimer = setInterval(loadJobs, JOB_POLL_MS);
  } else if (!needed && jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
}

/* --------------------------------------------------------------------------
 * Router
 * ----------------------------------------------------------------------- */

function currentHashPage() {
  const raw = window.location.hash.replace(/^#/, '').trim();
  return PAGES.includes(raw) ? raw : 'home';
}

function onHashChange() {
  const page = currentHashPage();
  if (page !== state.currentPage) setState({ currentPage: page, drawerOpen: false });
}

function navigate(page) {
  if (!PAGES.includes(page)) return;
  window.location.hash = page;
  // hashchange does not fire when the hash is already correct.
  if (currentHashPage() === state.currentPage) setState({ drawerOpen: false });
}

/* --------------------------------------------------------------------------
 * Actions
 * ----------------------------------------------------------------------- */

const ACTIONS = {
  navigate: (el) => navigate(el.dataset.page),

  'toggle-drawer': () => setState({ drawerOpen: !state.drawerOpen }),

  rescan: async () => {
    setState({ scanning: true });
    views.toast('info', 'Rescanning library…');
    try {
      await api.rescan();
      // The scan runs in the background; poll the library until it settles.
      await waitForScan();
      views.toast('success', 'Rescan complete',
        `${state.library.movies.length} movies, ${state.library.shows.length} shows`);
    } catch (error) {
      views.toast('error', 'Rescan failed', error.message);
    } finally {
      setState({ scanning: false });
    }
  },

  'open-detail': (el) => {
    const id = Number(el.dataset.id);
    const item = el.dataset.type === 'show' ? findShow(id) : findMovie(id);
    if (item) setState({ currentItem: item });
  },

  'close-modal': () => setState({ currentItem: null }),

  'close-modal-backdrop': (el, event) => {
    if (event.target === el) setState({ currentItem: null });
  },

  'expand-overview': (el) => {
    const overview = document.getElementById('modal-overview');
    if (!overview) return;
    const expanded = overview.classList.toggle('is-expanded');
    el.textContent = expanded ? 'Show less' : 'Show more';
  },

  'toggle-season': (el) => {
    el.closest('.season')?.classList.toggle('is-open');
  },

  play: (el) => {
    const path = el.dataset.path;
    if (!path) return;
    setState({ currentItem: null });
    player.open(path).catch((error) => views.toast('error', 'Could not open player', error.message));
  },

  'find-more': (el) => {
    const id = Number(el.dataset.id);
    const item = el.dataset.type === 'show' ? findShow(id) : findMovie(id);
    if (!item) return;
    setState({ currentItem: null });
    patchSlice('search', { type: el.dataset.type === 'show' ? 'show' : 'movie' });
    navigate('search');
    search.runSearch(item.title, el.dataset.type === 'show' ? 'show' : 'movie');
  },

  'add-torrent': () => {
    const magnet = window.prompt('Paste a magnet link or infohash');
    if (!magnet) return;
    const title = window.prompt('What is this? (used for the library folder)');
    if (!title) return;
    api.startDownload({ magnet: magnet.trim(), title: title.trim(), type: 'movie', source: 'manual' })
      .then((job) => {
        views.toast('success', 'Download queued', job.title);
        loadJobs().then(syncJobPolling);
      })
      .catch((error) => views.toast('error', 'Could not add torrent', error.message));
  },

  'run-search': () => {
    const input = document.getElementById('search-input');
    const type = document.getElementById('search-type');
    search.runSearch(input ? input.value : state.search.query, type ? type.value : state.search.type);
  },

  'filter-quality': (el) => {
    patchSlice('search', {
      query: liveQuery(),
      filters: { ...state.search.filters, quality: el.dataset.quality }
    });
  },

  'toggle-upscaled': (el) => {
    patchSlice('search', {
      query: liveQuery(),
      filters: { ...state.search.filters, hideUpscaled: el.checked }
    });
  },

  'clear-filters': () => {
    patchSlice('search', { filters: { quality: 'all', hideUpscaled: false } });
  },

  'download-result': async (el) => {
    el.disabled = true;
    el.textContent = 'Queued…';
    const job = await search.downloadResult(Number(el.dataset.index));
    if (job) {
      await loadJobs();
      syncJobPolling();
    } else {
      el.disabled = false;
      el.textContent = 'Download';
    }
  },

  'cancel-job': async (el) => {
    try {
      await api.cancelJob(el.dataset.id);
      views.toast('info', 'Download removed');
      await loadJobs();
      syncJobPolling();
    } catch (error) {
      views.toast('error', 'Could not cancel', error.message);
    }
  },

  'retry-job': async (el) => {
    const job = state.jobs.find((entry) => String(entry.id) === el.dataset.id);
    if (!job) return;
    try {
      // Re-posting the same magnet upserts the row back to 'queued'.
      await api.startDownload({ magnet: job.magnet, title: job.title, type: job.type, tmdb_id: job.tmdb_id, source: job.source });
      views.toast('info', 'Retrying download', job.title);
      await loadJobs();
      syncJobPolling();
    } catch (error) {
      views.toast('error', 'Retry failed', error.message);
    }
  },

  'open-folder': (el) => {
    // A browser cannot open a file manager; showing the path is the honest option.
    const path = el.dataset.path;
    if (!path) return;
    navigator.clipboard?.writeText(path)
      .then(() => views.toast('success', 'Path copied', path))
      .catch(() => views.toast('info', 'File location', path));
  },

  // --- player ---
  'close-player': () => player.close(),
  'toggle-play': () => player.togglePlay(),
  'seek-back': () => player.skip(-10),
  'seek-forward': () => player.skip(10),
  'toggle-mute': () => player.toggleMute(),
  'toggle-fullscreen': () => player.toggleFullscreen(),
  'toggle-menu': () => player.toggleMenu(),
  'set-subtitle': (el) => player.setSubtitle(el.dataset.track),
  'set-speed': (el) => player.setSpeed(el.dataset.speed),
  'play-next': () => player.playNext(),
  'cancel-next': () => player.cancelNext()
};

/**
 * Whatever is typed in the search box right now. Re-rendering the page would
 * otherwise discard text the user has not submitted yet.
 */
function liveQuery() {
  const input = document.getElementById('search-input');
  return input ? input.value : state.search.query;
}

/** Poll the library until a background scan finishes. */
async function waitForScan(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const library = await api.getLibrary().catch(() => null);
    if (!library) continue;
    if (!library.scanning) {
      setState({
        library: { movies: library.movies, shows: library.shows, unknown: library.unknown },
        lastScanAt: library.last_scan_at
      });
      return;
    }
  }
}

/* --------------------------------------------------------------------------
 * Wiring
 * ----------------------------------------------------------------------- */

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const handler = ACTIONS[target.dataset.action];
  if (!handler) return;

  // Inputs are driven by their own 'change' event; handling the click too
  // would run the action twice for one toggle.
  if (target.tagName === 'INPUT') {
    if (event.type === 'click') return;
  } else {
    event.preventDefault();
  }

  handler(target, event);
}

/**
 * Artwork that fails to load (TMDB gap, offline, blocked) degrades to the same
 * placeholder a poster-less item gets, instead of a broken-image frame.
 * Uses the capture phase because `error` on <img> does not bubble.
 */
function onResourceError(event) {
  const node = event.target;
  if (!(node instanceof HTMLImageElement) || node.dataset.failed) return;
  node.dataset.failed = '1';

  if (node.classList.contains('card__poster')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'card__placeholder';
    placeholder.textContent = node.alt || 'No artwork';
    node.replaceWith(placeholder);
  } else {
    // Backdrops, stills and cast photos already sit on a styled background.
    node.style.visibility = 'hidden';
  }
}

function onKeyDown(event) {
  // The player owns the keyboard while it is open.
  if (player.isOpen()) return;

  if (event.key === 'Escape' && state.currentItem) {
    setState({ currentItem: null });
    return;
  }

  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (event.key === 'Enter' && event.target.id === 'search-input') {
      ACTIONS['run-search']();
    }
    if (event.key === 'Enter' && event.target.id === 'global-search') {
      const value = event.target.value.trim();
      if (!value) return;
      navigate('search');
      search.runSearch(value, state.search.type);
    }
    return;
  }

  if (event.key === '/' ) {
    event.preventDefault();
    document.getElementById('global-search')?.focus();
  }
}

/* --------------------------------------------------------------------------
 * Boot
 * ----------------------------------------------------------------------- */

let previousItem = null;
let previousPage = null;

function onStateChange() {
  // Re-render the page only when something it depends on changed.
  render();

  if (state.currentItem !== previousItem) {
    previousItem = state.currentItem;
    views.renderDetailModal(state.currentItem);
  }

  if (state.currentPage !== previousPage) {
    previousPage = state.currentPage;
    syncJobPolling();
  }
}

async function boot() {
  views.renderShell();

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('error', onResourceError, true);

  state.currentPage = currentHashPage();
  previousPage = state.currentPage;

  // Subscribe before any loading kicks off, or the first setState renders nothing.
  subscribe(onStateChange);
  render();

  await loadLibrary();
  await loadJobs();
  syncJobPolling();
}

boot().catch((error) => {
  console.error(error);
  document.getElementById('app').innerHTML =
    `<div class="boot"><p class="boot__label">MediaWatcher failed to start: ${views.esc(error.message)}</p></div>`;
});
