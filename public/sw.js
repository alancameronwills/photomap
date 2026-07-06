/* ── Service worker: offline safety net for Track mode ───────────────────────
 * Strategy: NETWORK-FIRST for everything (tiles, photos, API data, app shell).
 * While the network works, the worker always serves the fresh network response
 * and is otherwise transparent — it never serves cached content online, so it
 * can't interfere with normal operation (no stale app shell, API, tiles or
 * photos). The caches are purely an offline fallback for mobile signal
 * drop-outs during a walk: they're charged with nearby content by the page-side
 * prefetch manager (offline-cache.js) while Track mode is on, and only read
 * when a fetch fails (i.e. we've gone offline).
 *
 * Cache names and their version live in tile-math.js (TileMath.CACHES);
 * bump CACHE_VERSION there on any change to cache key formats or routing so
 * stale caches are dropped on activate.
 */
importScripts('/tile-math.js');

const SW_VERSION = TileMath.CACHE_VERSION;
const { shell: SHELL, tiles: TILES, photos: PHOTOS, api: API } = TileMath.CACHES;

// Entry-count caps enforced by trimCache (Cache Storage has no built-in LRU;
// deleting from the front of cache.keys() approximates oldest-first).
const CACHE_CAPS = { [TILES]: 2500, [PHOTOS]: 600, [API]: 40 };

const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/tile-math.js',
  '/offline-cache.js',
  '/config.js',
  '/favicon.svg',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/leaflet/images/layers.png',
  '/vendor/leaflet/images/layers-2x.png',
  '/vendor/markercluster/leaflet.markercluster.js',
  '/vendor/markercluster/MarkerCluster.css',
  '/vendor/markercluster/MarkerCluster.Default.css',
  '/vendor/exifr/lite.umd.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // allSettled: a single missing asset mustn't block install — the
      // network-first route repairs any gap on the next online load.
      Promise.allSettled(SHELL_URLS.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith('pm-') && !n.endsWith(`-${SW_VERSION}`))
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'trim') {
    event.waitUntil(
      Promise.all(Object.entries(CACHE_CAPS).map(([name, cap]) => trimCache(name, cap)))
    );
  }
});

async function trimCache(name, maxEntries) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Network-first, cache read only on failure ────────────────────────────────
// Every strategy below hits the network first and returns its response whenever
// the fetch resolves — so online we always serve fresh content, never a stale
// cache entry, and the online path touches Cache Storage not at all. The cache
// is READ only when the fetch REJECTS (the device is offline). The worker never
// WRITES to the cache: it's filled by the shell precache (on install) and, for
// nearby content, by the prefetcher (offline-cache.js) while Track mode is on —
// so nothing accumulates during ordinary online browsing.

async function cachedFallback(cacheName, key, fallbackBody) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key);
  if (hit) return hit;
  if (fallbackBody !== undefined) return jsonResponse(fallbackBody);
  return null;
}

// Same-origin requests (app shell, API). On offline failure: cached copy, then
// a synthesized fallback body (if given) so the startup fetches never reject.
async function networkFirst(request, cacheName, key, fallbackBody) {
  try {
    return await fetch(request);
  } catch (e) {
    const fb = await cachedFallback(cacheName, key, fallbackBody);
    if (fb) return fb;
    throw e;
  }
}

// Tiles, keyed by a normalised synthetic key (folds a/b/c subdomains and the
// MapTiler ?key= so the cache entry matches what the prefetcher stored).
async function tileNetworkFirst(key, url) {
  try {
    return await fetch(url, { mode: 'cors' });
  } catch (e) {
    const fb = await cachedFallback(TILES, key);
    if (fb) return fb;
    throw e;
  }
}

// Photos. Prefers a cors fetch, falling back to no-cors on a CORS error. Only a
// genuine network failure (both modes reject) falls through to the cache.
async function photoNetworkFirst(key, request) {
  try {
    try {
      return await fetch(request.url, { mode: 'cors' });
    } catch (e) {
      return await fetch(request.url, { mode: 'no-cors' });
    }
  } catch (e) {
    const fb = await cachedFallback(PHOTOS, key);
    if (fb) return fb;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const tileKey = TileMath.normaliseTileKey(req.url);
  if (tileKey) {
    event.respondWith(tileNetworkFirst(tileKey, req.url));
    return;
  }

  const photoKey = TileMath.normalisePhotoKey(req.url);
  if (photoKey) {
    event.respondWith(photoNetworkFirst(photoKey, req));
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // foreign non-tile/photo: untouched

  const path = url.pathname;
  // API data: network-first with a synthesized empty fallback so the startup
  // Promise.all still resolves when we're offline with a cold cache.
  if (path === '/api/pois' || path === '/api/routes') {
    event.respondWith(networkFirst(req, API, path + url.search, []));
    return;
  }
  if (path === '/api/projects') {
    event.respondWith(networkFirst(req, API, path, { projects: [], defaultId: null }));
    return;
  }
  if (path === '/auth/status') {
    event.respondWith(networkFirst(req, API, path, { authenticated: false }));
    return;
  }
  if (path === '/config.js') {
    event.respondWith(networkFirst(req, SHELL, path));
    return;
  }
  // Other API/auth/upload traffic (writes, OAuth redirects, sw.js itself)
  // goes straight to the network.
  if (path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/uploads/') || path === '/sw.js') return;

  // App shell: navigations and same-origin static assets.
  event.respondWith(networkFirst(req, SHELL, req.mode === 'navigate' ? '/' : path));
});
