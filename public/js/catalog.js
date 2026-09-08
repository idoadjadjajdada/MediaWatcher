/** Title-first discovery. Library records remain the source of download status. */
import * as api from './api.js';
import { state, patchSlice, findMovie, findShow } from './state.js';
import { esc, icon, loadingState, emptyState } from './views.js';
import * as search from './search.js';

let browseRequest = 0;
let titleRequest = 0;
let seasonRequest = 0;
const artwork = (path, size = 'w500') => path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
const ownedTitle = (id, type) => type === 'show' ? findShow(Number(id)) : findMovie(Number(id));
const aired = date => Boolean(date && date <= new Date().toISOString().slice(0, 10));

export function ensureLoaded() {
  if (state.catalog.status === 'idle' && !state.catalog.title) browse();
}

export async function browse(patch = {}) {
  const token = ++browseRequest;
  back();
  patchSlice('catalog', { ...patch, page: patch.page || 1, status: 'loading', error: null, results: [] });
  const c = state.catalog;
  try {
    const data = await api.getCatalog({ q: c.query, type: c.type, genre: c.genre, year: c.year, rating: c.rating, sort: c.sort, page: c.page });
    if (token !== browseRequest) return;
    // Background results must not replace text typed since this request began.
    patchSlice('catalog', { ...data, query: state.catalog.query === c.query ? data.query : state.catalog.query, status: 'done', error: null });
  } catch (error) {
    if (token === browseRequest) patchSlice('catalog', { status: 'error', error: error.message });
  }
}

export function back() {
  titleRequest++;
  seasonRequest++;
  search.resetSearch();
  patchSlice('catalog', { title: null, detailStatus: 'idle', downloadTarget: null });
}

export async function openTitle(id, type) {
  const token = ++titleRequest;
  seasonRequest++;
  search.resetSearch();
  patchSlice('catalog', { title: { id: Number(id), type }, detailStatus: 'loading', detailError: null,
    selectedSeason: null, seasonDetails: null, seasonStatus: 'idle', seasonError: null, downloadTarget: null });
  window.scrollTo?.(0, 0);
  document.getElementById('main')?.scrollTo(0, 0);
  try {
    const raw = await api.getDiscoverDetail(type, id);
    if (token !== titleRequest) return;
    const title = { ...raw, type, title: raw.title || raw.name, year: Number((raw.release_date || raw.first_air_date || '').slice(0, 4)) || null };
    patchSlice('catalog', { title, detailStatus: 'done' });
    if (type === 'show') {
      const seasons = (raw.seasons || []).filter(s => s.episode_count > 0);
      const first = seasons.find(s => s.season_number > 0) || seasons[0];
      if (first) selectSeason(first.season_number);
    }
  } catch (error) {
    if (token === titleRequest) patchSlice('catalog', { detailStatus: 'error', detailError: error.message });
  }
}

export async function selectSeason(number) {
  const title = state.catalog.title;
  if (!title || title.type !== 'show') return;
  const token = ++seasonRequest;
  search.resetSearch();
  patchSlice('catalog', { selectedSeason: Number(number), seasonDetails: null, seasonStatus: 'loading', seasonError: null, downloadTarget: null });
  try {
    const data = await api.getCatalogSeason(title.id, number);
    if (token !== seasonRequest || state.catalog.title !== title) return;
    patchSlice('catalog', { seasonDetails: data, seasonStatus: 'done' });
  } catch (error) {
    if (token === seasonRequest) patchSlice('catalog', { seasonStatus: 'error', seasonError: error.message });
  }
}

export async function chooseDownload(episode = null, pack = false) {
  const c = state.catalog;
  const title = c.title;
  if (!title || c.detailStatus !== 'done') return;
  const entry = c.seasonDetails?.episodes?.find(e => e.episode_number === Number(episode));
  const first = c.seasonDetails?.episodes?.find(e => aired(e.air_date));
  if (title.type === 'show' && !(pack ? first : entry && aired(entry.air_date))) return;
  const target = { episode: pack ? first.episode_number : episode, pack,
    label: title.type === 'movie' ? 'Download movie' : pack ? `Download season ${c.selectedSeason}` : `Download S${String(c.selectedSeason).padStart(2, '0')}E${String(episode).padStart(2, '0')} · ${entry.name}` };
  patchSlice('catalog', { downloadTarget: target });
  const pending = search.runSearch(title.title, title.type, c.selectedSeason, target.episode,
    { tmdbId: title.id, year: title.year, pack, episodeTitle: entry?.name });
  document.getElementById('catalog-downloads')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await pending;
}

export function retryDownload() {
  const target = state.catalog.downloadTarget;
  if (target) return chooseDownload(target.episode, target.pack);
}

function card(item) {
  const owned = ownedTitle(item.tmdb_id, item.type);
  return `<button class="card catalog-card" data-action="open-catalog" data-id="${item.tmdb_id}" data-type="${esc(item.type)}" aria-label="View ${esc(item.title)}">
    <span class="card__art">${item.poster ? `<img class="card__poster" src="${esc(item.poster)}" loading="lazy" alt="${esc(item.title)}">` : `<span class="catalog-card__placeholder">${icon(item.type === 'show' ? 'tv' : 'film')}</span>`}
      <span class="catalog-card__status${owned ? ' is-owned' : ''}">${owned ? 'In library' : 'Not downloaded'}</span></span>
    <span class="card__title t-card">${esc(item.title)}</span><span class="card__meta">${esc(item.year || 'Coming soon')} · ${esc(item.rating)} ★</span></button>`;
}

export function renderCatalog() {
  const c = state.catalog;
  if (c.title) return renderTitle();
  const option = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="page__head"><div><h1 class="t-hero">Search</h1><p class="t-meta">Find your next watch. Browse by title, genre, year, or rating.</p></div></div>
    <div class="search-toolbar catalog-toolbar">
      <div class="search-toolbar__row"><input class="input" id="search-input" data-action="catalog-query" value="${esc(c.query)}" placeholder="Search a title or genre…" aria-label="Search titles or genres" autocomplete="off">
        <button class="btn btn--primary" data-action="run-search">${icon('search', 'icon-sm')} Search</button></div>
      <div class="catalog-filters">
        <label>Type<select class="select" id="catalog-type" data-action="catalog-filter" data-field="type">${option('movie', 'Movies', c.type)}${option('show', 'Series', c.type)}</select></label>
        <label>Genre<select class="select" id="catalog-genre" data-action="catalog-filter" data-field="genre">${option('', 'All genres', c.genre)}${c.genres.map(g => option(g.id, g.name, c.genre)).join('')}</select></label>
        <label>Year<input class="input" id="catalog-year" data-action="catalog-year" value="${esc(c.year)}" type="number" min="1870" max="2200" placeholder="Any year"></label>
        <label>Rating<select class="select" id="catalog-rating" data-action="catalog-filter" data-field="rating">${option('', 'Any rating', c.rating)}${[6, 7, 8, 9].map(r => option(r, `${r}+ stars`, c.rating)).join('')}</select></label>
        <label>Sort<select class="select" id="catalog-sort" data-action="catalog-filter" data-field="sort"${c.query ? ' disabled title="Title searches are ordered by relevance"' : ''}>${c.query ? option(c.sort, 'Relevance', c.sort) : option('popular', 'Popular', c.sort) + option('rating', 'Top rated', c.sort) + option('newest', 'Newest', c.sort)}</select></label>
        <button class="btn btn--ghost" data-action="catalog-reset">Reset</button>
      </div></div>
    ${c.status === 'loading' || c.status === 'idle' ? loadingState('Finding titles…')
      : c.status === 'error' ? emptyState({ iconName: 'warning', title: 'Could not load titles', text: c.error, action: { label: 'Try again', action: 'run-search' } })
      : c.results.length ? `<div class="grid catalog-grid">${c.results.map(card).join('')}</div>`
      : emptyState({ iconName: 'search', title: 'No matching titles on this page', text: c.totalPages > c.page ? 'Try the next page, or broaden your filters.' : 'Try another title or broaden your filters.' })}
    ${c.status === 'done' && c.totalPages > 1 ? `<div class="catalog-pagination"><button class="btn btn--secondary" data-action="catalog-page" data-page="${c.page - 1}"${c.page <= 1 ? ' disabled' : ''}>Previous</button><span class="t-meta">Page ${c.page} of ${c.totalPages}</span><button class="btn btn--secondary" data-action="catalog-page" data-page="${c.page + 1}"${c.page >= c.totalPages ? ' disabled' : ''}>Next</button></div>` : ''}`;
}

function renderTitle() {
  const c = state.catalog;
  const t = c.title;
  const backButton = `<button class="btn btn--ghost catalog-back" data-action="catalog-back">← Back to search</button>`;
  if (c.detailStatus === 'loading') return backButton + loadingState('Loading title…');
  if (c.detailStatus === 'error') return backButton + emptyState({ iconName: 'warning', title: 'Could not load this title', text: c.detailError, action: { label: 'Try again', action: 'catalog-retry-title' } });
  const owned = ownedTitle(t.id, t.type);
  const duration = t.runtime || t.episode_run_time?.[0];
  const poster = artwork(t.poster_path);
  return `<article class="catalog-detail">${backButton}
    <div class="catalog-hero">${t.backdrop_path ? `<img class="catalog-hero__backdrop" src="${esc(artwork(t.backdrop_path, 'w1280'))}" alt="">` : ''}
      <div class="catalog-hero__content">${poster ? `<img class="catalog-hero__poster" src="${esc(poster)}" alt="${esc(t.title)} poster">` : ''}
        <div class="catalog-hero__info"><span class="catalog-availability${owned ? ' is-owned' : ''}">${icon(owned ? 'check' : 'download', 'icon-sm')}${owned ? (t.type === 'show' ? 'Episodes in library' : 'In your library') : 'Not downloaded'}</span>
          <h1>${esc(t.title)}</h1><p class="catalog-meta">${t.type === 'show' ? 'Series' : 'Movie'}${t.year ? ` · ${t.year}` : ''}${duration ? ` · ${duration} min` : ''}${t.vote_average ? ` · ${Number(t.vote_average).toFixed(1)} ★` : ''}${t.number_of_seasons ? ` · ${t.number_of_seasons} seasons` : ''}</p>
          <div class="chips">${(t.genres || []).map(g => `<button class="chip" data-action="catalog-genre-link" data-genre="${g.id}" data-type="${t.type}">${esc(g.name)}</button>`).join('')}</div>
          ${t.tagline ? `<p class="catalog-tagline">${esc(t.tagline)}</p>` : ''}<p class="catalog-overview">${esc(t.overview || 'No synopsis available yet.')}</p>
          <div class="catalog-title-actions">${owned ? `<button class="btn btn--secondary" data-action="open-detail" data-id="${t.id}" data-type="${t.type}">Open in library</button>` : ''}
          ${t.type === 'movie' ? `<button class="btn btn--primary" data-action="catalog-download-movie">${icon('download', 'icon-sm')}${owned ? 'Find another version' : 'Download movie'}</button>` : `<a class="btn btn--primary" href="#search" data-action="catalog-scroll-seasons">Browse seasons</a>`}</div>
          <p class="t-meta catalog-download-note">${owned ? 'Browse available versions below.' : 'Choose a download below to add this title to your library.'}</p>
        </div></div></div>
    ${t.type === 'show' ? renderSeasons(t, owned) : ''}
    ${c.downloadTarget ? `<section class="catalog-downloads" id="catalog-downloads"><div class="page__head"><div><h2>${esc(c.downloadTarget.label)}</h2><p class="t-meta">Choose a release${c.downloadTarget.pack ? '. Only episodes from the selected season will be saved' : ''}.</p></div></div>${search.renderReleaseResults()}</section>` : ''}
    ${t.credits?.cast?.length ? `<section class="catalog-cast"><h2>Cast</h2><div class="catalog-cast__list">${t.credits.cast.slice(0, 10).map(person => `<div>${person.profile_path ? `<img loading="lazy" src="${esc(artwork(person.profile_path, 'w185'))}" alt="">` : '<span class="catalog-cast__empty"></span>'}<strong>${esc(person.name)}</strong><span class="t-meta">${esc(person.character || '')}</span></div>`).join('')}</div></section>` : ''}
    </article>`;
}

function renderSeasons(title, owned) {
  const c = state.catalog;
  const seasons = (title.seasons || []).filter(s => s.episode_count > 0);
  const episodes = c.seasonDetails?.episodes || [];
  const ready = episodes.some(e => aired(e.air_date));
  return `<section class="catalog-seasons" id="catalog-seasons"><div class="page__head"><h2>Seasons & episodes</h2></div>
    ${seasons.length ? `<div class="catalog-season-tabs" role="group" aria-label="Seasons">${seasons.map(s => `<button class="chip${c.selectedSeason === s.season_number ? ' is-active' : ''}" data-action="catalog-season" data-season="${s.season_number}">${esc(s.name || `Season ${s.season_number}`)} <span class="t-meta">${s.episode_count}</span></button>`).join('')}</div>` : '<p class="t-meta">Season information is not available yet.</p>'}
    ${c.seasonStatus === 'loading' ? loadingState('Loading episodes…') : c.seasonStatus === 'error' ? emptyState({ iconName: 'warning', title: 'Could not load episodes', text: c.seasonError, action: { label: 'Try again', action: 'catalog-retry-season' } })
      : c.seasonDetails ? `<div class="catalog-season-head"><div><h3>${esc(c.seasonDetails.name || `Season ${c.selectedSeason}`)}</h3><p class="t-meta">${episodes.length} episodes${ready ? ' · Download a season pack or choose episodes individually' : ''}</p></div><button class="btn btn--primary" data-action="catalog-download-season"${ready ? '' : ' disabled'}>${icon('download', 'icon-sm')} Download entire season</button></div>
        <div class="catalog-episodes">${episodes.map(ep => {
          const inLibrary = owned?.seasons?.find(s => s.number === c.selectedSeason)?.episodes?.find(e => e.episode_number === ep.episode_number && e.files?.length);
          const released = aired(ep.air_date);
          return `<div class="catalog-episode">${ep.still_path ? `<img loading="lazy" src="${esc(artwork(ep.still_path, 'w300'))}" alt="">` : `<span class="catalog-episode__number">${ep.episode_number}</span>`}<div class="catalog-episode__body"><h4>${ep.episode_number}. ${esc(ep.name)}</h4><p class="t-meta">${esc(ep.air_date || 'Date unannounced')}${ep.runtime ? ` · ${ep.runtime} min` : ''} · <span class="${inLibrary ? 'catalog-owned-text' : ''}">${inLibrary ? 'Downloaded' : released ? 'Not downloaded' : 'Upcoming'}</span></p><p>${esc(ep.overview || '')}</p></div><button class="btn btn--secondary" data-action="catalog-download-episode" data-episode="${ep.episode_number}"${released ? '' : ' disabled'}>${inLibrary ? 'Other versions' : released ? 'Download' : 'Not aired'}</button></div>`;
        }).join('') || '<p class="t-meta">No episodes have been announced yet.</p>'}</div>` : ''}</section>`;
}
