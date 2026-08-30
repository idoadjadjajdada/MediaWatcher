/**
 * Render functions.
 *
 * Everything here returns HTML strings (or writes into a root element) and is
 * otherwise side-effect free. Interaction is wired in app.js through event
 * delegation on [data-action] — CSP forbids inline handlers, and delegation
 * means a re-render never leaves dead listeners behind.
 */
import { state, recentlyAdded, activeJobCount, locateFile } from './state.js';

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
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  fullscreen: '<path d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  back10: '<path d="M11 5 4 12l7 7"/><path d="M20 5v14"/>',
  fwd10: '<path d="m13 5 7 7-7 7"/><path d="M4 5v14"/>',
  warning: '<path d="M12 4 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v7H3v-7z"/>'
};

export function icon(name, className = '') {
  const body = ICONS[name] || '';
  const fill = name === 'play' ? 'currentColor' : 'none';
  return `<svg class="${className}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
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

function posterCard(item, type) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  return `
    <article class="card" data-action="open-detail" data-type="${type}" data-id="${item.tmdb_id}" tabindex="0">
      ${poster}
      <div class="card__play"><div class="card__play-button">${playIcon()}</div></div>
      <div class="card__overlay">
        <div class="card__title">${esc(item.title)}</div>
        <div class="card__meta">${item.year || '—'}${item.rating ? ` · ★ ${item.rating}` : ''}</div>
      </div>
    </article>`;
}

/**
 * A discovery card. Owned titles route to the normal library modal so they
 * behave exactly like a card on the Movies or Shows page.
 */
function discoverCard(item) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  const action = item.owned
    ? `data-action="open-detail" data-type="${esc(item.type)}" data-id="${item.tmdb_id}"`
    : `data-action="open-discover" data-type="${esc(item.type)}" data-id="${item.tmdb_id}"`;

  return `
    <article class="card" ${action} tabindex="0">
      ${poster}
      ${item.owned ? '<span class="card__owned">In library</span>' : ''}
      <div class="card__play"><div class="card__play-button">${playIcon()}</div></div>
      <div class="card__overlay">
        <div class="card__title">${esc(item.title)}</div>
        <div class="card__meta">${item.year || '—'}${item.rating ? ` · ★ ${item.rating}` : ''}</div>
      </div>
    </article>`;
}

/** The discovery section, or nothing at all when no rail loaded. */
function discoverRails() {
  const { rails } = state.discover;
  if (!rails.length) return '';

  return rails.map((rail) => `
    <section class="section">
      <div class="section__header">
        <h2 class="section__title">${esc(rail.title)}</h2>
      </div>
      <div class="rail">${rail.items.map(discoverCard).join('')}</div>
    </section>`).join('');
}

function continueCard(entry) {
  const { row, item, label, backdrop } = entry;
  const percent = row.duration > 0 ? Math.min(100, (row.position / row.duration) * 100) : 0;
  const remaining = row.duration > 0 ? formatTime(row.duration - row.position) : '';

  return `
    <article class="card card--backdrop" data-action="play" data-path="${esc(row.file_path)}" tabindex="0">
      ${backdrop
    ? `<img class="card__image" loading="lazy" alt="" src="${esc(backdrop)}">`
    : '<div class="card__image"></div>'}
      <div class="card__body">
        <div class="card__title">${esc(item ? item.title : row.title || 'Unknown')}</div>
        <div class="card__meta">${esc(label)}${remaining ? ` · ${remaining} left` : ''}</div>
      </div>
      <div class="card__progress"><div class="progress"><div class="progress__fill" style="width:${percent.toFixed(1)}%"></div></div></div>
    </article>`;
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
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand__mark">${playIcon()}</div>
          <span class="brand__name">MediaWatcher</span>
        </div>
        <nav class="nav" id="nav">
          ${NAV.map((entry) => `
            <button class="nav__item" data-action="navigate" data-page="${entry.page}">
              ${icon(entry.iconName, 'nav__icon')}
              <span class="nav__label">${entry.label}</span>
              ${entry.page === 'downloads' ? '<span class="nav__badge" id="jobs-badge" hidden>0</span>' : ''}
            </button>`).join('')}
        </nav>
        <div class="sidebar__separator"></div>
        <div class="sidebar__footer">
          <button class="btn btn--secondary" style="width:100%" data-action="rescan" id="rescan-btn">
            ${icon('refresh', 'btn__icon')}<span class="btn__label">Rescan</span>
          </button>
        </div>
      </aside>

      <header class="topbar">
        <button class="btn btn--ghost btn--icon topbar__menu" data-action="toggle-drawer" aria-label="Menu">${icon('menu')}</button>
        <div class="topbar__search">
          ${icon('search', 'topbar__search-icon')}
          <input class="input" id="global-search" type="search" placeholder="Search your library or find something new…" autocomplete="off">
        </div>
        <div class="topbar__actions">
          <button class="btn btn--secondary" data-action="add-torrent">${icon('plus', 'btn__icon')}<span class="btn__label">Add Torrent</span></button>
        </div>
      </header>

      <main class="main" id="main"></main>
    </div>`;
}

/** Cheap per-render updates that don't need the shell rebuilt. */
export function updateShell() {
  document.querySelectorAll('.nav__item').forEach((node) => {
    node.classList.toggle('is-active', node.dataset.page === state.currentPage);
  });

  const badge = document.getElementById('jobs-badge');
  if (badge) {
    const count = activeJobCount();
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('is-open', state.drawerOpen);

  const scrim = document.querySelector('.drawer-scrim');
  if (state.drawerOpen && !scrim) {
    const node = document.createElement('div');
    node.className = 'drawer-scrim';
    node.dataset.action = 'toggle-drawer';
    document.body.appendChild(node);
  } else if (!state.drawerOpen && scrim) {
    scrim.remove();
  }

  const rescan = document.getElementById('rescan-btn');
  if (rescan) {
    rescan.disabled = state.scanning;
    const label = rescan.querySelector('.btn__label');
    if (label) label.textContent = state.scanning ? 'Scanning…' : 'Rescan';
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
      text: 'Drop video files into library/movies or library/shows and hit Rescan, or search for something to download.',
      action: { label: 'Search for something', action: 'navigate', page: 'search' }
    });
  }

  // Hero: a random item, but only one with artwork to show.
  const withArt = all.filter((entry) => entry.backdrop);
  const hero = (withArt.length > 0 ? withArt : all)[Math.floor(Math.random() * (withArt.length || all.length))];
  const heroIsShow = Boolean(hero.seasons);
  const heroFile = heroIsShow ? firstEpisodeFile(hero) : (hero.files || [])[0];

  const continueEntries = state.progress
    .map((row) => {
      const located = locateFile(row.file_path);
      const item = located ? located.item : null;
      const label = located && located.type === 'episode'
        ? episodeTag(located.season, located.episode.episode_number)
        : 'Movie';
      return { row, item, label, backdrop: item ? item.backdrop : null };
    })
    .filter((entry) => entry.item || entry.row.title);

  const recent = recentlyAdded(16);

  return `
    <section class="hero">
      ${hero.backdrop ? `<img class="hero__backdrop" alt="" src="${esc(hero.backdrop)}">` : ''}
      <div class="hero__content">
        <h1 class="hero__title">${esc(hero.title)}</h1>
        <div class="hero__meta">
          ${hero.rating ? `<span class="badge badge--rating">★ ${hero.rating}</span>` : ''}
          ${hero.year ? `<span>${hero.year}</span>` : ''}
          ${formatRuntime(hero.runtime) ? `<span>·</span><span>${formatRuntime(hero.runtime)}</span>` : ''}
          ${(hero.genres || []).length ? `<span>·</span><span>${esc(hero.genres.slice(0, 2).join(', '))}</span>` : ''}
        </div>
        ${hero.overview ? `<p class="hero__overview">${esc(hero.overview)}</p>` : ''}
        <div class="hero__actions">
          ${heroFile
    ? `<button class="btn btn--primary btn--lg" data-action="play" data-path="${esc(heroFile.file_path)}">${playIcon('btn__icon')}Play</button>`
    : ''}
          <button class="btn btn--secondary btn--lg" data-action="open-detail" data-type="${heroIsShow ? 'show' : 'movie'}" data-id="${hero.tmdb_id}">More Info</button>
        </div>
      </div>
    </section>

    ${continueEntries.length > 0 ? `
      <section class="section">
        <div class="section__header"><h2 class="section__title">Continue Watching</h2></div>
        <div class="rail">${continueEntries.map(continueCard).join('')}</div>
      </section>` : ''}

    <section class="section">
      <div class="section__header">
        <h2 class="section__title">Recently Added</h2>
        <span class="page__count">${recent.length} item${recent.length === 1 ? '' : 's'}</span>
      </div>
      <div class="grid">${recent.map((entry) => posterCard(entry.item, entry.type)).join('')}</div>
    </section>

    ${discoverRails()}`;
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
    return `
      <div class="page__header"><h1 class="page__title">Movies</h1></div>
      ${emptyState({
    iconName: 'film',
    title: 'No movies yet',
    text: 'Add files under library/movies and press Rescan, or find something to download.',
    action: { label: 'Search for a movie', action: 'navigate', page: 'search' }
  })}`;
  }

  return `
    <div class="page__header">
      <h1 class="page__title">Movies</h1>
      <span class="page__count">${movies.length} title${movies.length === 1 ? '' : 's'}</span>
    </div>
    <div class="grid">${movies.map((movie) => posterCard(movie, 'movie')).join('')}</div>`;
}

export function renderShows() {
  if (state.loading) return loadingState('Loading shows…');
  const { shows } = state.library;

  if (shows.length === 0) {
    return `
      <div class="page__header"><h1 class="page__title">Shows</h1></div>
      ${emptyState({
    iconName: 'tv',
    title: 'No shows yet',
    text: 'Add files under library/shows/<Show Name>/Season 01 and press Rescan.',
    action: { label: 'Search for a show', action: 'navigate', page: 'search' }
  })}`;
  }

  return `
    <div class="page__header">
      <h1 class="page__title">Shows</h1>
      <span class="page__count">${shows.length} title${shows.length === 1 ? '' : 's'}</span>
    </div>
    <div class="grid">${shows.map((show) => posterCard(show, 'show')).join('')}</div>`;
}

export function renderDownloads() {
  const { jobs } = state;

  const header = `
    <div class="page__header">
      <h1 class="page__title">Downloads</h1>
      ${jobs.length ? `<span class="page__count">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>` : ''}
    </div>`;

  if (jobs.length === 0) {
    return header + emptyState({
      iconName: 'download',
      title: 'Nothing downloading',
      text: 'Downloads you start from Search show up here with live progress.',
      action: { label: 'Find something', action: 'navigate', page: 'search' }
    });
  }

  return header + `<div class="job-list">${jobs.map(jobRow).join('')}</div>`;
}

function jobRow(job) {
  const percent = Math.round((Number(job.progress) || 0) * 100);
  const active = job.status === 'downloading' || job.status === 'queued';

  const actions = job.status === 'error'
    ? `<button class="btn btn--secondary" data-action="retry-job" data-id="${esc(job.id)}">Retry</button>
       <button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Remove</button>`
    : job.status === 'complete'
      ? `<button class="btn btn--secondary" data-action="open-folder" data-path="${esc(job.file_path || '')}">${icon('folder', 'btn__icon')}<span class="btn__label">Open Folder</span></button>
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

  const isShow = Boolean(item.seasons);
  const firstFile = isShow ? firstEpisodeFile(item) : (item.files || [])[0];

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
            ${item.rating ? `<span class="badge badge--rating">★ ${item.rating}</span>` : ''}
            ${item.year ? `<span class="badge">${item.year}</span>` : ''}
            ${formatRuntime(item.runtime) ? `<span class="badge">${formatRuntime(item.runtime)}</span>` : ''}
            ${(item.genres || []).map((genre) => `<span class="badge">${esc(genre)}</span>`).join('')}
          </div>
          ${item.overview ? `<p class="modal__overview" id="modal-overview">${esc(item.overview)}</p>
            <button class="modal__more" data-action="expand-overview">Show more</button>` : ''}
          <div class="modal__actions">
            ${firstFile
    ? `<button class="btn btn--primary btn--lg" data-action="play" data-path="${esc(firstFile.file_path)}">${playIcon('btn__icon')}Play</button>`
    : ''}
            <button class="btn btn--secondary btn--lg" data-action="find-more" data-type="${isShow ? 'show' : 'movie'}" data-id="${item.tmdb_id}">Find More</button>
          </div>

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

          ${isShow ? `
            <h3 style="margin:24px 0 8px">Episodes</h3>
            ${item.seasons.map((season, index) => renderSeason(item, season, index === 0)).join('')}` : ''}
        </div>
      </div>
    </div>`;
}

function renderSeason(show, season, open) {
  return `
    <div class="season${open ? ' is-open' : ''}">
      <button class="season__toggle" data-action="toggle-season">
        ${icon('chevron', 'season__chevron')}
        Season ${pad2(season.number)}
        <span class="season__count">${season.episodes.length} episode${season.episodes.length === 1 ? '' : 's'}</span>
      </button>
      <div class="season__episodes">
        ${season.episodes.map((episode) => {
    const file = (episode.files || [])[0];
    return `
          <div class="episode"${file ? ` data-action="play" data-path="${esc(file.file_path)}"` : ''}>
            ${episode.still
    ? `<img class="episode__still" loading="lazy" alt="" src="${esc(episode.still)}">`
    : '<div class="episode__still"></div>'}
            <div>
              <div class="episode__title">
                <span class="episode__number">${episode.episode_number ?? '–'}.</span>
                ${esc(episode.title || 'Untitled episode')}
              </div>
              ${episode.overview ? `<div class="episode__overview">${esc(episode.overview)}</div>` : ''}
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
      <video class="player__video" id="player-video" playsinline></video>

      <div class="player__spinner"><div class="spinner spinner--lg"></div></div>

      <div class="player__top">
        <button class="player__btn" data-action="close-player" aria-label="Back">${icon('back')}</button>
        <div class="player__heading">
          <div class="player__title">${esc(title)}</div>
          ${subtitle ? `<div class="player__subtitle">${esc(subtitle)}</div>` : ''}
        </div>
        ${modeLabel ? `<span class="badge ${lossless ? 'badge--source' : 'badge--warning'} player__mode">${esc(modeLabel)}</span>` : ''}
      </div>

      <div class="next-up" id="next-up" hidden>
        <!-- The count is filled from real remaining playback the moment the
             card is shown, so it has no meaningful initial value. -->
        <div class="next-up__label">Up next in <span class="next-up__count" id="next-up-count">—</span>s</div>
        <div class="next-up__title" id="next-up-title"></div>
        <div class="next-up__actions">
          <button class="btn btn--primary" data-action="play-next">Play now</button>
          <button class="btn btn--ghost" data-action="cancel-next">Cancel</button>
        </div>
      </div>

      <div class="player__controls">
        <div class="player__scrub">
          <span class="player__time" id="time-current">0:00</span>
          <input class="range" id="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
          <span class="player__time" id="time-total">0:00</span>
        </div>
        <div class="player__buttons">
          <button class="player__btn player__btn--play" data-action="toggle-play" id="play-btn" aria-label="Play">${playIcon()}</button>
          <button class="player__btn" data-action="seek-back" aria-label="Back 10 seconds">${icon('back10')}</button>
          <button class="player__btn" data-action="seek-forward" aria-label="Forward 10 seconds">${icon('fwd10')}</button>
          <div class="player__volume">
            <button class="player__btn" data-action="toggle-mute" id="mute-btn" aria-label="Mute">${icon('volume')}</button>
            <input class="range" id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
          </div>
          <div class="player__spacer"></div>
          <div class="player__menu" id="player-menu">
            <button class="player__btn" data-action="toggle-menu" aria-label="Settings">${icon('settings')}</button>
            <div class="player__menu-panel" id="menu-panel"></div>
          </div>
          <button class="player__btn" data-action="toggle-fullscreen" aria-label="Fullscreen">${icon('fullscreen')}</button>
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
