const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const sharp   = require('sharp');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db');

const router = express.Router();
const IS_AWS = !!process.env.PHOTOS_BUCKET;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Storage setup (local disk vs S3) ─────────────────────────────────────────

let upload, processPhoto, deletePhotoFiles, withPhotoUrls, withPhotoUrlsMany;

if (IS_AWS) {
  const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({});
  const BUCKET = process.env.PHOTOS_BUCKET;

  upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) =>
      /^image\/(jpeg|jpg|png|gif|webp|heic|heif)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files are accepted')),
  });

  processPhoto = async (file) => {
    const uuid = crypto.randomUUID();
    const ext  = path.extname(file.originalname).toLowerCase();
    const filename      = uuid + ext;
    const thumbFilename = uuid + '_thumb.jpg';
    const thumbBuf = await sharp(file.buffer).rotate().resize(200, 200, { fit: 'cover', position: 'centre' }).jpeg({ quality: 80 }).toBuffer();
    await Promise.all([
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `originals/${filename}`,      Body: file.buffer, ContentType: file.mimetype })),
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `thumbs/${thumbFilename}`,    Body: thumbBuf,    ContentType: 'image/jpeg' })),
    ]);
    return { filename, thumbFilename };
  };

  deletePhotoFiles = async (filename, thumbFilename) => {
    const del = key => key && s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
    await Promise.all([del(`originals/${filename}`), del(`thumbs/${thumbFilename}`)]);
  };

  const sign = key => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });

  withPhotoUrls = async (poi) => {
    if (!poi) return poi;
    const photos = await Promise.all((poi.photos || []).map(async ph => ({
      ...ph,
      url:       ph.filename       ? await sign(`originals/${ph.filename}`)       : null,
      thumb_url: ph.thumb_filename ? await sign(`thumbs/${ph.thumb_filename}`)     : null,
    })));
    return { ...poi, photos };
  };

  withPhotoUrlsMany = pois => Promise.all(pois.map(withPhotoUrls));

} else {
  const uploadDir = path.join(__dirname, '..', 'uploads', 'originals');
  const thumbDir  = path.join(__dirname, '..', 'uploads', 'thumbs');
  [uploadDir, thumbDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) =>
      /^image\/(jpeg|jpg|png|gif|webp|heic|heif)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files are accepted')),
  });

  processPhoto = async (file) => {
    const uuid = crypto.randomUUID();
    const ext  = path.extname(file.originalname).toLowerCase();
    const filename      = uuid + ext;
    const thumbFilename = uuid + '_thumb.jpg';
    fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
    const thumbBuf = await sharp(file.buffer).rotate().resize(200, 200, { fit: 'cover', position: 'centre' }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(path.join(thumbDir, thumbFilename), thumbBuf);
    return { filename, thumbFilename };
  };

  deletePhotoFiles = async (filename, thumbFilename) => {
    for (const f of [path.join(uploadDir, filename || ''), path.join(thumbDir, thumbFilename || '')]) {
      try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
  };

  withPhotoUrls     = async poi  => poi;
  withPhotoUrlsMany = async pois => pois;
}

async function extractGPS(buffer) {
  try {
    const exifr = await import('exifr');
    const gps = await exifr.default.gps(buffer);
    if (gps?.latitude && gps?.longitude) return { lat: gps.latitude, lng: gps.longitude };
  } catch (e) {}
  return null;
}

function parseId(id) { return IS_AWS ? id : Number(id); }

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', wrap(async (req, res) => {
  res.json(await Promise.resolve(db.getAllSettings()));
}));

router.put('/settings', requireAuth, wrap(async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  await Promise.resolve(db.setSetting(key, value ?? ''));
  res.json({ ok: true });
}));

// ── POI routes ────────────────────────────────────────────────────────────────

router.get('/pois', wrap(async (req, res) => {
  res.json(await withPhotoUrlsMany(await Promise.resolve(db.getAllPois())));
}));

router.get('/pois/:id', wrap(async (req, res) => {
  const poi = await withPhotoUrls(await Promise.resolve(db.getPoiById(parseId(req.params.id))));
  if (!poi) return res.status(404).json({ error: 'Not found' });
  res.json(poi);
}));

router.post('/pois', requireAuth, wrap(async (req, res) => {
  const { lat, lng, title, note } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  res.json(await Promise.resolve(db.createPoi(Number(lat), Number(lng), title, note)));
}));

router.put('/pois/:id', requireAuth, wrap(async (req, res) => {
  const { lat, lng, title, note } = req.body;
  const poi = await Promise.resolve(db.updatePoi(parseId(req.params.id), {
    lat: lat != null ? Number(lat) : undefined,
    lng: lng != null ? Number(lng) : undefined,
    title, note,
  }));
  if (!poi) return res.status(404).json({ error: 'Not found' });
  res.json(poi);
}));

router.delete('/pois/:id', requireAuth, wrap(async (req, res) => {
  const poi = await Promise.resolve(db.getPoiById(parseId(req.params.id)));
  if (!poi) return res.status(404).json({ error: 'Not found' });
  await Promise.all(poi.photos.map(p => deletePhotoFiles(p.filename, p.thumb_filename)));
  const nodeResult = await Promise.resolve(db.deletePoiLinkedNodes(parseId(req.params.id)));
  await Promise.resolve(db.deletePoi(parseId(req.params.id)));
  res.json({ ok: true, deletedNodeIds: nodeResult.deletedNodeIds, deletedRouteIds: nodeResult.deletedRouteIds });
}));

// ── Photo routes ──────────────────────────────────────────────────────────────

router.post('/pois/:id/photos', requireAuth, upload.array('photos', 50), wrap(async (req, res) => {
  const poi = await Promise.resolve(db.getPoiById(parseId(req.params.id)));
  if (!poi) return res.status(404).json({ error: 'Not found' });
  let orderIndex = poi.photos.length;
  for (const file of (req.files || [])) {
    const { filename, thumbFilename } = await processPhoto(file);
    await Promise.resolve(db.addPhoto(parseId(req.params.id), filename, thumbFilename, file.originalname, orderIndex++));
  }
  res.json(await withPhotoUrls(await Promise.resolve(db.getPoiById(parseId(req.params.id)))));
}));

router.put('/photos/:id', requireAuth, wrap(async (req, res) => {
  const { caption, direction, markerX, markerY, markerRotation } = req.body;
  const photo = await Promise.resolve(db.updatePhoto(parseId(req.params.id), {
    caption:        caption        !== undefined ? (caption || null)                                   : undefined,
    direction:      direction      !== undefined ? (direction ? Number(direction) : null)              : undefined,
    markerX:        markerX        !== undefined ? (markerX        != null ? Number(markerX)        : null) : undefined,
    markerY:        markerY        !== undefined ? (markerY        != null ? Number(markerY)        : null) : undefined,
    markerRotation: markerRotation !== undefined ? (markerRotation != null ? Number(markerRotation) : null) : undefined,
  }));
  if (!photo) return res.status(404).json({ error: 'Not found' });
  res.json(photo);
}));

router.delete('/photos/:id', requireAuth, wrap(async (req, res) => {
  const photo = await Promise.resolve(db.deletePhoto(parseId(req.params.id)));
  if (!photo) return res.status(404).json({ error: 'Not found' });
  await deletePhotoFiles(photo.filename, photo.thumb_filename);
  res.json({ ok: true });
}));

router.put('/pois/:id/photo-order', requireAuth, wrap(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array' });
  const ids = IS_AWS ? order : order.map(Number);
  await Promise.resolve(db.reorderPhotos(parseId(req.params.id), ids));
  res.json(await withPhotoUrls(await Promise.resolve(db.getPoiById(parseId(req.params.id)))));
}));

// ── Bulk upload ───────────────────────────────────────────────────────────────

router.post('/upload-photos', requireAuth, upload.array('photos', 100), wrap(async (req, res) => {
  const mapLat   = parseFloat(req.body.mapLat) || 51.5;
  const mapLng   = parseFloat(req.body.mapLng) || -0.1;
  const clientGps = req.body.gpsData ? JSON.parse(req.body.gpsData) : {};

  const processed = [];
  for (let i = 0; i < (req.files || []).length; i++) {
    const file = req.files[i];
    const { filename, thumbFilename } = await processPhoto(file);
    const gps = clientGps[i] ?? await extractGPS(file.buffer);
    processed.push({ file, gps, filename, thumbFilename });
  }

  const gpsPhotos   = processed.filter(p => p.gps);
  const noGpsPhotos = processed.filter(p => !p.gps);
  const groups = [];

  for (const item of gpsPhotos) {
    const { lat, lng } = item.gps;
    let placed = false;
    for (const g of groups) {
      if (db.haversineMeters(lat, lng, g.lat, g.lng) <= 10) { g.photos.push(item); placed = true; break; }
    }
    if (placed) continue;
    const nearby = await Promise.resolve(db.findNearestPoi(lat, lng, 10));
    if (nearby) {
      const existing = groups.find(g => g.existingPoiId === nearby.id);
      if (existing) existing.photos.push(item);
      else groups.push({ lat: nearby.lat, lng: nearby.lng, photos: [item], existingPoiId: nearby.id });
    } else {
      groups.push({ lat, lng, photos: [item], existingPoiId: null });
    }
  }

  if (noGpsPhotos.length > 0) {
    const nearby = await Promise.resolve(db.findNearestPoi(mapLat, mapLng, 10));
    if (nearby) {
      const existing = groups.find(g => g.existingPoiId === nearby.id);
      if (existing) existing.photos.push(...noGpsPhotos);
      else groups.push({ lat: nearby.lat, lng: nearby.lng, photos: noGpsPhotos, existingPoiId: nearby.id });
    } else {
      groups.push({ lat: mapLat, lng: mapLng, photos: noGpsPhotos, existingPoiId: null });
    }
  }

  const resultPois = [];
  for (const group of groups) {
    let poi = group.existingPoiId
      ? await Promise.resolve(db.getPoiById(group.existingPoiId))
      : await Promise.resolve(db.createPoi(group.lat, group.lng, null, null));
    let orderIndex = poi.photos.length;
    for (const item of group.photos) {
      await Promise.resolve(db.addPhoto(poi.id, item.filename, item.thumbFilename, item.file.originalname, orderIndex++));
    }
    resultPois.push(await withPhotoUrls(await Promise.resolve(db.getPoiById(poi.id))));
  }

  res.json({ pois: resultPois });
}));

// ── Route endpoints ───────────────────────────────────────────────────────────

router.get('/routes', wrap(async (req, res) => {
  res.json(await Promise.resolve(db.getAllRoutes()));
}));

router.post('/routes', requireAuth, wrap(async (req, res) => {
  res.json(await Promise.resolve(db.createRoute(req.body.name, req.body.color)));
}));

router.put('/routes/:id', requireAuth, wrap(async (req, res) => {
  const route = await Promise.resolve(db.updateRoute(parseId(req.params.id), req.body));
  if (!route) return res.status(404).json({ error: 'Not found' });
  res.json(route);
}));

router.post('/routes/:id/split', requireAuth, wrap(async (req, res) => {
  const { nodeId } = req.body;
  if (nodeId == null) return res.status(400).json({ error: 'nodeId required' });
  const result = await Promise.resolve(db.splitRoute(parseId(req.params.id), IS_AWS ? nodeId : Number(nodeId)));
  if (!result) return res.status(404).json({ error: 'Node not found in route' });
  res.json(result);
}));

router.delete('/routes/:id', requireAuth, wrap(async (req, res) => {
  if (!await Promise.resolve(db.getRouteById(parseId(req.params.id)))) return res.status(404).json({ error: 'Not found' });
  await Promise.resolve(db.deleteRoute(parseId(req.params.id)));
  res.json({ ok: true });
}));

router.post('/routes/:id/nodes', requireAuth, wrap(async (req, res) => {
  const { lat, lng, poiId, prepend, afterNodeId } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  if (afterNodeId != null) {
    const node = await Promise.resolve(db.insertRouteNode(parseId(req.params.id), IS_AWS ? afterNodeId : Number(afterNodeId), Number(lat), Number(lng), poiId || null));
    if (!node) return res.status(404).json({ error: 'afterNodeId not found' });
    return res.json(node);
  }
  res.json(await Promise.resolve(db.addRouteNode(parseId(req.params.id), Number(lat), Number(lng), poiId || null, !!prepend)));
}));

router.put('/route-nodes/:id', requireAuth, wrap(async (req, res) => {
  const { lat, lng, poiId } = req.body;
  const node = await Promise.resolve(db.updateRouteNode(parseId(req.params.id), {
    lat:   lat   != null ? Number(lat)  : undefined,
    lng:   lng   != null ? Number(lng)  : undefined,
    poiId: poiId !== undefined ? poiId : undefined,
  }));
  if (!node) return res.status(404).json({ error: 'Not found' });
  res.json(node);
}));

router.delete('/route-nodes/:id', requireAuth, wrap(async (req, res) => {
  res.json(await Promise.resolve(db.deleteRouteNode(parseId(req.params.id))));
}));

module.exports = router;
