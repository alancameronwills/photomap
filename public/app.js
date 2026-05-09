/* ── PhotoMap Frontend ── */

// NLS OS 6-inch 1888–1913 layer via MapTiler (tileset id: uk-osgb1888).
// Requires a free MapTiler API key: https://cloud.maptiler.com/account/keys/
// Set the MAPTILER_KEY environment variable before starting the server.
function makeNlsLayer() {
  const key = (window.APP_CONFIG || {}).maptilerKey;
  if (!key) console.warn('NLS Historic layer: set MAPTILER_KEY env var to enable.');
  return L.tileLayer(
    key ? `https://api.maptiler.com/tiles/uk-osgb1888/{z}/{x}/{y}.jpg?key=${key}` : '',
    {
      attribution: 'Historical mapping © <a href="https://maps.nls.uk">National Library of Scotland</a>, tiles by <a href="https://www.maptiler.com/copyright/">MapTiler</a>',
      minZoom: 1,
      maxNativeZoom: 16,
      maxZoom: 22,
      tileSize: 512,
      zoomOffset: -1,
    }
  );
}

// ── Photo scaling ────────────────────────────────────────────────────────────
// Scales a File down to maxPx × maxPx (preserving aspect ratio) using canvas,
// re-encoding as JPEG. Files already within the limit are returned unchanged.
// If the browser can't decode the format (e.g. HEIC), the original is returned.
function scaleImageFile(file, maxPx = 1000) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: h } = img;
      if (w <= maxPx && h <= maxPx) { resolve(file); return; }
      const scale = Math.min(maxPx / w, maxPx / h);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Extracts GPS from original files (before scaling strips EXIF) using the
// browser-loaded exifr lite build. Returns {index: {lat, lng}} for files that
// have GPS; indices with no GPS are absent from the result.
async function extractGPSFromFiles(files) {
  if (typeof exifr === 'undefined') return {};
  const result = {};
  await Promise.all(files.map(async (file, i) => {
    try {
      const gps = await exifr.gps(file);
      if (gps && gps.latitude && gps.longitude)
        result[i] = { lat: gps.latitude, lng: gps.longitude };
    } catch (e) { /* no GPS or unsupported format */ }
  }));
  return result;
}

// ── Tile layers config ──────────────────────────────────────────────────────
const TILE_LAYERS = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }),
  'Aerial (ESRI)': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles © Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19,
    }
  ),
  'Topographic': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style © <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxNativeZoom: 17,
    maxZoom: 22,
  }),
  'NLS Historic OS (UK)': makeNlsLayer(),
};

// ── Map init ────────────────────────────────────────────────────────────────
const savedMapView = (() => { try { return JSON.parse(localStorage.getItem('mapView')); } catch { return null; } })();

const map = L.map('map', {
  center: savedMapView ? [savedMapView.lat, savedMapView.lng] : [54, -2],
  zoom: savedMapView ? savedMapView.zoom : 6,
  layers: [TILE_LAYERS['Topographic']],
  zoomControl: false,
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ── Layer switcher ────────────────────────────────────────────────────────────
// activeLayerName  — the layer the user has chosen (persists through aerial fallback)
// aerialFallback   — true while auto-showing aerial because zoom > activeLayer.maxZoom
let activeLayerName = 'Topographic';
let aerialFallback = false;

function displayedLayerName() {
  return aerialFallback ? 'Aerial (ESRI)' : activeLayerName;
}

function updateLayerButtons() {
  const displayed = displayedLayerName();
  document.getElementById('layer-switcher').querySelectorAll('.layer-btn').forEach(btn => {
    const name = btn.dataset.layer;
    btn.classList.toggle('active', name === displayed);
    btn.classList.toggle('fallback', aerialFallback && name === activeLayerName);
  });
  const sel = document.getElementById('layer-select');
  if (sel) sel.value = activeLayerName;
}

function switchLayer(name) {
  const currently = displayedLayerName();
  if (name === currently && name === activeLayerName) return;
  map.removeLayer(TILE_LAYERS[currently]);
  map.addLayer(TILE_LAYERS[name]);
  activeLayerName = name;
  aerialFallback = false;
  updateLayerButtons();
  handleZoomForLayer();
}

function handleZoomForLayer() {
  if (activeLayerName === 'Aerial (ESRI)') return; // aerial is the chosen layer; nothing to do
  const z = map.getZoom();
  const opts = TILE_LAYERS[activeLayerName].options;
  const maxZ = (opts.maxNativeZoom || opts.maxZoom || 19) + 1;

  if (z > maxZ && !aerialFallback) {
    map.removeLayer(TILE_LAYERS[activeLayerName]);
    map.addLayer(TILE_LAYERS['Aerial (ESRI)']);
    aerialFallback = true;
    updateLayerButtons();
  } else if (z <= maxZ && aerialFallback) {
    map.removeLayer(TILE_LAYERS['Aerial (ESRI)']);
    map.addLayer(TILE_LAYERS[activeLayerName]);
    aerialFallback = false;
    updateLayerButtons();
  }
}

map.on('zoomend', handleZoomForLayer);
map.on('zoomend', () => {
  const show = map.getZoom() >= LABEL_MIN_ZOOM;
  Object.values(markers).forEach(m => {
    if (m.getTooltip()) show ? m.openTooltip() : m.closeTooltip();
  });
});
map.on('moveend', () => {
  const c = map.getCenter();
  localStorage.setItem('mapView', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  if (trackingMode && !editMode) updateTrackingDisplay();
});

function initLayerSwitcher() {
  const container = document.getElementById('layer-switcher');

  // Dropdown for small screens
  const select = document.createElement('select');
  select.id = 'layer-select';
  select.className = 'layer-select';
  Object.keys(TILE_LAYERS).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === activeLayerName) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => switchLayer(select.value));
  container.appendChild(select);

  // Buttons for large screens
  Object.keys(TILE_LAYERS).forEach(name => {
    const btn = document.createElement('button');
    btn.dataset.layer = name;
    btn.className = 'layer-btn' + (name === activeLayerName ? ' active' : '');
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('click', () => switchLayer(name));
    container.appendChild(btn);
  });
}

// Marker cluster group
const clusterGroup = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 60,
  iconCreateFunction(cluster) {
    const count = cluster.getChildCount();
    const size = count < 10 ? 36 : count < 100 ? 44 : 52;
    return L.divIcon({
      html: `<div class="cluster-icon" style="width:${size}px;height:${size}px;line-height:${size}px">${count}</div>`,
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  },
});
map.addLayer(clusterGroup);

// ── State ───────────────────────────────────────────────────────────────────
let editMode = false;
let routeEditMode = false;
let authenticated = false;
let pois = {};           // id → poi object
let markers = {};        // id → Leaflet marker
let activePoi = null;    // currently previewed/opened POI
let newPoiLatLng = null; // temp latlng for new POI from map click
let pendingNewFiles = []; // FileList accumulated for new POI dialog
let pendingNodeForPoi = null; // route node waiting to be linked to a new POI
let lightboxEditPoiId = null;   // non-null when lightbox opened from edit dialog
let currentMarkerPos = null;    // {x, y, rotation} while edit lightbox open
let directionPref = 0;          // 0 = all, 1 or 2 = show that direction first / hide opposite
let currentRoute = null;        // Route whose direction names apply to the current view
let previousPoiId = null;       // Most recently opened POI id (for route determination)
let trackingMode = false;
let trackingPoiId = null;
// lightboxViewer and trackingViewer — PhotoDisplay instances, created after DOM refs below

function getDirName(dir) {
  if (dir === 1) return currentRoute?.dir1_name || '1';
  if (dir === 2) return currentRoute?.dir2_name || '2';
  return String(dir);
}

// Returns all routes that have at least one node linked to poiId.
function getRoutesForPoi(poiId) {
  return Object.values(routes).filter(r => r.nodes.some(n => n.poi_id === poiId));
}

// Sets currentRoute according to the model rules, then records previousPoiId.
function updateCurrentRouteForPoi(poi) {
  const linked = getRoutesForPoi(poi.id);
  if (currentRoute && linked.some(r => r.id === currentRoute.id)) {
    // Current route already links this POI — no change.
  } else if (linked.length === 0) {
    currentRoute = null;
  } else {
    // POI has routes but none matches currentRoute.
    let chosen = null;
    if (previousPoiId) {
      const prevIds = new Set(getRoutesForPoi(previousPoiId).map(r => r.id));
      chosen = linked.find(r => prevIds.has(r.id)) || null;
    }
    currentRoute = chosen || linked[0];
  }
  previousPoiId = poi.id;
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const btnEditMode    = $('btn-edit-mode');
const btnLogout      = $('btn-logout');
const loginOverlay   = $('login-overlay');
const loginPassword  = $('login-password');
const loginError     = $('login-error');

// Show OAuth sign-in buttons only when the provider is configured server-side
if (window.APP_CONFIG.googleAuth || window.APP_CONFIG.microsoftAuth) {
  $('oauth-section').classList.remove('hidden');
  if (window.APP_CONFIG.googleAuth)    $('btn-google-login').classList.remove('hidden');
  if (window.APP_CONFIG.microsoftAuth) $('btn-microsoft-login').classList.remove('hidden');
}

// Handle redirect back from OAuth with an error (e.g. ?login_error=forbidden)
{
  const params = new URLSearchParams(window.location.search);
  const oauthErr = params.get('login_error');
  if (oauthErr) {
    const msg = oauthErr === 'forbidden'
      ? 'Your account is not authorised to access this application.'
      : 'Sign-in failed. Please try again.';
    $('oauth-error').textContent = msg;
    $('oauth-error').classList.remove('hidden');
    $('oauth-section').classList.remove('hidden');
    loginOverlay.classList.remove('hidden');
    history.replaceState({}, '', '/');
  }
}
const previewPanel   = $('preview-panel');
const previewPhotos  = $('preview-photos');
const previewTitle   = $('preview-title');
const previewNote    = $('preview-note');
const btnViewFull    = $('btn-view-full');
const btnEditPoi     = $('btn-edit-poi');
const fullOverlay    = $('full-overlay');
const fullPhotos     = $('full-photos');
const fullTitle      = $('full-title');
const fullNote       = $('full-note');
const editOverlay    = $('edit-overlay');
const editTitleInput = $('edit-title-input');
const editNoteInput  = $('edit-note-input');
const editPhotosList = $('edit-photos-list');
const editFileInput  = $('edit-file-input');
const editDropZone   = $('edit-drop-zone');
const newPoiOverlay  = $('new-poi-overlay');
const newTitleInput  = $('new-title-input');
const newNoteInput   = $('new-note-input');
const newFileInput   = $('new-file-input');
const newPhotosPreview = $('new-photos-preview');
const editIndicator  = $('edit-indicator');
const bulkFileInput  = $('bulk-file-input');
const uploadToast    = $('upload-toast');
const uploadToastMsg = $('upload-toast-msg');
const uploadFill     = $('upload-progress-fill');
const lightbox       = $('lightbox');
const lightboxImg    = $('lightbox-img');

// ── Shared photo-display logic ────────────────────────────────────────────────

// Renders a marker SVG into overlayEl, positioned to sit exactly over the
// image content (compensates for object-fit:contain letterboxing).
function renderMarker(overlayEl, imgEl, ph) {
  overlayEl.innerHTML = '';
  if (!ph || ph.marker_x == null || ph.marker_y == null) return;
  const cw = imgEl.offsetWidth, ch = imgEl.offsetHeight;
  let ox = 0, oy = 0, ow = cw, oh = ch;
  if (imgEl.naturalWidth && imgEl.naturalHeight) {
    const scale = Math.min(cw / imgEl.naturalWidth, ch / imgEl.naturalHeight);
    ow = imgEl.naturalWidth * scale; oh = imgEl.naturalHeight * scale;
    ox = (cw - ow) / 2; oy = (ch - oh) / 2;
  }
  Object.assign(overlayEl.style, { left: ox+'px', top: oy+'px', width: ow+'px', height: oh+'px' });
  const cfg = MARKER_CONFIGS[ph.marker_rotation ?? 0] || MARKER_CONFIGS[0];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '30'); svg.setAttribute('height', '30');
  svg.setAttribute('viewBox', '0 0 30 30');
  svg.classList.add('photo-marker-pin');
  svg.style.left = `${ph.marker_x * 100}%`; svg.style.top = `${ph.marker_y * 100}%`;
  svg.style.transform = cfg.transform;
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  poly.setAttribute('points', cfg.points);   poly.setAttribute('fill', '#ef4444');
  poly.setAttribute('stroke', '#000');        poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly); overlayEl.appendChild(svg);
}

// Factory: manages one photo-display context (image, marker, caption, direction
// label, prev/next/pause controls, auto-advance timer).
//   onBeforeNav — called before index changes (e.g. stash edit state)
//   onAfterNav  — called after index changes (e.g. update edit panel)
function createPhotoDisplay({ imgEl, overlayEl, captionEl, dirLabelEl,
                               prevBtn, nextBtn, pauseBtn,
                               onBeforeNav, onAfterNav }) {
  let photos = [], idx = 0, paused = false, timer = null;

  function renderPhoto() {
    const ph = photos[idx];
    if (!ph) { imgEl.src = ''; overlayEl.innerHTML = ''; return; }
    const src = ph.url || `/uploads/originals/${ph.filename}`;
    imgEl.onload = null;
    if (imgEl.src !== src) {
      imgEl.src = src;
      imgEl.onload = () => renderMarker(overlayEl, imgEl, ph);
    } else if (imgEl.complete && imgEl.naturalWidth) {
      renderMarker(overlayEl, imgEl, ph);
    } else {
      imgEl.onload = () => renderMarker(overlayEl, imgEl, ph);
    }
    if (dirLabelEl) {
      if (ph.direction) { dirLabelEl.textContent = `Direction: ${getDirName(ph.direction)}`; dirLabelEl.classList.remove('hidden'); }
      else dirLabelEl.classList.add('hidden');
    }
    if (captionEl) captionEl.textContent = ph.caption || '';
    updateDirPrefButtons();
  }

  function startAuto() {
    stopAuto();
    if (paused || photos.length <= 1) return;
    timer = setInterval(() => { idx = (idx + 1) % photos.length; renderPhoto(); }, 4000);
  }
  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function syncControls() {
    const multi = photos.length > 1;
    prevBtn?.classList.toggle('hidden', !multi);
    nextBtn?.classList.toggle('hidden', !multi);
    const showPause = trackingMode && multi;
    if (pauseBtn) {
      pauseBtn.classList.toggle('hidden', !showPause);
      if (showPause) { pauseBtn.innerHTML = paused ? '&#9654;' : '&#9208;'; pauseBtn.title = paused ? 'Play' : 'Pause'; }
    }
  }

  function nav(dir, manual = false) {
    if (!photos.length) return;
    onBeforeNav?.();
    idx = (idx + dir + photos.length) % photos.length;
    renderPhoto();
    onAfterNav?.();
    if (manual && timer) startAuto();  // restart timer so this photo gets a full 4s
  }

  function open(newPhotos, startIdx = 0, autoAdvance = true) {
    photos = newPhotos;
    idx = Math.max(0, Math.min(startIdx, Math.max(0, photos.length - 1)));
    paused = false;
    stopAuto();
    renderPhoto();
    syncControls();
    if (autoAdvance && trackingMode && photos.length > 1) startAuto();
  }

  function close() {
    stopAuto();
    imgEl.src = ''; imgEl.onload = null;
    overlayEl.innerHTML = '';
    pauseBtn?.classList.add('hidden');
    if (captionEl) captionEl.textContent = '';
    if (dirLabelEl) dirLabelEl.classList.add('hidden');
  }

  prevBtn?.addEventListener('click',  (e) => { e.stopPropagation(); nav(-1, true); });
  nextBtn?.addEventListener('click',  (e) => { e.stopPropagation(); nav(1,  true); });
  pauseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    paused = !paused;
    syncControls();
    if (paused) stopAuto(); else startAuto();
  });

  return {
    open, close,
    nav,           // manual nav (for keyboard shortcuts etc.)
    rerender: renderPhoto,
    stopAuto,
    get photos() { return photos; },
    get index()  { return idx; },
    set index(i) { idx = i; },
  };
}

// Lightbox viewer — edit-mode callbacks handle stashing/restoring pending edits
const lightboxViewer = createPhotoDisplay({
  imgEl:     $('lightbox-img'),
  overlayEl: $('lightbox-marker-overlay'),
  captionEl: $('lightbox-caption'),
  dirLabelEl:$('lightbox-direction-label'),
  prevBtn:   $('lightbox-prev'),
  nextBtn:   $('lightbox-next'),
  pauseBtn:  $('lightbox-pause'),
  onBeforeNav: () => stashCurrentLightboxPhotoEdit(),
  onAfterNav:  () => {
    if (lightboxEditPoiId) {
      $('lightbox-caption').textContent = '';
      $('lightbox-direction-label').classList.add('hidden');
      updateEditLightboxPanel();
    }
  },
});

// Tracking-panel viewer — view-mode only, no edit callbacks needed
const trackingViewer = createPhotoDisplay({
  imgEl:     $('tracking-photo'),
  overlayEl: $('tracking-marker-overlay'),
  captionEl: $('tracking-caption'),
  dirLabelEl:$('tracking-dir-label'),
  prevBtn:   $('tracking-prev'),
  nextBtn:   $('tracking-next'),
  pauseBtn:  $('tracking-pause'),
});

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const data = await fetch('/auth/status').then(r => r.json());
  authenticated = data.authenticated;
  if (authenticated) {
    btnLogout.classList.remove('hidden');
  }
  syncMobileMenu();
}

async function login(password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error('invalid');
  authenticated = true;
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  authenticated = false;
  setEditMode(false);
  btnEditMode.classList.remove('active');
  btnLogout.classList.add('hidden');
  syncMobileMenu();
}

// ── Edit mode ────────────────────────────────────────────────────────────────
function setEditMode(on) {
  if (!on && routeEditMode) exitRouteEditMode();
  editMode = on;
  editIndicator.classList.toggle('hidden', !on);
  $('btn-bulk-upload').classList.toggle('hidden', !on);
  $('btn-enter-route-edit').classList.toggle('hidden', !on);
  btnEditMode.textContent = on ? 'Done' : 'Edit';
  btnEditMode.classList.toggle('active', on);
  document.getElementById('map').classList.toggle('edit-active', on);

  // Switch markers between the cluster group (view mode) and the raw map (edit
  // mode). Markers inside a cluster have _icon === null, so dragging.enable()
  // silently fails for them regardless of _enabled state. Adding directly to the
  // map guarantees _icon is set and drag listeners attach correctly.
  for (const [id, marker] of Object.entries(markers)) {
    if (on) {
      // Move to raw map FIRST so _map and _icon are live when enable() runs.
      // Calling enable() before addTo() causes addHooks() to bail (_map is null),
      // sets _enabled=true anyway, then the post-addTo enable() is a silent no-op.
      clusterGroup.removeLayer(marker);
      marker.setIcon(createMarkerIcon(pois[id]));
      marker.addTo(map);
      marker.dragging.disable(); // reset _enabled in case a previous stale enable() set it
      marker.dragging.enable();  // _map and _icon are now live → listeners attach
    } else {
      marker.dragging?.disable();
      map.removeLayer(marker);
      marker.setIcon(createMarkerIcon(pois[id]));
      clusterGroup.addLayer(marker);
    }
  }

  btnEditPoi.classList.toggle('hidden', !on);
  $('dir-pref').classList.toggle('hidden', on);

  if (on) {
    // In edit mode show all POIs, including any hidden by direction filter
    for (const poi of Object.values(pois)) {
      if (!markers[poi.id]) addOrUpdateMarker(poi);
    }
  } else {
    // Re-apply direction filter now that edit mode is off
    for (const poi of Object.values(pois)) {
      if (shouldHidePoi(poi)) removeMarker(poi.id);
    }
  }

  // Tracking mode: hide panel while editing, restore orientation and display when done
  if (trackingMode) {
    if (on) {
      clearTrackingPanel();
      document.body.classList.remove('tracking-portrait', 'tracking-landscape');
    } else {
      updateTrackingLayout();
      updateTrackingDisplay();
    }
  }
  syncMobileMenu();
}

// ── Marker creation ──────────────────────────────────────────────────────────
const LABEL_MIN_ZOOM = 13;

function createMarkerIcon(poi) {
  const photos = sortedPhotos(poi);
  if (photos.length > 0) {
    const thumb = photos[0].thumb_url || `/uploads/thumbs/${photos[0].thumb_filename}`;
    const editCls = editMode ? ' edit-mode' : '';
    return L.divIcon({
      html: `<div class="photo-marker${editCls}"><img src="${thumb}" alt="" draggable="false"/></div>`,
      className: '',
      iconSize: [56, 56],
      iconAnchor: [28, 28],
    });
  }
  const editCls = editMode ? ' edit-mode' : '';
  return L.divIcon({
    html: `<div class="dot-marker${editCls}"></div>`,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function addOrUpdateMarker(poi) {
  if (shouldHidePoi(poi)) {
    removeMarker(poi.id);
    return;
  }
  if (markers[poi.id]) {
    if (editMode) map.removeLayer(markers[poi.id]);
    else clusterGroup.removeLayer(markers[poi.id]);
  }

  const marker = L.marker([poi.lat, poi.lng], {
    icon: createMarkerIcon(poi),
    draggable: false,
    title: poi.title || '',
  });

  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (routeEditMode) {
      addNodeAtPoi(poi.id);
    } else if (editMode) {
      openEditDialog(poi.id);
    } else {
      const p = pois[poi.id];
      if (p && (p.title || p.note)) {
        openFullModal(poi.id);
      } else if (p && p.photos && p.photos.length > 0) {
        openLightbox(p, 0);
      } else {
        showPreview(poi.id);
      }
    }
  });

  marker.on('dragend', async (e) => {
    const latlng = e.target.getLatLng();
    try {
      const updated = await api('PUT', `/pois/${poi.id}`, { lat: latlng.lat, lng: latlng.lng });
      pois[poi.id] = updated;
      syncPoiLinkedNodes(poi.id, latlng.lat, latlng.lng);
      await trySnapPoiToNodes(poi.id, latlng);
    } catch (err) {
      console.error('Failed to update POI location', err);
    }
  });

  if (poi.title) {
    marker.bindTooltip(poi.title, { permanent: true, direction: 'auto', className: 'poi-label' });
    if (map.getZoom() < LABEL_MIN_ZOOM) marker.closeTooltip();
  }

  markers[poi.id] = marker;
  if (editMode) {
    marker.addTo(map);
    marker.dragging.disable();
    marker.dragging.enable();
  } else {
    clusterGroup.addLayer(marker);
  }
}

function removeMarker(poiId) {
  if (markers[poiId]) {
    if (editMode) map.removeLayer(markers[poiId]);
    else clusterGroup.removeLayer(markers[poiId]);
    delete markers[poiId];
  }
}

// ── Load all POIs ────────────────────────────────────────────────────────────
async function loadPois() {
  const data = await api('GET', '/pois');
  pois = {};
  clusterGroup.clearLayers();
  markers = {};
  for (const p of data) {
    pois[p.id] = p;
    addOrUpdateMarker(p);
  }
  if (!savedMapView && data.length > 0) {
    const latlngs = data.map(p => [p.lat, p.lng]);
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 14);
    } else {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.2));
    }
  }
}

// ── Preview panel ────────────────────────────────────────────────────────────
function showPreview(poiId) {
  const poi = pois[poiId];
  if (!poi) return;
  activePoi = poi;

  // Photos
  previewPhotos.innerHTML = '';
  if (poi.photos && poi.photos.length > 0) {
    poi.photos.slice(0, 6).forEach((ph, idx) => {
      const img = document.createElement('img');
      img.src = ph.url || `/uploads/originals/${ph.filename}`;
      img.alt = '';
      img.addEventListener('click', () => openLightbox(poi, idx));
      previewPhotos.appendChild(img);
    });
  }

  // Title
  previewTitle.textContent = poi.title || '';

  // Note (first ~200 chars)
  if (poi.note) {
    const preview = poi.note.length > 200 ? poi.note.slice(0, 200) + '…' : poi.note;
    previewNote.textContent = preview;
  } else {
    previewNote.textContent = '';
  }

  previewPanel.classList.remove('hidden');
}

function closePreview() {
  previewPanel.classList.add('hidden');
  activePoi = null;
}

// ── Full POI modal ───────────────────────────────────────────────────────────
function openFullModal(poiId) {
  const poi = pois[poiId] || activePoi;
  if (!poi) return;
  activePoi = poi;
  updateCurrentRouteForPoi(poi);

  fullPhotos.innerHTML = '';
  if (poi.photos && poi.photos.length > 0) {
    poi.photos.forEach((ph, idx) => {
      const img = document.createElement('img');
      img.src = ph.url || `/uploads/originals/${ph.filename}`;
      img.alt = '';
      img.addEventListener('click', () => openLightbox(poi, idx));
      fullPhotos.appendChild(img);
    });
  }

  fullTitle.textContent = poi.title || '';
  fullNote.textContent = poi.note || '';

  fullOverlay.classList.remove('hidden');
}

function closeFullModal() {
  fullOverlay.classList.add('hidden');
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

// In tracking mode, exclude photos with the opposite direction (unset = always shown).
function lightboxPhotosFor(poi) {
  let photos = sortedPhotos(poi);
  if (trackingMode && directionPref) {
    photos = photos.filter(ph => !ph.direction || ph.direction === directionPref);
  }
  return photos;
}

function openLightbox(poi, startIdx) {
  updateCurrentRouteForPoi(poi);
  lightboxEditPoiId = null;
  const photos = lightboxPhotosFor(poi);
  const origPhoto = poi.photos[startIdx];
  const si = origPhoto ? photos.findIndex(p => p.id === origPhoto.id) : 0;
  $('lightbox-edit-panel').classList.add('hidden');
  $('lightbox-marker-overlay').classList.remove('edit-active');
  lightboxViewer.open(photos, si >= 0 ? si : 0);
  lightbox.classList.remove('hidden');
}

function openEditLightbox(poiId, photoIdx) {
  const poi = pois[poiId];
  if (!poi || !poi.photos?.length) return;
  lightboxEditPoiId = poiId;
  $('lightbox-edit-panel').classList.remove('hidden');
  $('lightbox-marker-overlay').classList.add('edit-active');
  lightboxViewer.open(poi.photos, photoIdx, false);   // no auto-advance while editing
  $('lightbox-caption').textContent = '';
  $('lightbox-direction-label').classList.add('hidden');
  updateEditLightboxPanel();
  lightbox.classList.remove('hidden');
}

// Marker configs: points + CSS transform so the arrow tip lands at (left%, top%).
// 0=down (tip bottom-centre), 1=left (tip left-centre), 2=right (tip right-centre).
const MARKER_CONFIGS = {
  0: { points: '10,1 20,1 20,15 29,15 15,29 1,15 10,15',  transform: 'translate(-50%,-100%)' },
  1: { points: '29,10 29,20 15,20 15,29 1,15 15,1 15,10', transform: 'translate(0%,-50%)' },
  2: { points: '1,10 1,20 15,20 15,29 29,15 15,1 15,10',  transform: 'translate(-100%,-50%)' },
};

function updateEditLightboxPanel() {
  const ph = lightboxViewer.photos[lightboxViewer.index];
  if (!ph) return;
  const pending = pendingPhotoEdits[ph.id];
  $('lightbox-caption-input').value = (pending !== undefined ? pending.caption : ph.caption) || '';
  const dir = pending !== undefined ? pending.direction : (ph.direction || null);
  document.querySelectorAll('#lightbox-edit-panel .dir-btn').forEach(btn => {
    const btnDir = btn.dataset.dir ? Number(btn.dataset.dir) : null;
    btn.classList.toggle('active', btnDir === dir);
  });
  const mx  = pending !== undefined ? pending.markerX            : (ph.marker_x        ?? null);
  const my  = pending !== undefined ? pending.markerY            : (ph.marker_y        ?? null);
  const rot = pending !== undefined ? (pending.markerRotation ?? 0) : (ph.marker_rotation ?? 0);
  currentMarkerPos = (mx != null && my != null) ? { x: mx, y: my, rotation: rot } : null;
  document.querySelectorAll('#lightbox-edit-panel .marker-rot-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.rot) === rot);
  });
  renderMarker($('lightbox-marker-overlay'), lightboxImg, mx != null ? { marker_x: mx, marker_y: my, marker_rotation: rot } : null);
}

function stashCurrentLightboxPhotoEdit() {
  if (!lightboxEditPoiId) return;
  const ph = lightboxViewer.photos[lightboxViewer.index];
  if (!ph) return;
  const caption = $('lightbox-caption-input').value.trim();
  const activeBtn = document.querySelector('#lightbox-edit-panel .dir-btn.active');
  const dir = activeBtn?.dataset.dir ? Number(activeBtn.dataset.dir) : null;
  pendingPhotoEdits[ph.id] = {
    caption:        caption || null,
    direction:      dir,
    markerX:        currentMarkerPos ? currentMarkerPos.x        : null,
    markerY:        currentMarkerPos ? currentMarkerPos.y        : null,
    markerRotation: currentMarkerPos ? currentMarkerPos.rotation : null,
  };
  ph.caption          = caption || null;
  ph.direction        = dir;
  ph.marker_x         = currentMarkerPos ? currentMarkerPos.x        : null;
  ph.marker_y         = currentMarkerPos ? currentMarkerPos.y        : null;
  ph.marker_rotation  = currentMarkerPos ? currentMarkerPos.rotation : null;
}

function closeLightbox() {
  stashCurrentLightboxPhotoEdit();
  const wasEditing = lightboxEditPoiId;
  lightboxEditPoiId = null;
  currentMarkerPos = null;
  lightboxViewer.close();
  $('lightbox-edit-panel').classList.add('hidden');
  $('lightbox-marker-overlay').classList.remove('edit-active');
  lightbox.classList.add('hidden');
  if (wasEditing && pois[wasEditing]) renderEditPhotosList(pois[wasEditing]);
}

function lightboxNav(dir) {
  lightboxViewer.nav(dir, !lightboxEditPoiId);
}

// ── Edit dialog ──────────────────────────────────────────────────────────────
let editingPoiId = null;
let pendingEditFiles = [];
let pendingPhotoEdits = {};  // photoId → { caption, direction } — flushed on POI save

function openEditDialog(poiId) {
  const poi = pois[poiId];
  if (!poi) return;
  editingPoiId = poiId;
  pendingEditFiles = [];
  pendingPhotoEdits = {};
  updateCurrentRouteForPoi(poi);

  editTitleInput.value = poi.title || '';
  editNoteInput.value = poi.note || '';

  renderEditPhotosList(poi);

  $('edit-modal-title').textContent = poi.title ? `Edit: ${poi.title}` : 'Edit Point of Interest';
  $('btn-os-maps').href = `https://explore.osmaps.com/?lat=${poi.lat}&lon=${poi.lng}&zoom=16&style=TopoAuto&type=2d`;
  editOverlay.classList.remove('hidden');
  closePreview();
}

function renderEditPhotosList(poi) {
  editPhotosList.innerHTML = '';
  if (!poi.photos) return;
  poi.photos.forEach((ph, idx) => {
    const item = document.createElement('div');
    item.className = 'edit-photo-item';
    const dirBadge = ph.direction ? `<span class="photo-dir-badge">${ph.direction}</span>` : '';
    item.innerHTML = `
      <img src="${ph.thumb_url || `/uploads/thumbs/${ph.thumb_filename}`}" alt="" title="Click to edit caption/direction"/>
      ${dirBadge}
      <button class="delete-photo-btn" data-photo-id="${ph.id}" title="Delete photo">&#x2715;</button>
    `;
    item.querySelector('img').addEventListener('click', () => openEditLightbox(poi.id, idx));
    item.querySelector('.delete-photo-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this photo?')) return;
      try {
        await api('DELETE', `/photos/${ph.id}`);
        const updated = await api('GET', `/pois/${editingPoiId}`);
        pois[editingPoiId] = updated;
        addOrUpdateMarker(updated);
        renderEditPhotosList(updated);
      } catch (err) { alert('Failed to delete photo: ' + err.message); }
    });
    editPhotosList.appendChild(item);
  });
}

async function saveEditDialog() {
  const poi = pois[editingPoiId];
  if (!poi) return;

  const title = editTitleInput.value.trim();
  const note = editNoteInput.value.trim();

  // Validate: at least one of title, note, photos
  const hasPhotos = poi.photos.length > 0 || pendingEditFiles.length > 0;
  if (!title && !note && !hasPhotos) {
    alert('Please add a title, note, or at least one photo.');
    return;
  }

  try {
    const updated = await api('PUT', `/pois/${editingPoiId}`, { title, note });
    pois[editingPoiId] = updated;
    addOrUpdateMarker(updated);

    // Flush any caption/direction edits made via the lightbox
    const photoEditEntries = Object.entries(pendingPhotoEdits);
    if (photoEditEntries.length) {
      await Promise.all(photoEditEntries.map(([photoId, edits]) =>
        api('PUT', `/photos/${photoId}`, edits)
      ));
    }

    // Upload any new photos (scaled client-side)
    if (pendingEditFiles.length > 0) {
      const scaled = await Promise.all(pendingEditFiles.map(f => scaleImageFile(f)));
      const fd = new FormData();
      scaled.forEach(f => fd.append('photos', f));
      const result = await api('POST', `/pois/${editingPoiId}/photos`, fd);
      pois[editingPoiId] = result;
      addOrUpdateMarker(result);
    } else if (photoEditEntries.length) {
      // Reload to get updated photo data
      const refreshed = await api('GET', `/pois/${editingPoiId}`);
      pois[editingPoiId] = refreshed;
      addOrUpdateMarker(refreshed);
    }

    closeEditDialog();
    if (activePoi && activePoi.id === editingPoiId) {
      activePoi = pois[editingPoiId];
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function deleteCurrentPoi() {
  if (!editingPoiId) return;
  if (!confirm('Delete this point of interest and all its photos?')) return;
  try {
    const result = await api('DELETE', `/pois/${editingPoiId}`);
    const deletedNodeIds = result.deletedNodeIds || [];
    const deletedRouteIds = new Set(result.deletedRouteIds || []);
    const survivingRouteIds = new Set(deletedNodeIds.map(id => nodeRouteId[id]).filter(rid => rid && !deletedRouteIds.has(rid)));
    for (const id of deletedNodeIds) {
      if (routeNodeMarkers[id]) { map.removeLayer(routeNodeMarkers[id]); delete routeNodeMarkers[id]; }
      delete nodeRouteId[id];
    }
    for (const rid of deletedRouteIds) {
      if (routePolylines[rid]) { map.removeLayer(routePolylines[rid]); delete routePolylines[rid]; }
      delete routes[rid];
      if (activeRouteId === rid) activeRouteId = null;
    }
    for (const rid of survivingRouteIds) {
      const route = routes[rid];
      if (route) { route.nodes = route.nodes.filter(n => !deletedNodeIds.includes(n.id)); redrawPolyline(rid); }
    }
    delete pois[editingPoiId];
    removeMarker(editingPoiId);
    closeEditDialog();
    closePreview();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function closeEditDialog() {
  editOverlay.classList.add('hidden');
  editingPoiId = null;
  pendingEditFiles = [];
  pendingPhotoEdits = {};
}

// ── New POI dialog (from map click in edit mode) ──────────────────────────────
function openNewPoiDialog(latlng) {
  newPoiLatLng = latlng;
  newTitleInput.value = '';
  newNoteInput.value = '';
  newPhotosPreview.innerHTML = '';
  pendingNewFiles = [];
  newPoiOverlay.classList.remove('hidden');
}

function closeNewPoiDialog() {
  newPoiOverlay.classList.add('hidden');
  newPoiLatLng = null;
  pendingNewFiles = [];
  pendingNodeForPoi = null;
}


function renderNewPhotoPreviews() {
  newPhotosPreview.innerHTML = '';
  pendingNewFiles.forEach(f => {
    const img = document.createElement('img');
    img.className = 'preview-thumb';
    img.src = URL.createObjectURL(f);
    newPhotosPreview.appendChild(img);
  });
}

setupDropZone($('new-drop-zone'), newFileInput, (files) => {
  pendingNewFiles = [...pendingNewFiles, ...files];
  renderNewPhotoPreviews();
});

async function saveNewPoi() {
  const title = newTitleInput.value.trim();
  const note = newNoteInput.value.trim();

  if (!title && !note && pendingNewFiles.length === 0) {
    alert('Please add a title, note, or at least one photo.');
    return;
  }

  try {
    let poi = await api('POST', '/pois', {
      lat: newPoiLatLng.lat,
      lng: newPoiLatLng.lng,
      title,
      note,
    });

    if (pendingNewFiles.length > 0) {
      const scaled = await Promise.all(pendingNewFiles.map(f => scaleImageFile(f)));
      const fd = new FormData();
      scaled.forEach(f => fd.append('photos', f));
      poi = await api('POST', `/pois/${poi.id}/photos`, fd);
    }

    pois[poi.id] = poi;
    addOrUpdateMarker(poi);

    // If this POI was created by clicking a route node, link them
    if (pendingNodeForPoi) {
      const node = pendingNodeForPoi;
      try {
        await api('PUT', `/route-nodes/${node.id}`, { poiId: poi.id });
        node.poi_id = poi.id;
        const marker = routeNodeMarkers[node.id];
        if (marker) {
          marker.dragging.disable();
          marker.setIcon(nodeIcon(node, false));
          // POI-linked nodes don't drag independently
        }
      } catch (e) {
        console.error('Failed to link node to POI', e);
      }
    }

    closeNewPoiDialog();
    map.panTo([poi.lat, poi.lng]);
  } catch (err) {
    alert('Failed to create POI: ' + err.message);
  }
}

// ── Bulk photo upload (edit mode toolbar) ─────────────────────────────────────
bulkFileInput.addEventListener('change', () => {
  if (bulkFileInput.files.length > 0) {
    uploadPhotosToMap(Array.from(bulkFileInput.files));
    bulkFileInput.value = '';
  }
});

async function uploadPhotosToMap(files) {
  const center = map.getCenter();
  showUploadToast('Processing photos…', 0);

  // Extract GPS from originals before scaling strips EXIF, then scale
  const [gpsMap, scaled] = await Promise.all([
    extractGPSFromFiles(files),
    Promise.all(files.map(f => scaleImageFile(f))),
  ]);

  // API Gateway has a 10 MB request limit, so send in batches of 10
  const BATCH = 10;
  const allPois = {};

  try {
    for (let start = 0; start < scaled.length; start += BATCH) {
      const batchScaled = scaled.slice(start, start + BATCH);

      const fd = new FormData();
      batchScaled.forEach(f => fd.append('photos', f));
      fd.append('mapLat', center.lat);
      fd.append('mapLng', center.lng);

      // Remap GPS indices to batch-local positions
      const batchGps = {};
      for (let j = 0; j < batchScaled.length; j++) {
        if (gpsMap[start + j]) batchGps[j] = gpsMap[start + j];
      }
      if (Object.keys(batchGps).length) fd.append('gpsData', JSON.stringify(batchGps));

      uploadFill.style.width = Math.round((start / scaled.length) * 95) + '%';
      uploadToastMsg.textContent = `Uploading… (${start + batchScaled.length}/${scaled.length})`;

      const result = await api('POST', '/upload-photos', fd);
      for (const poi of result.pois) allPois[poi.id] = poi;
    }

    uploadFill.style.width = '100%';

    const poiList = Object.values(allPois);
    for (const poi of poiList) {
      pois[poi.id] = poi;
      addOrUpdateMarker(poi);
    }

    if (poiList.length > 0) {
      const latlngs = poiList.map(p => [p.lat, p.lng]);
      if (latlngs.length === 1) {
        map.setView(latlngs[0], Math.max(map.getZoom(), 16));
      } else {
        map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
      }
    }

    setTimeout(hideUploadToast, 1200);
    uploadToastMsg.textContent = `Added ${poiList.length} location${poiList.length !== 1 ? 's' : ''}`;
  } catch (err) {
    hideUploadToast();
    alert('Upload failed: ' + err.message);
  }
}

function showUploadToast(msg, progress) {
  uploadToastMsg.textContent = msg;
  uploadFill.style.width = progress + '%';
  uploadToast.classList.remove('hidden');
}
function hideUploadToast() {
  uploadToast.classList.add('hidden');
  uploadFill.style.width = '0';
}

// ── Drop zone helper ──────────────────────────────────────────────────────────
function setupDropZone(zone, fileInput, onFiles) {
  zone.addEventListener('click', (e) => {
    if (!e.target.classList.contains('file-label')) fileInput.click();
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) onFiles(files);
  });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    if (files.length) onFiles(files);
    fileInput.value = '';
  });
}

setupDropZone(editDropZone, editFileInput, (files) => {
  pendingEditFiles = [...pendingEditFiles, ...files];
  // Show count indicator next to drop zone
  editDropZone.querySelector('span').textContent = `${pendingEditFiles.length} file${pendingEditFiles.length !== 1 ? 's' : ''} selected — drop more or save`;
});

// ── Event wiring ─────────────────────────────────────────────────────────────

// Suppress the map click that fires when a native colour picker is dismissed
// by tapping outside it on mobile (the dismiss tap falls through to the map).
let suppressNextMapClick = false;

// Map click
map.on('click', (e) => {
  if (suppressNextMapClick) { suppressNextMapClick = false; return; }
  if (routeEditMode) {
    handleRouteMapClick(e);
  } else if (editMode) {
    openNewPoiDialog(e.latlng);
  } else {
    closePreview();
  }
});

// Toolbar: edit mode toggle
btnEditMode.addEventListener('click', () => {
  if (editMode) {
    setEditMode(false);
  } else if (authenticated) {
    setEditMode(true);
  } else {
    loginOverlay.classList.remove('hidden');
    loginPassword.value = '';
    loginError.classList.add('hidden');
    setTimeout(() => loginPassword.focus(), 50);
  }
});

btnLogout.addEventListener('click', logout);

// Login modal
$('btn-login-cancel').addEventListener('click', () => loginOverlay.classList.add('hidden'));

$('btn-login-submit').addEventListener('click', async () => {
  try {
    await login(loginPassword.value);
    loginOverlay.classList.add('hidden');
    loginError.classList.add('hidden');
    btnLogout.classList.remove('hidden');
    setEditMode(true);
  } catch {
    loginError.classList.remove('hidden');
    loginPassword.select();
  }
});

loginPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-login-submit').click();
});

loginOverlay.addEventListener('click', (e) => {
  if (e.target === loginOverlay) loginOverlay.classList.add('hidden');
});

// Preview panel
$('preview-close').addEventListener('click', closePreview);

btnViewFull.addEventListener('click', () => {
  if (activePoi) openFullModal(activePoi.id);
});

btnEditPoi.addEventListener('click', () => {
  if (activePoi) { openEditDialog(activePoi.id); }
});

// Full modal
$('full-close').addEventListener('click', closeFullModal);
fullOverlay.addEventListener('click', (e) => {
  if (e.target === fullOverlay) closeFullModal();
});

// Edit dialog
$('edit-close').addEventListener('click', closeEditDialog);
editOverlay.addEventListener('click', (e) => {
  if (e.target === editOverlay) closeEditDialog();
});
$('btn-edit-cancel').addEventListener('click', closeEditDialog);
$('btn-edit-save').addEventListener('click', saveEditDialog);
$('btn-delete-poi').addEventListener('click', deleteCurrentPoi);

// New POI dialog
$('new-poi-close').addEventListener('click', closeNewPoiDialog);
newPoiOverlay.addEventListener('click', (e) => {
  if (e.target === newPoiOverlay) closeNewPoiDialog();
});
$('btn-new-cancel').addEventListener('click', closeNewPoiDialog);
$('btn-new-save').addEventListener('click', saveNewPoi);

// Lightbox
$('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
  // In view mode only, clicking the image also closes; in edit mode keep it open for editing
  if (e.target === lightboxImg && !lightboxEditPoiId) closeLightbox();
});
// lightbox-prev / lightbox-next / lightbox-pause are wired by lightboxViewer (createPhotoDisplay)

// Lightbox edit panel — direction buttons and marker rotation buttons
$('lightbox-edit-panel').addEventListener('click', (e) => {
  const dirBtn = e.target.closest('.dir-btn');
  if (dirBtn) {
    document.querySelectorAll('#lightbox-edit-panel .dir-btn').forEach(b => b.classList.remove('active'));
    dirBtn.classList.add('active');
    return;
  }
  const rotBtn = e.target.closest('.marker-rot-btn');
  if (rotBtn) {
    document.querySelectorAll('#lightbox-edit-panel .marker-rot-btn').forEach(b => b.classList.remove('active'));
    rotBtn.classList.add('active');
    if (currentMarkerPos) {
      currentMarkerPos.rotation = Number(rotBtn.dataset.rot);
      renderMarker($('lightbox-marker-overlay'), lightboxImg,
        { marker_x: currentMarkerPos.x, marker_y: currentMarkerPos.y, marker_rotation: currentMarkerPos.rotation });
    }
  }
});

// Marker overlay — click to place/move marker (edit mode only)
$('lightbox-marker-overlay').addEventListener('click', (e) => {
  if (!lightboxEditPoiId) return;
  e.stopPropagation();
  const overlay = $('lightbox-marker-overlay');
  const x = Math.max(0, Math.min(1, e.offsetX / overlay.clientWidth));
  const y = Math.max(0, Math.min(1, e.offsetY / overlay.clientHeight));
  const rotBtn = document.querySelector('#lightbox-edit-panel .marker-rot-btn.active');
  const rotation = rotBtn ? Number(rotBtn.dataset.rot) : 0;
  currentMarkerPos = { x, y, rotation };
  renderMarker($('lightbox-marker-overlay'), lightboxImg,
    { marker_x: x, marker_y: y, marker_rotation: rotation });
});

// Remove marker button
$('lightbox-remove-marker').addEventListener('click', (e) => {
  e.stopPropagation();
  currentMarkerPos = null;
  $('lightbox-marker-overlay').innerHTML = '';
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
    closeFullModal();
    closeEditDialog();
    closeNewPoiDialog();
    loginOverlay.classList.add('hidden');
    closePreview();
  }
  if (!lightbox.classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') lightboxNav(-1);
    if (e.key === 'ArrowRight') lightboxNav(1);
  }
});

// Bulk upload button
$('btn-bulk-upload').addEventListener('click', () => bulkFileInput.click());

// ── Cluster icon styles (injected) ───────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  .cluster-icon {
    background: #2563eb;
    color: #fff;
    border-radius: 50%;
    text-align: center;
    font-weight: 700;
    font-size: 0.85rem;
    border: 3px solid rgba(255,255,255,0.85);
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;
document.head.appendChild(style);

// ── Routes ───────────────────────────────────────────────────────────────────

// Dedicated Leaflet pane so polylines render below POI markers
map.createPane('routesPane');
map.getPane('routesPane').style.zIndex = 350;

let routes = {};           // routeId → route (with .nodes[])
let routePolylines = {};   // routeId → L.Polyline
let routeNodeMarkers = {}; // nodeId  → L.Marker
let nodeRouteId = {};      // nodeId  → routeId
let activeRouteId = null;
let selectedNodeId = null;
let undoStack = [];         // nodeIds added in the current route-edit session
let waitingForRouteStart = false; // true until the first meaningful click after entering route-edit
let extendingFromStart = false;   // true when prepending (user clicked the start node)

const ZERO_ICON = L.divIcon({ html: '', className: '', iconSize: [0, 0], iconAnchor: [0, 0] });

function nodeIcon(node, selected) {
  // Linked nodes sit exactly on their POI — hide unless selected.
  if (node.poi_id && !selected) return ZERO_ICON;
  // Unlinked nodes are only shown in route-edit mode.
  if (!node.poi_id && !routeEditMode && !selected) return ZERO_ICON;
  const cls = ['route-node'];
  if (node.poi_id) cls.push('poi-linked');
  if (selected) cls.push('selected');
  const route = routes[node.route_id || nodeRouteId[node.id]];
  const color = (selected && route) ? route.color : undefined;
  const style = color ? `border-color:${color};box-shadow:0 0 0 3px ${color}55,0 1px 5px rgba(0,0,0,.5)` : '';
  return L.divIcon({
    html: `<div class="${cls.join(' ')}" style="${style}"></div>`,
    className: '',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function redrawPolyline(routeId) {
  const route = routes[routeId];
  const poly = routePolylines[routeId];
  if (!route || !poly) return;
  poly.setLatLngs(route.nodes.map(n => [n.lat, n.lng]));
}

function setupNodeMarkerEvents(marker, node) {
  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    const current = routes[nodeRouteId[node.id]]?.nodes.find(n => n.id === node.id) || node;
    if (routeEditMode) {
      if (waitingForRouteStart) {
        const route = routes[nodeRouteId[node.id]];
        if (route && isStartOrEnd(node.id, route)) {
          activeRouteId = route.id;
          extendingFromStart = (route.nodes[0].id === node.id);
          waitingForRouteStart = false;
          setActiveRoute(activeRouteId);
          updateRouteHint();
        }
      }
      if (selectedNodeId === node.id) deselectNode();
      else selectNode(node.id);
    } else if (editMode) {
      if (current.poi_id) openEditDialog(current.poi_id);
      else createPoiAtNode(current);
    }
  });

  marker.on('drag', () => {
    const ll = marker.getLatLng();
    const n = routes[nodeRouteId[node.id]]?.nodes.find(x => x.id === node.id);
    if (n) { n.lat = ll.lat; n.lng = ll.lng; }
    redrawPolyline(nodeRouteId[node.id]);
  });

  marker.on('dragend', async () => {
    const ll = marker.getLatLng();
    try {
      // If the node was POI-linked, dragging it breaks the association — the user
      // is explicitly repositioning it. Clear the link, then check for a new snap.
      if (node.poi_id) {
        node.poi_id = null;
        marker.dragging.disable();
        marker.setIcon(nodeIcon(node, selectedNodeId === node.id));
        marker.dragging.enable();
      }
      const snapped = await trySnapNodeToPoi(node);
      if (!snapped) await api('PUT', `/route-nodes/${node.id}`, { lat: ll.lat, lng: ll.lng, poiId: null });
    } catch (e) { console.error('Node save failed', e); }
  });
}

function renderRoute(route) {
  // Clear any existing map objects for this route
  clearRoute(route.id);

  const color = route.color || '#ff69b4';
  const latlngs = route.nodes.map(n => [n.lat, n.lng]);

  const poly = L.polyline(latlngs, {
    color, weight: 10, opacity: 0.5, pane: 'routesPane',
  }).addTo(map);
  routePolylines[route.id] = poly;

  poly.on('click', async (e) => {
    L.DomEvent.stopPropagation(e);
    e.originalEvent.stopPropagation();
    if (!routeEditMode) return;
    const liveRoute = routes[route.id];
    if (!liveRoute || liveRoute.nodes.length < 2) return;

    if (waitingForRouteStart) {
      activeRouteId = route.id;
      waitingForRouteStart = false;
      extendingFromStart = false;
      setActiveRoute(activeRouteId);
    }

    const segIdx = findClosestSegmentIndex(liveRoute, e.latlng);
    if (segIdx < 0) return;

    try {
      const node = await api('POST', `/routes/${route.id}/nodes`, {
        lat: e.latlng.lat, lng: e.latlng.lng, afterNodeId: liveRoute.nodes[segIdx].id,
      });
      node.route_id = route.id;
      nodeRouteId[node.id] = route.id;
      liveRoute.nodes.splice(segIdx + 1, 0, node);
      const marker = L.marker([node.lat, node.lng], {
        icon: nodeIcon(node, false), draggable: false, zIndexOffset: 200,
      }).addTo(map);
      setupNodeMarkerEvents(marker, node);
      routeNodeMarkers[node.id] = marker;
      enableNodeDrag(marker);
      redrawPolyline(route.id);
    } catch (err) { console.error('Insert node failed:', err); }
  });

  for (const node of route.nodes) {
    nodeRouteId[node.id] = route.id;
    const marker = L.marker([node.lat, node.lng], {
      icon: nodeIcon(node, false),
      draggable: false,
      zIndexOffset: 200,
    }).addTo(map);
    setupNodeMarkerEvents(marker, node);
    routeNodeMarkers[node.id] = marker;
  }
}

function clearRoute(routeId) {
  if (routePolylines[routeId]) { map.removeLayer(routePolylines[routeId]); delete routePolylines[routeId]; }
  const route = routes[routeId];
  if (route) {
    for (const n of route.nodes) {
      if (routeNodeMarkers[n.id]) { map.removeLayer(routeNodeMarkers[n.id]); delete routeNodeMarkers[n.id]; }
      delete nodeRouteId[n.id];
    }
  }
}

async function loadRoutes() {
  const data = await api('GET', '/routes');
  routes = {};
  for (const r of data) routes[r.id] = r;
  for (const r of data) renderRoute(r);
}

// ── Route segment hit-testing ────────────────────────────────────────────────

function ptToSegmentDistPx(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function findClosestSegmentIndex(route, latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < route.nodes.length - 1; i++) {
    const a = map.latLngToContainerPoint([route.nodes[i].lat, route.nodes[i].lng]);
    const b = map.latLngToContainerPoint([route.nodes[i + 1].lat, route.nodes[i + 1].lng]);
    const d = ptToSegmentDistPx(pt, a, b);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// ── Drag-to-link snapping ─────────────────────────────────────────────────────

const LINK_SNAP_PX = 30; // centre-to-centre pixel distance that triggers linking

function screenDist(latlng1, latlng2) {
  const a = map.latLngToContainerPoint(latlng1);
  const b = map.latLngToContainerPoint(latlng2);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Called at the end of a node drag. If the node is unlinked and now sits within
// LINK_SNAP_PX of a POI, link it and snap its position to the POI exactly.
// Returns true if a snap occurred (so the caller can skip saving the raw position).
async function trySnapNodeToPoi(node) {
  if (node.poi_id) return false;
  const marker = routeNodeMarkers[node.id];
  if (!marker) return false;
  const ll = marker.getLatLng();
  for (const poi of Object.values(pois)) {
    if (screenDist(ll, [poi.lat, poi.lng]) <= LINK_SNAP_PX) {
      await api('PUT', `/route-nodes/${node.id}`, { lat: poi.lat, lng: poi.lng, poiId: poi.id });
      node.lat = poi.lat; node.lng = poi.lng; node.poi_id = poi.id;
      marker.dragging.disable();
      marker.setLatLng([poi.lat, poi.lng]);
      marker.setIcon(nodeIcon(node, selectedNodeId === node.id));
      redrawPolyline(nodeRouteId[node.id]);
      return true;
    }
  }
  return false;
}

// Called at the end of a POI drag. Links any unlinked route nodes within
// LINK_SNAP_PX, snapping them to the POI's new position.
async function trySnapPoiToNodes(poiId, poiLatlng) {
  for (const route of Object.values(routes)) {
    for (const node of route.nodes) {
      if (node.poi_id) continue;
      if (screenDist(poiLatlng, [node.lat, node.lng]) <= LINK_SNAP_PX) {
        await api('PUT', `/route-nodes/${node.id}`, { lat: poiLatlng.lat, lng: poiLatlng.lng, poiId: poiId });
        node.lat = poiLatlng.lat; node.lng = poiLatlng.lng; node.poi_id = poiId;
        const m = routeNodeMarkers[node.id];
        if (m) {
          m.dragging.disable();
          m.setLatLng([poiLatlng.lat, poiLatlng.lng]);
          m.setIcon(nodeIcon(node, selectedNodeId === node.id));
        }
        redrawPolyline(route.id);
      }
    }
  }
}

// Called after a POI is dragged — updates any linked node positions client-side
function syncPoiLinkedNodes(poiId, lat, lng) {
  for (const route of Object.values(routes)) {
    let changed = false;
    for (const node of route.nodes) {
      if (node.poi_id === poiId) {
        node.lat = lat; node.lng = lng;
        routeNodeMarkers[node.id]?.setLatLng([lat, lng]);
        changed = true;
      }
    }
    if (changed) redrawPolyline(route.id);
  }
}

// ── Route edit mode ──────────────────────────────────────────────────────────

const routeEditIndicator = $('route-edit-indicator');
const routeColorInput    = $('route-color-input');
const btnDeleteNode      = $('btn-delete-node');
const btnSplitRoute      = $('btn-split-route');
const btnDeleteRoute     = $('btn-delete-route');

function setActiveRoute(routeId) {
  activeRouteId = routeId;
}

function enableNodeDrag(marker) {
  // setIcon() swaps the DOM element and strips listeners, but doesn't reset
  // dragging._enabled — so a subsequent enable() silently no-ops.
  // Always disable first to clear the guard flag, then re-enable on the live element.
  marker.dragging.disable();
  marker.dragging.enable();
}

// ── Route-start helpers ───────────────────────────────────────────────────────

function isStartOrEnd(nodeId, route) {
  const n = route.nodes;
  return n.length > 0 && (n[0].id === nodeId || n[n.length - 1].id === nodeId);
}

// Returns {node, route} if poiId has exactly one linked node that is at the
// start or end of its route; otherwise null.
function findLinkedStartEndNode(poiId) {
  const linked = [];
  for (const route of Object.values(routes)) {
    for (const node of route.nodes) {
      if (node.poi_id === poiId) linked.push({ node, route });
    }
  }
  if (linked.length !== 1) return null;
  const { node, route } = linked[0];
  return isStartOrEnd(node.id, route) ? { node, route } : null;
}

function updateRouteHint() {
  const el = document.getElementById('route-edit-hint');
  if (!el) return;
  el.textContent = waitingForRouteStart
    ? 'click a start/end node or POI to extend a route · click map to start a new route'
    : 'click map · click POI to link · click node to select';
}

async function createNewRouteAndActivate() {
  const color = routeColorInput.value || '#ff69b4';
  const route = await api('POST', '/routes', { color });
  routes[route.id] = route;
  renderRoute(route);
  waitingForRouteStart = false;
  extendingFromStart = false;
  setActiveRoute(route.id);
  updateRouteHint();
}

function refreshAllNodeIcons() {
  for (const route of Object.values(routes)) {
    for (const node of route.nodes) {
      const marker = routeNodeMarkers[node.id];
      if (!marker) continue;
      const selected = selectedNodeId === node.id;
      marker.dragging.disable();
      marker.setIcon(nodeIcon(node, selected));
      if (routeEditMode) marker.dragging.enable();
    }
  }
}

function enterRouteEditMode() {
  routeEditMode = true;
  waitingForRouteStart = true;
  extendingFromStart = false;
  activeRouteId = null;
  $('btn-enter-route-edit').textContent = 'Done Editing Routes';
  routeEditIndicator.classList.remove('hidden');
  editIndicator.classList.add('hidden');
  document.getElementById('map').classList.add('route-edit-active');
  routeColorInput.disabled = true;
  updateRouteHint();
  refreshAllNodeIcons();
  syncMobileMenu();
}

function exitRouteEditMode() {
  // If the most recently added node is the only node in its route, the user
  // started a new route and didn't finish it — drop the orphan node so we don't
  // leave a degenerate single-node route behind. deleteNode cascades to remove
  // the route since it falls below 2 nodes.
  const lastNodeId = undoStack[undoStack.length - 1];
  const orphanRouteId = lastNodeId ? nodeRouteId[lastNodeId] : null;
  const shouldCleanupOrphan = orphanRouteId && routes[orphanRouteId]?.nodes.length === 1;

  deselectNode();
  routeEditMode = false;
  waitingForRouteStart = false;
  extendingFromStart = false;
  undoStack = [];
  updateUndoBtn();
  $('btn-enter-route-edit').textContent = 'Edit Routes';
  routeEditIndicator.classList.add('hidden');
  if (editMode) editIndicator.classList.remove('hidden');
  document.getElementById('map').classList.remove('route-edit-active');
  refreshAllNodeIcons();
  syncMobileMenu();

  if (shouldCleanupOrphan) deleteNode(lastNodeId);
}

function selectNode(nodeId) {
  if (selectedNodeId) deselectNode();
  selectedNodeId = nodeId;
  const marker = routeNodeMarkers[nodeId];
  const node = routes[nodeRouteId[nodeId]]?.nodes.find(n => n.id === nodeId);
  if (!marker || !node) return;
  // Disable drag before setIcon so the _enabled flag is cleared; the new icon
  // element needs a fresh enable() call after the DOM swap.
  marker.dragging.disable();
  marker.setIcon(nodeIcon(node, true));
  marker.dragging.enable();
  btnDeleteNode.disabled = false;
  btnSplitRoute.disabled = false;
  btnDeleteRoute.disabled = false;
  currentRoute = routes[nodeRouteId[nodeId]] || null;
  routeColorInput.value = currentRoute?.color || '#ff69b4';
  routeColorInput.disabled = false;
  $('dir1-name-input').value = currentRoute?.dir1_name || '';
  $('dir2-name-input').value = currentRoute?.dir2_name || '';
  $('dir-name-fields').classList.remove('hidden');
}

function deselectNode() {
  if (!selectedNodeId) return;
  const marker = routeNodeMarkers[selectedNodeId];
  const node = routes[nodeRouteId[selectedNodeId]]?.nodes.find(n => n.id === selectedNodeId);
  if (marker && node) {
    marker.dragging.disable();
    marker.setIcon(nodeIcon(node, false));
    // Restore drag on the new icon if still in route-edit mode
    if (routeEditMode) marker.dragging.enable();
  }
  selectedNodeId = null;
  btnDeleteNode.disabled = true;
  btnSplitRoute.disabled = true;
  btnDeleteRoute.disabled = true;
  routeColorInput.disabled = true;
  $('dir-name-fields').classList.add('hidden');
}

function updateUndoBtn() {
  $('btn-undo-node').disabled = undoStack.length === 0;
}

async function deleteNode(nodeId) {
  if (selectedNodeId === nodeId) deselectNode();
  try {
    const result = await api('DELETE', `/route-nodes/${nodeId}`);
    for (const id of result.deletedNodeIds) {
      if (routeNodeMarkers[id]) { map.removeLayer(routeNodeMarkers[id]); delete routeNodeMarkers[id]; }
      delete nodeRouteId[id];
    }
    if (result.routeDeleted) {
      if (routePolylines[result.routeId]) { map.removeLayer(routePolylines[result.routeId]); delete routePolylines[result.routeId]; }
      delete routes[result.routeId];
      if (activeRouteId === result.routeId) activeRouteId = null;
    } else {
      const route = routes[result.routeId];
      if (route) { route.nodes = route.nodes.filter(n => !result.deletedNodeIds.includes(n.id)); redrawPolyline(result.routeId); }
    }
  } catch (e) { alert('Failed to delete node: ' + e.message); }
}

async function deleteSelectedNode() {
  if (!selectedNodeId) return;
  const nodeId = selectedNodeId;
  await deleteNode(nodeId);
  undoStack = undoStack.filter(id => id !== nodeId);
  updateUndoBtn();
}

async function undoLastNode() {
  // Skip any nodes that were already deleted another way (e.g. via Delete Node button)
  while (undoStack.length > 0) {
    const nodeId = undoStack.pop();
    if (nodeRouteId[nodeId] !== undefined) {
      await deleteNode(nodeId);
      break;
    }
  }
  updateUndoBtn();
}

async function addNodeToRoute(routeId, lat, lng, poiId) {
  try {
    const node = await api('POST', `/routes/${routeId}/nodes`, {
      lat, lng, poiId: poiId || null, prepend: extendingFromStart,
    });
    node.route_id = routeId;
    const route = routes[routeId];
    if (extendingFromStart) route.nodes.unshift(node); else route.nodes.push(node);
    nodeRouteId[node.id] = routeId;

    const marker = L.marker([node.lat, node.lng], {
      icon: nodeIcon(node, false), draggable: false, zIndexOffset: 200,
    }).addTo(map);
    setupNodeMarkerEvents(marker, node);
    routeNodeMarkers[node.id] = marker;
    if (routeEditMode) enableNodeDrag(marker);
    undoStack.push(node.id);
    updateUndoBtn();

    // Create polyline on first node; update otherwise
    if (route.nodes.length === 1) {
      routePolylines[routeId] = L.polyline([[lat, lng]], {
        color: route.color, weight: 10, opacity: 0.5, pane: 'routesPane',
      }).addTo(map);
    } else {
      redrawPolyline(routeId);
    }
  } catch (e) { console.error('Failed to add node:', e); }
}

async function handleRouteMapClick(e) {
  if (selectedNodeId) deselectNode();
  if (waitingForRouteStart) await createNewRouteAndActivate();
  if (!activeRouteId) return;
  addNodeToRoute(activeRouteId, e.latlng.lat, e.latlng.lng, null);
}

// In regular edit mode: clicking an unlinked node opens the new-POI dialog
// pre-positioned at the node. After creation the node is linked to the new POI.
function createPoiAtNode(node) {
  pendingNodeForPoi = node;
  openNewPoiDialog({ lat: node.lat, lng: node.lng });
}

async function addNodeAtPoi(poiId) {
  if (waitingForRouteStart) {
    const hit = findLinkedStartEndNode(poiId);
    if (hit) {
      // Extend the existing route from this end
      activeRouteId = hit.route.id;
      extendingFromStart = (hit.route.nodes[0].id === hit.node.id);
      waitingForRouteStart = false;
      setActiveRoute(activeRouteId);
      updateRouteHint();
      return;
    }
    // New route, first node linked to this POI
    await createNewRouteAndActivate();
  }
  if (!activeRouteId) return;
  const poi = pois[poiId];
  if (!poi) return;
  addNodeToRoute(activeRouteId, poi.lat, poi.lng, poiId);
}

// ── Route edit event wiring ───────────────────────────────────────────────────

$('btn-tracking').addEventListener('click', () => setTrackingMode(!trackingMode));

window.addEventListener('resize', updateTrackingLayout);

// tracking-prev / tracking-next / tracking-pause are wired by trackingViewer (createPhotoDisplay)
$('tracking-photo-wrap').addEventListener('click', () => {
  if (!trackingPoiId || !trackingViewer.photos.length) return;
  const poi = pois[trackingPoiId];
  if (poi) openLightbox(poi, trackingViewer.index);
});

$('btn-enter-route-edit').addEventListener('click', () => {
  if (routeEditMode) exitRouteEditMode(); else enterRouteEditMode();
});

$('dir1-name-input').addEventListener('change', async () => {
  if (!currentRoute) return;
  const val = $('dir1-name-input').value.trim();
  try {
    await api('PUT', `/routes/${currentRoute.id}`, { dir1Name: val });
    currentRoute.dir1_name = val;
  } catch (e) { console.error('Failed to save dir1Name', e); }
});
$('dir2-name-input').addEventListener('change', async () => {
  if (!currentRoute) return;
  const val = $('dir2-name-input').value.trim();
  try {
    await api('PUT', `/routes/${currentRoute.id}`, { dir2Name: val });
    currentRoute.dir2_name = val;
  } catch (e) { console.error('Failed to save dir2Name', e); }
});


// Whenever the colour picker is invoked (either by direct click on the input or
// programmatically via routeColorInput.click() from the mobile menu), arm the
// suppress flag so the dismiss tap on mobile doesn't reach the map.
routeColorInput.addEventListener('click', () => { suppressNextMapClick = true; });
routeColorInput.addEventListener('input', () => {
  // A real colour selection fired — no dismiss click to suppress.
  suppressNextMapClick = false;
  if (!selectedNodeId) return;
  const routeId = nodeRouteId[selectedNodeId];
  if (!routeId) return;
  const color = routeColorInput.value;
  if (routes[routeId]) routes[routeId].color = color;
  routePolylines[routeId]?.setStyle({ color });
});
routeColorInput.addEventListener('change', async () => {
  if (!selectedNodeId) return;
  const routeId = nodeRouteId[selectedNodeId];
  if (!routeId) return;
  try { await api('PUT', `/routes/${routeId}`, { color: routeColorInput.value }); }
  catch (e) { console.error('Failed to save colour', e); }
});

async function splitSelectedRoute() {
  if (!selectedNodeId) return;
  const routeId = nodeRouteId[selectedNodeId];
  if (!routeId) return;
  const nodeId = selectedNodeId;
  deselectNode();
  try {
    const result = await api('POST', `/routes/${routeId}/split`, { nodeId });

    // Remove split node
    if (routeNodeMarkers[nodeId]) { map.removeLayer(routeNodeMarkers[nodeId]); delete routeNodeMarkers[nodeId]; }
    delete nodeRouteId[nodeId];
    undoStack = undoStack.filter(id => id !== nodeId);

    // Remove deleted head node markers
    for (const id of result.deletedHeadNodeIds) {
      if (routeNodeMarkers[id]) { map.removeLayer(routeNodeMarkers[id]); delete routeNodeMarkers[id]; }
      delete nodeRouteId[id];
    }

    // Remove deleted tail node markers
    for (const id of result.deletedTailNodeIds) {
      if (routeNodeMarkers[id]) { map.removeLayer(routeNodeMarkers[id]); delete routeNodeMarkers[id]; }
      delete nodeRouteId[id];
      undoStack = undoStack.filter(uid => uid !== id);
    }

    if (result.headDeleted) {
      if (routePolylines[routeId]) { map.removeLayer(routePolylines[routeId]); delete routePolylines[routeId]; }
      delete routes[routeId];
      if (activeRouteId === routeId) activeRouteId = null;
    } else {
      const route = routes[routeId];
      if (route) {
        const tailIds = new Set(result.newRoute ? result.newRoute.nodes.map(n => n.id) : result.deletedTailNodeIds);
        route.nodes = route.nodes.filter(n => n.id !== nodeId && !tailIds.has(n.id));
        redrawPolyline(routeId);
      }
    }

    if (result.newRoute) {
      // Clear stale markers for tail nodes before re-rendering
      for (const n of result.newRoute.nodes) {
        if (routeNodeMarkers[n.id]) { map.removeLayer(routeNodeMarkers[n.id]); delete routeNodeMarkers[n.id]; }
        delete nodeRouteId[n.id];
      }
      routes[result.newRoute.id] = result.newRoute;
      renderRoute(result.newRoute);
      if (routeEditMode) {
        for (const n of result.newRoute.nodes) {
          const m = routeNodeMarkers[n.id];
          if (m) enableNodeDrag(m);
        }
      }
    }

    updateUndoBtn();
  } catch (e) { alert('Split failed: ' + e.message); }
}

async function deleteSelectedRoute() {
  if (!selectedNodeId) return;
  const routeId = nodeRouteId[selectedNodeId];
  if (!routeId) return;
  if (!confirm('Delete this entire route?')) return;
  deselectNode();
  try {
    await api('DELETE', `/routes/${routeId}`);
    clearRoute(routeId);
    delete routes[routeId];
    if (activeRouteId === routeId) activeRouteId = null;
    undoStack = undoStack.filter(id => nodeRouteId[id] !== undefined);
    updateUndoBtn();
  } catch (e) { alert('Delete route failed: ' + e.message); }
}

btnDeleteNode.addEventListener('click', deleteSelectedNode);
$('btn-undo-node').addEventListener('click', undoLastNode);
btnSplitRoute.addEventListener('click', splitSelectedRoute);
btnDeleteRoute.addEventListener('click', deleteSelectedRoute);

document.addEventListener('keydown', (e) => {
  if (!routeEditMode) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'Delete') { e.preventDefault(); deleteSelectedNode(); }
  if (e.key === 'z' && e.ctrlKey) { e.preventDefault(); undoLastNode(); }
});

// ── Tracking mode ────────────────────────────────────────────────────────────

function setTrackingMode(on) {
  trackingMode = on;
  $('btn-tracking').classList.toggle('active', on);
  $('crosshair').classList.toggle('hidden', !on);
  if (on && !editMode) {
    updateTrackingLayout();
    updateTrackingDisplay();
  } else {
    $('tracking-panel').classList.add('hidden');
    document.body.classList.remove('tracking-portrait', 'tracking-landscape');
  }
  syncMobileMenu();
}

function updateTrackingLayout() {
  updateToolbarHeightVar();
  if (!trackingMode || editMode) return;
  const portrait = window.innerHeight > window.innerWidth;
  document.body.classList.toggle('tracking-portrait', portrait);
  document.body.classList.toggle('tracking-landscape', !portrait);
}

function updateToolbarHeightVar() {
  const h = document.getElementById('toolbar').offsetHeight;
  document.documentElement.style.setProperty('--toolbar-height', h + 'px');
}
updateToolbarHeightVar();

function getPoiAtCrosshair() {
  const sz = map.getSize();
  let cx = sz.x / 2, cy = sz.y / 2;
  if (document.body.classList.contains('tracking-portrait'))  cy = sz.y * 3 / 4;
  if (document.body.classList.contains('tracking-landscape')) cx = sz.x * 3 / 4;
  const crosshair = map.containerPointToLatLng([cx, cy]);
  const THRESHOLD_METERS = 20;
  let closest = null, minDist = THRESHOLD_METERS;
  for (const poi of Object.values(pois)) {
    if (shouldHidePoi(poi)) continue;
    const d = map.distance(crosshair, [poi.lat, poi.lng]);
    if (d < minDist) { minDist = d; closest = poi; }
  }
  return closest;
}

function updateTrackingDisplay() {
  if (!trackingMode || editMode) return;
  const poi = getPoiAtCrosshair();
  const newId = poi ? poi.id : null;
  if (newId === trackingPoiId) return;
  trackingPoiId = newId;
  if (poi) {
    updateCurrentRouteForPoi(poi);
    renderTrackingPanel(poi);
  } else {
    clearTrackingPanel();
  }
}

function renderTrackingPanel(poi) {
  $('tracking-empty').classList.add('hidden');
  $('tracking-content').classList.remove('hidden');
  $('tracking-panel').classList.remove('hidden');
  trackingViewer.open(lightboxPhotosFor(poi), 0);
  $('tracking-title').textContent = poi.title || '';
  $('tracking-note').textContent = poi.note || '';
  $('tracking-info').classList.toggle('hidden', !poi.title && !poi.note);
}

function clearTrackingPanel() {
  trackingViewer.close();
  $('tracking-panel').classList.add('hidden');
}

// ── Direction preference ──────────────────────────────────────────────────────

function sortedPhotos(poi) {
  if (!directionPref || !poi.photos || !poi.photos.length) return poi.photos || [];
  return [...poi.photos].sort((a, b) => {
    const aMatch = a.direction === directionPref ? 0 : 1;
    const bMatch = b.direction === directionPref ? 0 : 1;
    return aMatch - bMatch;
  });
}

function shouldHidePoi(poi) {
  if (editMode) return false;
  if (!directionPref) return false;
  if (!poi.photos || poi.photos.length === 0) return false;
  // Hide only if every photo has a direction set AND all are the opposite direction
  return poi.photos.every(ph => ph.direction && ph.direction !== directionPref);
}

function reapplyDirectionFilter() {
  for (const poi of Object.values(pois)) {
    addOrUpdateMarker(poi);  // removes if hidden, adds/updates if visible
  }
}

function updateDirPrefButtons() {
  const names = [1, 2].map(d => {
    const name = d === 1 ? currentRoute?.dir1_name : currentRoute?.dir2_name;
    return name ? `To: ${name}` : String(d);
  });
  document.querySelectorAll('#dir-pref .dir-btn').forEach(btn => {
    const d = btn.dataset.dir ? Number(btn.dataset.dir) : 0;
    btn.classList.toggle('active', d === directionPref);
    if (d === 1 || d === 2) btn.textContent = names[d - 1];
  });
  const sel = $('dir-pref-select');
  sel.value = directionPref ? String(directionPref) : '';
  sel.options[1].text = names[0];
  sel.options[2].text = names[1];
}

function initDirPref() {
  const saved = localStorage.getItem('directionPref');
  directionPref = saved ? Number(saved) : 0;
  updateDirPrefButtons();
}

$('dir-pref').addEventListener('click', (e) => {
  const btn = e.target.closest('.dir-btn');
  if (!btn) return;
  directionPref = btn.dataset.dir ? Number(btn.dataset.dir) : 0;
  localStorage.setItem('directionPref', directionPref);
  updateDirPrefButtons();
  reapplyDirectionFilter();
});
$('dir-pref-select').addEventListener('change', (e) => {
  directionPref = e.target.value ? Number(e.target.value) : 0;
  localStorage.setItem('directionPref', directionPref);
  updateDirPrefButtons();
  reapplyDirectionFilter();
});

// ── Mobile menu ───────────────────────────────────────────────────────────────
function syncMobileMenu() {
  const pairs = [
    ['mob-tracking', 'btn-tracking'],
    ['mob-edit-mode', 'btn-edit-mode'],
    ['mob-bulk-upload', 'btn-bulk-upload'],
    ['mob-enter-route-edit', 'btn-enter-route-edit'],
    ['mob-logout', 'btn-logout'],
  ];
  for (const [mobId, deskId] of pairs) {
    const desk = $(deskId), mob = $(mobId);
    mob.classList.toggle('hidden', desk.classList.contains('hidden'));
    mob.textContent = desk.textContent;
    mob.classList.toggle('active', desk.classList.contains('active'));
  }
}

$('btn-mobile-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('mobile-menu');
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (opening) syncMobileMenu();
});

['mob-tracking', 'mob-edit-mode', 'mob-bulk-upload', 'mob-enter-route-edit', 'mob-logout'].forEach(id => {
  $(id).addEventListener('click', () => {
    $('mobile-menu').classList.add('hidden');
    $(id.replace('mob-', 'btn-')).click();
  });
});

// ── Route-edit mobile menu ────────────────────────────────────────────────────
const ROUTE_EDIT_MENU_PAIRS = [
  ['mob-split-route',  'btn-split-route'],
  ['mob-delete-route', 'btn-delete-route'],
  ['mob-delete-node',  'btn-delete-node'],
  ['mob-undo-node',    'btn-undo-node'],
];
function syncRouteEditMenu() {
  for (const [mobId, deskId] of ROUTE_EDIT_MENU_PAIRS) {
    $(mobId).disabled = $(deskId).disabled;
  }
  const colourBtn = $('mob-route-color');
  colourBtn.disabled = routeColorInput.disabled;
  colourBtn.querySelector('.mobile-menu-swatch').style.background = routeColorInput.value;
}
$('btn-route-edit-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('route-edit-menu');
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if (opening) syncRouteEditMenu();
});
for (const [mobId, deskId] of ROUTE_EDIT_MENU_PAIRS) {
  $(mobId).addEventListener('click', () => {
    $('route-edit-menu').classList.add('hidden');
    if (!$(deskId).disabled) $(deskId).click();
  });
}
$('mob-route-color').addEventListener('click', () => {
  $('route-edit-menu').classList.add('hidden');
  if (!routeColorInput.disabled) routeColorInput.click();
});
$('mob-done-route-edit').addEventListener('click', () => {
  $('route-edit-menu').classList.add('hidden');
  $('btn-enter-route-edit').click();
});
$('btn-edit-routes-shortcut').addEventListener('click', () => $('btn-enter-route-edit').click());

document.addEventListener('click', () => {
  $('mobile-menu').classList.add('hidden');
  $('route-edit-menu').classList.add('hidden');
});

// ── Init ──────────────────────────────────────────────────────────────────────
initLayerSwitcher();
initDirPref();
if (window.innerWidth <= 768) setTrackingMode(true);
(async () => {
  await Promise.all([checkAuth(), loadPois(), loadRoutes()]);
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('hidden');
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  if (trackingMode) updateTrackingDisplay();
})();
