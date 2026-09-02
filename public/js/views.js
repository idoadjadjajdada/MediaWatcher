/**
 * Render functions.
 *
 * Everything here returns HTML strings (or writes into a root element) and is
 * otherwise side-effect free. Interaction is wired in app.js through event
 * delegation on [data-action] — CSP forbids inline handlers, and delegation
 * means a re-render never leaves dead listeners behind.
 */
import { state, activeJobCount, locateFile, continueEntry, watchState } from './state.js';

/* --------------------------------------------------------------------------
 * Primitives
 * ----------------------------------------------------------------------- */

/** Escape anything interpolated into HTML — titles come from files and TMDB. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16"/>',
  tv: '<rect x="2" y="6" width="20" height="13" rx="2"/><path d="m8 3 4 3 4-3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  refresh: '<path d="M20 11A8 8 0 1 0 12 20"/><path d="M20 5v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  fullscreen: '<path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9.5 10.5a2 2 0 1 0 0 3M15.5 10.5a2 2 0 1 0 0 3"/>',
  sync: '<path d="M4 8h12l-3-3M20 16H8l3 3"/><path d="M4 8v2M20 16v-2"/>',
  brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5"/>',
  // Circular arrow with a 10 in it — a real "jump back ten seconds", not the
  // skip-to-previous-track glyph these used to be.
  back10: '<path d="M11.5 4.5 7 8l4.5 3.5"/><path d="M7.2 8H14a6 6 0 1 1-6 6" stroke-linejoin="round"/><text x="12" y="17.5" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">10</text>',
  fwd10: '<path d="M12.5 4.5 17 8l-4.5 3.5"/><path d="M16.8 8H10a6 6 0 1 0 6 6" stroke-linejoin="round"/><text x="12" y="17.5" font-size="7.5" font-weight="700" fill="currentColor" stroke="none" text-anchor="middle">10</text>',
  prevEp: '<path d="M17 5 9 12l8 7"/><path d="M6 5v14"/>',
  nextEp: '<path d="m7 5 8 7-8 7"/><path d="M18 5v14"/>',
  warning: '<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  // A screen with an upward arrow: sending this picture somewhere else.
  airplay: '<path d="M5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1"/><path d="M12 15l5 6H7l5-6z" fill="currentColor" stroke="none"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v7H3v-7z"/>'
};

export function icon(name, className = '') {
  const body = ICONS[name] || '';
  const fill = name === 'play' ? 'currentColor' : 'none';
  // Default to a sized class. Called bare, this produced <svg class=""> which
  // laid out at 0x0 and made the mobile menu button invisible.
  const cls = className || 'icon';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function playIcon(className = '') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
}

export function pauseIcon(className = '') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;
}

/* --------------------------------------------------------------------------
 * Formatting
 * ----------------------------------------------------------------------- */

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

/** Seconds → "1:04:12" or "4:12". */
export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatRuntime(minutes) {
  const value = Number(minutes);
  if (!value) return null;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const pad2 = (n) => String(n).padStart(2, '0');
export const episodeTag = (season, episode) =>
  episode == null ? `S${pad2(season ?? 0)}` : `S${pad2(season ?? 0)}E${pad2(episode)}`;

/* --------------------------------------------------------------------------
 * Toasts
 * ----------------------------------------------------------------------- */

const TOAST_LIMIT = 4;

export function toast(type, title, text = '') {
  const root = document.getElementById('toast-root');
  if (!root) return;

  while (root.children.length >= TOAST_LIMIT) root.firstElementChild.remove();

  const node = document.createElement('div');
  node.className = `toast toast--${type}`;
  node.innerHTML = `
    <div class="toast__body">
      <div class="toast__title">${esc(title)}</div>
      ${text ? `<div class="toast__text">${esc(text)}</div>` : ''}
    </div>`;
  root.appendChild(node);

  setTimeout(() => {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // Belt and braces if the animation never fires (reduced motion).
    setTimeout(() => node.remove(), 400);
  }, 3500);
}

/* --------------------------------------------------------------------------
 * Shared fragments
 * ----------------------------------------------------------------------- */

export function emptyState({ iconName = 'inbox', title, text, action }) {
  return `
    <div class="empty">
      <div class="empty__icon">${icon(iconName)}</div>
      <div class="empty__title">${esc(title)}</div>
      ${text ? `<p class="empty__text">${esc(text)}</p>` : ''}
      ${action ? `<button class="btn btn--primary empty__action" data-action="${esc(action.action)}"${action.page ? ` data-page="${esc(action.page)}"` : ''}>${esc(action.label)}</button>` : ''}
    </div>`;
}

export function loadingState(label = 'Loading…') {
  return `<div class="loading-state"><div class="spinner spinner--lg"></div><span>${esc(label)}</span></div>`;
}

/**
 * One poster card, used for library and discovery alike.
 * The underline is the only thing distinguishing them: full bar = owned,
 * partial = watch progress, absent = discoverable.
 */
export function posterCard(item, type, { owned = false, progress = null } = {}) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  const action = owned
    ? `data-action="open-detail" data-type="${esc(type)}" data-id="${item.tmdb_id}"`
    : `data-action="open-discover" data-type="${esc(type)}" data-id="${item.tmdb_id}"`;

  const width = progress === null ? 100 : Math.max(2, Math.min(100, progress * 100));
  const bar = owned
    ? `<div class="card__owned"><span style="width:${width.toFixed(1)}%"></span></div>`
    : '';

  return `
    <article class="card" ${action} tabindex="0" aria-label="${esc(item.title)}">
      <div class="card__art">
        ${poster}
        ${bar}
      </div>
      <div class="card__title t-card">${esc(item.title)}</div>
      <div class="card__meta">${item.year || ''}</div>
    </article>`;
}

/** A horizontal row. One component for every row in the app. */
/**
 * A Continue Watching card.
 *
 * Episodes get their own still, label, description and air year, because the
 * show's poster and first-aired year tell you nothing about where you are.
 * Movies keep their poster - that is how a film is recognised - and reveal a
 * frame from where you stopped on hover, loaded lazily by app.js.
 */
export function continueCard(entry) {
  const isEpisode = entry.type === 'episode';
  const art = entry.art
    ? `<img class="continue__img" loading="lazy" alt="" src="${esc(entry.art)}">`
    : `<div class="card__placeholder">${esc(entry.title)}</div>`;

  const width = Math.max(2, Math.min(100, entry.progress * 100));

  return `
    <article class="continue ${isEpisode ? 'continue--episode' : 'continue--movie'}"
      data-action="resume" data-path="${esc(entry.filePath)}"
      data-position="${entry.position}" tabindex="0"
      aria-label="Resume ${esc(entry.title)}${entry.subtitle ? `, ${esc(entry.subtitle)}` : ''}">
      <div class="continue__art">
        ${art}
        ${isEpisode ? '' : '<div class="continue__frame" aria-hidden="true"></div>'}
        <div class="continue__play">${playIcon('icon-lg')}</div>
        <div class="card__owned"><span style="width:${width.toFixed(1)}%"></span></div>
      </div>
      <div class="continue__body">
        <div class="continue__title t-card">${esc(entry.title)}</div>
        ${entry.subtitle ? `<div class="continue__sub">${esc(entry.subtitle)}</div>` : ''}
        <div class="continue__meta">${entry.year || ''}</div>
        ${entry.description ? `<div class="continue__desc">${esc(entry.description)}</div>` : ''}
      </div>
    </article>`;
}

export function rail(title, cardsHtml, { count = null } = {}) {
  return `
    <section class="row">
      <div class="row__head">
        <h2 class="t-section">${esc(title)}</h2>
        ${count !== null ? `<span class="t-meta">${esc(count)}</span>` : ''}
      </div>
      <div class="row__wrap">
        <button class="row__arrow row__arrow--prev" data-action="rail-scroll" data-dir="-1" aria-label="Scroll left">${icon('back', 'icon')}</button>
        <div class="rail">${cardsHtml}</div>
        <button class="row__arrow row__arrow--next" data-action="rail-scroll" data-dir="1" aria-label="Scroll right">${icon('chevron', 'icon')}</button>
      </div>
    </section>`;
}



/* --------------------------------------------------------------------------
 * Shell
 * ----------------------------------------------------------------------- */

const NAV = [
  { page: 'home', label: 'Home', iconName: 'home' },
  { page: 'movies', label: 'Movies', iconName: 'film' },
  { page: 'shows', label: 'Shows', iconName: 'tv' },
  { page: 'search', label: 'Search', iconName: 'search' },
  { page: 'downloads', label: 'Downloads', iconName: 'download' }
];

/** Build the persistent chrome once; pages render into `.main` afterwards. */
export function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="app-shell">
      <aside class="navrail" id="navrail">
        <div class="navrail__mark">${playIcon()}</div>
        <nav class="navrail__nav">
          ${NAV.map((entry) => `
            <button class="navrail__item" data-action="navigate" data-page="${entry.page}" aria-label="${entry.label}" title="${entry.label}">
              ${icon(entry.iconName, 'icon')}
              ${entry.page === 'downloads' ? '<span class="navrail__badge" id="jobs-badge" hidden>0</span>' : ''}
            </button>`).join('')}
        </nav>
        <button class="navrail__item navrail__item--foot" data-action="rescan" id="rescan-btn" aria-label="Rescan" title="Rescan library">
          ${icon('refresh', 'icon')}
        </button>
      </aside>

      <header class="topbar">
        <div class="topbar__search">
          ${icon('search', 'icon-sm')}
          <input class="input topbar__input" id="global-search" type="search" placeholder="Search" autocomplete="off">
        </div>
        <button class="btn btn--secondary topbar__add" data-action="add-torrent" aria-label="Add torrent">
          ${icon('plus', 'icon-sm')}<span class="btn__label">Add</span>
        </button>
      </header>

      <main class="main" id="main"></main>

      <nav class="tabbar" id="tabbar">
        ${NAV.map((entry) => `
          <button class="tabbar__item" data-action="navigate" data-page="${entry.page}">
            ${icon(entry.iconName, 'icon')}
            <span class="tabbar__label">${entry.label}</span>
            ${entry.page === 'downloads' ? '<span class="tabbar__badge" id="jobs-badge-m" hidden>0</span>' : ''}
          </button>`).join('')}
      </nav>
    </div>`;
}

/** Cheap per-render updates that don't need the shell rebuilt. */
export function updateShell() {
  // Both nav surfaces exist in the DOM at all times; CSS decides which is shown.
  document.querySelectorAll('.navrail__item, .tabbar__item').forEach((node) => {
    if (!node.dataset.page) return;
    node.classList.toggle('is-active', node.dataset.page === state.currentPage);
  });

  const count = activeJobCount();
  for (const id of ['jobs-badge', 'jobs-badge-m']) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  const rescan = document.getElementById('rescan-btn');
  if (rescan) {
    rescan.disabled = state.scanning;
    rescan.classList.toggle('is-busy', state.scanning);
  }
}

/* --------------------------------------------------------------------------
 * Pages
 * ----------------------------------------------------------------------- */

export function renderHome() {
  const { movies, shows } = state.library;
  const all = [...movies, ...shows];

  if (state.loading) return loadingState('Loading your library…');

  if (all.length === 0) {
    return emptyState({
      iconName: 'inbox',
      title: 'Your library is empty',
      text: 'Drop video files into library/movies or library/shows, or search for something to download.',
      action: { label: 'Search for something', action: 'navigate', page: 'search' }
    });
  }

  const hero = pickHero(state.library, state.progress);
  const ownedIds = new Set(all.map((entry) => entry.tmdb_id));

  const continueCards = state.progress
    .map((row) => continueEntry(row, state.library))
    .filter(Boolean)
    .map(continueCard)
    .join('');

  /* Library rails, collapsed by size. With a handful of titles, "Recently
     added" and "Your library" are the same posters twice, directly under
     Continue watching showing them a third time. */
  const byNewest = all.slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a));
  const cardFor = (entry) =>
    posterCard(entry, Array.isArray(entry.seasons) ? 'show' : 'movie', { owned: true });

  const libraryRails = byNewest.length > 8
    ? rail('Recently added', byNewest.slice(0, 20).map(cardFor).join(''))
      + rail('Your library', byNewest.map(cardFor).join(''), { count: `${byNewest.length} titles` })
    : rail('Your library', byNewest.map(cardFor).join(''), { count: `${byNewest.length} titles` });

  const discoverRails = (state.discover.rails || []).map((entry) => rail(
    entry.title,
    (entry.items || []).map((title) => posterCard(
      title,
      title.type === 'show' ? 'show' : 'movie',
      { owned: ownedIds.has(title.tmdb_id) }
    )).join('')
  )).join('');

  return `
    ${hero ? renderHero(hero) : ''}
    <div class="page">
      ${continueCards ? rail('Continue watching', continueCards) : ''}
      ${libraryRails}
      ${discoverRails}
    </div>`;
}

function renderHero(hero) {
  const { item, type, file, located } = hero;
  const isShow = type === 'show';

  let line;
  if (located && located.type === 'episode') {
    const title = located.episode.title ? ` · ${located.episode.title}` : '';
    line = `${episodeTag(located.season, located.episode.episode_number)}${title}`;
  } else {
    line = [item.year, formatRuntime(item.runtime), (item.genres || [])[0]]
      .filter(Boolean).join(' · ');
  }

  const remaining = hero.resumeRow && hero.resumeRow.duration > 0
    ? ` · ${formatTime(hero.resumeRow.duration - hero.resumeRow.position)} left`
    : '';

  return `
    <section class="hero">
      ${item.backdrop ? `<img class="hero__art" alt="" src="${esc(item.backdrop)}">` : ''}
      <div class="hero__scrim"></div>
      <div class="hero__body">
        <h1 class="hero__title t-hero">${esc(item.title)}</h1>
        <div class="hero__meta t-meta">${esc(line)}${esc(remaining)}</div>
        ${item.overview ? `<p class="hero__overview">${esc(item.overview)}</p>` : ''}
        <div class="hero__actions">
          ${file ? `<button class="btn btn--primary" data-action="play" data-path="${esc(file.file_path)}">
            ${playIcon('icon-sm')}${hero.resumeRow ? 'Resume' : 'Play'}</button>` : ''}
          <button class="btn btn--secondary" data-action="open-detail" data-type="${isShow ? 'show' : 'movie'}" data-id="${item.tmdb_id}">More info</button>
        </div>
      </div>
    </section>`;
}

/**
 * Which title leads the page.
 *
 * The old rule picked at random on every render, so the hero changed identity
 * whenever state updated. Prefer the thing you were last watching, so Resume
 * actually means something.
 */
export function pickHero(library, progress) {
  const all = [...library.movies, ...library.shows];
  if (all.length === 0) return null;

  for (const row of progress) {
    const located = locateFile(row.file_path);
    if (!located) continue;
    return {
      item: located.item,
      type: located.type === 'episode' ? 'show' : 'movie',
      file: { file_path: row.file_path },
      resumeRow: row,
      located
    };
  }

  const withArt = all.filter((entry) => entry.backdrop);
  const pool = withArt.length > 0 ? withArt : all;
  const item = pool.slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a))[0];
  const isShow = Array.isArray(item.seasons);
  return {
    item,
    type: isShow ? 'show' : 'movie',
    file: isShow ? firstEpisodeFile(item) : (item.files || [])[0],
    resumeRow: null,
    located: null
  };
}

function newestAddedAt(item) {
  let newest = 0;
  for (const file of item.files || []) newest = Math.max(newest, file.added_at || 0);
  for (const season of item.seasons || []) {
    for (const episode of season.episodes) {
      for (const file of episode.files || []) newest = Math.max(newest, file.added_at || 0);
    }
  }
  return newest;
}

function firstEpisodeFile(show) {
  for (const season of show.seasons || []) {
    for (const episode of season.episodes) {
      if (episode.files && episode.files.length > 0) return episode.files[0];
    }
  }
  return null;
}

export function renderMovies() {
  if (state.loading) return loadingState('Loading movies…');
  const { movies } = state.library;

  if (movies.length === 0) {
    return `<div class="page">
      <div class="page__head"><h1 class="t-hero">Movies</h1></div>
      ${emptyState({
    iconName: 'film',
    title: 'No movies yet',
    text: 'Add files under library/movies and press Rescan, or find something to download.',
    action: { label: 'Search for a movie', action: 'navigate', page: 'search' }
  })}</div>`;
  }

  return `
    <div class="page">
      <div class="page__head">
        <h1 class="t-hero">Movies</h1>
        <span class="t-meta">${movies.length} title${movies.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid">${movies.map((movie) => posterCard(movie, 'movie', { owned: true })).join('')}</div>
    </div>`;
}

export function renderShows() {
  if (state.loading) return loadingState('Loading shows…');
  const { shows } = state.library;

  if (shows.length === 0) {
    return `<div class="page">
      <div class="page__head"><h1 class="t-hero">Shows</h1></div>
      ${emptyState({
    iconName: 'tv',
    title: 'No shows yet',
    text: 'Add files under library/shows/<Show Name>/Season 01 and press Rescan.',
    action: { label: 'Search for a show', action: 'navigate', page: 'search' }
  })}</div>`;
  }

  return `
    <div class="page">
      <div class="page__head">
        <h1 class="t-hero">Shows</h1>
        <span class="t-meta">${shows.length} title${shows.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid">${shows.map((show) => posterCard(show, 'show', { owned: true })).join('')}</div>
    </div>`;
}

export function renderDownloads() {
  const { jobs } = state;

  const header = `
    <div class="page__head">
      <h1 class="t-hero">Downloads</h1>
      ${jobs.length ? `<span class="t-meta">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>` : ''}
    </div>`;

  if (jobs.length === 0) {
    return `<div class="page">${header}${emptyState({
      iconName: 'download',
      title: 'Nothing downloading',
      text: 'Downloads you start from Search show up here with live progress.',
      action: { label: 'Find something', action: 'navigate', page: 'search' }
    })}</div>`;
  }

  return `<div class="page">${header}<div class="job-list">${jobs.map(jobRow).join('')}</div></div>`;
}

function jobRow(job) {
  const percent = Math.round((Number(job.progress) || 0) * 100);
  const active = job.status === 'downloading' || job.status === 'queued';

  const actions = job.status === 'error'
    ? `<button class="btn btn--secondary" data-action="retry-job" data-id="${esc(job.id)}">Retry</button>
       <button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Remove</button>`
    : job.status === 'complete'
      ? `<button class="btn btn--secondary" data-action="open-folder" data-path="${esc(job.file_path || '')}">${icon('folder', 'icon-sm')}<span class="btn__label">Open Folder</span></button>
         <button class="btn btn--ghost btn--icon" data-action="cancel-job" data-id="${esc(job.id)}" aria-label="Remove">${icon('trash')}</button>`
      : `<button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>`;

  return `
    <div class="job">
      <div class="job__head">
        <span class="job__title">${esc(job.title)}</span>
        <span class="badge badge--${esc(job.status)}">${esc(job.status)}</span>
      </div>
      <div class="job__actions">${actions}</div>
      ${job.error ? `<div class="job__error">${esc(job.error)}</div>` : `
        <div class="job__progress">
          <div class="progress progress--lg"><div class="progress__fill" style="width:${percent}%"></div></div>
          <div class="job__stats">
            <span>${percent}%${job.phase ? ` · ${esc(job.phase)}` : ''}${active && !job.phase ? ' · waiting' : ''}</span>
            <span>${job.status === 'complete' ? 'Finished' : ''}</span>
          </div>
        </div>`}
    </div>`;
}

/* --------------------------------------------------------------------------
 * Detail modal
 * ----------------------------------------------------------------------- */

export function renderDetailModal(item) {
  const root = document.getElementById('modal-root');
  if (!root) return;

  if (!item) {
    root.innerHTML = '';
    return;
  }

  // A discovery item has no files and no library-shaped seasons, so it carries
  // its type explicitly. Library items keep the old inference.
  const isShow = item.media_type ? item.media_type === 'show' : Boolean(item.seasons);
  const firstFile = isShow ? firstEpisodeFile(item) : (item.files || [])[0];
  const unowned = item.owned === false;

  root.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(item.title)}">
        <button class="modal__close" data-action="close-modal" aria-label="Close">${icon('close')}</button>
        <div class="modal__hero">
          ${item.backdrop ? `<img class="modal__backdrop" alt="" src="${esc(item.backdrop)}">` : ''}
        </div>
        <div class="modal__body">
          <h2 class="modal__title">${esc(item.title)}</h2>
          <div class="modal__chips">
            ${item.rating ? `<span class="badge">★ ${item.rating}</span>` : ''}
            ${item.year ? `<span class="badge">${item.year}</span>` : ''}
            ${formatRuntime(item.runtime) ? `<span class="badge">${formatRuntime(item.runtime)}</span>` : ''}
            ${(item.genres || []).map((genre) => `<span class="badge">${esc(genre)}</span>`).join('')}
          </div>
          ${item.overview ? `<p class="modal__overview" id="modal-overview">${esc(item.overview)}</p>
            <button class="modal__more" data-action="expand-overview">Show more</button>` : ''}
          <div class="modal__actions">
            ${firstFile
    ? `<button class="btn btn--primary" data-action="play" data-path="${esc(firstFile.file_path)}">${playIcon('icon-sm')}Play</button>`
    : ''}
            <button class="btn ${unowned ? 'btn--primary' : 'btn--secondary'}"
                    data-action="find-torrents"
                    data-type="${isShow ? 'show' : 'movie'}"
                    data-id="${item.tmdb_id}"
                    data-title="${esc(item.title)}">${unowned ? 'Find torrents' : 'Find More'}</button>
          </div>
          ${unowned && isShow
    ? '<p class="modal__hint">Shows are indexed one episode at a time — pick a season and episode on the next screen.</p>'
    : ''}

          ${(item.cast || []).length ? `
            <h3 style="margin-bottom:16px">Cast</h3>
            <div class="cast">
              ${item.cast.map((person) => `
                <div class="cast__person">
                  ${person.profile
    ? `<img class="cast__photo" loading="lazy" alt="" src="${esc(person.profile)}">`
    : '<div class="cast__photo"></div>'}
                  <div class="cast__name">${esc(person.name)}</div>
                  <div class="cast__role">${esc(person.character || '')}</div>
                </div>`).join('')}
            </div>` : ''}

          ${/* Gated on having the data, not on being a show: a discovery item
                is a show with no seasons array at all, and this used to lean on
                isShow being derived from item.seasons. */
    isShow && Array.isArray(item.seasons) && item.seasons.length ? `
            <h3 style="margin:24px 0 8px">Episodes</h3>
            ${item.seasons.map((season, index) => renderSeason(item, season, index === 0)).join('')}` : ''}
        </div>
      </div>
    </div>`;
}

function renderSeason(show, season, open) {
  // The bulk fetch sits beside the toggle rather than inside it: a button
  // nested in a button is invalid, and clicking it would also collapse the
  // season it had just started working on.
  const canFetch = Boolean(state.subtitles?.download && show.tmdb_id);

  return `
    <div class="season${open ? ' is-open' : ''}">
      <div class="season__head">
        <button class="season__toggle" data-action="toggle-season">
          ${icon('chevron', 'season__chevron')}
          Season ${pad2(season.number)}
          <span class="season__count">${season.episodes.length} episode${season.episodes.length === 1 ? '' : 's'}</span>
        </button>
        ${canFetch ? `
        <button class="season__subs" data-action="fetch-season-subs"
          data-show="${show.tmdb_id}" data-season="${season.number}"
          title="Download subtitles for every episode of this season">Subtitles</button>` : ''}
      </div>
      <div class="season__episodes">
        ${season.episodes.map((episode) => {
    const file = (episode.files || [])[0];
    // Watch state comes from every progress row, not the Continue Watching
    // subset, so an episode you finished still reads as watched here.
    const seen = watchState(file ? state.watched[file.file_path] : null);

    return `
          <div class="episode${seen.watched ? ' is-watched' : ''}${seen.started && !seen.watched ? ' is-started' : ''}"
            ${file ? ` data-action="play" data-path="${esc(file.file_path)}"` : ''}>
            <div class="episode__art">
              ${episode.still
    ? `<img class="episode__still" loading="lazy" alt="" src="${esc(episode.still)}">`
    : '<div class="episode__still"></div>'}
              ${seen.started ? `<div class="episode__bar"><span style="width:${seen.percent.toFixed(1)}%"></span></div>` : ''}
              ${seen.watched ? `<div class="episode__seen" title="Watched">${icon('check')}</div>` : ''}
            </div>
            <div>
              <div class="episode__title">
                <span class="episode__number">${episode.episode_number ?? '–'}.</span>
                ${esc(episode.title || 'Untitled episode')}
              </div>
              ${episode.overview ? `<div class="episode__overview">${esc(episode.overview)}</div>` : ''}
              ${seen.started && !seen.watched && seen.remaining
    ? `<div class="episode__left">${formatTime(seen.remaining)} left</div>` : ''}
            </div>
            ${file ? `<button class="btn btn--ghost btn--icon" aria-label="Play">${playIcon()}</button>` : '<span class="badge">missing</span>'}
          </div>`;
  }).join('')}
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
 * Player markup (behaviour lives in player.js)
 * ----------------------------------------------------------------------- */

export function renderPlayer({ title, subtitle, modeLabel, lossless }) {
  return `
    <div class="player" id="player" tabindex="-1">
      <!--
        x-webkit-airplay lets Safari offer the stream to an Apple TV. It only
        works because everything that needs ffmpeg is HLS now; AirPlay will not
        take an arbitrary progressive stream.
      -->
      <video class="player__video" id="player-video" playsinline x-webkit-airplay="allow"></video>

      <!--
        ASS subtitles are drawn here rather than through a <track>, which
        cannot express their positioning. Sits above the video and below the
        controls, and ignores pointer events so it never eats a tap meant for
        the video underneath.
      -->
      <div class="player__ass" id="player-ass" aria-hidden="true"></div>

      <div class="player__touch" id="player-touch" aria-hidden="true">
        <div class="player__ripple player__ripple--l" id="ripple-l"><span>-10s</span></div>
        <div class="player__ripple player__ripple--r" id="ripple-r"><span>+10s</span></div>
      </div>

      <div class="player__spinner"><div class="spinner spinner--lg"></div></div>

      <!--
        Says where it picked up and offers to start over, without standing in
        front of the video. It replaced a blocking sheet with Resume and Start
        over: on iOS that sheet would not dismiss, and because it covered the
        whole player a control that fails to respond means the show cannot be
        watched at all. This way the worst case is a pill that lingers.
      -->
      <div class="player__resumed" id="resume-card" hidden>
        <span class="player__resumed-text">Resumed from <b class="t-num" id="resume-time">0:00</b></span>
        <button class="player__resumed-btn" data-action="resume-restart" id="resume-restart-btn">Start over</button>
        <button class="player__resumed-close" data-action="resume-dismiss" aria-label="Dismiss">${icon('close', 'icon')}</button>
      </div>

      <div class="player__shortcuts" id="shortcuts-card" hidden>
        <div class="player__shortcuts-head">
          <strong>Keyboard shortcuts</strong>
          <button class="player__btn" data-action="toggle-shortcuts" aria-label="Close">${icon('close', 'icon')}</button>
        </div>
        <dl class="player__shortcuts-list">
          <dt>Space / K</dt><dd>Play or pause</dd>
          <dt>&larr; &rarr;</dt><dd>Skip 10 seconds</dd>
          <dt>&uarr; &darr;</dt><dd>Volume</dd>
          <dt>M</dt><dd>Mute</dd>
          <dt>F</dt><dd>Fullscreen</dd>
          <dt>N</dt><dd>Next episode</dd>
          <dt>[ ]</dt><dd>Audio delay</dd>
          <dt>I</dt><dd>Playback stats</dd>
          <dt>?</dt><dd>This list</dd>
          <dt>Esc</dt><dd>Back out one layer</dd>
        </dl>
      </div>

      <div class="player__top">
        <button class="player__btn" data-action="close-player" aria-label="Back">${icon('back', 'icon-lg')}</button>
        <div class="player__heading">
          <div class="player__title">${esc(title)}</div>
          ${subtitle ? `<div class="player__subtitle">${esc(subtitle)}</div>` : ''}
        </div>
        ${modeLabel ? `<span class="badge${lossless ? '' : ' badge--warn'} player__mode">${esc(modeLabel)}</span>` : ''}
      </div>

      <button class="player__skip-intro" id="skip-intro" data-action="skip-intro" hidden>
        Skip intro
      </button>

      <div class="next-up" id="next-up" hidden>
        <div class="next-up__label">Up next</div>
        <div class="next-up__title" id="next-up-title"></div>
        <div class="next-up__actions">
          <button class="btn btn--primary" data-action="play-next">Play now</button>
          <button class="btn btn--ghost" data-action="cancel-next">Cancel</button>
        </div>
      </div>

      <button class="player__eparrow" id="ep-arrow" data-action="toggle-episodes"
        aria-label="Episodes" title="Episodes" hidden>${icon('back', 'icon-lg')}</button>

      <aside class="player__episodes" id="ep-panel" hidden>
        <div class="player__ep-head">
          <div class="player__ep-title" id="ep-show"></div>
          <button class="player__btn" data-action="close-episodes" aria-label="Close">${icon('close', 'icon')}</button>
        </div>
        <div class="player__ep-tabs" id="ep-tabs"></div>
        <div class="player__ep-list" id="ep-list"></div>
      </aside>

      <div class="player__stats" id="player-stats" hidden aria-live="off"></div>

      <div class="player__controls">
        <div class="player__scrub" id="scrub">
          <input class="range" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
          <div class="player__band" id="preview-band" aria-hidden="true"></div>
          <div class="player__knob" id="seek-knob" aria-hidden="true"></div>
          <div class="player__ball" id="preview-ball" aria-hidden="true"></div>
          <div class="player__card" id="preview-card" aria-hidden="true">
            <div class="player__card-frame" id="preview-frame"></div>
            <div class="player__card-time t-num" id="preview-time">0:00</div>
          </div>
        </div>
        <div class="player__times t-num">
          <span id="time-current">0:00</span>
          <span id="time-total">0:00</span>
        </div>
        <div class="player__buttons">
          <div class="player__buttons-left">
            <div class="player__volume">
              <button class="player__btn" data-action="toggle-mute" id="mute-btn" aria-label="Mute">${icon('volume', 'icon')}</button>
              <input class="range range--vol" id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
            </div>
          </div>

          <div class="player__transport">
            <button class="player__btn player__btn--ep" data-action="prev-episode" aria-label="Previous episode" title="Previous episode">${icon('prevEp', 'icon')}</button>
            <button class="player__btn" data-action="seek-back" aria-label="Back 10 seconds" title="Back 10s">${icon('back10', 'icon-lg')}</button>
            <button class="player__btn player__btn--play" data-action="toggle-play" id="play-btn" aria-label="Play">${playIcon('icon-lg')}</button>
            <button class="player__btn" data-action="seek-forward" aria-label="Forward 10 seconds" title="Forward 10s">${icon('fwd10', 'icon-lg')}</button>
            <button class="player__btn player__btn--ep" data-action="next-episode" aria-label="Next episode" title="Next episode">${icon('nextEp', 'icon')}</button>
          </div>

          <div class="player__buttons-right" id="player-settings">
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="subs"
                aria-label="Subtitles" title="Subtitles">${icon('cc', 'icon')}</button>
              <div class="player__pop-panel" id="popover-subs" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="sync"
                aria-label="Audio delay" title="Audio delay">${icon('sync', 'icon')}</button>
              <div class="player__pop-panel" id="popover-sync" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn player__btn--rate" data-action="toggle-popover" data-popover="speed"
                aria-label="Playback speed" title="Playback speed" id="rate-btn">1&times;</button>
              <div class="player__pop-panel" id="popover-speed" hidden></div>
            </div>
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="picture"
                aria-label="Picture" title="Brightness and contrast">${icon('brightness', 'icon')}</button>
              <div class="player__pop-panel" id="popover-picture" hidden></div>
            </div>
            <button class="player__btn" data-action="airplay" id="airplay-btn"
              aria-label="AirPlay" title="AirPlay" hidden>${icon('airplay', 'icon')}</button>
            <button class="player__btn" data-action="toggle-fullscreen" aria-label="Fullscreen">${icon('fullscreen', 'icon')}</button>
          </div>
        </div>
      </div>
    </div>`;
}

export default {
  esc, icon, playIcon, pauseIcon, toast,
  formatBytes, formatTime, formatRuntime, episodeTag,
  emptyState, loadingState,
  renderShell, updateShell,
  renderHome, renderMovies, renderShows, renderDownloads,
  renderDetailModal, renderPlayer
};
