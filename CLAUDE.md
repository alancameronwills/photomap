# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # production: node --env-file=.env server.js
npm run dev        # development: nodemon --env-file=.env server.js (auto-reload)
```

The server runs on port 3000 by default (`PORT` env var overrides this).

## Environment

All configuration lives in `.env` (gitignored). Key variables:

| Variable | Purpose | Default |
|---|---|---|
| `MAPTILER_KEY` | NLS Historic OS tile layer (MapTiler tileset `uk-osgb1888`) | *(layer disabled)* |
| `ADMIN_PASSWORD` | Edit-mode login password | `changeme` |
| `SESSION_SECRET` | Express session signing key | `photomap-dev-secret` |
| `PORT` | HTTP port | `3000` |

`MAPTILER_KEY` is exposed to the browser via `GET /config.js` → `window.APP_CONFIG.maptilerKey`. No other env vars reach the client.

## Architecture

### Backend (Node.js / Express)

**`server.js`** — entry point. Mounts routes, serves `public/` as static files, serves `uploads/` at `/uploads`, and injects env config at `/config.js`.

**`db.js`** — single SQLite file (`photomap.db`) via `better-sqlite3`. Opens synchronously at startup, creates tables on first run. Exports plain functions (no ORM); all queries are prepared statements. `haversineMeters` and `findNearestPoi` are used by the upload route to geo-group photos.

**`routes/auth.js`** — stateless single-user auth. Login compares plaintext against `ADMIN_PASSWORD`, sets `req.session.authenticated = true`.

**`routes/api.js`** — all POI and photo endpoints. Photo uploads go through `multer` → `sharp` thumbnail (200×200 JPEG in `uploads/thumbs/`). `POST /api/upload-photos` is the bulk import path: it groups uploaded photos into POIs by proximity (10 m threshold), adding to existing nearby POIs when found. GPS is normally supplied by the client as a `gpsData` JSON field (see below); server-side `exifr` extraction is the fallback for files the browser couldn't read.

**`middleware/requireAuth.js`** — guards all write endpoints; reads `req.session.authenticated`.

### Frontend (`public/`)

No build step — plain JS loaded directly by the browser. CDN scripts loaded in order: Leaflet → MarkerCluster → exifr lite (browser GPS extraction) → `/config.js` → `app.js`.

**`app.js`** is one file (~800 lines) organised into sections:

- **`scaleImageFile(file, maxPx=1000)`** — scales images client-side using a canvas before upload. Files within the limit pass through unchanged; formats the browser can't decode (e.g. HEIC) fall back to the original.
- **`extractGPSFromFiles(files)`** — reads GPS EXIF from the *originals* using the browser exifr build before scaling strips it. Returns `{index: {lat, lng}}`. Called in parallel with scaling in `uploadPhotosToMap`.
- **GPS preservation in bulk upload** — `uploadPhotosToMap` extracts GPS and scales simultaneously, then posts scaled files with a `gpsData` JSON field (`{fileIndex: {lat, lng}}`). The server prefers `gpsData[i]` over re-extracting from the (now EXIF-stripped) file.
- **`makeNlsLayer()`** — defined before `TILE_LAYERS` because it reads `window.APP_CONFIG` (injected by `/config.js` which loads before `app.js`).
- **`TILE_LAYERS`** — Leaflet tile layer instances keyed by display name. Layers with limited zoom use `maxNativeZoom` (not `maxZoom`) so the map isn't zoom-capped; `handleZoomForLayer` uses `maxNativeZoom` as the aerial fallback threshold.
- **Layer switcher / aerial fallback** — `activeLayerName` is the user's intended layer; `aerialFallback` is true while a zoom-triggered override is showing Aerial. `handleZoomForLayer` fires on every `zoomend`. Clicking a layer button always clears `aerialFallback` then immediately re-checks zoom. The fallback threshold is `maxNativeZoom + 1` (one upscaled zoom level before switching).
- **Marker rendering** — POIs render as circular photo thumbnails (`divIcon` with `<img>`) or blue dots. `createMarkerIcon(poi)` reads the global `editMode` flag to add the amber border class. Markers live in a `L.markerClusterGroup`.
- **Edit mode** — toggled by `setEditMode(on)`, which also adds/removes the `edit-active` class on `#map` (CSS shifts the Leaflet zoom control above the edit banner via `#map.edit-active .leaflet-bottom.leaflet-right`).
- **Bulk photo upload flow** — client extracts GPS + scales files, posts to `POST /api/upload-photos` with `mapLat`/`mapLng` and `gpsData`; server returns created/updated POI objects; client calls `addOrUpdateMarker` for each and fits map bounds to the new locations.

### Data model

```
pois  (id, lat, lng, title, note, created_at, updated_at)
  └── photos  (id, poi_id, filename, thumb_filename, original_name, order_index, created_at)
```

Photo files: `uploads/originals/{uuid}.{ext}` and `uploads/thumbs/{uuid}_thumb.jpg`. Deleting a POI cascades to photos in the DB; the API route manually deletes the files.
