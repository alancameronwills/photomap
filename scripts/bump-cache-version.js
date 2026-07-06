#!/usr/bin/env node
/* Bump the service-worker cache version so a deploy always invalidates stale
 * caches (app shell, tiles, photos, API). Run automatically before every deploy
 * (see the `deploy` npm script and scripts/deploy.sh).
 *
 * Rewrites the CACHE_VERSION literal in public/tile-math.js to a fresh UTC
 * timestamp (vYYYYMMDDHHMMSS) — always unique and monotonic, so the SW's
 * activate handler drops every cache from the previous deploy.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'tile-math.js');
const RE = /(const CACHE_VERSION = ')([^']*)(';)/;

const src = fs.readFileSync(FILE, 'utf8');
const m = src.match(RE);
if (!m) {
  console.error('bump-cache-version: could not find CACHE_VERSION in', FILE);
  process.exit(1);
}

const now = new Date();
const p = (n, w = 2) => String(n).padStart(w, '0');
const next = `v${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
  `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;

fs.writeFileSync(FILE, src.replace(RE, `$1${next}$3`));
console.log(`CACHE_VERSION: ${m[2]} -> ${next}`);
