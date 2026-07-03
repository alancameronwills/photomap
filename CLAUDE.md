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

`POST /api/import-gpx` is the GPX import path (counterpart to the client-side GPX/KML export). The browser parses the GPX with `DOMParser` and posts `{ name, color, trackPoints:[{lat,lng}], waypoints:[{lat,lng,name,desc}] }`. The server creates one route from the track and a POI for each text-bearing waypoint (a waypoint with no `name`/`desc` is skipped entirely), linking every POI to a route node at its location. A waypoint within `WAYPOINT_SNAP_M` (8 m) of a track point reuses that node rather than inserting a new one — so round-tripping our own export reconstructs the original POI-linked nodes; otherwise the waypoint node is inserted just after its nearest track point. With no track present, the waypoints themselves form the route in file order. Routes with fewer than 2 nodes aren't created (`route: null` is returned with the POIs). Photos referenced by waypoint `<link>` are not imported.

**`middleware/requireAuth.js`** — guards all write endpoints; reads `req.session.authenticated`.

**`template.yaml`** — AWS SAM template. Defines Lambda function, API Gateway HTTP API, five DynamoDB tables (PAY_PER_REQUEST), and S3 bucket. `scripts/deploy.sh` wraps `sam build && sam deploy`.

### Frontend (`public/`)

No build step — plain JS loaded directly by the browser. Scripts served locally (from `node_modules` via `/vendor/` routes) in order: Leaflet → MarkerCluster → exifr lite → `/config.js` → `app.js`.

**`app.js`** (~2200 lines) organised into sections:

- **Photo scaling / GPS extraction** — `scaleImageFile(file, maxPx=1000)` scales via canvas; `extractGPSFromFiles(files)` reads EXIF from originals before scaling strips it. Both run in parallel in `uploadPhotosToMap`, which batches the scaled files into groups of 10 and posts each batch to `POST /api/upload-photos` with a `gpsData` JSON field. The server prefers `gpsData[i]` over re-extracting from the scaled file.
- **GPX import** — the Edit-mode toolbar `Import GPX` button (mirrored as `mob-import-gpx`, shown/hidden by `setEditMode`) opens a hidden file input. `parseGpx(text)` uses `DOMParser` + `getElementsByTagName` (namespace-agnostic) to pull `<trkpt>` (falling back to `<rtept>`) track points and `<wpt>` waypoints (`name`, `desc`/`cmt`) plus the route name. `importGpxFiles(files)` posts each file to `POST /api/import-gpx`, then adds the returned route (`renderRoute`) and POIs (`addOrUpdateMarker` + `refreshPoiConnectionStyles`) to the live map and fits the view to what was imported. Successive imports cycle `GPX_IMPORT_PALETTE` so routes are visually distinct.
- **Photo URLs** — all photo display uses `ph.url || '/uploads/originals/' + ph.filename` and `ph.thumb_url || '/uploads/thumbs/' + ph.thumb_filename`. On AWS the `url`/`thumb_url` fields are presigned S3 URLs returned by the API; on local they are absent and the fallback paths are used.
- **Tile layers** — `TILE_LAYERS` keyed by display name. Default is `'Topographic'`. All limited-zoom layers use `maxNativeZoom` (not `maxZoom`) so the map zoom is never capped. `handleZoomForLayer` fires on `zoomend`; `aerialFallback` flag is separate from `activeLayerName` so the intended layer is restored on zoom-out. Fallback threshold is `maxNativeZoom + 1`.
- **Map state persistence** — zoom and centre are saved to `localStorage` on every `moveend` and restored before the map is constructed. If no saved position exists and POIs are loaded, the map fits to all POI locations.
- **Marker rendering** — POIs render as circular photo thumbnails (`divIcon`) or blue dots. Markers live in a `L.markerClusterGroup` in view mode and are moved directly onto `map` in edit mode (necessary for drag to work — clustered markers have `_icon = null`). The thumbnail shown is the first photo from `sortedPhotos(poi)`, which puts direction-preferred photos first.
- **Marker drag fix** — `setIcon()` swaps the DOM element but doesn't reset `dragging._enabled`; always call `disable() → setIcon() → enable()` or `addTo(map) → disable() → enable()`.
- **POI labels** — rendered via `marker.bindTooltip(title, { permanent: true, direction: 'auto', className: 'poi-label' })`. Hidden at zoom < `LABEL_MIN_ZOOM` (13); a `zoomend` listener shows/hides all tooltips. Labels use `width: max-content; max-width: 160px` so short titles don't wrap prematurely.
- **POI click routing** (view mode) — `openFullModal` if POI has title or note; `openLightbox(poi, 0)` if photos only; `showPreview` as fallback.
- **Loading indicator** — `#loading-overlay` covers the map until the startup `Promise.all([checkAuth(), loadPois(), loadRoutes()])` resolves, then fades out and is removed from the DOM.
- **Edit mode** — `setEditMode(on)` moves markers between cluster and map, toggles toolbar buttons (Upload Photos, Edit Routes) and the edit-indicator banner. Always starts off on page load. Entering edit mode reveals all POIs regardless of direction filter; exiting re-applies it.
- **Direction preference** — toolbar control (All/1/2) stored in `localStorage`. Buttons show `"To: <name>"` when `currentRoute.dir1_name` / `dir2_name` are set, falling back to `"1"`/`"2"`; `updateDirPrefButtons()` is called from `renderPhoto` so the names refresh whenever a photo is displayed. `sortedPhotos(poi)` sorts matching-direction photos first; `shouldHidePoi(poi)` returns true if all photos have the opposite direction.
- **Photo annotations (lightbox edit mode)** — clicking a thumbnail in the edit dialog calls `openEditLightbox(poiId, idx)`, which adds a crosshair overlay on the photo. Clicking the photo places a directional arrow marker (↓/←/→, controlled by rotation buttons); caption and direction tag are also editable. All changes are buffered in `pendingPhotoEdits` and flushed via `PUT /api/photos/:id` calls when the POI is saved. `stashCurrentLightboxPhotoEdit()` snapshots the current photo's state before navigating or closing. The lightbox does not auto-advance while editing — `openEditLightbox` calls `lightboxViewer.open(photos, idx, false)` to suppress the timer.

#### Photo display factory

`createPhotoDisplay({ imgEl, overlayEl, captionEl, dirLabelEl, prevBtn, nextBtn, pauseBtn, onBeforeNav, onAfterNav })` returns an object encapsulating one photo-display context: image src, marker overlay, caption, direction label, prev/next/pause wiring, and the auto-advance interval. Two instances are created up-front:

- `lightboxViewer` — the full-screen modal lightbox; `onBeforeNav`/`onAfterNav` callbacks stash pending photo edits and refresh the edit panel.
- `trackingViewer` — the half-screen tracking panel; no edit callbacks.

`renderMarker(overlayEl, imgEl, ph)` is the shared marker renderer used by both. It compensates for `object-fit: contain` letterboxing in the tracking panel by computing the actual displayed image rect from `imgEl.naturalWidth/Height` and `imgEl.offsetWidth/Height`. Auto-advance is gated on `trackingMode && photos.length > 1` and an optional `autoAdvance` argument to `open()`.

#### Mobile / responsive UI

At ≤480px the toolbar wraps to two rows (title on its own line, dir-pref + ⋮ menu button on the second). The right-side action buttons collapse into `#mobile-menu`, a kebab dropdown — items proxy clicks to the corresponding desktop buttons (`mob-tracking` → `btn-tracking` etc.) so all state lives in one place. `syncMobileMenu()` mirrors visibility, text and `.active` state from desktop buttons to menu items and is called from each state-changing function (`setEditMode`, `setTrackingMode`, `enterRouteEditMode`, `exitRouteEditMode`, `checkAuth`, `logout`).

`#route-edit-indicator` has its own kebab menu (`#route-edit-menu` with the `mobile-menu-up` variant that opens upward since the indicator sits at the bottom). The native colour picker (`<input type="color">`) is hidden at narrow widths via `opacity: 0; pointer-events: none` while remaining in the DOM; tapping the menu's "Colour" item calls `routeColorInput.click()` to open the OS picker. The swatch is updated from `routeColorInput.value` when the menu opens.

`--toolbar-height` is a CSS variable kept in sync with `#toolbar.offsetHeight` (set by `updateToolbarHeightVar()`, called on resize). The tracking panel positions itself relative to it (`top: var(--toolbar-height)`) so it sits below the actual toolbar height even when the toolbar wraps to two rows on narrow screens.

#### Tracking mode

Auto-enabled on load when `Math.min(window.innerWidth, window.innerHeight) <= 768` (catches phones in either orientation but not tablets/desktops).

**Layout.** Portrait: panel at `top: var(--toolbar-height); height: 33vh`, map fills the remaining ~67vh below. Landscape: panel takes the left 50%, map the right 50%. The `#crosshair` element is positioned by CSS at the centre of the visible map area (`top: calc(var(--toolbar-height)/2 + 66.5vh)` portrait, `left: 75%` landscape).

**Crosshair pixel — `getCrosshairPixel()`.** Reads the rendered `#crosshair` element's `getBoundingClientRect` rather than recomputing from `sz.y * 0.33`. Important on Android: the dynamic URL bar makes `100vh` (used by CSS) and `window.innerHeight` (used by `map.getSize()`) drift apart by tens of pixels, which would otherwise put the JS detection out of step with the visible crosshair.

**POI matching — `getPoiAtCrosshair()`.** A POI qualifies when *any* of:
1. Its lat/lng is within 40 m (ground distance, via `map.distance`) of the crosshair.
2. The crosshair pixel falls within its marker icon (radius = max(iconSize.x, iconSize.y) / 2).
3. The crosshair pixel falls within the cluster icon currently representing it — `clusterGroup.getVisibleParent(marker)` returns the marker itself when unclustered, or the parent cluster when clustered.

Among qualifying POIs the one with the smallest ground distance wins. The icon-overlap test does *not* gate on `parent._icon` because MarkerCluster's `removeOutsideVisibleBounds` (default `true`) prunes elements at the viewport edge, making `_icon` flicker null even for visible POIs. `iconSize` is normalised through `L.point()` since marker icons store it as `[w, h]` arrays while cluster icons store it as `L.Point` objects.

**Live GPS tracking.** `#btn-live-track` (target icon, `position: fixed; right: 12px; bottom: 25vh`) is shown only in tracking mode + view mode + when `navigator.geolocation` is available (`updateLiveTrackBtn()`). Clicking it calls `navigator.geolocation.watchPosition`; each fix calls `panMapToUserLocation(lat, lng)` which `map.panBy`s the offset between the user's pixel and the crosshair pixel. A user-initiated `dragstart` turns it off (programmatic `panBy` does not fire `dragstart`).

**Camera button.** `#btn-camera-photo` (camera icon, sits ~56 px below the live-track button on the right edge) appears only when `trackingMode && authenticated && hasCamera && navigator.geolocation`. `hasCamera` is determined once at startup via `navigator.mediaDevices.enumerateDevices()` (falling back to `'ontouchstart' in window` if the API isn't available). Visibility is refreshed inside `syncMobileMenu()` so it tracks auth + tracking state changes. Clicking opens a hidden `<input type="file" accept="image/*" capture="environment">` (back camera). On `change`, `navigator.geolocation.getCurrentPosition` provides the lat/lng and `uploadPhotosToMap([file], { lat, lng })` posts the photo to the bulk endpoint with the GPS as override; the server then groups it (10 m threshold) into the nearest existing POI or creates a new one.

**`uploadPhotosToMap(files, gpsOverride?)`** has an optional `gpsOverride` parameter. When supplied, every file in the batch is uploaded with that lat/lng instead of EXIF-extracted GPS — used by the camera-button path because freshly-shot Android photos often have their EXIF GPS stripped before the page sees them.

**No-photos POI.** `renderTrackingPanel(poi)` hides `#tracking-photo-wrap` when `lightboxPhotosFor(poi)` is empty so the empty `<img>` doesn't render as a broken-image icon — only title and note are shown.

**Re-detection on retoggle / upload.** `setTrackingMode` resets `trackingPoiId` to `null` whenever it switches state, so toggling tracking off and back on with the crosshair still over the same POI re-renders the panel (otherwise the `if (newId === trackingPoiId) return;` guard in `updateTrackingDisplay` would skip it). After `uploadPhotosToMap` finishes, if the upload touched the currently-tracked POI, `renderTrackingPanel(pois[trackingPoiId])` is called so the slideshow restarts and the new photo enters the rotation.

**Onboarding cue.** On the off→on transition (and only when not in edit mode), `showCrosshairHint()` is scheduled with a 50 ms delay — long enough for layout to settle. It pulses the crosshair red four times via a CSS animation on `#crosshair.flash::before/::after` (~1.6 s total) and pops a `#crosshair-tip` ("move points here to see details") just above the crosshair for ~3.5 s, positioned via `getBoundingClientRect`. The crosshair is hidden whenever edit mode is on; restored on edit-mode exit if tracking is still active.

#### Bottom indicators

Only one of `#edit-indicator` (orange "Edit Mode" banner) and `#route-edit-indicator` (blue route-editing controls) is visible at a time. Both sit at `bottom: 0`. `enterRouteEditMode` hides the edit-indicator; `exitRouteEditMode` restores it (when `editMode` is still true). The Edit-Mode banner has an "Edit Routes" shortcut button on the right that proxies clicks to `btn-enter-route-edit`.

#### Map click suppression after colour picker

On mobile, dismissing the native colour picker by tapping outside it lets the tap fall through to the Leaflet map. `routeColorInput.addEventListener('click', ...)` arms a `suppressNextMapClick` flag whenever the picker is invoked (directly or via `routeColorInput.click()` from the menu); the next `map.on('click')` event consumes the flag and returns early. The flag is cleared by the input's `input` event so a real colour selection doesn't leave it stale.

#### Help / welcome modal

`HELP_CONTENT.welcome()` and `HELP_CONTENT.edit()` return HTML strings; the welcome variant branches on `trackingMode` (rather than screen size) to pick the mobile-flavoured guide vs the desktop one — so the visible state of the Track button stays in sync with what the help describes. `showHelp(key)` populates `#help-overlay`, `maybeShowHelp(key)` only triggers when the matching `localStorage.helpSeen_<key>` flag is unset (and sets it). Welcome auto-opens once after the loading overlay clears; edit auto-opens once on the first call to `setEditMode(true)`. The toolbar `?` button (mirrored as a "Help" item in `#mobile-menu`) always shows the welcome variant.

#### OAuth → edit-mode handoff

When the user clicks Edit while not authenticated, the login overlay opens *and* `localStorage.editAfterAuth` is set. After an OAuth round-trip lands them back at the app, the post-load handler checks `authenticated && localStorage.editAfterAuth` and, if both, calls `setEditMode(true)` and clears the flag. The flag is also cleared on cancel / outside-click of the login modal and on a successful password login (which already enters edit mode directly), so a later OAuth login from the welcome screen alone doesn't unexpectedly switch to edit mode.

#### URL-bar collapsing on mobile

PWA-ish meta tags (`apple-mobile-web-app-capable`, `mobile-web-app-capable`, `theme-color`, `viewport-fit=cover`) make "Add to Home Screen" launch in standalone mode. As a best-effort fallback while in-browser, the init block does a one-pixel `window.scrollTo(0, 1)` after temporarily setting `documentElement.style.minHeight = 'calc(100% + 1px)'`; this nudges some Android Chrome versions into auto-collapsing the URL bar. iOS Safari and current Chrome still require user-initiated scrolling, but the trick is harmless when ineffective.

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

**Auto-cleanup on exit** — `exitRouteEditMode` checks `undoStack[top]`: if the most recently added node is the only node in its route (the user started a route but didn't finish it), it fires `deleteNode(lastNodeId)` which cascades the empty route. The deletion runs after the synchronous UI cleanup so the user perceives the exit immediately.

### Data model

```
pois         (id, lat, lng, title, note, project_id, created_at, updated_at)
  └── photos (id, poi_id, filename, thumb_filename, original_name, order_index, project_id, created_at,
              caption, direction, marker_x, marker_y, marker_rotation)

routes       (id, name, color, project_id, created_at)
  └── route_nodes (id, route_id, order_index REAL, lat, lng, poi_id → pois.id, project_id)
```

- `project_id` on `photos`/`route_nodes` mirrors the parent POI/route's project, set at insert time (SQLite via an `INSERT … SELECT` subquery; DynamoDB copied from a sibling node or fetched from the parent). It lets a project's children be fetched without joining every project's rows in memory. **SQLite** filters children by `project_id` directly (a startup migration backfills existing rows from their parents). **DynamoDB** has no backfill, so `getAllPois`/`getAllRoutes` scope children by parent-membership (the set of the project's POI/route ids) rather than the child's own `project_id`, keeping legacy rows correct; the stored `project_id` is there for a future `project_id` GSI to replace the full-table scans.

- `photos.direction` — integer 1 or 2 (or null); used for direction-preference filtering/sorting.
- `photos.marker_x`, `photos.marker_y` — 0–1 fractions of image dimensions; position of the arrow marker tip.
- `photos.marker_rotation` — integer 0=down, 1=left, 2=right; selects which of three arrow polygon shapes to render.

- `id` fields are auto-increment integers in SQLite; UUID strings in DynamoDB.
- `route_nodes.order_index` is a float so `insertRouteNode` can bisect without renumbering.
- **SQLite**: deleting a route cascades its nodes; deleting a POI sets `route_nodes.poi_id = NULL` via FK. `deletePoiLinkedNodes` then removes orphaned nodes and cleans up sub-2-node routes.
- **DynamoDB**: no FK cascades — all cascade logic is implemented explicitly in `db-dynamo.js`. `poi_id` is omitted from route node items (not stored as NULL) when unset; DynamoDB GSI key attributes cannot hold NULL values.
- Photo files: `uploads/originals/{uuid}.{ext}` and `uploads/thumbs/{uuid}_thumb.jpg` (local), or `originals/{uuid}.{ext}` and `thumbs/{uuid}_thumb.jpg` (S3 keys).
