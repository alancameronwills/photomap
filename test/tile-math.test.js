const { test } = require('node:test');
const assert = require('node:assert');
const {
  PROVIDERS,
  latLngToTile,
  tileRangeForRadius,
  tilesForRadius,
  tileUrl,
  normaliseTileKey,
  normalisePhotoKey,
  haversineMeters,
} = require('../public/tile-math');

// Inverse Mercator (north-west corner of tile x/y at zoom z) — used to verify
// latLngToTile against an independent formula rather than itself.
const tileNorthLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const tileWestLng = (x, z) => (x / 2 ** z) * 360 - 180;

test('latLngToTile exact cases', () => {
  assert.deepStrictEqual(latLngToTile(0, 0, 0), { x: 0, y: 0 });
  assert.deepStrictEqual(latLngToTile(0.0001, 0.0001, 1), { x: 1, y: 0 });
  assert.deepStrictEqual(latLngToTile(-0.0001, -0.0001, 1), { x: 0, y: 1 });
  assert.deepStrictEqual(latLngToTile(0, 90, 2), { x: 3, y: 2 });
  assert.deepStrictEqual(latLngToTile(0, -180, 3), { x: 0, y: 4 });
});

test('latLngToTile output tile contains the input point (round-trip)', () => {
  const points = [
    [51.5074, -0.1278], // London
    [52.4, -3.6],       // mid-Wales
    [-33.86, 151.21],   // Sydney
    [64.14, -21.9],     // Reykjavík
  ];
  for (const [lat, lng] of points) {
    for (const z of [8, 12, 16]) {
      const { x, y } = latLngToTile(lat, lng, z);
      assert.ok(tileWestLng(x, z) <= lng && lng < tileWestLng(x + 1, z), `lng in tile at z${z}`);
      assert.ok(tileNorthLat(y + 1, z) <= lat && lat < tileNorthLat(y, z), `lat in tile at z${z}`);
    }
  }
});

test('latLngToTile clamps beyond the Mercator singularity', () => {
  assert.strictEqual(latLngToTile(89.9, 0, 4).y, 0);
  assert.strictEqual(latLngToTile(-89.9, 0, 4).y, 15);
});

test('tileRangeForRadius spans the expected tile count and contains the centre', () => {
  // At lat 52 / z16 a tile is ~376 m wide, so a 2 km radius (4 km box) needs
  // roughly 11 tiles per axis.
  const r = tileRangeForRadius(52, -3.6, 2000, 16);
  const w = r.maxX - r.minX + 1;
  const h = r.maxY - r.minY + 1;
  assert.ok(w >= 10 && w <= 13, `width ${w}`);
  assert.ok(h >= 10 && h <= 13, `height ${h}`);
  const c = latLngToTile(52, -3.6, 16);
  assert.ok(c.x >= r.minX && c.x <= r.maxX);
  assert.ok(c.y >= r.minY && c.y <= r.maxY);
});

test('tileRangeForRadius with radius 0 is the single centre tile', () => {
  const r = tileRangeForRadius(52, -3.6, 0, 14);
  assert.strictEqual(r.minX, r.maxX);
  assert.strictEqual(r.minY, r.maxY);
});

test('tilesForRadius grows ~4x per zoom level and has no duplicates', () => {
  const tiles = tilesForRadius(52, -3.6, 2000, [12, 13, 14, 15, 16], PROVIDERS['Topographic']);
  const keys = new Set(tiles.map(t => `${t.z}/${t.x}/${t.y}`));
  assert.strictEqual(keys.size, tiles.length, 'no duplicate tiles');
  const perZoom = {};
  tiles.forEach(t => { perZoom[t.z] = (perZoom[t.z] || 0) + 1; });
  assert.deepStrictEqual(Object.keys(perZoom).map(Number).sort((a, b) => a - b), [12, 13, 14, 15, 16]);
  assert.ok(perZoom[16] > perZoom[15] && perZoom[15] > perZoom[14]);
  // Sanity on total size: a 2 km circle at z12–16 should be modest.
  assert.ok(tiles.length > 100 && tiles.length < 300, `total ${tiles.length}`);
});

test('NLS provider applies zoomOffset -1 and maxNativeZoom 16', () => {
  const tiles = tilesForRadius(52, -3.6, 500, [12, 16, 18], PROVIDERS['NLS Historic OS (UK)']);
  const zooms = [...new Set(tiles.map(t => t.z))].sort((a, b) => a - b);
  // map z12 → tile z11; map z16 and z18 both clamp to 16 → tile z15, once.
  assert.deepStrictEqual(zooms, [11, 15]);
});

test('tileUrl expands templates, including ESRI z/y/x order and MapTiler key', () => {
  const t = { z: 14, x: 8100, y: 5200 };
  assert.strictEqual(
    tileUrl(PROVIDERS['Topographic'], t, { subdomain: 'b' }),
    'https://b.tile.opentopomap.org/14/8100/5200.png'
  );
  assert.strictEqual(
    tileUrl(PROVIDERS['Aerial (ESRI)'], t),
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5200/8100'
  );
  assert.strictEqual(
    tileUrl(PROVIDERS['NLS Historic OS (UK)'], t, { key: 'abc123' }),
    'https://api.maptiler.com/tiles/uk-osgb1888/14/8100/5200.jpg?key=abc123'
  );
});

test('normaliseTileKey folds subdomains and strips the MapTiler key', () => {
  assert.strictEqual(
    normaliseTileKey('https://a.tile.opentopomap.org/14/8100/5200.png'),
    normaliseTileKey('https://b.tile.opentopomap.org/14/8100/5200.png')
  );
  assert.strictEqual(
    normaliseTileKey('https://c.tile.openstreetmap.org/12/2025/1300.png'),
    '/__tile/osm/12/2025/1300'
  );
  assert.strictEqual(
    normaliseTileKey('https://api.maptiler.com/tiles/uk-osgb1888/13/4050/2600.jpg?key=SECRET'),
    '/__tile/nls/13/4050/2600'
  );
  // ESRI path is z/y/x — key must come out as z/x/y.
  assert.strictEqual(
    normaliseTileKey('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5200/8100'),
    '/__tile/esri/14/8100/5200'
  );
});

test('normaliseTileKey round-trips tileUrl for every provider', () => {
  const t = { z: 15, x: 16200, y: 10400 };
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const url = tileUrl(p, t, { subdomain: p.subdomains[0] || '', key: 'k' });
    assert.strictEqual(normaliseTileKey(url), `/__tile/${p.id}/15/16200/10400`, name);
  }
});

test('normaliseTileKey rejects non-tile URLs', () => {
  assert.strictEqual(normaliseTileKey('https://example.com/12/34/56.png'), null);
  assert.strictEqual(normaliseTileKey('https://tile.openstreetmap.org/about'), null);
  assert.strictEqual(normaliseTileKey('not a url'), null);
});

test('normalisePhotoKey maps local and presigned S3 URLs to the same key', () => {
  const local = normalisePhotoKey('/uploads/thumbs/abc_thumb.jpg');
  const s3 = normalisePhotoKey(
    'https://photomap-bucket.s3.eu-west-2.amazonaws.com/thumbs/abc_thumb.jpg?X-Amz-Signature=deadbeef&X-Amz-Expires=3600'
  );
  assert.strictEqual(local, '/__photo/thumbs/abc_thumb.jpg');
  assert.strictEqual(s3, local);
  assert.strictEqual(
    normalisePhotoKey('http://localhost:3000/uploads/originals/abc.jpg'),
    '/__photo/originals/abc.jpg'
  );
});

test('normalisePhotoKey rejects unrelated URLs', () => {
  assert.strictEqual(normalisePhotoKey('https://example.com/originals/abc.jpg'), null);
  assert.strictEqual(normalisePhotoKey('/api/pois'), null);
  assert.strictEqual(normalisePhotoKey('/uploads/other/abc.jpg'), null);
});

test('haversineMeters sanity', () => {
  // One degree of latitude ≈ 111.2 km.
  const d = haversineMeters(52, -3.6, 53, -3.6);
  assert.ok(Math.abs(d - 111200) < 1000, `${d}`);
  assert.strictEqual(haversineMeters(52, -3.6, 52, -3.6), 0);
});
