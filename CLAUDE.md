# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # kills any existing server on port 3000, then: node --env-file=.env server.js
npm run dev        # nodemon --env-file=.env server.js (auto-reload; does not kill existing)
```

The server runs on port 3000 by default (`PORT` env var overrides this). `kill-server.js` is the prestart hook — it uses PowerShell's `Get-NetTCPConnection` to find and kill the process on port 3000.

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

**`server.js`** — entry point. Mounts routes, serves `public/` as static files, serves `uploads/` at `/uploads`, injects env config at `/config.js`, and exposes npm package dist files at `/vendor/leaflet`, `/vendor/markercluster`, `/vendor/exifr`.

**`db.js`** — single SQLite file (`photomap.db`) via `better-sqlite3`. Opens synchronously at startup, creates tables on first run. Exports plain functions (no ORM); all queries are prepared statements.

Key functions beyond basic CRUD:
- `haversineMeters` / `findNearestPoi` — used by the bulk-upload route to geo-group photos
- `deletePoiLinkedNodes(poiId)` — removes all route nodes linked to a POI, cascades routes that fall below 2 nodes; called before `deletePoi`
- `deleteRouteNode(id)` — returns `{deletedNodeIds, routeDeleted, routeId}`; cascades the route when ≤1 node remains
- `insertRouteNode(routeId, afterNodeId, lat, lng, poiId)` — inserts between two nodes using floating-point bisection of `order_index`
- `splitRoute(routeId, splitNodeId)` — transactionally deletes the split node, moves tail nodes (≥2) to a new route, cleans up degenerate remainders; returns `{headDeleted, deletedHeadNodeIds, deletedTailNodeIds, newRoute}`

**`routes/auth.js`** — stateless single-user auth. Login compares plaintext against `ADMIN_PASSWORD`, sets `req.session.authenticated = true`.

**`routes/api.js`** — all POI, photo, and route endpoints. Photo uploads go through `multer` → `sharp` thumbnail (200×200 JPEG in `uploads/thumbs/`). `POST /api/upload-photos` is the bulk import path: groups photos into POIs by proximity (10 m threshold). GPS is supplied by the client as a `gpsData` JSON field; server-side `exifr` extraction is the fallback. `POST /routes/:id/split` delegates to `db.splitRoute`. `DELETE /route-nodes/:id` returns the full deletion result so the client can do surgical cleanup.

**`middleware/requireAuth.js`** — guards all write endpoints; reads `req.session.authenticated`.

### Frontend (`public/`)

No build step — plain JS loaded directly by the browser. Scripts served locally (from `node_modules` via `/vendor/` routes) in order: Leaflet → MarkerCluster → exifr lite → `/config.js` → `app.js`.

**`app.js`** (~1530 lines) organised into sections:

- **Photo scaling / GPS extraction** — `scaleImageFile(file, maxPx=1000)` scales via canvas; `extractGPSFromFiles(files)` reads EXIF from originals before scaling strips it. Both run in parallel in `uploadPhotosToMap`, which then posts scaled files plus a `gpsData` JSON field. The server prefers `gpsData[i]` over re-extracting from the scaled file.
- **Tile layers** — `TILE_LAYERS` keyed by display name. All limited-zoom layers use `maxNativeZoom` (not `maxZoom`) so the map zoom is never capped. `handleZoomForLayer` fires on `zoomend`; `aerialFallback` flag is separate from `activeLayerName` so the intended layer is restored on zoom-out. Fallback threshold is `maxNativeZoom + 1`.
- **Map state persistence** — zoom and centre are saved to `localStorage` on every `moveend` and restored before the map is constructed.
- **Marker rendering** — POIs render as circular photo thumbnails (`divIcon`) or blue dots. Markers live in a `L.markerClusterGroup` in view mode and are moved directly onto `map` in edit mode (necessary for drag to work — clustered markers have `_icon = null`).
- **Marker drag fix** — `setIcon()` swaps the DOM element but doesn't reset `dragging._enabled`; always call `disable() → setIcon() → enable()` or `addTo(map) → disable() → enable()`.
- **Edit mode** — `setEditMode(on)` moves markers between cluster and map, toggles toolbar buttons (Upload Photos, Edit Routes) and the edit-indicator banner. Always starts off on page load.
- **Bulk upload flow** — posts to `POST /api/upload-photos` with `mapLat/mapLng` and `gpsData`; server returns POI objects; client calls `addOrUpdateMarker` for each.

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
  └── photos (id, poi_id, filename, thumb_filename, original_name, order_index, created_at)

routes       (id, name, color, created_at)
  └── route_nodes (id, route_id, order_index REAL, lat, lng, poi_id → pois.id ON DELETE SET NULL)
```

- `route_nodes.order_index` is a `REAL` so `insertRouteNode` can bisect without renumbering.
- Deleting a route cascades its nodes. Deleting a POI sets linked `route_nodes.poi_id = NULL` (FK `ON DELETE SET NULL`); `deletePoiLinkedNodes` then removes those orphaned nodes and cleans up sub-2-node routes.
- Photo files: `uploads/originals/{uuid}.{ext}` and `uploads/thumbs/{uuid}_thumb.jpg`. The API route manually deletes files on POI/photo delete.
