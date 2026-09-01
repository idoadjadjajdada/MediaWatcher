/**
 * Router + bootstrap.
 *
 * One click listener on the document handles every [data-action] in the app.
 * That keeps re-rendering cheap (no listener bookkeeping) and satisfies the
 * CSP, which forbids inline handlers.
 */
import * as api from './api.js';
import {
  state, setState, subscribe, patchSlice, findMovie, findShow, progressByPath
} from './state.js';
import * as views from './views.js';
import * as search from './search.js';
import * as player from './player.js';
import * as preview from './preview.js';

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

// Replacing main's innerHTML destroys the focused control, which makes the
// browser fire `change` on it. That reaches the delegated listener and can call
// render() again mid-assignment, which throws NotFoundError. One render at a
// time; the outer pass already reflects the latest state.
let rendering = false;

function render() {
  const main = document.getElementById('main');
  if (!main || rendering) return;
  rendering = true;
  try {
    renderInner(main);
  } finally {
    rendering = false;
  }
}

function renderInner(main) {

  // Rendering replaces the page wholesale, which drops focus and the caret.
  // That was tolerable when only a click could trigger it, but typing in the
  // search box re-renders on every keystroke, so the focused control has to
  // survive the swap.
  const active = document.activeElement;
  const focusedId = active && active.id && main.contains(active) ? active.id : null;
  const caretStart = focusedId && active.selectionStart != null ? active.selectionStart : null;
  const caretEnd = focusedId && active.selectionEnd != null ? active.selectionEnd : null;

  const renderer = RENDERERS[state.currentPage] || views.renderHome;
  main.innerHTML = `<div class="page">${renderer()}</div>`;
  views.updateShell();

  if (focusedId) {
    const restored = document.getElementById(focusedId);
    if (restored) {
      restored.focus();
      if (caretStart != null && typeof restored.setSelectionRange === 'function') {
        // Number inputs throw on setSelectionRange; their caret is not ours to manage.
        try { restored.setSelectionRange(caretStart, caretEnd); } catch { /* not a text field */ }
      }
    }
  }
}

/* --------------------------------------------------------------------------
 * Data loading
 * ----------------------------------------------------------------------- */

async function loadLibrary() {
  try {
    const [library, progress, allProgress] = await Promise.all([
      api.getLibrary(),
      api.getContinueWatching().catch(() => []),
      // Every row rather than the Continue Watching subset: the detail page
      // needs completed episodes too, to mark them as seen.
      api.getAllProgress().catch(() => [])
    ]);

    setState({
      library: { movies: library.movies, shows: library.shows, unknown: library.unknown },
      progress,
      watched: progressByPath(allProgress),
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

/**
 * Rails are decoration: a failure leaves Home exactly as it was, with no
 * toast, because the library above them is still perfectly usable.
 */
async function loadDiscover() {
  patchSlice('discover', { status: 'loading' });
  try {
    const payload = await api.getDiscover();
    patchSlice('discover', { rails: payload.rails || [], status: 'done', error: null });
  } catch (error) {
    patchSlice('discover', { rails: [], status: 'error', error: error.message });
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
  const raw = window.location.hash.replace(/^#/, '').trim();

  // The player is its own screen and owns the hash while it is up. Leaving
  // that hash by any route - Back, a typed URL, a nav click - closes it rather
  // than swapping the page out from underneath it.
  if (raw === player.PLAYER_HASH) return;
  // Not awaited: the page behind should update immediately, and the only thing
  // close() still has to do is save progress.
  if (player.isOpen()) player.close({ save: true });

  const page = currentHashPage();
  if (page !== state.currentPage) setState({ currentPage: page });
}

function navigate(page) {
  if (!PAGES.includes(page)) return;
  window.location.hash = page;
  // hashchange does not fire when the hash is already correct.
  if (currentHashPage() === state.currentPage) setState({});
}

/* --------------------------------------------------------------------------
 * Actions
 * ----------------------------------------------------------------------- */

const ACTIONS = {
  navigate: (el) => navigate(el.dataset.page),


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

  'rail-scroll': (el) => {
    const wrap = el.closest('.row__wrap');
    const track = wrap ? wrap.querySelector('.rail') : null;
    if (!track) return;
    const dir = Number(el.dataset.dir) || 1;
    track.scrollBy({ left: dir * Math.round(track.clientWidth * 0.8), behavior: 'smooth' });
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

  /**
   * Search for a title by TMDB id.
   *
   * Works for both library items and discovery items: the id is authoritative,
   * so no title matching happens at all. Shows land on the Search page with the
   * season and episode fields ready, which is the one place in the app that
   * picks an episode.
   */
  'find-torrents': (el) => {
    const type = el.dataset.type === 'show' ? 'show' : 'movie';
    const title = el.dataset.title || '';
    const tmdbId = Number(el.dataset.id) || null;

    setState({ currentItem: null });
    patchSlice('search', { type, tmdbId, suggestions: [] });
    navigate('search');
    search.runSearch(title, type, state.search.season, state.search.episode);
  },

  'open-discover': async (el) => {
    const type = el.dataset.type === 'show' ? 'show' : 'movie';
    const tmdbId = Number(el.dataset.id);
    if (!Number.isFinite(tmdbId)) return;

    try {
      const details = await api.getDiscoverDetail(type, tmdbId);
      const released = type === 'show' ? details.first_air_date : details.release_date;

      setState({
        currentItem: {
          tmdb_id: details.id,
          media_type: type,
          owned: false,
          title: type === 'show' ? details.name : details.title,
          year: Number(String(released || '').slice(0, 4)) || null,
          // Built here because the detail endpoint returns raw TMDB records;
          // the sizes match config.tmdb posterSize/backdropSize/profileSize.
          poster: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
          backdrop: details.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
          rating: typeof details.vote_average === 'number' ? Number(details.vote_average.toFixed(1)) : null,
          overview: details.overview || '',
          genres: (details.genres || []).map((genre) => genre.name),
          runtime: details.runtime || (details.episode_run_time || [])[0] || null,
          cast: (details.credits?.cast || []).slice(0, 10).map((person) => ({
            id: person.id,
            name: person.name,
            character: person.character || null,
            profile: person.profile_path ? `https://image.tmdb.org/t/p/w185${person.profile_path}` : null
          }))
        }
      });
    } catch (error) {
      views.toast('error', 'Could not load that title', error.message);
    }
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
    const live = liveSearch();
    patchSlice('search', { suggestions: [] });
    search.runSearch(live.query, live.type, live.season, live.episode);
  },

  // Deliberately does not patch state on every keystroke: that would re-render
  // the page under the caret. The typed value lives in the DOM and is read by
  // liveSearch(); it is folded into state when suggestions land.
  'suggest-input': (el) => {
    if (state.search.tmdbId) patchSlice('search', { tmdbId: null });
    scheduleSuggest(el.value);
  },

  'pick-suggestion': (el) => {
    const entry = state.search.suggestions[Number(el.dataset.index)];
    if (!entry) return;
    const live = liveSearch();
    patchSlice('search', {
      query: entry.title, type: entry.type, tmdbId: entry.tmdb_id, suggestions: []
    });
    search.runSearch(entry.title, entry.type, live.season, live.episode);
  },

  // Switching to Show reveals the season/episode boxes, so this has to
  // re-render rather than wait for the next search.
  'set-search-type': (el) => {
    patchSlice('search', { ...liveSearch(), type: el.value });
  },

  'filter-quality': (el) => {
    patchSlice('search', {
      ...liveSearch(),
      filters: { ...state.search.filters, quality: el.dataset.quality }
    });
  },

  'toggle-upscaled': (el) => {
    patchSlice('search', {
      ...liveSearch(),
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
  'resume': (el) => player.open(el.dataset.path),
  'close-player': () => player.close(),
  'toggle-play': () => player.togglePlay(),
  'seek-back': () => player.skip(-10),
  'seek-forward': () => player.skip(10),
  'toggle-mute': () => player.toggleMute(),
  'toggle-fullscreen': () => player.toggleFullscreen(),
  'toggle-popover': (el) => player.togglePopover(el.dataset.popover),
  'toggle-episodes': () => player.toggleEpisodes(),
  'close-episodes': () => player.closeEpisodes(),
  'select-season': (el) => player.selectSeason(el.dataset.season),
  'play-episode': (el) => { player.closeEpisodes(); player.open(el.dataset.path); },
  'picture-reset': () => player.setPicture({ brightness: 100, contrast: 100 }),
  'set-subtitle': (el) => player.setSubtitle(el.dataset.track),
  'set-speed': (el) => player.setSpeed(el.dataset.speed),
  'set-quality': (el) => player.setQuality(el.dataset.quality),
  'set-audio-track': (el) => player.setAudioTrack(el.dataset.index),
  'seek-chapter': (el) => player.seekChapter(el.dataset.start),
  'prev-episode': () => player.playPrevious(),
  'next-episode': () => player.playNextEpisode(),
  'audio-nudge': (el) => player.nudgeAudioOffset(Number(el.dataset.delta)),
  'audio-reset': () => player.resetAudioOffset(),
  'play-next': () => player.playNext(),
  'cancel-next': () => player.cancelNext()
};

/* --------------------------------------------------------------------------
 * Continue Watching hover frame
 *
 * A movie card shows its poster, so nothing on it says where you stopped.
 * Hovering fetches the generated frame nearest that position from the same
 * thumbnail service the seek bar uses, and fades it over the poster.
 *
 * Loaded on hover rather than up front: these are full-size requests, and most
 * cards are never hovered. Failure is silent - the poster simply stays.
 * ----------------------------------------------------------------------- */

const hoverFrames = new Map();

async function loadHoverFrame(card) {
  const filePath = card.dataset.path;
  const position = Number(card.dataset.position) || 0;
  const target = card.querySelector('.continue__frame');
  if (!filePath || !target || card.dataset.frameState) return;

  card.dataset.frameState = 'loading';
  try {
    // Not memoised while still generating: asking again is what nudges the
    // server to keep going, and the answer changes as frames land.
    let meta = hoverFrames.get(filePath);
    if (!meta) {
      const response = await fetch(api.thumbMetaUrl(filePath));
      if (!response.ok) throw new Error(String(response.status));
      meta = await response.json();
      if (meta.ready) hoverFrames.set(filePath, meta);
    }
    if (!meta.interval || !meta.total) throw new Error('no frames yet');

    const index = Math.min(preview.frameIndex(position, meta.interval), meta.total - 1);
    const url = api.thumbUrl(filePath, index);
    await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = resolve;
      probe.onerror = reject;
      probe.src = url;
    });
    target.style.backgroundImage = `url("${url}")`;
    card.dataset.frameState = 'ready';
  } catch {
    // Frames are generated on demand, so "not there yet" is the normal first
    // answer. Clearing the flag lets the next hover try again rather than
    // marking the card as permanently posterless.
    delete card.dataset.frameState;
  }
}

const SUGGEST_DEBOUNCE_MS = 250;
let suggestTimer = null;
let suggestSeq = 0;

/**
 * Fetch suggestions 250ms after typing stops. Replies carry a sequence number
 * so a slow response for an older query cannot overwrite a newer one.
 */
function scheduleSuggest(value) {
  clearTimeout(suggestTimer);
  const term = String(value || '').trim();

  if (term.length < 2) {
    if (state.search.suggestions.length > 0) patchSlice('search', { suggestions: [] });
    return;
  }

  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    try {
      const suggestions = await api.suggest(term);
      // Carry the query too: the re-render reads it back out of state, and
      // without it the box would revert to whatever was last searched.
      if (seq === suggestSeq) patchSlice('search', { suggestions, query: term });
    } catch {
      // A failed lookup just leaves the dropdown closed.
    }
  }, SUGGEST_DEBOUNCE_MS);
}

/**
 * Whatever is in the search controls right now. Re-rendering the page would
 * otherwise discard anything the user has typed but not submitted yet, so
 * every action that triggers a re-render folds this back into state first.
 */
function liveSearch() {
  const read = (id, fallback) => {
    const node = document.getElementById(id);
    return node ? node.value : fallback;
  };
  const whole = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };

  return {
    query: read('search-input', state.search.query),
    type: read('search-type', state.search.type),
    season: whole(read('search-season', state.search.season), state.search.season),
    episode: whole(read('search-episode', state.search.episode), state.search.episode)
  };
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
  // Form controls are driven by their own 'change' event. Handling the click
  // too would run the action twice for a toggle, and for a <select> it would
  // re-render the page out from under the open dropdown.
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') {
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

  // Progress only loaded at boot, so Continue Watching and the watched marks
  // on a show page stayed at whatever they were when the tab opened. Closing
  // the player is the moment they are certain to be wrong.
  if (previousPlayerOpen && !state.player.open) refreshProgress();
  previousPlayerOpen = state.player.open;
}

let previousPlayerOpen = false;

async function refreshProgress() {
  const [progress, allProgress] = await Promise.all([
    api.getContinueWatching().catch(() => null),
    api.getAllProgress().catch(() => null)
  ]);
  const patch = {};
  if (progress) patch.progress = progress;
  if (allProgress) patch.watched = progressByPath(allProgress);
  if (Object.keys(patch).length) setState(patch);
}

async function boot() {
  views.renderShell();

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onClick);
  document.addEventListener('input', onClick);
  // Delegated so it survives re-renders, and capture-phase because pointerover
  // does not bubble from every nested element consistently across browsers.
  document.addEventListener('pointerover', (event) => {
    const card = event.target.closest?.('.continue--movie');
    if (card) loadHoverFrame(card);
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('error', onResourceError, true);

  // A reload while the player was up leaves #player in the address bar with no
  // player behind it. Nothing can restore one - the file is not in the hash -
  // so drop back to a real page rather than showing Home under a stale route.
  if (window.location.hash.replace(/^#/, '').trim() === player.PLAYER_HASH) {
    window.location.replace(`${window.location.pathname}${window.location.search}#home`);
  }

  state.currentPage = currentHashPage();
  previousPage = state.currentPage;

  // Subscribe before any loading kicks off, or the first setState renders nothing.
  subscribe(onStateChange);
  render();

  await loadLibrary();
  await loadJobs();
  syncJobPolling();

  // Deliberately not awaited: Home renders from the library first and the
  // rails drop in when TMDB answers.
  loadDiscover();
}

boot().catch((error) => {
  console.error(error);
  document.getElementById('app').innerHTML =
    `<div class="boot"><p class="boot__label">MediaWatcher failed to start: ${views.esc(error.message)}</p></div>`;
});
