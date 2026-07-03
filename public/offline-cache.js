/* ── Offline-cache prefetch manager ──────────────────────────────────────────
 * Registers the service worker (sw.js) and, while Track mode is on, keeps a
 * radius around the walker's position cached: tiles for the active layer
 * (map zooms 12–16), plus full-size photos and thumbnails of every POI in
 * range. Entering Track mode prefetches a 2 km radius; a 5-minute review
 * loop then keeps 1 km topped up. When a signal drop-out is detected the
 * loop polls faster (45 s) so the cache refills the moment signal returns.
 *
 * The page writes straight into the same Cache Storage caches the service
 * worker reads from (names and key normalisation shared via tile-math.js),
 * so prefetch works even before the worker controls the page.
 *
 * app.js wires this up: init(hooks) once at startup, then setTracking /
 * noteLayerChange / notePoisChanged from the corresponding state changes.
 */
window.OfflineCache = (() => {
  'use strict';

  const INITIAL_RADIUS_M = 2000;
  const REVIEW_RADIUS_M = 1000;
  const MONITOR_INTERVAL_MS = 5 * 60 * 1000;
  const OFFLINE_INTERVAL_MS = 45 * 1000;
  const PREFETCH_ZOOMS = [12, 13, 14, 15, 16];
  const FETCH_TIMEOUT_MS = 10 * 1000; // weak-signal fetches can hang, not fail
  const OFFLINE_AFTER_FAILURES = 5;   // consecutive network errors that end a pass

  const supported = 'caches' in window && !window.Cypress;

  let hooks = null;        // { getActiveLayerName, getFallbackLatLng, getPois, refreshPoiPhotoUrls, getProjectId }
  let tracking = false;
  let offline = false;     // last pass hit a drop-out
  let timer = null;
  let nextDueAt = 0;
  let passAbort = null;    // AbortController of the in-flight pass (single-flight)
  let pendingReview = null; // review requested mid-pass, e.g. {full:true} on layer change

  // ── Status UI ──────────────────────────────────────────────────────────────
  const statusEl = () => document.getElementById('offline-status');

  function showStatus(text, badge) {
    const el = statusEl();
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('offline-badge', !!badge);
    el.classList.remove('hidden');
  }

  function hideStatus() {
    const el = statusEl();
    if (el) el.classList.add('hidden');
  }

  // ── Position ───────────────────────────────────────────────────────────────
  // GPS when available; otherwise the crosshair / map centre supplied by
  // app.js — in Track mode the map is centred on the walker anyway.
  function getPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(hooks.getFallbackLatLng());
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => resolve(hooks.getFallbackLatLng()),
        { maximumAge: 60000, timeout: 8000, enableHighAccuracy: false }
      );
    });
  }

  // ── Fetch pool ─────────────────────────────────────────────────────────────
  // Jobs: { key, getUrl(), cache, photo }. getUrl is re-read on retry so a
  // presign refresh mid-pass takes effect. Returns pass statistics; bails out
  // early after OFFLINE_AFTER_FAILURES consecutive network errors so a dead
  // connection doesn't burn through hundreds of doomed fetches.
  async function fetchJobs(jobs, concurrency, signal, onProgress) {
    let idx = 0;
    let fetched = 0;
    let failed = 0;
    let consecutiveErrors = 0;
    let refreshedUrls = false;

    async function fetchWithTimeout(url, mode) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal.addEventListener('abort', onAbort);
      const timeout = setTimeout(onAbort, FETCH_TIMEOUT_MS);
      try {
        return await fetch(url, { mode, signal: ctrl.signal });
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
      }
    }

    async function runJob(job, isRetry) {
      let resp;
      try {
        resp = await fetchWithTimeout(job.getUrl(), 'cors');
      } catch (e) {
        if (signal.aborted) throw e;
        if (!job.photo) throw e;
        // Photos may sit on an S3 bucket without CORS: an opaque copy still
        // displays in <img>, so fall back rather than fail.
        resp = await fetchWithTimeout(job.getUrl(), 'no-cors');
      }
      consecutiveErrors = 0;
      if (job.photo && resp.status === 403 && !isRetry) {
        // Presigned URL expired mid-walk: refresh once per pass, then retry
        // this job with the new URL.
        if (!refreshedUrls) {
          refreshedUrls = true;
          await hooks.refreshPoiPhotoUrls();
        }
        return runJob(job, true);
      }
      if (resp.ok || resp.type === 'opaque') {
        await job.cache.put(job.key, resp.clone()).catch(() => {});
        fetched++;
      } else {
        failed++;
      }
    }

    async function worker() {
      while (idx < jobs.length && !signal.aborted && consecutiveErrors < OFFLINE_AFTER_FAILURES) {
        const job = jobs[idx++];
        try {
          await runJob(job, false);
        } catch (e) {
          if (signal.aborted) return;
          failed++;
          consecutiveErrors++;
        }
        if (onProgress) onProgress(fetched + failed);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    return { fetched, failed, brokeOff: consecutiveErrors >= OFFLINE_AFTER_FAILURES };
  }

  // Refresh the cached API data (POIs, routes, projects, config) so an
  // offline reload mid-walk boots with current data. Done explicitly from the
  // page because on the very first visit the startup fetches race ahead of
  // the service worker taking control, leaving the api cache empty; it also
  // keeps the cached POI set opportunistically fresh on every review.
  async function refreshApiCache(signal) {
    const apiCache = await caches.open(TileMath.CACHES.api);
    const shellCache = await caches.open(TileMath.CACHES.shell);
    const project = hooks.getProjectId();
    const q = project != null ? '?project=' + encodeURIComponent(project) : '';
    const targets = [
      { cache: apiCache, url: '/api/pois' + q },
      { cache: apiCache, url: '/api/routes' + q },
      { cache: apiCache, url: '/api/projects' },
      { cache: shellCache, url: '/config.js' },
    ];
    for (const t of targets) {
      try {
        const resp = await fetch(t.url, { signal });
        if (resp.ok) await t.cache.put(t.url, resp);
      } catch (e) { /* offline — the tile/photo pool below will notice */ }
    }
  }

  // ── One prefetch pass ──────────────────────────────────────────────────────
  // Builds the tile + photo want-lists for radiusM around the current
  // position, fetches what's missing, and reports whether the network looked
  // dead. Single-flight: a second call while one runs is coalesced by the
  // caller via rerunAfterPass.
  async function runPass(radiusM, showProgress) {
    passAbort = new AbortController();
    const signal = passAbort.signal;
    try {
      const { lat, lng } = await getPosition();
      if (signal.aborted) return null;

      await refreshApiCache(signal);

      const tileCache = await caches.open(TileMath.CACHES.tiles);
      const photoCache = await caches.open(TileMath.CACHES.photos);

      const provider = TileMath.PROVIDERS[hooks.getActiveLayerName()];
      const maptilerKey = (window.APP_CONFIG || {}).maptilerKey || '';
      const tileJobs = [];
      if (provider && !(provider.id === 'nls' && !maptilerKey)) {
        TileMath.tilesForRadius(lat, lng, radiusM, PREFETCH_ZOOMS, provider).forEach((t, i) => {
          const subdomain = provider.subdomains.length
            ? provider.subdomains[i % provider.subdomains.length]
            : '';
          const url = TileMath.tileUrl(provider, t, { subdomain, key: maptilerKey });
          tileJobs.push({
            cache: tileCache,
            key: `/__tile/${provider.id}/${t.z}/${t.x}/${t.y}`,
            getUrl: () => url,
          });
        });
      }

      const photoJobs = [];
      const pois = hooks.getPois();
      for (const id in pois) {
        const poi = pois[id];
        if (TileMath.haversineMeters(lat, lng, poi.lat, poi.lng) > radiusM) continue;
        for (const ph of poi.photos || []) {
          // Re-read ph on retry: refreshPoiPhotoUrls updates url/thumb_url
          // in place when a presigned URL has expired.
          const variants = [
            () => ph.url || '/uploads/originals/' + ph.filename,
            () => ph.thumb_url || '/uploads/thumbs/' + ph.thumb_filename,
          ];
          for (const getUrl of variants) {
            const key = TileMath.normalisePhotoKey(getUrl());
            if (key) photoJobs.push({ cache: photoCache, key, getUrl, photo: true });
          }
        }
      }

      const missing = [];
      for (const job of [...tileJobs, ...photoJobs]) {
        if (signal.aborted) return null;
        if (!(await job.cache.match(job.key))) missing.push(job);
      }

      if (!missing.length) return { missing: 0, fetched: 0, offline: false };

      let done = 0;
      const onProgress = showProgress
        ? () => showStatus(`Caching map for offline… ${++done}/${missing.length}`)
        : null;
      if (showProgress) showStatus(`Caching map for offline… 0/${missing.length}`);

      const missingTiles = missing.filter((j) => !j.photo);
      const missingPhotos = missing.filter((j) => j.photo);
      const tileStats = await fetchJobs(
        missingTiles, provider ? provider.politeConcurrency : 2, signal, onProgress);
      const photoStats = signal.aborted
        ? { fetched: 0, failed: 0, brokeOff: false }
        : await fetchJobs(missingPhotos, 4, signal, onProgress);

      navigator.serviceWorker?.controller?.postMessage({ type: 'trim' });

      const fetched = tileStats.fetched + photoStats.fetched;
      return {
        missing: missing.length,
        fetched,
        offline: (tileStats.brokeOff || photoStats.brokeOff) && fetched === 0,
      };
    } catch (e) {
      console.warn('Offline-cache pass failed', e);
      return { missing: 0, fetched: 0, offline: !navigator.onLine };
    } finally {
      passAbort = null;
      if (showProgress) hideStatus();
    }
  }

  // ── Review loop ────────────────────────────────────────────────────────────
  function schedule(ms) {
    clearTimeout(timer);
    nextDueAt = Date.now() + ms;
    timer = setTimeout(review, ms);
  }

  function updateBadge() {
    if (tracking && offline) showStatus('Offline — using cached map', true);
    else hideStatus();
  }

  async function review(opts = {}) {
    if (!tracking || !supported) return;
    if (passAbort) { pendingReview = { full: !!(opts.initial || opts.full) }; return; } // coalesce
    clearTimeout(timer);

    // After a drop-out (or on entry / layer or project change) top up the
    // full 2 km; routine reviews keep 1 km around the walker.
    const radius = opts.initial || opts.full || offline ? INITIAL_RADIUS_M : REVIEW_RADIUS_M;
    const result = await runPass(radius, !!opts.initial);
    if (!tracking) return;

    offline = !!(result && result.offline);
    updateBadge();
    if (pendingReview) {
      const next = pendingReview;
      pendingReview = null;
      review(next);
      return;
    }
    schedule(offline ? OFFLINE_INTERVAL_MS : MONITOR_INTERVAL_MS);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function init(h) {
    hooks = h;
    if (!supported) return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((e) =>
        console.warn('Service worker registration failed', e));
    }
    // Ask the browser not to evict our caches under storage pressure
    // (best-effort; a no-op on iOS).
    navigator.storage?.persist?.().catch(() => {});

    window.addEventListener('online', () => {
      if (tracking && offline) review();
    });
    window.addEventListener('offline', () => {
      offline = true;
      updateBadge();
      if (tracking) schedule(OFFLINE_INTERVAL_MS);
    });
    // Mobile browsers throttle background timers; catch up when the tab
    // returns to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && tracking && Date.now() >= nextDueAt) review();
    });
  }

  function setTracking(on) {
    if (!hooks || !supported || on === tracking) return;
    tracking = on;
    if (on) {
      review({ initial: true });
    } else {
      clearTimeout(timer);
      timer = null;
      if (passAbort) passAbort.abort();
      pendingReview = null;
      offline = false;
      hideStatus();
    }
  }

  // Active tile layer changed: cache the new layer's tiles as soon as we can.
  function noteLayerChange() {
    if (tracking) review({ full: true });
  }

  // POIs/routes were reloaded (project switch): cache the new set.
  function notePoisChanged() {
    if (tracking) review({ full: true });
  }

  return { init, setTracking, noteLayerChange, notePoisChanged };
})();
