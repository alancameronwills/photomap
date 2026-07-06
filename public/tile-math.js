/* ── Tile math & offline-cache URL normalisation ─────────────────────────────
 * Pure helpers shared three ways: by the page (window.TileMath), by the
 * service worker (importScripts → self.TileMath) and by node:test
 * (module.exports). No DOM, no Leaflet, no network.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TileMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const M_PER_DEG_LAT = 111320; // metres per degree of latitude

  // Cache Storage names shared by sw.js and offline-cache.js. Bump the
  // version on any change to cache key formats so stale caches are dropped
  // when the new service worker activates.
  const CACHE_VERSION = 'v20260706213943';
  const CACHES = {
    shell: `pm-shell-${CACHE_VERSION}`,
    tiles: `pm-tiles-${CACHE_VERSION}`,
    photos: `pm-photos-${CACHE_VERSION}`,
    api: `pm-api-${CACHE_VERSION}`,
  };

  // Tile providers mirroring TILE_LAYERS in app.js, keyed by the same display
  // names. zoomOffset / maxNativeZoom are in Leaflet terms: the tile-URL zoom
  // is min(mapZoom, maxNativeZoom) + zoomOffset (the NLS layer serves 512px
  // tiles, hence its -1 offset). hostRe/pathRe recognise the provider's tile
  // URLs; coordOrder says how pathRe's capture groups map onto z/x/y.
  // politeConcurrency caps parallel prefetch fetches (OSM and OpenTopoMap
  // usage policies discourage bulk downloading).
  const PROVIDERS = {
    'OpenStreetMap': {
      id: 'osm',
      template: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      hostRe: /^([a-c]\.)?tile\.openstreetmap\.org$/,
      pathRe: /^\/(\d+)\/(\d+)\/(\d+)\.png$/,
      coordOrder: 'zxy',
      zoomOffset: 0,
      maxNativeZoom: 19,
      politeConcurrency: 2,
    },
    'Aerial (ESRI)': {
      id: 'esri',
      template: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      subdomains: [],
      hostRe: /^server\.arcgisonline\.com$/,
      pathRe: /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/,
      coordOrder: 'zyx',
      zoomOffset: 0,
      maxNativeZoom: 19,
      politeConcurrency: 4,
    },
    'Topographic': {
      id: 'opentopo',
      template: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      hostRe: /^([a-c]\.)?tile\.opentopomap\.org$/,
      pathRe: /^\/(\d+)\/(\d+)\/(\d+)\.png$/,
      coordOrder: 'zxy',
      zoomOffset: 0,
      maxNativeZoom: 17,
      politeConcurrency: 2,
    },
    'NLS Historic OS (UK)': {
      id: 'nls',
      template: 'https://api.maptiler.com/tiles/uk-osgb1888/{z}/{x}/{y}.jpg?key={key}',
      subdomains: [],
      hostRe: /^api\.maptiler\.com$/,
      pathRe: /^\/tiles\/uk-osgb1888\/(\d+)\/(\d+)\/(\d+)\.jpg$/,
      coordOrder: 'zxy',
      zoomOffset: -1,
      maxNativeZoom: 16,
      politeConcurrency: 4,
    },
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Standard slippy-map tile containing a lat/lng at tile zoom z.
  function latLngToTile(lat, lng, z) {
    const n = 2 ** z;
    const latRad = (lat * Math.PI) / 180;
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
    return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
  }

  // Inclusive x/y tile range covering a circle of radiusM around lat/lng at
  // tile zoom z (bounding square of the circle — a few corner tiles extra).
  function tileRangeForRadius(lat, lng, radiusM, z) {
    const dLat = radiusM / M_PER_DEG_LAT;
    const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    const nw = latLngToTile(lat + dLat, lng - dLng, z);
    const se = latLngToTile(lat - dLat, lng + dLng, z);
    return { minX: nw.x, maxX: se.x, minY: nw.y, maxY: se.y };
  }

  // Flat {z,x,y} list (tile-URL coordinates) covering the circle at each of
  // the given map zooms. Applies the provider's maxNativeZoom clamp and
  // zoomOffset; tile zooms that collapse together after clamping are emitted
  // once.
  function tilesForRadius(lat, lng, radiusM, mapZooms, provider) {
    const tiles = [];
    const seenZ = new Set();
    for (const mz of mapZooms) {
      const tz = Math.min(mz, provider.maxNativeZoom) + provider.zoomOffset;
      if (tz < 0 || seenZ.has(tz)) continue;
      seenZ.add(tz);
      const r = tileRangeForRadius(lat, lng, radiusM, tz);
      for (let x = r.minX; x <= r.maxX; x++)
        for (let y = r.minY; y <= r.maxY; y++)
          tiles.push({ z: tz, x, y });
    }
    return tiles;
  }

  function tileUrl(provider, tile, { subdomain = '', key = '' } = {}) {
    return provider.template
      .replace('{s}', subdomain)
      .replace('{z}', tile.z)
      .replace('{x}', tile.x)
      .replace('{y}', tile.y)
      .replace('{key}', key);
  }

  // Stable synthetic cache key for a tile URL, or null if the URL isn't a
  // known tile server. Folds the a/b/c subdomains into one key and drops the
  // MapTiler ?key= so the same tile always hits the same cache entry.
  function normaliseTileKey(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    for (const p of Object.values(PROVIDERS)) {
      if (!p.hostRe.test(u.hostname)) continue;
      const m = p.pathRe.exec(u.pathname);
      if (!m) continue;
      const x = p.coordOrder === 'zyx' ? m[3] : m[2];
      const y = p.coordOrder === 'zyx' ? m[2] : m[3];
      return `/__tile/${p.id}/${m[1]}/${x}/${y}`;
    }
    return null;
  }

  // Stable cache key for a photo URL, or null for anything else. Matches the
  // local /uploads/... paths and presigned S3 URLs (any *.amazonaws.com host,
  // signature query string ignored), so the local and AWS URLs for the same
  // photo share one cache entry that never expires.
  function normalisePhotoKey(url) {
    let u;
    try { u = new URL(url, 'http://relative.invalid'); } catch { return null; }
    let m = /^\/uploads\/(originals|thumbs)\/([^/?#]+)$/.exec(u.pathname);
    if (m) return `/__photo/${m[1]}/${m[2]}`;
    if (/\.amazonaws\.com$/.test(u.hostname)) {
      m = /\/(originals|thumbs)\/([^/?#]+)$/.exec(u.pathname);
      if (m) return `/__photo/${m[1]}/${m[2]}`;
    }
    return null;
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  return {
    CACHE_VERSION,
    CACHES,
    PROVIDERS,
    latLngToTile,
    tileRangeForRadius,
    tilesForRadius,
    tileUrl,
    normaliseTileKey,
    normalisePhotoKey,
    haversineMeters,
  };
});
