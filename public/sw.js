/**
 * Service worker.
 *
 * Two jobs, kept in two caches so neither can evict the other:
 *
 *   SHELL    the app itself - HTML, CSS, modules, icons. Small, versioned,
 *            replaced wholesale on deploy.
 *   OFFLINE  video someone deliberately saved. Enormous, never versioned, and
 *            deleted only when they say so.
 *
 * What is deliberately NOT cached is as important. API responses are not:
 * a stale library that shows episodes you have since deleted, or hides ones
 * you just downloaded, is worse than an honest failure. The one exception is
 * the library listing itself, kept as a fallback so the app has something to
 * draw when it opens with no network - and only ever used when the network
 * has actually failed.
 *
 * Streaming is not intercepted at all. Range requests, HLS playlists and
 * segments all go straight to the network; a service worker sitting in the
 * middle of a video stream is a way to break seeking, not to speed it up.
 */

const VERSION = 'v7';
const SHELL_CACHE = `mw-shell-${VERSION}`;
const DATA_CACHE = `mw-data-${VERSION}`;
// Not versioned: saved video survives deploys. Bumping this would silently
// throw away gigabytes someone chose to keep.
const OFFLINE_CACHE = 'mw-offline';

/*
 * Every module the app boots from. Listed rather than discovered, because a
 * service worker has no way to crawl an ES module graph, and a missing entry
 * means the app half-loads offline instead of failing cleanly.
 */
const SHELL = [
  '/',
  '/index.html',
  // The gate is part of the shell: opening the app after the cookie expired
  // must reach a login form rather than a browser error page.
  '/login.html',
  '/js/login.js',
  '/css/login.css',
  '/css/styles.css',
  '/css/base.css',
  '/css/shell.css',
  '/css/content.css',
  '/css/catalog.css',
  '/css/player.css',
  '/css/settings.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/views.js',
  '/js/search.js',
  '/js/catalog.js',
  '/js/player.js',
  '/js/settings.js',
  '/js/preview.js',
  '/js/picture.js',
  '/js/intro.js',
  '/js/intro-edit.js',
  '/js/ass.js',
  '/js/subtitle-style.js',
  '/js/track-prefs.js',
  '/js/device-prefs.js',
  '/js/offline.js',
  '/js/push.js',
  '/js/notify.js',
  '/js/cast.js',
  '/js/adaptive.js',
  '/js/install.js',
  '/js/media-session.js',
  '/js/hls-player.js',
  '/js/vendor/hls.min.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/mark.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually rather than cache.addAll: that rejects the whole batch if
    // any single request fails, which would leave the worker uninstalled
    // because one optional file moved.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    // No waiting: the page that registered this worker should get it now
    // rather than on the next visit.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, OFFLINE_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((name) => (keep.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

/** Saved video is addressed by a synthetic URL the app builds and owns. */
const isOfflineAsset = (url) => url.pathname.startsWith('/offline-media/');

/** Requests that must always go to the network, untouched. */
function isPassThrough(url) {
  // /api/stream covers /api/stream/info too: the decision that starts an
  // encoder is on the critical path to first frame and must not gain a hop.
  return url.pathname.startsWith('/api/stream')
    || url.pathname.startsWith('/api/hls')
    || url.pathname.startsWith('/api/offline/file')
    || url.pathname.startsWith('/api/thumbs')
    || url.pathname.startsWith('/api/subs');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Another origin's problem — TMDB images, mostly.
  if (url.origin !== self.location.origin) return;

  if (isOfflineAsset(url)) {
    event.respondWith(caches.open(OFFLINE_CACHE).then((cache) => cache.match(request)
      .then((hit) => hit || new Response('Not saved for offline', { status: 404 }))));
    return;
  }

  if (isPassThrough(url)) return;

  /*
   * Navigations: network first so a deploy is picked up immediately, cache
   * second so the app opens at all with no connection. The cached shell is
   * the fallback rather than the offline page, because the app renders its own
   * empty states far better than a static page could.
   */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // The library listing is worth a fallback copy; nothing else is. A stale
    // job list or device list would be actively misleading.
    const cacheable = url.pathname === '/api/media/library';
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (cacheable && response.ok) {
          const cache = await caches.open(DATA_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        if (!cacheable) throw error;
        const cache = await caches.open(DATA_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        throw error;
      }
    })());
    return;
  }

  /*
   * Everything else is the shell: cache first, and refresh in the background
   * so an edit shows up on the next load without ever making this one wait.
   */
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);

    return hit || (await network) || Response.error();
  })());
});

/**
 * Messages from the page.
 *
 * Saving a video is driven from the page rather than here: it needs progress
 * reporting and the ability to be cancelled, and a worker cannot report either
 * back to a specific tab without more plumbing than it saves.
 */
self.addEventListener('message', (event) => {
  const { type } = event.data || {};
  if (type === 'skip-waiting') self.skipWaiting();
});

/* --------------------------------------------------------------------------
 * Notifications
 *
 * A push arrives with no payload at all — deliberately. Encrypting one needs
 * the whole of RFC 8291 on the server, and it would mean the title of whatever
 * you just downloaded passing through Google or Mozilla on its way here. So
 * the push is an empty knock, and this asks the server what it was about.
 *
 * The cost is that a notification cannot be shown while the server is
 * unreachable, which is the one case where there is nothing worth saying
 * anyway: every event this raises is something the server just did.
 * ----------------------------------------------------------------------- */

/** The highest event id already shown, so a second knock repeats nothing. */
let lastShownEvent = 0;

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let events = [];
    try {
      const response = await fetch(`/api/notifications/pending?since=${lastShownEvent}`, {
        credentials: 'include'
      });
      if (response.ok) events = (await response.json()).events || [];
    } catch {
      // Unreachable. Nothing useful to say, and a "something happened"
      // notification with no detail is worse than silence.
    }

    if (events.length === 0) return;

    for (const item of events) {
      lastShownEvent = Math.max(lastShownEvent, item.id);
      await self.registration.showNotification(item.title, {
        body: item.body,
        // Same tag replaces rather than stacks: three finished downloads
        // should not be three rows to dismiss.
        tag: item.tag || 'mediawatcher',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: '/' }
      });
    }
  })());
});

/**
 * Tapping one opens the app — or focuses it, if it is already open somewhere.
 *
 * Focusing rather than opening matters on a phone: a second tab of the same
 * app, with its own player, is not what tapping a notification should produce.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin)) return client.focus();
    }
    return self.clients.openWindow(event.notification.data?.url || '/');
  })());
});
