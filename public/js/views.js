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
  // Sliders: the intro editor, which is two values on a track and nothing else.
  tune: '<path d="M3 6h4M11 6h10M3 12h10M17 12h4M3 18h6M13 18h8"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/>',
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
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v7H3v-7z"/>',
  // The Cast glyph: a screen with the three arcs of a signal in its corner.
  cast: '<path d="M2 16.1A5 5 0 0 1 5.9 20"/><path d="M2 12.05A9 9 0 0 1 9.95 20"/><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>'
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
export function posterCard(item, type, { owned = false, progress = null, index = 0 } = {}) {
  const poster = item.poster
    ? `<img class="card__poster" loading="lazy" alt="${esc(item.title)}" src="${esc(item.poster)}">`
    : `<div class="card__placeholder">${esc(item.title)}</div>`;

  const action = owned
    ? `data-action="open-detail" data-type="${esc(type)}" data-id="${item.tmdb_id}"`
    : `data-action="open-discover" data-type="${esc(type)}" data-id="${item.tmdb_id}"`;

  /*
   * The old rule drew a full-width white bar under everything on disk, which
   * turned a wall of posters into a wall of underlines. The bar is now kept
   * for the one thing it reads well - how far in you are - and owning a title
   * is said by a small mark in the corner instead.
   */
  const partial = typeof progress === 'number' && progress > 0 && progress < 1;
  const width = partial ? Math.max(2, Math.min(100, progress * 100)) : 0;
  const bar = partial
    ? `<div class="card__owned"><span style="width:${width.toFixed(1)}%"></span></div>`
    : '';
  const mark = owned && !partial
    ? `<span class="card__mark" aria-label="In your library" title="In your library">${icon('check', 'icon-sm')}</span>`
    : '';

  return `
    <article class="card" ${action} style="--i:${index}" tabindex="0" aria-label="${esc(item.title)}">
      <div class="card__art">
        ${poster}
        ${mark}
        <!-- Affordance only: the whole card is the target, so this must not eat
             the click that opens it. -->
        <div class="card__over" aria-hidden="true"><span class="card__play">${playIcon('icon')}</span></div>
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
        <div class="navrail__in">
          <div class="navrail__mark"><img src="/icons/mark.png" alt="MediaWatcher" width="22" height="34"></div>
          <nav class="navrail__nav">
            <!-- One indicator slides between the items; app.js places it. -->
            <div class="navrail__ind" id="navrail-ind" hidden></div>
            ${NAV.map((entry) => `
              <button class="navrail__item" data-action="navigate" data-page="${entry.page}" aria-label="${entry.label}" title="${entry.label}">
                ${icon(entry.iconName, 'icon')}
                ${entry.page === 'downloads' ? '<span class="navrail__badge" id="jobs-badge" hidden>0</span>' : ''}
              </button>`).join('')}
          </nav>
          <!--
            Add, settings and rescan sit in the foot rather than the nav list:
            the tab bar on mobile is already five items wide, and a sixth would
            shrink them all to fit something reached once a month. The rail
            carrying all three is also why there is no header on desktop —
            a second row holding the same controls was pure duplication.
          -->
          <div class="navrail__foot">
            <div class="navrail__sep"></div>
            <button class="navrail__item" data-action="add-torrent" aria-label="Add torrent" title="Add a torrent">
              ${icon('plus', 'icon')}
            </button>
            <button class="navrail__item navrail__item--foot" data-action="navigate" data-page="settings"
              aria-label="Settings" title="Settings">
              ${icon('settings', 'icon')}
            </button>
            <button class="navrail__item navrail__item--foot" data-action="rescan" id="rescan-btn" aria-label="Rescan" title="Rescan library">
              ${icon('refresh', 'icon')}
            </button>
          </div>
        </div>
      </aside>

      <!-- Phone only. On anything with a rail this is display:none. -->
      <header class="topbar">
        <div class="topbar__search">
          ${icon('search', 'icon-sm')}
          <input class="input topbar__input" id="global-search" type="search" placeholder="Search" autocomplete="off">
        </div>
        <button class="btn btn--secondary btn--icon topbar__add" data-action="add-torrent" aria-label="Add torrent">
          ${icon('plus', 'icon-sm')}
        </button>
        <button class="btn btn--secondary btn--icon topbar__settings" data-action="navigate" data-page="settings"
          aria-label="Settings" title="Settings">
          ${icon('settings', 'icon-sm')}
        </button>
      </header>

      <main class="main" id="main"></main>

      <nav class="tabbar" id="tabbar">
        <div class="tabbar__in">
          <div class="tabbar__ind" id="tabbar-ind"></div>
          ${NAV.map((entry) => `
            <button class="tabbar__item" data-action="navigate" data-page="${entry.page}">
              ${icon(entry.iconName, 'icon')}
              <span class="tabbar__label">${entry.label}</span>
              ${entry.page === 'downloads' ? '<span class="tabbar__badge" id="jobs-badge-m" hidden>0</span>' : ''}
            </button>`).join('')}
        </div>
      </nav>
    </div>`;
}

/*
 * Where the marker was last put, so it is not measured again for nothing.
 *
 * Reading offsetTop is a synchronous layout, and this runs on every render —
 * immediately after #main is replaced, which is the worst possible moment to
 * ask the browser a geometry question, because it has to lay the whole page
 * out again before it can answer. The marker only moves when the page changes,
 * so that is when it is measured. A resize can change the rail's step, and
 * clears this.
 */
let placedFor = null;
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { placedFor = null; }, { passive: true });
}

/**
 * Move the sliding markers onto the active item.
 *
 * Measured rather than computed from an index: the rail's step depends on the
 * button height and the gap, and reading offsetTop means a change to either in
 * CSS does not need a matching constant in here. Settings and Rescan live
 * outside the nav list, so on those pages the rail marker hides rather than
 * parking on whichever item it last sat under.
 */
export function placeIndicators() {
  if (placedFor === state.currentPage) return;
  const rail = document.getElementById('navrail-ind');
  if (rail) {
    placedFor = state.currentPage;
    const active = document.querySelector(`.navrail__nav .navrail__item[data-page="${state.currentPage}"]`);
    rail.hidden = !active;
    if (active) rail.style.transform = `translateY(${active.offsetTop}px)`;
  }

  const tab = document.getElementById('tabbar-ind');
  if (tab) {
    const index = NAV.findIndex((entry) => entry.page === state.currentPage);
    tab.style.opacity = index < 0 ? '0' : '1';
    if (index >= 0) tab.style.transform = `translateX(${index * 100}%)`;
  }
}

/** Cheap per-render updates that don't need the shell rebuilt. */
export function updateShell() {
  // Both nav surfaces exist in the DOM at all times; CSS decides which is shown.
  document.querySelectorAll('.navrail__item, .tabbar__item').forEach((node) => {
    if (!node.dataset.page) return;
    node.classList.toggle('is-active', node.dataset.page === state.currentPage);
  });
  placeIndicators();

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

/**
 * What the library gained, lost or replaced since this device last looked.
 *
 * On Home, above everything, because it is the question you actually have on
 * opening the app after a few days — and one that a list of what exists cannot
 * answer. Dismissing it is what marks it seen: a banner that cleared itself on
 * being fetched would be consumed by a background poll while the tab was shut.
 */
/**
 * How long ago, in the coarsest unit that is still true.
 *
 * Relative rather than a date, because the question this answers is "have I
 * been away long enough for this to matter" — and "3 days ago" answers that
 * where "12 Aug, 21:04" makes you work it out.
 */
export function formatSince(ms) {
  const elapsed = Date.now() - Number(ms || 0);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'just now';

  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

export function renderChanges() {
  const changes = state.changes;
  if (!changes || changes.first || changes.total === 0) return '';

  const { counts } = changes;
  const parts = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.upgraded > 0) parts.push(`${counts.upgraded} replaced`);
  if (counts.removed > 0) parts.push(`${counts.removed} gone`);

  const names = [...changes.added, ...changes.upgraded].slice(0, 6).map((entry) => entry.name);

  return `
    <section class="changes">
      <div class="changes__main">
        <div class="changes__head">
          <strong>${esc(parts.join(' · '))}</strong>
          <span class="t-meta">since ${esc(formatSince(changes.since))}</span>
        </div>
        ${names.length > 0 ? `<div class="changes__names">${esc(names.join(' · '))}${
  changes.total > names.length ? ` and ${changes.total - names.length} more` : ''
}</div>` : ''}
      </div>
      <button class="btn btn--ghost" data-action="dismiss-changes">Got it</button>
    </section>`;
}

export function renderHome() {
  const { movies, shows } = state.library;
  const all = [...movies, ...shows];

  if (state.loading) return loadingState('Loading your library…');

  const heroes = heroCandidates(state.library, state.progress);
  if (heroIndex >= heroes.length) heroIndex = 0;
  const hero = heroes[heroIndex] || null;
  const ownedIds = new Set(all.map((entry) => entry.tmdb_id));

  const continueCards = state.progress
    .map((row) => continueEntry(row, state.library))
    .filter(Boolean)
    .map(continueCard)
    .join('');

  // Home gets a short recent row; the complete collection lives in Library.
  const byNewest = all.slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a));
  const cardFor = (entry, index) =>
    posterCard(entry, Array.isArray(entry.seasons) ? 'show' : 'movie', { owned: true, index });

  const libraryRails = byNewest.length
    ? rail('Recently added', byNewest.slice(0, 16).map(cardFor).join('')) : '';

  const discoverRails = (state.discover.rails || []).map((entry) => rail(
    entry.title,
    (entry.items || []).map((title, index) => posterCard(
      title,
      title.type === 'show' ? 'show' : 'movie',
      { owned: ownedIds.has(title.tmdb_id), index }
    )).join('')
  )).join('');

  return `
    ${hero ? renderHero(hero, heroIndex, heroes.length) : ''}
    <div class="page">
      ${renderChanges()}
      ${continueCards ? rail('Continue watching', continueCards) : ''}
      ${libraryRails}
      ${discoverRails}
      ${!all.length && !discoverRails ? (state.discover.status === 'loading'
    ? loadingState('Finding recommendations…')
    : emptyState({ iconName: 'search', title: 'Find your next watch',
      text: 'Explore movies and shows, or browse by genre.',
      action: { label: 'Explore titles', action: 'navigate', page: 'search' } })) : ''}
    </div>`;
}

function renderHero(hero, index = 0, total = 1) {
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

  /*
   * The dots are the only clue that the hero is going to change under you, and
   * the fill inside the active one is how long you have before it does. They
   * are also the way to stop waiting and go straight to one.
   */
  const dots = total > 1 ? `
      <div class="hero__dots">
        ${Array.from({ length: total }, (_, i) => `
          <button class="hero__dot${i === index ? ' is-on' : ''}" data-action="hero-jump" data-index="${i}"
            aria-label="Show ${i + 1} of ${total}"><i></i></button>`).join('')}
      </div>` : '';

  return `
    <section class="hero" id="hero">
      ${item.backdrop ? `<img class="hero__art" alt="" src="${esc(item.backdrop)}">` : ''}
      <div class="hero__scrim"></div>
      ${dots}
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

/** Which of the candidates is up. Module-level so a re-render keeps its place. */
let heroIndex = 0;
const HERO_MAX = 5;

/**
 * The titles the hero cycles through.
 *
 * Resume entries lead, because "Resume" has to mean something the first time
 * the page settles; the newest arrivals fill the rest. Only titles with a
 * backdrop are eligible past the first - a rotation that lands on an empty
 * frame is worse than not rotating.
 */
export function heroCandidates(library, progress) {
  const all = [...library.movies, ...library.shows];
  if (all.length === 0) return [];

  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || seen.has(entry.item.tmdb_id)) return;
    seen.add(entry.item.tmdb_id);
    out.push(entry);
  };

  for (const row of progress) {
    if (out.length >= 3) break;
    const located = locateFile(row.file_path);
    if (!located) continue;
    push({
      item: located.item,
      type: located.type === 'episode' ? 'show' : 'movie',
      file: { file_path: row.file_path },
      resumeRow: row,
      located
    });
  }

  const withArt = all.filter((entry) => entry.backdrop);
  const pool = (withArt.length > 0 ? withArt : all)
    .slice().sort((a, b) => newestAddedAt(b) - newestAddedAt(a));
  for (const item of pool) {
    if (out.length >= HERO_MAX) break;
    const isShow = Array.isArray(item.seasons);
    push({
      item,
      type: isShow ? 'show' : 'movie',
      file: isShow ? firstEpisodeFile(item) : (item.files || [])[0],
      resumeRow: null,
      located: null
    });
  }
  return out;
}

/**
 * Which title leads the page.
 *
 * The old rule picked at random on every render, so the hero changed identity
 * whenever state updated. Prefer the thing you were last watching, so Resume
 * actually means something.
 */
export function pickHero(library, progress) {
  return heroCandidates(library, progress)[0] || null;
}

/** How many the hero can cycle through right now. */
export function heroCount() {
  return heroCandidates(state.library, state.progress).length;
}

/**
 * Move the hero on without re-rendering the page.
 *
 * A full render would reset the scroll position and restart every card's
 * entrance, for a change that touches one section. This swaps the artwork and
 * the copy in place and leaves the rest of the page alone.
 */
export function showHero(next) {
  const heroes = heroCandidates(state.library, state.progress);
  if (heroes.length < 2) return;
  heroIndex = ((next % heroes.length) + heroes.length) % heroes.length;

  const section = document.getElementById('hero');
  if (!section) return;
  const markup = renderHero(heroes[heroIndex], heroIndex, heroes.length);
  const next$ = document.createElement('div');
  next$.innerHTML = markup;
  const fresh = next$.firstElementChild;

  const art = section.querySelector('.hero__art');
  const freshArt = fresh.querySelector('.hero__art');
  // Cross-fade the picture, swap everything else outright: the copy changing
  // mid-fade reads as a glitch, the picture changing mid-fade reads as a cut.
  if (art && freshArt) {
    art.classList.add('is-out');
    setTimeout(() => {
      art.src = freshArt.getAttribute('src') || '';
      art.classList.remove('is-out');
    }, 180);
  } else {
    section.replaceChildren(...fresh.childNodes);
    return;
  }
  section.querySelector('.hero__body')?.replaceWith(fresh.querySelector('.hero__body'));
  section.querySelector('.hero__dots')?.replaceWith(fresh.querySelector('.hero__dots'));
  section.querySelector('.hero__body')?.classList.add('is-swapping');
}

/** Where the hero currently is, so a caller can step it on. */
export function currentHeroIndex() {
  return heroIndex;
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

/**
 * What this job is actually waiting for.
 *
 * "50%" was the single most confusing thing on this page: it is the boundary
 * between AllDebrid fetching the torrent and the local transfer, so a job that
 * sits there is not stuck, it is waiting on a torrent AllDebrid did not
 * already hold. Now it says so — and says the opposite too, because a cached
 * torrent racing through the same percentage is worth telling apart.
 */
function jobPhase(job) {
  if (job.status !== 'downloading') return null;
  if (job.phase === 'debrid') {
    return job.cached === 0
      ? 'AllDebrid is fetching this torrent — it was not already cached'
      : 'waiting for AllDebrid';
  }
  if (job.cached === 1) return 'was cached — transferring';
  return 'transferring';
}

function jobRow(job) {
  const percent = Math.round((Number(job.progress) || 0) * 100);
  const active = job.status === 'downloading' || job.status === 'queued';
  const phase = jobPhase(job);

  /*
   * Reordering is only offered on jobs that are actually waiting. A running
   * transfer has already started and a finished one has nowhere to go, so
   * arrows on those would be controls that do nothing.
   */
  const waiting = job.status === 'queued' || job.status === 'paused';
  const move = waiting ? `
    <div class="job__move">
      <button class="job__arrow" data-action="move-job" data-id="${esc(job.id)}" data-move="top" title="Move to top">&uarr;&uarr;</button>
      <button class="job__arrow" data-action="move-job" data-id="${esc(job.id)}" data-move="up" title="Move up">&uarr;</button>
      <button class="job__arrow" data-action="move-job" data-id="${esc(job.id)}" data-move="down" title="Move down">&darr;</button>
    </div>` : '';

  const actions = job.status === 'error'
    ? `<button class="btn btn--secondary" data-action="retry-job" data-id="${esc(job.id)}">Retry</button>
       <button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Remove</button>`
    : job.status === 'complete'
      ? `<button class="btn btn--secondary" data-action="open-folder" data-path="${esc(job.file_path || '')}">${icon('folder', 'icon-sm')}<span class="btn__label">Open Folder</span></button>
         <button class="btn btn--ghost btn--icon" data-action="cancel-job" data-id="${esc(job.id)}" aria-label="Remove">${icon('trash')}</button>`
      : job.status === 'paused'
        ? `${move}
           <button class="btn btn--secondary" data-action="job-state" data-id="${esc(job.id)}" data-state="resume">Resume</button>
           <button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>`
        : `${move}
           <button class="btn btn--secondary" data-action="job-state" data-id="${esc(job.id)}" data-state="pause">Pause</button>
           <button class="btn btn--danger" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>`;

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
            <span>${percent}%${phase ? ` · ${esc(phase)}` : ''}${active && !job.phase ? ' · waiting' : ''}${job.status === 'paused' ? ' · paused' : ''}</span>
            <span>${job.status === 'complete' ? 'Finished' : ''}</span>
          </div>
        </div>`}
    </div>`;
}

/* --------------------------------------------------------------------------
 * Detail modal
 * ----------------------------------------------------------------------- */

/**
 * Whether this title is converted ahead of time.
 *
 * On the title's own page because that is where the thought occurs — usually
 * while looking at a 4K remux and realising the machine has been spending an
 * hour a time converting copies of it for a phone that will never play it.
 *
 * Three states rather than a switch. "Auto" is not the same as "always": it
 * means the general rules decide, and the difference matters the moment a size
 * limit is set.
 */
export function renderWarmRule(item, isShow) {
  const rules = state.settings?.warmPolicy?.policy?.titles || {};
  const key = `${isShow ? 'show' : 'movie'}:${item.tmdb_id}`;
  const choice = rules[key] || 'auto';

  const option = (value, label, hint) => `
    <button class="choices__item${choice === value ? ' is-active' : ''}"
      data-action="warm-rule" data-kind="${isShow ? 'show' : 'movie'}"
      data-id="${item.tmdb_id}" data-choice="${value}" title="${esc(hint)}">${label}</button>`;

  return `
    <div class="modal__warm">
      <span class="modal__warm-label">Convert ahead of time</span>
      <div class="choices">
        ${option('auto', 'Auto', 'Let the rules in Settings decide')}
        ${option('always', 'Always', 'Convert this even when the rules would skip it')}
        ${option('never', 'Never', 'Never convert this — play it as it is')}
      </div>
    </div>`;
}

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
            ${firstFile && !isShow
    // Only for movies here. A show's files belong to individual episodes, so
    // its save buttons live on the episode rows instead — "save this show"
    // would be a hundred gigabytes behind one unlabelled press.
    ? `<button class="btn btn--secondary" data-action="save-offline"
        data-path="${esc(firstFile.file_path)}" data-title="${esc(item.title)}">Save offline</button>`
    : ''}
            <button class="btn ${unowned ? 'btn--primary' : 'btn--secondary'}"
                    data-action="find-torrents"
                    data-type="${isShow ? 'show' : 'movie'}"
                    data-id="${item.tmdb_id}"
                    data-title="${esc(item.title)}">${unowned ? 'Find torrents' : 'Find More'}</button>
          </div>
          ${unowned ? '' : renderWarmRule(item, isShow)}
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

/**
 * The gaps in a season, drawn under its episode list.
 *
 * Missing and unaired are kept visually apart because they are different
 * facts: one is something to go and get, the other is something that does not
 * exist yet. Collapsing them would make every currently-airing show look
 * permanently incomplete, which is the fastest way to get the whole feature
 * ignored.
 */
function renderMissing(show, season) {
  const report = state.missing[show.tmdb_id];
  if (!report) return '';

  const entry = (report.seasons || []).find((s) => s.season === season.number);
  if (!entry || (entry.missing.length === 0 && entry.unaired.length === 0)) return '';

  const list = (episodes, className) => episodes.map((episode) => `
    <li class="gap ${className}">
      <span class="gap__num t-num">${episode.episode_number}</span>
      <span class="gap__title">${esc(episode.title || 'Untitled')}</span>
      ${episode.air_date ? `<span class="gap__date t-num">${esc(episode.air_date)}</span>` : ''}
    </li>`).join('');

  return `
    <div class="gaps">
      ${entry.missing.length > 0 ? `
        <div class="gaps__label gaps__label--missing">
          ${entry.missing.length} missing
        </div>
        <ul class="gaps__list">${list(entry.missing, 'gap--missing')}</ul>` : ''}
      ${entry.unaired.length > 0 ? `
        <div class="gaps__label">${entry.unaired.length} not aired yet</div>
        <ul class="gaps__list">${list(entry.unaired, 'gap--unaired')}</ul>` : ''}
    </div>`;
}

function renderSeason(show, season, open) {
  // The bulk fetch sits beside the toggle rather than inside it: a button
  // nested in a button is invalid, and clicking it would also collapse the
  // season it had just started working on.
  // Three states, not two. Unknown draws nothing; unavailable draws a disabled
  // button that says why, because a feature that renders as absence cannot be
  // discovered or diagnosed.
  const canFetch = Boolean(state.subtitles?.download && show.tmdb_id);
  const showFetch = Boolean(state.subtitles && show.tmdb_id);

  return `
    <div class="season${open ? ' is-open' : ''}">
      <div class="season__head">
        <button class="season__toggle" data-action="toggle-season">
          ${icon('chevron', 'season__chevron')}
          Season ${pad2(season.number)}
          <span class="season__count">${season.episodes.length} episode${season.episodes.length === 1 ? '' : 's'}</span>
        </button>
        ${showFetch ? `
        <button class="season__subs" data-action="${canFetch ? 'fetch-season-subs' : 'subs-unavailable'}"
          data-show="${show.tmdb_id}" data-season="${season.number}"
          ${canFetch ? '' : 'data-disabled="1"'}
          title="${canFetch
    ? 'Download subtitles for every episode of this season'
    : 'Needs an OpenSubtitles account — see Settings'}">Subtitles</button>` : ''}
      </div>
      ${renderMissing(show, season)}
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
            ${file ? `
              <div class="episode__actions">
                <button class="btn btn--ghost btn--icon" aria-label="Play">${playIcon()}</button>
                <!-- Stops the row's own data-action="play" from firing too. -->
                <button class="episode__save" data-action="save-offline"
                  data-path="${esc(file.file_path)}"
                  data-title="${esc(`${show.title} ${episodeTag(season.number, episode.episode_number)}`)}"
                  title="Save this episode to this device">Save</button>
              </div>` : '<span class="badge">missing</span>'}
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

      <!--
        Intro editor. The strip is not the seek bar zoomed in - it is a
        different window on the file, a couple of minutes wide, so a second is
        worth dragging. Everything inside it is written by player.js, which
        owns the draft being edited.
      -->
      <div class="introedit" id="intro-editor" hidden>
        <div class="introedit__head">
          <div class="introedit__titles">
            <strong>Intro timings</strong>
            <div class="introedit__scope" id="intro-scope"></div>
          </div>
          <div class="introedit__zoom">
            <button class="introedit__zoombtn" data-action="intro-zoom" data-direction="-1"
              aria-label="Zoom in">&minus;</button>
            <span class="introedit__span t-num" id="intro-span">2m</span>
            <button class="introedit__zoombtn" data-action="intro-zoom" data-direction="1"
              aria-label="Zoom out">+</button>
          </div>
          <button class="player__btn" data-action="close-intro-editor" aria-label="Close">${icon('close', 'icon')}</button>
        </div>

        <div class="introedit__strip" id="intro-strip">
          <div class="introedit__frames" id="intro-frames" aria-hidden="true"></div>
          <div class="introedit__region" id="intro-region" aria-hidden="true"></div>
          <div class="introedit__playhead" id="intro-playhead" aria-hidden="true" hidden></div>
          <div class="introedit__handle introedit__handle--start" id="intro-handle-start"
            data-handle="start" role="slider" tabindex="0" aria-label="Intro start"></div>
          <div class="introedit__handle introedit__handle--end" id="intro-handle-end"
            data-handle="end" role="slider" tabindex="0" aria-label="Intro end"></div>
        </div>
        <div class="introedit__scale t-num" id="intro-scale" aria-hidden="true"></div>

        <div class="introedit__rows" id="intro-rows"></div>
      </div>

      <div class="player__top">
        <button class="player__btn" data-action="close-player" aria-label="Back">${icon('back', 'icon-lg')}</button>
        <div class="player__heading">
          <div class="player__title">${esc(title)}</div>
          ${subtitle ? `<div class="player__subtitle">${esc(subtitle)}</div>` : ''}
        </div>
        ${modeLabel ? `<span class="badge${lossless ? '' : ' badge--warn'} player__mode">${esc(modeLabel)}</span>` : ''}
      </div>

      <!--
        The offer and the way to correct it, together: the moment the button
        lands in the wrong place is the moment anyone wants to move it, and
        hunting through a menu then means watching the titles again first.
      -->
      <div class="player__skip-wrap" id="skip-intro-wrap" hidden>
        <button class="player__skip-intro" id="skip-intro" data-action="skip-intro">
          Skip intro
        </button>
        <button class="player__skip-tune" data-action="open-intro-editor"
          aria-label="Adjust intro timings" title="Adjust intro timings">${icon('tune', 'icon')}</button>
      </div>

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
        <div class="player__buttons">
          <div class="player__buttons-left">
            <div class="player__volume">
              <button class="player__btn" data-action="toggle-mute" id="mute-btn" aria-label="Mute">${icon('volume', 'icon')}</button>
              <input class="range range--vol" id="volume" type="range" min="0" max="100" value="100" aria-label="Volume">
            </div>
          </div>

          <!--
            The clock rides with the transport rather than sitting in a row of
            its own. The ghost after the buttons is an invisible copy of it, so
            the play button lands on the bar's exact centre instead of the
            centre of clock-plus-transport. Below 920px CSS lifts the clock
            back out to a row above, where there is room for it.
          -->
          <div class="player__transport">
            <span class="player__times t-num">
              <span id="time-current">0:00</span>
              <span class="player__times-sep" aria-hidden="true">/</span>
              <span id="time-total">0:00</span>
            </span>
            <button class="player__btn player__btn--ep" data-action="prev-episode" aria-label="Previous episode" title="Previous episode">${icon('prevEp', 'icon')}</button>
            <button class="player__btn" data-action="seek-back" aria-label="Back 10 seconds" title="Back 10s">${icon('back10', 'icon-lg')}</button>
            <button class="player__btn player__btn--play" data-action="toggle-play" id="play-btn" aria-label="Play">${playIcon('icon-lg')}</button>
            <button class="player__btn" data-action="seek-forward" aria-label="Forward 10 seconds" title="Forward 10s">${icon('fwd10', 'icon-lg')}</button>
            <button class="player__btn player__btn--ep" data-action="next-episode" aria-label="Next episode" title="Next episode">${icon('nextEp', 'icon')}</button>
            <span class="player__times player__times--ghost t-num" aria-hidden="true">0:00 / 0:00</span>
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
            <button class="player__btn" data-action="open-intro-editor" id="intro-btn"
              aria-label="Intro timings" title="Intro timings" hidden>${icon('tune', 'icon')}</button>
            <div class="player__pop">
              <button class="player__btn" data-action="toggle-popover" data-popover="picture"
                aria-label="Picture" title="Brightness and contrast">${icon('brightness', 'icon')}</button>
              <div class="player__pop-panel" id="popover-picture" hidden></div>
            </div>
            <button class="player__btn" data-action="airplay" id="airplay-btn"
              aria-label="AirPlay" title="AirPlay" hidden>${icon('airplay', 'icon')}</button>
            <!-- Hidden until the SDK loads and the server says it is reachable:
                 a cast button that cannot work is worse than no button, because
                 the device spins and fails with nothing to explain why. -->
            <button class="player__btn" data-action="cast" id="cast-btn"
              aria-label="Cast" title="Cast to a Chromecast" hidden>${icon('cast', 'icon')}</button>
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
