// elevation.js — MapTiler Terrain-RGB elevation lookup.
//
// Decodes elevation from MapTiler's `terrain-rgb-v2` raster DEM tiles. These are
// NOT the visual topographic map — each pixel's RGB bytes encode a height, so the
// lookup is deterministic arithmetic, not image recognition:
//
//   elevation_metres = -10000 + (R * 65536 + G * 256 + B) * 0.1
//
// Used by GET /routes/:id/profile to build elevation profiles. Works identically
// in local and AWS mode (server-side fetch, no S3/Dynamo branching).

const sharp = require('sharp');

const Z = 14; // sampling zoom: ~10 m/px at UK latitudes — ample for a route profile.
const TILE_URL = (z, x, y) =>
  `https://api.maptiler.com/tiles/terrain-rgb-v2/${z}/${x}/${y}.webp?key=${process.env.MAPTILER_KEY}`;

// Decoded-tile LRU cache: "z/x/y" -> { data, width, height, channels }.
const tileCache = new Map();
const TILE_CACHE_MAX = 64;

// Web-Mercator: lng/lat -> tile index plus the fractional position within the tile.
function lngLatToTile(lng, lat, z) {
  const n = Math.pow(2, z);
  const xt = n * ((lng + 180) / 360);
  const latRad = (lat * Math.PI) / 180;
  const yt = (n * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI)) / 2;
  const x = Math.floor(xt);
  const y = Math.floor(yt);
  return { x, y, fx: xt - x, fy: yt - y };
}

async function loadTile(z, x, y, referer) {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    tileCache.delete(key); // refresh LRU position
    tileCache.set(key, cached);
    return cached;
  }
  if (!process.env.MAPTILER_KEY) throw new Error('MAPTILER_KEY not set');
  // MapTiler keys are typically referrer-restricted. The browser sends its origin
  // automatically; server-side we pass the app's own origin so the request matches
  // whatever domain is whitelisted (localhost in dev, the deployed host in prod).
  const resp = await fetch(TILE_URL(z, x, y), referer ? { headers: { Referer: referer } } : undefined);
  if (!resp.ok) throw new Error(`terrain tile ${key} -> HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  // Decode to raw pixels; read actual dimensions/channels so 256 vs 512 tiles both work.
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const tile = { data, width: info.width, height: info.height, channels: info.channels };
  tileCache.set(key, tile);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return tile;
}

function decode(r, g, b) {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

// points: [{ lat, lng }]. Returns metres (Number) per point, or null where a tile
// could not be read. Groups points by tile so each tile is fetched/decoded once.
// `referer` is sent as the Referer header to satisfy referrer-restricted keys.
async function sampleElevations(points, referer) {
  const lookups = points.map((p) => {
    const t = lngLatToTile(p.lng, p.lat, Z);
    return { key: `${Z}/${t.x}/${t.y}`, x: t.x, y: t.y, fx: t.fx, fy: t.fy };
  });

  const uniq = new Map();
  for (const l of lookups) if (!uniq.has(l.key)) uniq.set(l.key, l);

  const tiles = new Map();
  await Promise.all(
    [...uniq.values()].map(async (l) => {
      try {
        tiles.set(l.key, await loadTile(Z, l.x, l.y, referer));
      } catch {
        tiles.set(l.key, null);
      }
    })
  );

  return lookups.map(({ key, fx, fy }) => {
    const tile = tiles.get(key);
    if (!tile) return null;
    const px = Math.min(tile.width - 1, Math.floor(fx * tile.width));
    const py = Math.min(tile.height - 1, Math.floor(fy * tile.height));
    const i = (py * tile.width + px) * tile.channels;
    return decode(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
  });
}

module.exports = { sampleElevations, Z };
