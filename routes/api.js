const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db');

function newUUID() {
  return crypto.randomUUID();
}

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads', 'originals');
const thumbDir = path.join(__dirname, '..', 'uploads', 'thumbs');
[uploadDir, thumbDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, newUUID() + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|jpg|png|gif|webp|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are accepted'));
  },
});

async function generateThumb(srcPath, thumbPath) {
  await sharp(srcPath)
    .rotate()
    .resize(200, 200, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
}

async function extractGPS(filePath) {
  try {
    const exifr = await import('exifr');
    const gps = await exifr.default.gps(filePath);
    if (gps && gps.latitude && gps.longitude) {
      return { lat: gps.latitude, lng: gps.longitude };
    }
  } catch (e) { /* no GPS data */ }
  return null;
}

// GET /api/pois
router.get('/pois', (req, res) => {
  res.json(db.getAllPois());
});

// GET /api/pois/:id
router.get('/pois/:id', (req, res) => {
  const poi = db.getPoiById(Number(req.params.id));
  if (!poi) return res.status(404).json({ error: 'Not found' });
  res.json(poi);
});

// POST /api/pois — create empty POI
router.post('/pois', requireAuth, (req, res) => {
  const { lat, lng, title, note } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  const poi = db.createPoi(Number(lat), Number(lng), title, note);
  res.json(poi);
});

// PUT /api/pois/:id
router.put('/pois/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { lat, lng, title, note } = req.body;
  const poi = db.updatePoi(id, {
    lat: lat != null ? Number(lat) : undefined,
    lng: lng != null ? Number(lng) : undefined,
    title,
    note,
  });
  if (!poi) return res.status(404).json({ error: 'Not found' });
  res.json(poi);
});

// DELETE /api/pois/:id
router.delete('/pois/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const poi = db.getPoiById(id);
  if (!poi) return res.status(404).json({ error: 'Not found' });
  // Clean up photo files
  for (const photo of poi.photos) {
    [
      path.join(uploadDir, photo.filename),
      path.join(thumbDir, photo.thumb_filename || ''),
    ].forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  }
  db.deletePoi(id);
  res.json({ ok: true });
});

// POST /api/pois/:id/photos — add photos to existing POI
router.post('/pois/:id/photos', requireAuth, upload.array('photos', 50), async (req, res) => {
  const poiId = Number(req.params.id);
  const poi = db.getPoiById(poiId);
  if (!poi) return res.status(404).json({ error: 'Not found' });

  const added = [];
  let orderIndex = poi.photos.length;

  for (const file of req.files || []) {
    const thumbFilename = path.basename(file.filename, path.extname(file.filename)) + '_thumb.jpg';
    const thumbPath = path.join(thumbDir, thumbFilename);
    try {
      await generateThumb(file.path, thumbPath);
    } catch (e) {
      console.error('Thumb error:', e.message);
    }
    const photo = db.addPhoto(poiId, file.filename, thumbFilename, file.originalname, orderIndex++);
    added.push(photo);
  }

  res.json(db.getPoiById(poiId));
});

// DELETE /api/photos/:id
router.delete('/photos/:id', requireAuth, (req, res) => {
  const photo = db.deletePhoto(Number(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Not found' });
  [
    path.join(uploadDir, photo.filename),
    path.join(thumbDir, photo.thumb_filename || ''),
  ].forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} });
  res.json({ ok: true });
});

// PUT /api/pois/:id/photo-order
router.put('/pois/:id/photo-order', requireAuth, (req, res) => {
  const { order } = req.body; // array of photo ids
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  db.reorderPhotos(Number(req.params.id), order);
  res.json(db.getPoiById(Number(req.params.id)));
});

// POST /api/upload-photos — upload photos with EXIF, auto-create/group POIs
router.post('/upload-photos', requireAuth, upload.array('photos', 100), async (req, res) => {
  const mapLat = parseFloat(req.body.mapLat) || 51.5;
  const mapLng = parseFloat(req.body.mapLng) || -0.1;

  // GPS extracted client-side (before scaling stripped EXIF); fall back to
  // server-side extraction only for files the client couldn't read.
  const clientGps = req.body.gpsData ? JSON.parse(req.body.gpsData) : {};

  const processed = [];
  for (let i = 0; i < (req.files || []).length; i++) {
    const file = req.files[i];
    const thumbFilename = path.basename(file.filename, path.extname(file.filename)) + '_thumb.jpg';
    const thumbPath = path.join(thumbDir, thumbFilename);
    try { await generateThumb(file.path, thumbPath); } catch (e) { console.error('Thumb:', e.message); }

    const gps = clientGps[i] ?? await extractGPS(file.path);
    processed.push({ file, gps, thumbFilename });
  }

  // Separate GPS photos from no-GPS photos
  const gpsPhotos = processed.filter(p => p.gps);
  const noGpsPhotos = processed.filter(p => !p.gps);

  // Group GPS photos: check existing DB POIs and batch groups within 10m
  const groups = []; // {lat, lng, photos: [], existingPoiId}

  for (const item of gpsPhotos) {
    const { lat, lng } = item.gps;
    let placed = false;

    // Check batch groups already formed
    for (const g of groups) {
      if (db.haversineMeters(lat, lng, g.lat, g.lng) <= 10) {
        g.photos.push(item);
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // Check existing DB POIs
    const nearby = db.findNearestPoi(lat, lng, 10);
    if (nearby) {
      const existing = groups.find(g => g.existingPoiId === nearby.id);
      if (existing) {
        existing.photos.push(item);
      } else {
        groups.push({ lat: nearby.lat, lng: nearby.lng, photos: [item], existingPoiId: nearby.id });
      }
    } else {
      groups.push({ lat, lng, photos: [item], existingPoiId: null });
    }
  }

  // All no-GPS photos go to one group at map center (check for nearby existing POI first)
  if (noGpsPhotos.length > 0) {
    const nearby = db.findNearestPoi(mapLat, mapLng, 10);
    if (nearby) {
      const existing = groups.find(g => g.existingPoiId === nearby.id);
      if (existing) {
        existing.photos.push(...noGpsPhotos);
      } else {
        groups.push({ lat: nearby.lat, lng: nearby.lng, photos: noGpsPhotos, existingPoiId: nearby.id });
      }
    } else {
      groups.push({ lat: mapLat, lng: mapLng, photos: noGpsPhotos, existingPoiId: null });
    }
  }

  // Create or update POIs for each group
  const resultPois = [];
  for (const group of groups) {
    let poi;
    if (group.existingPoiId) {
      poi = db.getPoiById(group.existingPoiId);
    } else {
      poi = db.createPoi(group.lat, group.lng, null, null);
    }
    let orderIndex = poi.photos.length;
    for (const item of group.photos) {
      db.addPhoto(poi.id, item.file.filename, item.thumbFilename, item.file.originalname, orderIndex++);
    }
    resultPois.push(db.getPoiById(poi.id));
  }

  res.json({ pois: resultPois });
});

module.exports = router;
