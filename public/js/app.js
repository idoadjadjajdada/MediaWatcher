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
import * as catalog from './catalog.js';
import * as notify from './notify.js';
import * as player from './player.js';
import * as settings from './settings.js';
import * as preview from './preview.js';
import * as offline from './offline.js';
import * as install from './install.js';

const PAGES = ['home', 'movies', 'shows', 'search', 'downloads', 'settings'];
const JOB_POLL_MS = 3000;

let jobTimer = null;

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

const RENDERERS = {
  home: views.renderHome,
  movies: views.renderMovies,
  shows: views.renderShows,
  search: catalog.renderCatalog,
  downloads: views.renderDownloads,
  settings: settings.renderSettings
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

/* ---- entrance and hero rotation ----
   Both are page-scoped: they start when Home is on screen and stop the moment
   it is not, so nothing keeps ticking behind a player or a settings page. */
let lastRenderedPage = null;
let enterTimer = null;
let heroTimer = null;

const HERO_INTERVAL = 10000;

function syncHeroRotation() {
  clearInterval(heroTimer);
  heroTimer = null;
  if (state.currentPage !== 'home' || views.heroCount() < 2) return;
  heroTimer = setInterval(() => {
    // Not while a modal or the player is over it, and not while it is being
    // read: the dot's fill pauses on hover, so the timer has to as well or the
    // two would disagree about how long is left.
    if (document.querySelector('#modal-root > *') || document.querySelector('#player-root > *')) return;
    if (document.querySelector('.hero:hover')) return;
    views.showHero(views.currentHeroIndex() + 1);
  }, HERO_INTERVAL);
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

  /*
   * Entrance animations belong to a page change, not to a render. Polling
   * re-renders this element every few seconds, and without the gate every card
   * on screen would restart its entrance each time - a page that flickers on
   * its own is worse than one that never animates at all.
   */
  if (state.currentPage !== lastRenderedPage) {
    lastRenderedPage = state.currentPage;
    main.classList.remove('is-entering');
    void main.offsetWidth;
    main.classList.add('is-entering');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => main.classList.remove('is-entering'), 1200);
  }
  syncHeroRotation();

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
  // Whether subtitles can be fetched decides whether the season list draws a
  // button, so it is asked for alongside the library rather than lazily on
  // first player open. It resolves into state on its own and is deliberately
  // not awaited: the library must not wait on it.
  player.loadSubtitleCapabilities();

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
    // Before the state is replaced: what ended is the difference between them.
    notify.announce(state.jobs, jobs);
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
 * Installing
 * ----------------------------------------------------------------------- */

/**
 * Register the service worker.
 *
 * Deliberately not awaited and never fatal: it is what makes the app
 * installable and openable offline, and none of that is worth failing a boot
 * over. Browsers also refuse to register one over plain http on a non-local
 * host, which is a normal configuration here rather than a fault.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.info('service worker not registered:', error.message);
  });
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

  /* Jumping to a dot also restarts the clock — otherwise the title you just
     chose could be replaced a moment later by the tick already in flight. */
  'hero-jump': (el) => {
    views.showHero(Number(el.dataset.index) || 0);
    syncHeroRotation();
  },


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
   * so no title matching happens at all. Shows open their season and episode list.
   */
  'find-torrents': (el) => ACTIONS['open-catalog'](el),
  'open-discover': (el) => ACTIONS['open-catalog'](el),
  'open-catalog': (el) => {
    setState({ currentItem: null });
    navigate('search');
    catalog.openTitle(Number(el.dataset.id), el.dataset.type === 'show' ? 'show' : 'movie');
  },
  // Typing is not a state change; see the note on the draft in catalog.js.
  'catalog-query': (el) => catalog.edit('query', el.value),
  'catalog-year': (el) => catalog.edit('year', el.value),
  'catalog-filter': (el) => catalog.browse({ [el.dataset.field]: el.value, ...(el.dataset.field === 'type' ? { genre: '', genres: [] } : {}) }),
  'catalog-reset': () => catalog.browse({ query: '', genre: '', year: '', rating: '', sort: 'popular' }),
  'catalog-page': (el) => catalog.browse({ page: Number(el.dataset.page) }),
  'catalog-back': () => { catalog.back(); catalog.ensureLoaded(); },
  'catalog-genre-link': (el) => catalog.browse({ query: '', type: el.dataset.type, genre: el.dataset.genre }),
  'catalog-season': (el) => catalog.selectSeason(Number(el.dataset.season)),
  'catalog-retry-season': () => catalog.selectSeason(state.catalog.selectedSeason),
  'catalog-retry-title': () => catalog.openTitle(state.catalog.title.id, state.catalog.title.type),
  'catalog-download-movie': () => catalog.chooseDownload(),
  'catalog-download-season': () => catalog.chooseDownload(null, true),
  'catalog-download-episode': (el) => catalog.chooseDownload(Number(el.dataset.episode)),
  'catalog-retry-download': () => catalog.retryDownload(),
  'catalog-scroll-seasons': () => document.getElementById('catalog-seasons')?.scrollIntoView({ behavior: 'smooth' }),

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

  'run-search': () => catalog.browse(),

  'filter-quality': (el) => {
    patchSlice('search', {
      filters: { ...state.search.filters, quality: el.dataset.quality }
    });
  },

  'toggle-upscaled': (el) => {
    patchSlice('search', {
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

  'job-state': async (el) => {
    try {
      await api.setJobState(el.dataset.id, el.dataset.state);
      await loadJobs();
      syncJobPolling();
    } catch (error) {
      views.toast('error', 'Could not change that job', error.message);
    }
  },

  'move-job': async (el) => {
    try {
      await api.moveJob(el.dataset.id, el.dataset.move);
      await loadJobs();
    } catch (error) {
      views.toast('error', 'Could not reorder', error.message);
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
  'set-subtitle': (el) => {
    // The timing answer was about the track that was showing, so it stops
    // being true the moment a different one is chosen.
    player.clearSubtitleTiming();
    player.setSubtitle(el.dataset.track);
  },
  'subtitle-check-sync': () => player.checkSubtitleTiming(),
  'fetch-subtitles': () => player.fetchSubtitles(),
  'fetch-season-subs': (el) => fetchSeasonSubtitles(el),
  'subs-unavailable': () => views.toast('info', 'Subtitle download is not set up',
    'Add OPENSUBTITLES_API_KEY, _USERNAME and _PASSWORD to .env, then restart.'),
  'settings-step': (el) => settings.stepSetting(el.dataset.field, el.dataset.delta),
  'settings-toggle': (el) => settings.toggleSetting(el.dataset.field),
  'settings-choose': (el) => settings.chooseSetting(el.dataset.field, el.dataset.value),
  'settings-colour': (el) => settings.chooseSubtitleColour(el.dataset.value),
  'settings-reset-appearance': () => settings.resetAppearance(),
  'settings-revoke': (el) => settings.revokeDevice(el.dataset.id),
  'settings-refresh': () => settings.refreshDiagnostics(),
  'settings-kill-encoder': (el) => settings.killEncoder(el.dataset.id),
  'settings-benchmark': () => settings.runBenchmark(),
  'warm-exclude': (el) => settings.editWarmExclude(el.value),
  'warm-rule': async (el) => {
    try {
      await api.setWarmTitleRule(el.dataset.kind, Number(el.dataset.id), el.dataset.choice);
      // Kept on state so the modal redraws with the new choice, and so the
      // Settings page agrees with it without being reloaded.
      const warmPolicy = await api.getWarmPolicy().catch(() => state.settings?.warmPolicy);
      setState({ settings: { ...state.settings, warmPolicy } });
      views.toast('success', el.dataset.choice === 'never'
        ? 'This will not be converted ahead of time'
        : el.dataset.choice === 'always'
          ? 'This will always be converted ahead of time'
          : 'Back to the general rules');
    } catch (error) {
      views.toast('error', 'Could not save that', error.message);
    }
  },
  'warm-title-clear': (el) => settings.clearWarmTitle(el.dataset.kind, el.dataset.id),
  'settings-reset-sources': () => settings.resetSourceStats(),
  'settings-enrol': () => settings.createEnrolment(),
  'settings-push-on': () => settings.enablePush(),
  'settings-push-off': () => settings.disablePush(),
  'settings-push-test': () => settings.testPush(),
  'settings-enrol-cancel': () => settings.cancelEnrolment(),
  'dismiss-changes': async () => {
    // Marked seen on dismissal rather than on load: a banner that cleared
    // itself when fetched would be consumed by a background poll while the
    // tab was shut.
    setState({ changes: null });
    await api.markChangesSeen().catch(() => { /* it will simply show again */ });
  },

  'inspect-result': (el) => search.inspectResult(Number(el.dataset.index)),
  'toggle-inspect-file': (el) => search.toggleInspectFile(el.dataset.filename),
  'download-chosen': () => search.downloadChosen(),
  'close-inspect': () => search.closeInspect(),
  // Only the backdrop itself, so a click inside the dialog does not close it.
  'close-inspect-backdrop': (el, event) => {
    if (event.target === el) search.closeInspect();
  },
  'settings-log-level': (el) => settings.setLogLevel(el.dataset.level),
  'settings-log-follow': () => settings.toggleLogFollow(),
  'settings-env-edit': (el) => settings.editEnv(el.dataset.key, el.value),
  'settings-env-save': () => settings.saveEnv(),
  'settings-env-discard': () => settings.discardEnvEdits(),
  'settings-restart': () => settings.restartServer(),
  'settings-install': () => settings.install(),
  'settings-warm': () => settings.warmLibrary(),
  'settings-unsave': (el) => settings.unsave(el.dataset.path),
  'settings-unsave-all': () => settings.unsaveAll(),
  'save-offline': (el) => saveOffline(el),
  'subtitle-nudge': (el) => player.nudgeSubtitleStyle(el.dataset.field, el.dataset.delta),
  'subtitle-colour': (el) => player.setSubtitleColour(el.dataset.colour),
  'subtitle-reset': () => player.resetSubtitleStyle(),
  'toggle-pitch': () => player.togglePitchMode(),
  'reset-speed': () => player.resetSpeed(),
  'set-quality': (el) => player.setQuality(el.dataset.quality),
  'set-audio-track': (el) => player.setAudioTrack(el.dataset.index),
  'toggle-stats': () => player.toggleStats(),
  'toggle-shortcuts': () => player.toggleShortcuts(),
  'resume-restart': () => player.answerResume('restart'),
  'resume-dismiss': () => player.answerResume('dismiss'),
  'airplay': () => player.showAirplayPicker(),
  'cast': () => player.castToDevice(),
  'skip-intro': () => player.skipIntro(),
  'open-intro-editor': () => player.openIntroEditor(),
  'close-intro-editor': () => player.closeIntroEditor(),
  'intro-zoom': (el) => player.zoomIntro(Number(el.dataset.direction)),
  'intro-nudge': (el) => player.nudgeIntroEdge(el.dataset.edge, Number(el.dataset.delta)),
  'intro-here': (el) => player.setIntroEdgeHere(el.dataset.edge),
  'intro-play': (el) => player.playFromIntroEdge(el.dataset.edge),
  'intro-save': () => player.saveIntroEdits(),
  'intro-forget': () => player.forgetIntroMarker(),
  'prev-episode': () => player.playPrevious(),
  'next-episode': () => player.playNextEpisode(),
  'audio-nudge': (el) => player.nudgeAudioOffset(Number(el.dataset.delta)),
  'audio-reset': () => player.resetAudioOffset(),
  'play-next': () => player.playNext(),
  'cancel-next': () => player.cancelNext()
};

/**
 * Save one file to this device.
 *
 * The button becomes the progress indicator rather than opening a dialog: the
 * download is minutes long on an episode, and a modal that has to stay open
 * for it would stop you doing anything else meanwhile. Pressing it again while
 * it runs cancels.
 */
async function saveOffline(button) {
  const filePath = button.dataset.path;
  const title = button.dataset.title || null;
  if (!filePath) return;

  if (offline.isSaving(filePath)) {
    offline.cancelSave(filePath);
    return;
  }

  const original = button.textContent;
  button.textContent = 'Starting…';

  try {
    await offline.save(filePath, {
      title,
      onProgress: ({ ratio, received, total }) => {
        button.textContent = total > 0
          ? `${Math.round(ratio * 100)}% — tap to cancel`
          : `${Math.round(received / 1e6)} MB`;
      }
    });
    button.textContent = 'Saved';
    views.toast('success', 'Saved to this device', 'It will play with no connection.');
    offline.requestPersistence();
  } catch (error) {
    button.textContent = original;
    if (error.name === 'AbortError') {
      views.toast('info', 'Save cancelled');
    } else if (error.code === 'preparing') {
      views.toast('info', 'Preparing a copy', error.message);
    } else {
      views.toast('error', 'Could not save', error.message);
    }
  }
}

/**
 * Work out what a show is missing, once per show per session.
 *
 * Only for shows that are actually in the library — a discovery result has no
 * seasons to compare against — and only once, because the answer costs a TMDB
 * season lookup per season and does not change while you are looking at it.
 * A failure is silent: the season list is perfectly usable without it.
 */
async function loadMissingFor(item) {
  const tmdbId = item?.tmdb_id;
  if (!tmdbId || !Array.isArray(item.seasons) || item.seasons.length === 0) return;
  if (state.missing[tmdbId]) return;

  try {
    const report = await api.getMissingEpisodes(tmdbId);
    const show = (report.shows || [])[0];
    if (!show) return;

    setState({ missing: { ...state.missing, [tmdbId]: show } });

    /*
     * The modal is drawn once, when currentItem changes, and this answer
     * arrives seconds later — so setState alone repaints the page behind the
     * modal and leaves the modal itself showing the season list without its
     * gaps. It has to be told, and only if it is still showing this title:
     * the report can land after someone has closed it or opened another.
     */
    if (state.currentItem?.tmdb_id === tmdbId) views.renderDetailModal(state.currentItem);
  } catch {
    // The gaps are an extra; the episode list above them still works.
  }
}

/**
 * Download one subtitle per episode of a season.
 *
 * The request is sequential on the server and can take a minute over a long
 * season, so the button holds a pending state for the whole run rather than
 * answering immediately. It is deliberately not a background job: this is a
 * thing you asked for and want to see the result of, and a season is bounded.
 *
 * Episodes that already had a subtitle are skipped rather than replaced, so
 * running this twice is cheap and does not spend the account's daily quota
 * re-fetching what is already on disk.
 */
async function fetchSeasonSubtitles(button) {
  const tmdbId = Number(button.dataset.show);
  const season = Number(button.dataset.season);
  const label = button.textContent;

  button.disabled = true;
  button.textContent = 'Fetching…';

  try {
    const result = await api.fetchSeasonSubtitles({ tmdbId, season });
    const tally = result.tally || {};
    const saved = tally.saved || 0;
    const failed = tally.error || 0;

    const parts = [];
    if (saved) parts.push(`${saved} added`);
    if (tally.skipped) parts.push(`${tally.skipped} already had one`);
    if (tally.none) parts.push(`${tally.none} not found`);
    if (failed) parts.push(`${failed} failed`);
    // Fewer attempts than episodes only happens when the quota ran out.
    if (result.attempted < result.requested) {
      parts.push(`stopped after ${result.attempted} of ${result.requested}`);
    }
    if (result.remaining !== null && result.remaining !== undefined) {
      parts.push(`${result.remaining} downloads left today`);
    }

    views.toast(
      saved === 0 && failed > 0 ? 'error' : 'success',
      `Season ${season} subtitles`,
      parts.join(' · ') || 'Nothing to do'
    );
  } catch (error) {
    views.toast('error', 'Subtitle fetch failed', error.message);
  } finally {
    // A re-render may have replaced this node mid-fetch, in which case these
    // land on a detached element and the fresh button is already enabled.
    button.disabled = false;
    button.textContent = label;
  }
}

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
      catalog.browse({ query: value, genre: '', year: '', rating: '' });
    }
    return;
  }

  if (event.key === '/' ) {
    event.preventDefault();
    /*
     * The header field only exists on a phone now — on desktop the rail
     * carries search instead. offsetParent is null for a display:none element,
     * so this is how we tell whether there is anything to focus; without the
     * check the shortcut silently did nothing on the widest screens.
     */
    const global = document.getElementById('global-search');
    if (global && global.offsetParent !== null) {
      global.focus();
      return;
    }
    navigate('search');
    requestAnimationFrame(() => document.getElementById('search-input')?.focus());
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
    loadMissingFor(state.currentItem);
  }

  if (state.currentPage !== previousPage) {
    previousPage = state.currentPage;
    syncJobPolling();
    if (state.currentPage === 'search') catalog.ensureLoaded();

    // Devices, login history and diagnostics are only worth fetching when the
    // page that shows them is open. Diagnostics walks the cache directories,
    // so asking for it at boot would cost every session a directory scan
    // nobody looked at.
    if (state.currentPage === 'settings') settings.loadSettings();

    /*
     * The encoder panel polls while it is on screen and stops the moment it is
     * not. Left running it would keep asking the server what is encoding from
     * a page nobody is looking at, which is exactly the kind of background
     * traffic that makes a phone's battery the app's problem.
     */
    if (state.currentPage === 'settings') {
      settings.startEncoderWatch();
    } else {
      settings.stopEncoderWatch();
      settings.stopLogFollow();
    }
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

  // The first stream URL asks this browser what it can decode, and the first
  // ask is slow enough to be felt. Get it over with while the library is on
  // screen rather than when somebody presses play.
  api.warmDecoderCapabilities();
  registerServiceWorker();
  install.watch(() => setState({}));
  // An installed app is the case where evicted offline video hurts most, so
  // the request is made once the app is actually installed rather than at boot.
  if (install.isInstalled()) offline.requestPersistence();

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

  /*
   * Page-entry loading is driven by the page CHANGING, and at boot it has not:
   * previousPage is initialised to the current page above. So opening the app
   * straight onto a deep link — or reloading while already there — has to
   * trigger the same load by hand, or the page sits on "Loading…" forever.
   */
  if (state.currentPage === 'settings') {
    settings.loadSettings();
    settings.startEncoderWatch();
  }

  if (state.currentPage === 'search') catalog.ensureLoaded();
  await loadLibrary();
  await loadJobs();

  /*
   * After the library, because it is computed against it: asking first would
   * compare this device's snapshot with a library that has not been scanned
   * yet and report the whole thing as gone.
   */
  api.getChanges().then((changes) => setState({ changes })).catch(() => { /* not worth a toast */ });

  /*
   * The warm rules are small and a title's page needs them to draw its own
   * control, so they are fetched at boot rather than only when Settings is
   * opened — otherwise every title would show "Auto" until you had been there.
   */
  api.getWarmPolicy()
    .then((warmPolicy) => setState({ settings: { ...state.settings, warmPolicy } }))
    .catch(() => { /* the control falls back to Auto, which is the default anyway */ });
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
