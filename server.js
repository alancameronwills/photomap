const express = require('express');
const session = require('express-session');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Session store ─────────────────────────────────────────────────────────────
// On AWS: DynamoDB-backed store (SESSIONS_TABLE env var set by SAM).
// Locally: default in-memory store (fine for single-server use).

let sessionStore;
if (process.env.SESSIONS_TABLE) {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

  class DynamoDBSessionStore extends session.Store {
    constructor(table) {
      super();
      this.table = table;
      this.ttl = 7 * 24 * 3600;
      this.client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    get(sid, cb) {
      this.client.send(new GetCommand({ TableName: this.table, Key: { id: sid } }))
        .then(({ Item }) => {
          if (!Item) return cb(null, null);
          if (Item.expires && Item.expires < Math.floor(Date.now() / 1000)) return cb(null, null);
          let sess;
          try { sess = JSON.parse(Item.sess); }
          catch { return cb(null, null); } // corrupt row → treat as no session, don't 500 every request
          cb(null, sess);
        }).catch(cb);
    }
    set(sid, sess, cb) {
      const expires = Math.floor(Date.now() / 1000) + this.ttl;
      this.client.send(new PutCommand({ TableName: this.table, Item: { id: sid, sess: JSON.stringify(sess), expires } }))
        .then(() => cb(null)).catch(cb);
    }
    destroy(sid, cb) {
      this.client.send(new DeleteCommand({ TableName: this.table, Key: { id: sid } }))
        .then(() => cb(null)).catch(cb);
    }
  }
  sessionStore = new DynamoDBSessionStore(process.env.SESSIONS_TABLE);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'photomap-dev-secret',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Config endpoint ───────────────────────────────────────────────────────────

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({
    maptilerKey:   process.env.MAPTILER_KEY        || '',
    googleAuth:    !!process.env.GOOGLE_CLIENT_ID,
    microsoftAuth: !!process.env.MICROSOFT_CLIENT_ID,
  })};`);
});

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Browsers must revalidate the service worker on every load, or a stale
    // sw.js (heuristically cached by the browser or API Gateway) can pin old
    // caching logic for hours after a deploy.
    if (filePath.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
  },
}));

if (process.env.PHOTOS_BUCKET) {
  // AWS: redirect /uploads/* to the photo's stable public S3 URL. Photos are
  // served from a public-read bucket (see PhotomapBucketPolicy in template.yaml),
  // so no presigning is needed. The API already returns these URLs directly on
  // POIs; this route is only a fallback (e.g. GPX/KML export links).
  const region = process.env.AWS_REGION || 'eu-west-2';
  const base = `https://${process.env.PHOTOS_BUCKET}.s3.${region}.amazonaws.com`;
  app.use('/uploads', (req, res) => {
    const key = req.path.replace(/^\//, '');
    if (!key) return res.status(404).end();
    res.redirect(302, `${base}/${key}`);
  });
} else {
  // Local: ensure upload dirs exist and serve statically
  const fs = require('fs');
  ['uploads/originals', 'uploads/thumbs'].forEach(d => {
    const full = path.join(__dirname, d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  });
  app.use('/uploads', require('express').static(path.join(__dirname, 'uploads')));
}

app.use('/vendor/leaflet',       express.static(path.join(__dirname, 'node_modules/leaflet/dist')));
app.use('/vendor/markercluster', express.static(path.join(__dirname, 'node_modules/leaflet.markercluster/dist')));
app.use('/vendor/exifr',         express.static(path.join(__dirname, 'node_modules/exifr/dist')));
app.use('/vendor/heic2any',      express.static(path.join(__dirname, 'node_modules/heic2any/dist')));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

// ── JSON error handler ────────────────────────────────────────────────────────
// The API's async handlers are wrapped so their rejections reach here, and multer
// / body-parser surface their own errors here too. Without this, Express emits its
// default HTML error page, which the client's res.json() then fails to parse. We
// always answer with JSON and a sensible status.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err.status || err.statusCode ||
    (err.name === 'MulterError' ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : 500);
  if (status >= 500) console.error('Unhandled request error:', err);
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

// ── Start (skipped in Lambda — lambda.js provides the handler) ────────────────

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`PhotoMap running at http://localhost:${PORT}`);
    console.log(`Edit mode password: ${process.env.ADMIN_PASSWORD || 'changeme'}`);
  });
}

module.exports = { app };
