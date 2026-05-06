const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'photomap.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS pois (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    title TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poi_id INTEGER NOT NULL REFERENCES pois(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    thumb_filename TEXT,
    original_name TEXT,
    order_index INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestPoi(lat, lng, maxMeters) {
  const pois = db.prepare('SELECT id, lat, lng FROM pois').all();
  let best = null;
  let bestDist = maxMeters;
  for (const p of pois) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function getAllPois() {
  const pois = db.prepare('SELECT * FROM pois ORDER BY created_at DESC').all();
  const photos = db.prepare('SELECT * FROM photos ORDER BY order_index ASC, id ASC').all();
  const photosByPoi = {};
  for (const ph of photos) {
    if (!photosByPoi[ph.poi_id]) photosByPoi[ph.poi_id] = [];
    photosByPoi[ph.poi_id].push(ph);
  }
  return pois.map(p => ({ ...p, photos: photosByPoi[p.id] || [] }));
}

function getPoiById(id) {
  const poi = db.prepare('SELECT * FROM pois WHERE id = ?').get(id);
  if (!poi) return null;
  const photos = db.prepare('SELECT * FROM photos WHERE poi_id = ? ORDER BY order_index ASC, id ASC').all(id);
  return { ...poi, photos };
}

function createPoi(lat, lng, title, note) {
  const result = db.prepare(
    'INSERT INTO pois (lat, lng, title, note) VALUES (?, ?, ?, ?)'
  ).run(lat, lng, title || null, note || null);
  return getPoiById(result.lastInsertRowid);
}

function updatePoi(id, { lat, lng, title, note }) {
  const fields = [];
  const vals = [];
  if (lat !== undefined) { fields.push('lat = ?'); vals.push(lat); }
  if (lng !== undefined) { fields.push('lng = ?'); vals.push(lng); }
  if (title !== undefined) { fields.push('title = ?'); vals.push(title || null); }
  if (note !== undefined) { fields.push('note = ?'); vals.push(note || null); }
  if (!fields.length) return getPoiById(id);
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE pois SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getPoiById(id);
}

function deletePoi(id) {
  db.prepare('DELETE FROM pois WHERE id = ?').run(id);
}

function addPhoto(poiId, filename, thumbFilename, originalName, orderIndex) {
  const result = db.prepare(
    'INSERT INTO photos (poi_id, filename, thumb_filename, original_name, order_index) VALUES (?, ?, ?, ?, ?)'
  ).run(poiId, filename, thumbFilename, originalName, orderIndex || 0);
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(result.lastInsertRowid);
}

function deletePhoto(id) {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(id);
  return photo;
}

function reorderPhotos(poiId, orderedIds) {
  const stmt = db.prepare('UPDATE photos SET order_index = ? WHERE id = ? AND poi_id = ?');
  const tx = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, poiId));
  });
  tx();
}

module.exports = {
  haversineMeters,
  findNearestPoi,
  getAllPois,
  getPoiById,
  createPoi,
  updatePoi,
  deletePoi,
  addPhoto,
  deletePhoto,
  reorderPhotos,
};
