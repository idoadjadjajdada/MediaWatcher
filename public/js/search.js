/**
 * Search page: markup, filters, and the download action.
 *
 * renderSearch lives here rather than in views.js because the filter logic and
 * the markup are the same concern — views.js stays the home of the pages that
 * only read library state.
 */
import * as api from './api.js';
import { state, patchSlice } from './state.js';
import { esc, icon, emptyState, loadingState, toast, formatBytes } from './views.js';

const QUALITY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: '4k', label: '4K' },
  { id: '1080p', label: '1080p' },
  { id: '720p', label: '720p' },
  { id: 'bluray', label: 'BluRay' },
  { id: 'webdl', label: 'WEB-DL' }
];

/** Apply the chip + toggle filters to a ranked result set. */
export function applyFilters(results, filters) {
  return results.filter((result) => {
    if (filters.hideUpscaled && result.is_upscaled) return false;

    switch (filters.quality) {
      case '4k': return result.is_4k;
      case '1080p': return result.is_1080p;
      case '720p': return result.is_720p;
      case 'bluray': return result.is_bluray;
      case 'webdl': return result.is_webdl;
      default: return true;
    }
  });
}

/**
 * Clamp a season/episode box to a sane whole number.
 *
 * Zero is a legitimate value — that is where specials live — so this cannot
 * lean on `Number(x) || fallback`, which would quietly rewrite 0 to 1.
 */
function wholeOr(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Run a search and push the outcome into state.
 *
 * Season and episode only travel for shows: Torrentio's series endpoint is
 * keyed on `imdb:season:episode`, and querying it without them returns an
 * empty list rather than an error.
 */
export async function runSearch(query, type, season, episode) {
  const term = String(query || '').trim();
  if (!term) return;

  const isShow = type === 'show';
  const wantedSeason = isShow ? wholeOr(season, state.search.season) : state.search.season;
  const wantedEpisode = isShow ? wholeOr(episode, state.search.episode) : state.search.episode;

  patchSlice('search', {
    query: term, type, season: wantedSeason, episode: wantedEpisode,
    status: 'loading', error: null, results: [], sources: []
  });

  const params = { q: term, type };
  if (isShow) {
    params.season = wantedSeason;
    params.episode = wantedEpisode;
  }

  try {
    const outcome = await api.searchTorrents(params);
    patchSlice('search', {
      status: 'done',
      results: outcome.results || [],
      sources: outcome.sources || []
    });
  } catch (error) {
    patchSlice('search', { status: 'error', error: error.message, results: [], sources: [] });
  }
}

/** Send a chosen result to the downloader. */
export async function downloadResult(index) {
  const result = state.search.results[index];
  if (!result) return;

  const isShow = state.search.type === 'show';

  try {
    const job = await api.startDownload({
      magnet: result.magnet,
      infoHash: result.infoHash,
      title: state.search.query || result.title,
      type: isShow ? 'episode' : 'movie',
      // Without these the organizer files every episode as S00E00 and picks
      // the largest file out of a season pack rather than the right one.
      season: isShow ? state.search.season : undefined,
      episode: isShow ? state.search.episode : undefined,
      source: result.source
    });
    toast('success', 'Download started', job.title || result.title);
    return job;
  } catch (error) {
    toast('error', 'Could not start download', error.message);
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */

export function renderSearch() {
  const { query, type, season, episode, filters, status, results, sources, error } = state.search;
  const visible = applyFilters(results, filters);

  const toolbar = `
    <div class="search-toolbar">
      <div class="search-toolbar__row">
        <input class="input" id="search-input" placeholder="Title to search for…" value="${esc(query)}" autocomplete="off">
        <select class="select" id="search-type" data-action="set-search-type">
          <option value="movie"${type === 'movie' ? ' selected' : ''}>Movie</option>
          <option value="show"${type === 'show' ? ' selected' : ''}>Show</option>
        </select>
        ${type === 'show' ? `
          <label class="episode-picker" title="Torrentio indexes shows one episode at a time">
            <span class="episode-picker__label">S</span>
            <input class="input input--num" id="search-season" type="number" min="0" max="99"
                   value="${wholeOr(season, 1)}" aria-label="Season" autocomplete="off">
            <span class="episode-picker__label">E</span>
            <input class="input input--num" id="search-episode" type="number" min="0" max="999"
                   value="${wholeOr(episode, 1)}" aria-label="Episode" autocomplete="off">
          </label>` : ''}
        <button class="btn btn--primary" data-action="run-search">${icon('search', 'btn__icon')}<span class="btn__label">Search</span></button>
      </div>
      <div class="search-toolbar__row">
        <div class="chips">
          ${QUALITY_FILTERS.map((filter) => `
            <button class="chip${filters.quality === filter.id ? ' is-active' : ''}" data-action="filter-quality" data-quality="${filter.id}">${filter.label}</button>`).join('')}
        </div>
        <label class="switch" style="margin-left:auto">
          <input type="checkbox" id="hide-upscaled" data-action="toggle-upscaled"${filters.hideUpscaled ? ' checked' : ''}>
          <span class="switch__track"><span class="switch__thumb"></span></span>
          <span>Hide low-quality upscaled</span>
        </label>
      </div>
      ${sources.length ? `
        <div class="source-pills">
          <span>Sources:</span>
          ${sources.map((source) => `<span class="badge${source.ok ? '' : ' badge--error'}"${source.error ? ` title="${esc(source.error)}"` : ''}>${esc(source.label || source.id)} · ${source.ok ? source.count : 'failed'}</span>`).join('')}
        </div>` : ''}
    </div>`;

  let body;
  if (status === 'loading') {
    body = loadingState('Searching all sources…');
  } else if (status === 'error') {
    body = emptyState({
      iconName: 'warning',
      title: 'Search failed',
      text: error || 'Check connection and try again.',
      action: { label: 'Try again', action: 'run-search' }
    });
  } else if (status === 'idle') {
    body = emptyState({
      iconName: 'search',
      title: 'Find something to watch',
      text: 'Search across your AllDebrid cache, Torrentio and any indexers you have configured.'
    });
  } else if (results.length === 0) {
    body = emptyState({
      iconName: 'search',
      title: 'No results',
      text: 'Try a different query.'
    });
  } else if (visible.length === 0) {
    body = emptyState({
      iconName: 'search',
      title: 'Everything is filtered out',
      text: `${results.length} result${results.length === 1 ? '' : 's'} found, but none match the current filters.`,
      action: { label: 'Clear filters', action: 'clear-filters' }
    });
  } else {
    body = `<div class="result-list">${visible.map(resultRow).join('')}</div>`;
  }

  return `
    <div class="page__header">
      <h1 class="page__title">Search</h1>
      ${status === 'done' && results.length
    ? `<span class="page__count">${visible.length} of ${results.length} shown</span>`
    : ''}
    </div>
    ${toolbar}
    ${body}`;
}

function resultRow(result) {
  const index = state.search.results.indexOf(result);
  const title = result.title.length > 60 ? `${result.title.slice(0, 60)}…` : result.title;
  const quality = result.badges?.quality || 'SD';
  const source = result.badges?.source;
  const warnings = result.badges?.warnings || [];

  const qualityClass = quality === '4K' ? 'badge--4k'
    : quality === '1080p' ? 'badge--1080p'
      : quality === '720p' ? 'badge--720p' : 'badge--sd';

  return `
    <div class="result">
      <div class="result__main">
        <div class="result__title" title="${esc(result.title)}">${esc(title)}</div>
        <div class="result__badges">
          <span class="badge ${qualityClass}">${esc(quality)}</span>
          ${source ? `<span class="badge ${source === 'CAM' ? 'badge--cam' : 'badge--source'}">${esc(source)}</span>` : ''}
          ${result.cached ? '<span class="badge badge--complete">cached</span>' : ''}
          ${warnings.map((warning) => `
            <span class="badge badge--warning tooltip" data-tooltip="Likely AI-upscaled">
              <span class="result__warning">${icon('warning')}</span>${esc(warning)}
            </span>`).join('')}
          ${(result.indexers || []).slice(0, 2).map((name) => `<span class="badge">${esc(name)}</span>`).join('')}
        </div>
      </div>
      <div class="result__stat"><strong>${esc(result.size_human || formatBytes(result.size_bytes))}</strong>size</div>
      <div class="result__stat"><strong>${result.seeders ?? 0}</strong>seeders</div>
      <div class="result__stat"><strong>${Number(result.final_score).toFixed(2)}</strong>score</div>
      <button class="btn ${result.is_upscaled || result.is_cam ? 'btn--secondary' : 'btn--primary'}" data-action="download-result" data-index="${index}">Download</button>
    </div>`;
}

export default { renderSearch, runSearch, downloadResult, applyFilters };
