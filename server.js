const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure upload directories exist
['uploads/originals', 'uploads/thumbs'].forEach(d => {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'photomap-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// Expose selected env vars to the frontend (no secrets beyond what's needed for tiles)
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ maptilerKey: process.env.MAPTILER_KEY || '' })};`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/markercluster', express.static(path.join(__dirname, 'node_modules/leaflet.markercluster/dist')));
app.use('/vendor/exifr', express.static(path.join(__dirname, 'node_modules/exifr/dist')));

app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));

app.listen(PORT, () => {
  console.log(`PhotoMap running at http://localhost:${PORT}`);
  console.log(`Edit mode password: ${process.env.ADMIN_PASSWORD || 'changeme'}`);
});
