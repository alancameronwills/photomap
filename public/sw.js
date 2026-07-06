/* ── Service worker: offline cache for Track mode ─────────────────────────────
 * Serves map tiles, photos, API data and the app shell from Cache Storage so
 * the app keeps working through mobile signal drop-outs. The page-side
 * prefetch manager (offline-cache.js) fills the same caches proactively;
 * this worker fills them opportunistically during normal browsing and serves
 * from them when the network fails.
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
      // stale-while-revalidate route repairs any gap on first online use.
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

// Cache-first under a normalised synthetic key. On a miss the request is
// re-issued as a cors fetch of the real URL (all our tile hosts send
// Access-Control-Allow-Origin: *) so the cached response is non-opaque —
// opaque responses are heavily padded in browser quota accounting.
async function tileCacheFirst(key, url) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(key);
  if (hit) return hit;
  const resp = await fetch(url, { mode: 'cors' });
  if (resp.ok) cache.put(key, resp.clone()).catch(() => {});
  return resp;
}

// Cache-first for photos. Prefers a cors fetch (accurate quota, readable
// status); falls back to no-cors — an opaque response still displays in <img>
// and is better than nothing if S3 CORS isn't configured yet.
async function photoCacheFirst(key, request) {
  const cache = await caches.open(PHOTOS);
  const hit = await cache.match(key);
  if (hit) return hit;
  let resp;
  try {
    resp = await fetch(request.url, { mode: 'cors' });
  } catch (e) {
    resp = await fetch(request.url, { mode: 'no-cors' });
  }
  if (resp.ok || resp.type === 'opaque') cache.put(key, resp.clone()).catch(() => {});
  return resp;
}

// Network-first with a timeout, falling back to the cached copy, then to a
// synthesized fallback body (if given) so callers never see a rejection.
//
// The timeout only decides how long we wait before serving a fallback — it does
// NOT abort the network request. A slow-but-successful response (e.g. the multi-
// MB /api/pois payload, which can take several seconds) keeps running in the
// background and refreshes the cache, so the next load is fresh. Aborting it
// would leave the cache permanently stale whenever the server is slower than the
// timeout.
async function networkFirst(request, cacheName, key, timeoutMs, fallbackBody) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then((resp) => {
    if (resp.ok) cache.put(key, resp.clone()).catch(() => {});
    return resp;
  });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });

  try {
    const resp = await Promise.race([network, timeout]);
    if (resp) { clearTimeout(timer); return resp; } // network won the race
  } catch (e) {
    // network rejected (likely offline) — fall through to cache/fallback
  }
  network.catch(() => {}); // keep filling the cache; swallow a later rejection
  const hit = await cache.match(key);
  if (hit) return hit;
  if (fallbackBody !== undefined) return jsonResponse(fallbackBody);
  return network; // no cache, no fallback: wait for the real response
}

// Stale-while-revalidate for the app shell: serve the cached copy immediately,
// refresh it in the background.
async function staleWhileRevalidate(request, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key);
  const refresh = fetch(request)
    .then((resp) => {
      if (resp.ok) cache.put(key, resp.clone()).catch(() => {});
      return resp;
    });
  if (hit) {
    refresh.catch(() => {}); // background refresh may fail offline — fine
    return hit;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const tileKey = TileMath.normaliseTileKey(req.url);
  if (tileKey) {
    event.respondWith(tileCacheFirst(tileKey, req.url));
    return;
  }

  const photoKey = TileMath.normalisePhotoKey(req.url);
  if (photoKey) {
    event.respondWith(photoCacheFirst(photoKey, req));
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // foreign non-tile/photo: untouched

  const path = url.pathname;
  if (path === '/api/pois' || path === '/api/routes') {
    // /api/pois is a multi-MB payload that regularly takes ~6s; give it ample
    // headroom so online users get fresh data on this load rather than a stale
    // fallback. (An offline fetch rejects fast regardless of this value.)
    event.respondWith(networkFirst(req, API, path + url.search, 15000, []));
    return;
  }
  if (path === '/api/projects') {
    event.respondWith(networkFirst(req, API, path, 4000, { projects: [], defaultId: null }));
    return;
  }
  if (path === '/auth/status') {
    event.respondWith(networkFirst(req, API, path, 3000, { authenticated: false }));
    return;
  }
  if (path === '/config.js') {
    event.respondWith(networkFirst(req, SHELL, path, 3000));
    return;
  }
  // Other API/auth/upload traffic (writes, OAuth redirects, sw.js itself)
  // goes straight to the network.
  if (path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/uploads/') || path === '/sw.js') return;

  // App shell: navigations and same-origin static assets.
  event.respondWith(staleWhileRevalidate(req, req.mode === 'navigate' ? '/' : path));
});
