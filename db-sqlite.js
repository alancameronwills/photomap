const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'photomap.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate: add new columns to photos (silently ignored if columns already exist)
try { db.exec('ALTER TABLE photos ADD COLUMN caption TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE photos ADD COLUMN direction INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE photos ADD COLUMN marker_x REAL'); } catch (_) {}
try { db.exec('ALTER TABLE photos ADD COLUMN marker_y REAL'); } catch (_) {}
try { db.exec('ALTER TABLE photos ADD COLUMN marker_rotation INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE routes ADD COLUMN dir1_name TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE routes ADD COLUMN dir2_name TEXT'); } catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    color TEXT NOT NULL DEFAULT '#ff69b4',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS route_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL DEFAULT 0,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    poi_id INTEGER REFERENCES pois(id) ON DELETE SET NULL
  );

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
  // Keep route nodes linked to this POI in sync when position changes
  if (lat !== undefined || lng !== undefined) {
    const p = db.prepare('SELECT lat, lng FROM pois WHERE id = ?').get(id);
    if (p) db.prepare('UPDATE route_nodes SET lat = ?, lng = ? WHERE poi_id = ?').run(p.lat, p.lng, id);
  }
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

function updatePhoto(id, { caption, direction, markerX, markerY, markerRotation }) {
  const fields = [], vals = [];
  if (caption        !== undefined) { fields.push('caption = ?');          vals.push(caption || null); }
  if (direction      !== undefined) { fields.push('direction = ?');         vals.push(direction || null); }
  if (markerX        !== undefined) { fields.push('marker_x = ?');          vals.push(markerX ?? null); }
  if (markerY        !== undefined) { fields.push('marker_y = ?');          vals.push(markerY ?? null); }
  if (markerRotation !== undefined) { fields.push('marker_rotation = ?');   vals.push(markerRotation ?? null); }
  if (!fields.length) return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  vals.push(id);
  db.prepare(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
}

function reorderPhotos(poiId, orderedIds) {
  const stmt = db.prepare('UPDATE photos SET order_index = ? WHERE id = ? AND poi_id = ?');
  const tx = db.transaction(() => {
    orderedIds.forEach((id, idx) => stmt.run(idx, id, poiId));
  });
  tx();
}

// ── Routes ──────────────────────────────────────────────────────────────────

function getAllRoutes() {
  const routes = db.prepare('SELECT * FROM routes ORDER BY created_at ASC').all();
  const nodes = db.prepare('SELECT * FROM route_nodes ORDER BY route_id, order_index ASC, id ASC').all();
  const byRoute = {};
  for (const n of nodes) {
    if (!byRoute[n.route_id]) byRoute[n.route_id] = [];
    byRoute[n.route_id].push(n);
  }
  return routes.map(r => ({ ...r, nodes: byRoute[r.id] || [] }));
}

function getRouteById(id) {
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) return null;
  const nodes = db.prepare('SELECT * FROM route_nodes WHERE route_id = ? ORDER BY order_index ASC, id ASC').all(id);
  return { ...route, nodes };
}

function createRoute(name, color) {
  const r = db.prepare('INSERT INTO routes (name, color) VALUES (?, ?)').run(name || null, color || '#ff69b4');
  return getRouteById(r.lastInsertRowid);
}

function updateRoute(id, { name, color, dir1Name, dir2Name }) {
  const fields = [], vals = [];
  if (name     !== undefined) { fields.push('name = ?');      vals.push(name || null); }
  if (color    !== undefined) { fields.push('color = ?');     vals.push(color || '#ff69b4'); }
  if (dir1Name !== undefined) { fields.push('dir1_name = ?'); vals.push(dir1Name || null); }
  if (dir2Name !== undefined) { fields.push('dir2_name = ?'); vals.push(dir2Name || null); }
  if (!fields.length) return getRouteById(id);
  vals.push(id);
  db.prepare(`UPDATE routes SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getRouteById(id);
}

function deleteRoute(id) {
  db.prepare('DELETE FROM routes WHERE id = ?').run(id);
}

function splitRoute(routeId, splitNodeId) {
  return db.transaction(() => {
    const allNodes = db.prepare('SELECT * FROM route_nodes WHERE route_id = ? ORDER BY order_index ASC, id ASC').all(routeId);
    const splitIdx = allNodes.findIndex(n => n.id === splitNodeId);
    if (splitIdx < 0) return null;

    const headNodes = allNodes.slice(0, splitIdx);
    const tailNodes = allNodes.slice(splitIdx + 1);

    db.prepare('DELETE FROM route_nodes WHERE id = ?').run(splitNodeId);

    // Move tail to a new route before potentially cascade-deleting the original
    let newRoute = null;
    const deletedTailNodeIds = [];
    if (tailNodes.length >= 2) {
      const origRoute = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
      const nr = db.prepare('INSERT INTO routes (color) VALUES (?)').run(origRoute?.color || '#ff69b4');
      const newRouteId = nr.lastInsertRowid;
      const placeholders = tailNodes.map(() => '?').join(',');
      db.prepare(`UPDATE route_nodes SET route_id = ? WHERE id IN (${placeholders})`).run(newRouteId, ...tailNodes.map(n => n.id));
      newRoute = db.prepare('SELECT * FROM routes WHERE id = ?').get(newRouteId);
      newRoute.nodes = db.prepare('SELECT * FROM route_nodes WHERE route_id = ? ORDER BY order_index ASC').all(newRouteId);
    } else {
      for (const n of tailNodes) { deletedTailNodeIds.push(n.id); db.prepare('DELETE FROM route_nodes WHERE id = ?').run(n.id); }
    }

    // Clean up head if too small
    let headDeleted = false;
    const deletedHeadNodeIds = headNodes.map(n => n.id);
    if (headNodes.length < 2) {
      db.prepare('DELETE FROM routes WHERE id = ?').run(routeId); // cascades remaining head nodes
      headDeleted = true;
    }

    return { splitNodeId, originalRouteId: routeId, headDeleted, deletedHeadNodeIds, deletedTailNodeIds, newRoute };
  })();
}

function insertRouteNode(routeId, afterNodeId, lat, lng, poiId) {
  const after = db.prepare('SELECT order_index FROM route_nodes WHERE id = ?').get(afterNodeId);
  if (!after) return null;
  const next = db.prepare(
    'SELECT order_index FROM route_nodes WHERE route_id = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1'
  ).get(routeId, after.order_index);
  const orderIndex = next ? (after.order_index + next.order_index) / 2 : after.order_index + 1;
  const r = db.prepare(
    'INSERT INTO route_nodes (route_id, order_index, lat, lng, poi_id) VALUES (?, ?, ?, ?, ?)'
  ).run(routeId, orderIndex, lat, lng, poiId || null);
  return db.prepare('SELECT * FROM route_nodes WHERE id = ?').get(r.lastInsertRowid);
}

function addRouteNode(routeId, lat, lng, poiId, prepend = false) {
  let orderIndex;
  if (prepend) {
    const min = db.prepare('SELECT MIN(order_index) AS m FROM route_nodes WHERE route_id = ?').get(routeId);
    orderIndex = (min?.m ?? 0) - 1;
  } else {
    const max = db.prepare('SELECT MAX(order_index) AS m FROM route_nodes WHERE route_id = ?').get(routeId);
    orderIndex = (max?.m ?? -1) + 1;
  }
  const r = db.prepare(
    'INSERT INTO route_nodes (route_id, order_index, lat, lng, poi_id) VALUES (?, ?, ?, ?, ?)'
  ).run(routeId, orderIndex, lat, lng, poiId || null);
  return db.prepare('SELECT * FROM route_nodes WHERE id = ?').get(r.lastInsertRowid);
}

function updateRouteNode(id, { lat, lng, poiId }) {
  const fields = [], vals = [];
  if (lat !== undefined) { fields.push('lat = ?'); vals.push(lat); }
  if (lng !== undefined) { fields.push('lng = ?'); vals.push(lng); }
  if (poiId !== undefined) { fields.push('poi_id = ?'); vals.push(poiId || null); }
  if (!fields.length) return db.prepare('SELECT * FROM route_nodes WHERE id = ?').get(id);
  vals.push(id);
  db.prepare(`UPDATE route_nodes SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT * FROM route_nodes WHERE id = ?').get(id);
}

// Deletes a route (cascade) when it has fewer than 2 nodes remaining.
function cleanupRouteIfTooSmall(routeId) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM route_nodes WHERE route_id = ?').get(routeId);
  if (row.c < 2) { db.prepare('DELETE FROM routes WHERE id = ?').run(routeId); return true; }
  return false;
}

function deleteRouteNode(id) {
  const node = db.prepare('SELECT * FROM route_nodes WHERE id = ?').get(id);
  if (!node) return { deletedNodeIds: [], routeDeleted: false, routeId: null };
  // Snapshot all node IDs for this route before any deletion (needed if route gets cascade-deleted)
  const allIds = db.prepare('SELECT id FROM route_nodes WHERE route_id = ?').all(node.route_id).map(n => n.id);
  db.prepare('DELETE FROM route_nodes WHERE id = ?').run(id);
  const routeDeleted = cleanupRouteIfTooSmall(node.route_id);
  return {
    deletedNodeIds: routeDeleted ? allIds : [id],
    routeDeleted,
    routeId: node.route_id,
  };
}

// Deletes all route nodes linked to poiId, then cleans up any routes that fall
// below 2 nodes. Returns the full list of deleted node IDs and route IDs.
function deletePoiLinkedNodes(poiId) {
  const linked = db.prepare('SELECT id, route_id FROM route_nodes WHERE poi_id = ?').all(poiId);
  if (!linked.length) return { deletedNodeIds: [], deletedRouteIds: [] };
  const routeIds = [...new Set(linked.map(n => n.route_id))];
  // Snapshot all node IDs per route before deletion
  const allByRoute = {};
  for (const rid of routeIds)
    allByRoute[rid] = db.prepare('SELECT id FROM route_nodes WHERE route_id = ?').all(rid).map(n => n.id);
  db.prepare('DELETE FROM route_nodes WHERE poi_id = ?').run(poiId);
  const deletedNodeIds = new Set(linked.map(n => n.id));
  const deletedRouteIds = [];
  for (const rid of routeIds) {
    if (cleanupRouteIfTooSmall(rid)) {
      deletedRouteIds.push(rid);
      for (const nid of allByRoute[rid]) deletedNodeIds.add(nid);
    }
  }
  return { deletedNodeIds: [...deletedNodeIds], deletedRouteIds };
}

// Called when a POI moves; keeps linked route nodes in sync.
function syncPoiNodes(poiId, lat, lng) {
  db.prepare('UPDATE route_nodes SET lat = ?, lng = ? WHERE poi_id = ?').run(lat, lng, poiId);
}

module.exports = {
  haversineMeters,
  splitRoute,
  insertRouteNode,
  findNearestPoi,
  getAllPois,
  getPoiById,
  createPoi,
  updatePoi,
  deletePoi,
  addPhoto,
  deletePhoto,
  updatePhoto,
  reorderPhotos,
  getAllRoutes,
  getRouteById,
  createRoute,
  updateRoute,
  deleteRoute,
  addRouteNode,
  updateRouteNode,
  deleteRouteNode,
  deletePoiLinkedNodes,
  syncPoiNodes,
};
