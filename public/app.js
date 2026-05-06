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
const map = L.map('map', {
  center: [54, -2],
  zoom: 6,
  layers: [TILE_LAYERS['OpenStreetMap']],
  zoomControl: false,
});

L.control.zoom({ position: 'bottomright' }).addTo(map);

// ── Layer switcher ────────────────────────────────────────────────────────────
// activeLayerName  — the layer the user has chosen (persists through aerial fallback)
// aerialFallback   — true while auto-showing aerial because zoom > activeLayer.maxZoom
let activeLayerName = 'OpenStreetMap';
let aerialFallback = false;

function displayedLayerName() {
  return aerialFallback ? 'Aerial (ESRI)' : activeLayerName;
}

function updateLayerButtons() {
  const displayed = displayedLayerName();
  document.getElementById('layer-switcher').querySelectorAll('.layer-btn').forEach(btn => {
    const name = btn.dataset.layer;
    btn.classList.toggle('active', name === displayed);
    // 'fallback' marks the intended layer while aerial is covering for it
    btn.classList.toggle('fallback', aerialFallback && name === activeLayerName);
  });
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

function initLayerSwitcher() {
  const container = document.getElementById('layer-switcher');
  Object.keys(TILE_LAYERS).forEach(name => {
    const btn = document.createElement('button');
    btn.dataset.layer = name;
    btn.className = 'layer-btn' + (name === activeLayerName ? ' active' : '');
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener('click', () => {
      const currently = displayedLayerName();
      if (name === currently && name === activeLayerName) return;
      map.removeLayer(TILE_LAYERS[currently]);
      map.addLayer(TILE_LAYERS[name]);
      activeLayerName = name;
      aerialFallback = false;
      updateLayerButtons();
      // Immediately re-check: if already zoomed past this layer's limit, fall back again
      handleZoomForLayer();
    });
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
let authenticated = false;
let pois = {};           // id → poi object
let markers = {};        // id → Leaflet marker
let activePoi = null;    // currently previewed/opened POI
let newPoiLatLng = null; // temp latlng for new POI from map click
let pendingNewFiles = []; // FileList accumulated for new POI dialog
let lightboxImages = [];
let lightboxIndex = 0;

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const btnEditMode    = $('btn-edit-mode');
const btnLogout      = $('btn-logout');
const loginOverlay   = $('login-overlay');
const loginPassword  = $('login-password');
const loginError     = $('login-error');
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
    btnEditMode.classList.add('active');
    btnLogout.classList.remove('hidden');
    setEditMode(true);
  }
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
}

// ── Edit mode ────────────────────────────────────────────────────────────────
function setEditMode(on) {
  editMode = on;
  editIndicator.classList.toggle('hidden', !on);
  btnEditMode.classList.toggle('active', on);
  document.getElementById('map').classList.toggle('edit-active', on);

  // Toggle marker draggability and icon style
  for (const [id, marker] of Object.entries(markers)) {
    if (on) marker.dragging.enable(); else marker.dragging.disable();
    marker.setIcon(createMarkerIcon(pois[id]));
  }

  btnEditPoi.classList.toggle('hidden', !on);
}

// ── Marker creation ──────────────────────────────────────────────────────────
function createMarkerIcon(poi) {
  if (poi.photos && poi.photos.length > 0) {
    const thumb = poi.photos[0].thumb_filename;
    const editCls = editMode ? ' edit-mode' : '';
    return L.divIcon({
      html: `<div class="photo-marker${editCls}"><img src="/uploads/thumbs/${thumb}" alt="" draggable="false"/></div>`,
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
  if (markers[poi.id]) {
    clusterGroup.removeLayer(markers[poi.id]);
  }

  const marker = L.marker([poi.lat, poi.lng], {
    icon: createMarkerIcon(poi),
    draggable: editMode,
    title: poi.title || '',
  });

  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    if (editMode) {
      openEditDialog(poi.id);
    } else {
      showPreview(poi.id);
    }
  });

  marker.on('dragend', async (e) => {
    const latlng = e.target.getLatLng();
    try {
      const updated = await api('PUT', `/pois/${poi.id}`, { lat: latlng.lat, lng: latlng.lng });
      pois[poi.id] = updated;
    } catch (err) {
      console.error('Failed to update POI location', err);
    }
  });

  markers[poi.id] = marker;
  clusterGroup.addLayer(marker);
}

function removeMarker(poiId) {
  if (markers[poiId]) {
    clusterGroup.removeLayer(markers[poiId]);
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
      img.src = `/uploads/originals/${ph.filename}`;
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

  fullPhotos.innerHTML = '';
  if (poi.photos && poi.photos.length > 0) {
    poi.photos.forEach((ph, idx) => {
      const img = document.createElement('img');
      img.src = `/uploads/originals/${ph.filename}`;
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
function openLightbox(poi, startIdx) {
  lightboxImages = poi.photos.map(ph => `/uploads/originals/${ph.filename}`);
  lightboxIndex = startIdx;
  lightboxImg.src = lightboxImages[lightboxIndex];
  lightbox.classList.remove('hidden');
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
}

function lightboxNav(dir) {
  lightboxIndex = (lightboxIndex + dir + lightboxImages.length) % lightboxImages.length;
  lightboxImg.src = lightboxImages[lightboxIndex];
}

// ── Edit dialog ──────────────────────────────────────────────────────────────
let editingPoiId = null;
let pendingEditFiles = [];

function openEditDialog(poiId) {
  const poi = pois[poiId];
  if (!poi) return;
  editingPoiId = poiId;
  pendingEditFiles = [];

  editTitleInput.value = poi.title || '';
  editNoteInput.value = poi.note || '';

  renderEditPhotosList(poi);

  $('edit-modal-title').textContent = poi.title ? `Edit: ${poi.title}` : 'Edit Point of Interest';
  editOverlay.classList.remove('hidden');
  closePreview();
}

function renderEditPhotosList(poi) {
  editPhotosList.innerHTML = '';
  if (!poi.photos) return;
  poi.photos.forEach(ph => {
    const item = document.createElement('div');
    item.className = 'edit-photo-item';
    item.innerHTML = `
      <img src="/uploads/thumbs/${ph.thumb_filename}" alt=""/>
      <button class="delete-photo-btn" data-photo-id="${ph.id}" title="Delete photo">&#x2715;</button>
    `;
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

    // Upload any new photos (scaled client-side)
    if (pendingEditFiles.length > 0) {
      const scaled = await Promise.all(pendingEditFiles.map(f => scaleImageFile(f)));
      const fd = new FormData();
      scaled.forEach(f => fd.append('photos', f));
      const result = await api('POST', `/pois/${editingPoiId}/photos`, fd);
      pois[editingPoiId] = result;
      addOrUpdateMarker(result);
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
    await api('DELETE', `/pois/${editingPoiId}`);
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

  const fd = new FormData();
  scaled.forEach(f => fd.append('photos', f));
  fd.append('mapLat', center.lat);
  fd.append('mapLng', center.lng);
  if (Object.keys(gpsMap).length) fd.append('gpsData', JSON.stringify(gpsMap));

  try {
    // Simulate progress
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress = Math.min(progress + 5, 85);
      uploadFill.style.width = progress + '%';
    }, 200);

    const result = await api('POST', '/upload-photos', fd);

    clearInterval(progressInterval);
    uploadFill.style.width = '100%';

    // Update local POI store and markers
    for (const poi of result.pois) {
      pois[poi.id] = poi;
      addOrUpdateMarker(poi);
    }

    // Zoom to fit all new POI locations
    if (result.pois.length > 0) {
      const latlngs = result.pois.map(p => [p.lat, p.lng]);
      if (latlngs.length === 1) {
        map.setView(latlngs[0], Math.max(map.getZoom(), 16));
      } else {
        map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
      }
    }

    setTimeout(hideUploadToast, 1200);
    uploadToastMsg.textContent = `Added ${result.pois.length} location${result.pois.length !== 1 ? 's' : ''}`;
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

// Map click in edit mode
map.on('click', (e) => {
  if (editMode) {
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
  if (e.target === lightbox || e.target === lightboxImg) closeLightbox();
});
$('lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(-1); });
$('lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(1); });

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

// ── Init ──────────────────────────────────────────────────────────────────────
initLayerSwitcher();
(async () => {
  await Promise.all([checkAuth(), loadPois()]);
})();
