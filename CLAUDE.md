# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # kills any existing server on port 3000, then: node --env-file=.env server.js
npm run dev        # nodemon --env-file=.env server.js (auto-reload; does not kill existing)
```

The server runs on port 3000 by default (`PORT` env var overrides this). `kill-server.js` is the prestart hook — it uses PowerShell's `Get-NetTCPConnection` to find and kill the process on port 3000.

AWS deployment uses SAM: `sam build && sam deploy` (requires Docker + SAM CLI). `samconfig.toml` (gitignored) holds the saved deploy parameters.

## Deployment modes

The codebase supports two deployment modes selected automatically by environment variables:

| Mode | Trigger | DB | Photo storage | Sessions |
|---|---|---|---|---|
| **Local** | No `POIS_TABLE` set | SQLite (`db-sqlite.js`) | Local disk (`uploads/`) | In-memory |
| **AWS** | `POIS_TABLE` set (by SAM) | DynamoDB (`db-dynamo.js`) | S3 (`PHOTOS_BUCKET`) | DynamoDB (`SESSIONS_TABLE`) |

**`db.js`** is a one-line router that loads `db-dynamo.js` or `db-sqlite.js` based on `POIS_TABLE`.

## Environment

All configuration lives in `.env` (gitignored). Key variables:

| Variable | Purpose | Default |
|---|---|---|
| `MAPTILER_KEY` | NLS Historic OS tile layer (MapTiler tileset `uk-osgb1888`) | *(layer disabled)* |
| `ADMIN_PASSWORD` | Edit-mode login password | `changeme` |
| `SESSION_SECRET` | Express session signing key | `photomap-dev-secret` |
| `PORT` | HTTP port | `3000` |

AWS-only (set via `template.yaml` / SAM, not `.env`):

| Variable | Purpose |
|---|---|
| `POIS_TABLE` / `PHOTOS_TABLE` / `ROUTES_TABLE` / `NODES_TABLE` / `SESSIONS_TABLE` | DynamoDB table names |
| `PHOTOS_BUCKET` | S3 bucket for photo storage |

`MAPTILER_KEY` is exposed to the browser via `GET /config.js` → `window.APP_CONFIG.maptilerKey`. No other env vars reach the client.

## Architecture

### Backend (Node.js / Express)

**`server.js`** — entry point. Mounts routes, serves `public/` as static files, injects env config at `/config.js`, and exposes npm package dist files at `/vendor/leaflet`, `/vendor/markercluster`, `/vendor/exifr`. In AWS mode: redirects `/uploads/*` to S3 presigned URLs and uses a DynamoDB session store. In local mode: serves `uploads/` as static files and uses the default in-memory session store. Exports `{ app }` for `lambda.js`; calls `app.listen` only when not running in Lambda.

**`lambda.js`** — AWS Lambda entry point. Wraps `app` from `server.js` using `@vendia/serverless-express`.

**`db.js`** — thin router: loads `db-dynamo.js` or `db-sqlite.js` based on `POIS_TABLE`.

**`db-sqlite.js`** — SQLite implementation via `better-sqlite3`. Opens synchronously at startup, creates tables on first run. All queries are synchronous prepared statements.

**`db-dynamo.js`** — DynamoDB implementation. All functions are async and return Promises. IDs are UUIDs (vs auto-increment integers in SQLite). Route node `poi_id` is omitted from items (not stored as NULL) when unset, since DynamoDB GSI keys cannot be NULL.

Both db modules export the same function signatures:
- `haversineMeters` / `findNearestPoi` — used by the bulk-upload route to geo-group photos
- `addPhoto` / `deletePhoto` / `updatePhoto(id, {caption, direction, markerX, markerY, markerRotation})` — photo CRUD; `updatePhoto` persists per-photo annotations
- `deletePoiLinkedNodes(poiId)` — removes all route nodes linked to a POI, cascades routes that fall below 2 nodes; called before `deletePoi`
- `deleteRouteNode(id)` — returns `{deletedNodeIds, routeDeleted, routeId}`; cascades the route when ≤1 node remains
- `insertRouteNode(routeId, afterNodeId, lat, lng, poiId)` — inserts between two nodes using floating-point bisection of `order_index`
- `splitRoute(routeId, splitNodeId)` — deletes the split node, moves tail nodes (≥2) to a new route, cleans up degenerate remainders; returns `{headDeleted, deletedHeadNodeIds, deletedTailNodeIds, newRoute}`

**`routes/auth.js`** — stateless single-user auth. Login compares plaintext against `ADMIN_PASSWORD`, calls `req.session.save()` explicitly before responding (required on Lambda where the process may freeze before the async session write completes).

**`routes/api.js`** — all POI, photo, and route endpoints. Storage behaviour is selected at startup by `IS_AWS = !!process.env.PHOTOS_BUCKET`:
- **Local**: `multer.memoryStorage()` → `sharp` in memory → write to `uploads/originals/` and `uploads/thumbs/` via `fs`. Photo URLs are plain `/uploads/...` paths.
- **AWS**: `multer.memoryStorage()` → `sharp` in memory → `PutObjectCommand` to S3. All POI responses include presigned `url` and `thumb_url` fields (1-hour expiry) so the browser loads photos directly from S3 without routing through Lambda.

`POST /api/upload-photos` is the bulk import path. The client batches uploads in groups of 10 (API Gateway HTTP API has a 10 MB request limit). Groups photos by GPS proximity (10 m threshold). GPS is supplied by the client as a `gpsData` JSON field; server-side `exifr` extraction is the fallback.

`PUT /api/photos/:id` updates a photo's `caption`, `direction` (1/2/null), `markerX`/`markerY` (0–1 fractions), and `markerRotation` (0=down, 1=left, 2=right). Called in bulk when the POI edit dialog is saved.

`POST /routes/:id/split` delegates to `db.splitRoute`. `DELETE /route-nodes/:id` returns the full deletion result so the client can do surgical cleanup.

**`middleware/requireAuth.js`** — guards all write endpoints; reads `req.session.authenticated`.

**`template.yaml`** — AWS SAM template. Defines Lambda function, API Gateway HTTP API, five DynamoDB tables (PAY_PER_REQUEST), and S3 bucket. `scripts/deploy.sh` wraps `sam build && sam deploy`.

### Frontend (`public/`)

No build step — plain JS loaded directly by the browser. Scripts served locally (from `node_modules` via `/vendor/` routes) in order: Leaflet → MarkerCluster → exifr lite → `/config.js` → `app.js`.

**`app.js`** (~1700 lines) organised into sections:

- **Photo scaling / GPS extraction** — `scaleImageFile(file, maxPx=1000)` scales via canvas; `extractGPSFromFiles(files)` reads EXIF from originals before scaling strips it. Both run in parallel in `uploadPhotosToMap`, which batches the scaled files into groups of 10 and posts each batch to `POST /api/upload-photos` with a `gpsData` JSON field. The server prefers `gpsData[i]` over re-extracting from the scaled file.
- **Photo URLs** — all photo display uses `ph.url || '/uploads/originals/' + ph.filename` and `ph.thumb_url || '/uploads/thumbs/' + ph.thumb_filename`. On AWS the `url`/`thumb_url` fields are presigned S3 URLs returned by the API; on local they are absent and the fallback paths are used.
- **Tile layers** — `TILE_LAYERS` keyed by display name. Default is `'Topographic'`. All limited-zoom layers use `maxNativeZoom` (not `maxZoom`) so the map zoom is never capped. `handleZoomForLayer` fires on `zoomend`; `aerialFallback` flag is separate from `activeLayerName` so the intended layer is restored on zoom-out. Fallback threshold is `maxNativeZoom + 1`.
- **Map state persistence** — zoom and centre are saved to `localStorage` on every `moveend` and restored before the map is constructed. If no saved position exists and POIs are loaded, the map fits to all POI locations.
- **Marker rendering** — POIs render as circular photo thumbnails (`divIcon`) or blue dots. Markers live in a `L.markerClusterGroup` in view mode and are moved directly onto `map` in edit mode (necessary for drag to work — clustered markers have `_icon = null`). The thumbnail shown is the first photo from `sortedPhotos(poi)`, which puts direction-preferred photos first.
- **Marker drag fix** — `setIcon()` swaps the DOM element but doesn't reset `dragging._enabled`; always call `disable() → setIcon() → enable()` or `addTo(map) → disable() → enable()`.
- **POI labels** — rendered via `marker.bindTooltip(title, { permanent: true, direction: 'auto', className: 'poi-label' })`. Hidden at zoom < `LABEL_MIN_ZOOM` (13); a `zoomend` listener shows/hides all tooltips. Labels use `width: max-content; max-width: 160px` so short titles don't wrap prematurely.
- **POI click routing** (view mode) — `openFullModal` if POI has title or note; `openLightbox(poi, 0)` if photos only; `showPreview` as fallback.
- **Loading indicator** — `#loading-overlay` covers the map until the startup `Promise.all([checkAuth(), loadPois(), loadRoutes()])` resolves, then fades out and is removed from the DOM.
- **Edit mode** — `setEditMode(on)` moves markers between cluster and map, toggles toolbar buttons (Upload Photos, Edit Routes) and the edit-indicator banner. Always starts off on page load. Entering edit mode reveals all POIs regardless of direction filter; exiting re-applies it.
- **Direction preference** — toolbar control (All/1/2) stored in `localStorage`. `sortedPhotos(poi)` sorts matching-direction photos first; `shouldHidePoi(poi)` returns true if all photos have the opposite direction; `reapplyDirectionFilter()` re-renders all markers when preference changes.
- **Photo annotations (lightbox edit mode)** — clicking a thumbnail in the edit dialog calls `openEditLightbox(poiId, idx)`, which adds a crosshair overlay on the photo. Clicking the photo places a directional arrow marker (↓/←/→, controlled by rotation buttons); caption and direction tag are also editable. All changes are buffered in `pendingPhotoEdits` and flushed via `PUT /api/photos/:id` calls when the POI is saved. `stashCurrentLightboxPhotoEdit()` snapshots the current photo's state before navigating or closing.

#### Route editing

State variables: `routeEditMode`, `waitingForRouteStart`, `activeRouteId`, `extendingFromStart`, `selectedNodeId`, `undoStack`.

**Entry flow** (`waitingForRouteStart = true`):
- Click a start/end node → activates that route for extension, selects the node (falls through — no early return)
- Click a POI with exactly one linked endpoint → extends that route
- Click map → `createNewRouteAndActivate()` creates a new route
- Click a polyline segment → inserts node into that route (also activates it)

**Polyline click / segment insert** — `poly.on('click')` calls both `L.DomEvent.stopPropagation(e)` AND `e.originalEvent.stopPropagation()` to prevent the map's click handler from also firing (Leaflet's `stopPropagation` on a layer event only sets an internal flag, not the native DOM event). Uses `findClosestSegmentIndex` (perpendicular pixel distance) to identify the segment, then calls `POST /routes/:id/nodes` with `afterNodeId`.

**Node icons** — POI-linked nodes render as 0×0 (hidden behind the POI marker) unless selected. Unlinked nodes are also 0×0 outside route-edit mode. `ZERO_ICON` is a shared `L.divIcon` with `iconSize: [0,0]`.

**Selection** — `selectNode` / `deselectNode` enable/disable Delete Node, Split Route, Delete Route buttons and the colour picker. The colour picker reflects the selected node's route and persists on `change`.

**Keyboard shortcuts** (route-edit mode only, ignored in inputs): `Delete` → delete selected node; `Ctrl+Z` → undo last added node.

**Split route** — `splitSelectedRoute()` calls `POST /routes/:id/split`; cleans up stale markers for moved tail nodes before calling `renderRoute` on the new route.

**Cascade on POI delete** — `deleteCurrentPoi()` calls `DELETE /pois/:id` which returns `{deletedNodeIds, deletedRouteIds}`; client does surgical cleanup of markers, polylines and route state before removing the POI marker.

### Data model

```
pois         (id, lat, lng, title, note, created_at, updated_at)
  └── photos (id, poi_id, filename, thumb_filename, original_name, order_index, created_at,
              caption, direction, marker_x, marker_y, marker_rotation)

routes       (id, name, color, created_at)
  └── route_nodes (id, route_id, order_index REAL, lat, lng, poi_id → pois.id)
```

- `photos.direction` — integer 1 or 2 (or null); used for direction-preference filtering/sorting.
- `photos.marker_x`, `photos.marker_y` — 0–1 fractions of image dimensions; position of the arrow marker tip.
- `photos.marker_rotation` — integer 0=down, 1=left, 2=right; selects which of three arrow polygon shapes to render.

- `id` fields are auto-increment integers in SQLite; UUID strings in DynamoDB.
- `route_nodes.order_index` is a float so `insertRouteNode` can bisect without renumbering.
- **SQLite**: deleting a route cascades its nodes; deleting a POI sets `route_nodes.poi_id = NULL` via FK. `deletePoiLinkedNodes` then removes orphaned nodes and cleans up sub-2-node routes.
- **DynamoDB**: no FK cascades — all cascade logic is implemented explicitly in `db-dynamo.js`. `poi_id` is omitted from route node items (not stored as NULL) when unset; DynamoDB GSI key attributes cannot hold NULL values.
- Photo files: `uploads/originals/{uuid}.{ext}` and `uploads/thumbs/{uuid}_thumb.jpg` (local), or `originals/{uuid}.{ext}` and `thumbs/{uuid}_thumb.jpg` (S3 keys).
