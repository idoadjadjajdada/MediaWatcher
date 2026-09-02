/**
 * Search page: markup, filters, and the download action.
 *
 * renderSearch lives here rather than in views.js because the filter logic and
 * the markup are the same concern — views.js stays the home of the pages that
 * only read library state.
 */
import * as api from './api.js';
import { state, setState, patchSlice } from './state.js';
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
  // A picked suggestion carries its TMDB id, which the resolver treats as
  // authoritative - no title matching, so no way for a typo to matter.
  if (state.search.tmdbId) params.tmdb_id = state.search.tmdbId;

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
export async function downloadResult(index, { files = null, pack = false } = {}) {
  const result = state.search.results[index];
  if (!result) return null;

  const isShow = state.search.type === 'show';

  try {
    const job = await api.startDownload({
      magnet: result.magnet,
      infoHash: result.infoHash,
      title: state.search.query || result.title,
      /*
       * 'season' is its own thing, not an episode with the number left off. It
       * tells the server to read each file's own numbering rather than writing
       * every file in the torrent to one episode's path.
       */
      type: pack ? 'season' : (isShow ? 'episode' : 'movie'),
      // Without these the organizer files every episode as S00E00 and picks
      // the largest file out of a season pack rather than the right one.
      season: isShow ? state.search.season : undefined,
      episode: isShow && !pack ? state.search.episode : undefined,
      files: files || undefined,
      source: result.source
    });
    toast('success', pack ? 'Season download started' : 'Download started', job.title || result.title);
    return job;
  } catch (error) {
    toast('error', 'Could not start download', error.message);
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Looking inside a torrent
 *
 * A release is a filename and a size, and neither says whether it holds one
 * episode, a whole season, or a film with three sample files and a readme
 * beside it. Asking costs an upload to AllDebrid, so it is a deliberate act
 * rather than something done for every row in a result list.
 * ----------------------------------------------------------------------- */

/** Which files are ticked, by filename. */
const chosen = new Set();

export async function inspectResult(index) {
  const result = state.search.results[index];
  if (!result) return;

  chosen.clear();
  patchSlice('search', { inspecting: { index, status: 'loading', files: [], ready: false } });

  try {
    const found = await api.inspectTorrent({ magnet: result.magnet, infoHash: result.infoHash });
    // Everything worth having is ticked to start with: the common case is
    // wanting all of it, minus the sample.
    for (const file of found.files) if (file.video && !file.sample) chosen.add(file.filename);
    patchSlice('search', { inspecting: { index, status: 'done', ...found } });
  } catch (error) {
    patchSlice('search', { inspecting: { index, status: 'error', error: error.message, files: [] } });
  }
}

export function toggleInspectFile(filename) {
  if (chosen.has(filename)) chosen.delete(filename);
  else chosen.add(filename);
  setState({});
}

export function closeInspect() {
  chosen.clear();
  patchSlice('search', { inspecting: null });
}

/** Download exactly what is ticked. */
export async function downloadChosen() {
  const inspecting = state.search.inspecting;
  if (!inspecting || chosen.size === 0) return;

  /*
   * More than one episode among the ticked files means this is a pack however
   * it was searched for, so each file has to be filed by its own name rather
   * than all of them at whatever episode the search box happened to hold.
   */
  const episodes = inspecting.files.filter((file) => chosen.has(file.filename) && file.episode);
  const pack = episodes.length > 1;

  await downloadResult(inspecting.index, { files: [...chosen], pack });
  closeInspect();
}

/** The file list, as a dialog over the results. */
export function renderInspect() {
  const inspecting = state.search.inspecting;
  if (!inspecting) return '';

  const tag = (episode) =>
    'S' + String(episode.season).padStart(2, '0') + 'E' + String(episode.episode).padStart(2, '0');

  const body = inspecting.status === 'loading'
    ? '<div class="settings__loading">Asking AllDebrid what is in it…</div>'
    : inspecting.status === 'error'
      ? `<div class="settings__warn">${esc(inspecting.error)}</div>`
      : !inspecting.ready
        ? `<div class="settings__warn">
             AllDebrid does not hold this torrent yet, so there is no file list to
             show — it only exists once they have fetched it. Downloading starts
             that, and every episode will still be filed by its own name.
           </div>`
        : `<div class="filelist">
            ${inspecting.files.map((file) => `
              <label class="filelist__row${file.video ? '' : ' is-other'}">
                <input type="checkbox" data-action="toggle-inspect-file"
                  data-filename="${esc(file.filename)}"${chosen.has(file.filename) ? ' checked' : ''}>
                <span class="filelist__name">${esc(file.filename)}</span>
                ${file.episode ? `<span class="badge">${esc(tag(file.episode))}</span>` : ''}
                ${file.sample ? '<span class="badge badge--warning">sample</span>' : ''}
                <span class="filelist__size t-num">${esc(formatBytes(file.size))}</span>
              </label>`).join('')}
          </div>`;

  return `
    <div class="modal-backdrop" data-action="close-inspect-backdrop">
      <div class="modal modal--narrow" role="dialog" aria-modal="true" aria-label="Files in this torrent">
        <button class="modal__close" data-action="close-inspect" aria-label="Close">${icon('close')}</button>
        <div class="modal__body">
          <h2 class="modal__title">What is in this torrent</h2>
          ${body}
          <div class="settings__actions">
            <button class="btn btn--primary" data-action="download-chosen"
              ${inspecting.ready && chosen.size > 0 ? '' : 'disabled'}>
              Download ${inspecting.ready ? `${chosen.size} file${chosen.size === 1 ? '' : 's'}` : 'anyway'}
            </button>
            <button class="btn btn--ghost" data-action="close-inspect">Close</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* --------------------------------------------------------------------------
 * Render
 * ----------------------------------------------------------------------- */

export function renderSearch() {
  const { query, type, season, episode, suggestions, filters, status, results, sources, error } = state.search;
  const visible = applyFilters(results, filters);

  const toolbar = `
    <div class="search-toolbar">
      <div class="search-toolbar__row">
        <input class="input" id="search-input" placeholder="Title to search for…" value="${esc(query)}"
               autocomplete="off" data-action="suggest-input"
               role="combobox" aria-expanded="${suggestions.length > 0}">
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
        <button class="btn btn--primary" data-action="run-search">${icon('search', 'icon-sm')}<span class="btn__label">Search</span></button>
      </div>
      ${suggestions.length ? `
        <div class="suggestions" id="suggestions" role="listbox">
          ${suggestions.map((entry, index) => `
            <button class="suggestion" role="option" data-action="pick-suggestion" data-index="${index}">
              ${entry.poster
    ? `<img class="suggestion__poster" loading="lazy" alt="" src="${esc(entry.poster)}">`
    : '<span class="suggestion__poster suggestion__poster--empty"></span>'}
              <span class="suggestion__title">${esc(entry.title)}</span>
              ${entry.year ? `<span class="suggestion__year">${entry.year}</span>` : ''}
              <span class="badge suggestion__type">${entry.type === 'show' ? 'Show' : 'Movie'}</span>
            </button>`).join('')}
        </div>` : ''}
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
    <div class="page__head">
      <h1 class="t-hero">Search</h1>
      ${status === 'done' && results.length
    ? `<span class="t-meta">${visible.length} of ${results.length} shown</span>`
    : ''}
    </div>
    ${toolbar}
    ${body}
    ${renderInspect()}`;
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
      <button class="btn btn--ghost" data-action="inspect-result" data-index="${index}"
        title="List what is inside before downloading">Files</button>
      <button class="btn ${result.is_upscaled || result.is_cam ? 'btn--secondary' : 'btn--primary'}" data-action="download-result" data-index="${index}">Download</button>
    </div>`;
}

export default {
  renderSearch, runSearch, downloadResult, applyFilters,
  inspectResult, toggleInspectFile, closeInspect, downloadChosen, renderInspect
};
