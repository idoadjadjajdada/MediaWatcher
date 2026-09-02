/**
 * Saving titles for offline playback.
 *
 * The video goes into a Cache the service worker also reads, under a synthetic
 * URL this module owns (`/offline-media/<encoded path>`). That indirection is
 * the point: the player asks this module for a URL and gets either the saved
 * one or the normal streaming one, so nothing else in the app has to know
 * whether a file is saved.
 *
 * The download is driven from the page rather than the worker because it needs
 * two things a worker cannot easily give back to a specific tab: progress, and
 * the ability to be cancelled. An episode is a gigabyte or more, and a
 * progress bar that cannot be stopped is worse than no button at all.
 */
import * as api from './api.js';

const CACHE_NAME = 'mw-offline';
const INDEX_KEY = 'mw.offline.index';

/** The synthetic URL a saved file lives at. */
export const offlineUrl = (filePath) => `/offline-media/${encodeURIComponent(filePath)}`;

export const isSupported = () =>
  typeof caches !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/* --------------------------------------------------------------------------
 * The index
 *
 * A Cache can be enumerated, but not cheaply and not with the title, size and
 * date the UI wants to show. So a small index rides alongside in localStorage;
 * the Cache stays the source of truth for what is actually playable, and the
 * index is reconciled against it on read.
 * ----------------------------------------------------------------------- */

function readIndex() {
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeIndex(index) {
  try {
    globalThis.localStorage?.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Losing the index costs the listing its titles, not the saved video.
  }
}

/**
 * Everything saved, newest first, reconciled against the Cache.
 *
 * An entry the Cache no longer holds is dropped rather than listed: browsers
 * evict storage under pressure without telling anyone, and offering to play
 * something that is gone is the worst version of this feature.
 */
export async function listSaved() {
  if (!isSupported()) return [];

  const index = readIndex();
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    return [];
  }

  const alive = [];
  let changed = false;
  for (const [filePath, entry] of Object.entries(index)) {
    const hit = await cache.match(offlineUrl(filePath));
    if (hit) alive.push({ filePath, ...entry });
    else changed = true;
  }

  if (changed) {
    writeIndex(Object.fromEntries(alive.map(({ filePath, ...rest }) => [filePath, rest])));
  }
  return alive.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function isSaved(filePath) {
  if (!isSupported()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(offlineUrl(filePath)));
  } catch {
    return false;
  }
}

/** The URL to play: the saved copy when there is one, otherwise null. */
export async function playbackUrl(filePath) {
  return (await isSaved(filePath)) ? offlineUrl(filePath) : null;
}

/* --------------------------------------------------------------------------
 * Saving
 * ----------------------------------------------------------------------- */

const inFlight = new Map();

export const isSaving = (filePath) => inFlight.has(filePath);
export const savingPaths = () => Array.from(inFlight.keys());

/** Stop a save in progress. The partial download is discarded. */
export function cancelSave(filePath) {
  const controller = inFlight.get(filePath);
  if (controller) controller.abort();
}

/**
 * Download a file into the offline cache.
 *
 * Read as a stream so progress can be reported and so a cancel takes effect
 * partway through rather than after the whole gigabyte has arrived. The
 * assembled body is only written to the Cache once it is complete: a partial
 * entry would look saved and play as a truncated file.
 */
export async function save(filePath, { title = null, onProgress } = {}) {
  if (!isSupported()) throw new Error('This browser cannot store offline video');
  if (inFlight.has(filePath)) throw new Error('Already saving');

  const info = await api.getOfflineInfo(filePath);
  if (!info.ready) {
    const error = new Error('A browser-friendly copy is being prepared. Try again in a few minutes.');
    error.code = 'preparing';
    throw error;
  }

  const controller = new AbortController();
  inFlight.set(filePath, controller);

  try {
    const response = await fetch(api.offlineFileUrl(filePath), { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);

    const total = Number(response.headers.get('content-length')) || info.bytes || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (typeof onProgress === 'function') {
        onProgress({ received, total, ratio: total > 0 ? received / total : 0 });
      }
    }

    const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'video/mp4' });
    const cache = await caches.open(CACHE_NAME);
    // Content-Length matters: the media element uses it to work out whether it
    // can seek, and a cached response without one plays but will not scrub.
    await cache.put(offlineUrl(filePath), new Response(blob, {
      headers: {
        'Content-Type': blob.type,
        'Content-Length': String(blob.size)
      }
    }));

    const index = readIndex();
    index[filePath] = { title, bytes: blob.size, savedAt: Date.now() };
    writeIndex(index);

    return { bytes: blob.size };
  } finally {
    inFlight.delete(filePath);
  }
}

/** Delete a saved copy and forget it. */
export async function remove(filePath) {
  if (!isSupported()) return false;
  const cache = await caches.open(CACHE_NAME);
  const removed = await cache.delete(offlineUrl(filePath));

  const index = readIndex();
  delete index[filePath];
  writeIndex(index);
  return removed;
}

/** Delete everything saved. */
export async function removeAll() {
  if (!isSupported()) return 0;
  const saved = await listSaved();
  for (const entry of saved) await remove(entry.filePath);
  return saved.length;
}

/* --------------------------------------------------------------------------
 * Storage
 * ----------------------------------------------------------------------- */

/**
 * How much room there is, as the browser sees it.
 *
 * `estimate()` reports the whole origin's usage, not just ours, and browsers
 * deliberately fuzz it — so it is shown as guidance and never used to decide
 * whether a save may proceed. The save either fits or throws.
 */
export async function quota() {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota: limit } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: limit || 0 };
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict this origin under storage pressure.
 *
 * Without it, saved video is the first thing thrown away when the device fills
 * up — which is exactly the moment someone is relying on it being there.
 * Chrome grants this silently for installed apps; Firefox prompts; Safari
 * ignores it. A refusal is not an error worth surfacing.
 */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export default {
  isSupported, offlineUrl, listSaved, isSaved, playbackUrl,
  save, remove, removeAll, cancelSave, isSaving, savingPaths,
  quota, requestPersistence
};
