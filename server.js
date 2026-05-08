const express = require('express');
const session = require('express-session');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
          cb(null, JSON.parse(Item.sess));
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

app.use(express.static(path.join(__dirname, 'public')));

if (process.env.PHOTOS_BUCKET) {
  // AWS: redirect /uploads/* to S3 via a presigned URL
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({});
  app.use('/uploads', async (req, res) => {
    try {
      const key = req.path.replace(/^\//, '');
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.PHOTOS_BUCKET, Key: key }), { expiresIn: 3600 });
      res.redirect(302, url);
    } catch (e) { res.status(404).end(); }
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

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

// ── Start (skipped in Lambda — lambda.js provides the handler) ────────────────

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`PhotoMap running at http://localhost:${PORT}`);
    console.log(`Edit mode password: ${process.env.ADMIN_PASSWORD || 'changeme'}`);
  });
}

module.exports = { app };
