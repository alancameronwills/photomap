const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
if (ADMIN_PASSWORD === 'changeme') {
  console.warn('WARNING: Using default password. Set ADMIN_PASSWORD environment variable before exposing to the internet.');
}

// Permitted OAuth users (comma-separated emails in PERMITTED_USERS env var)
const permittedUsers = new Set(
  (process.env.PERMITTED_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

function isPermitted(email) {
  if (!email || !permittedUsers.size) return false;
  return permittedUsers.has(email.toLowerCase());
}

// Derive the app's base URL from the incoming request (works locally and on Lambda)
function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Exchange an OAuth authorization code for tokens
async function exchangeCode(tokenUrl, params) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || body.error || `HTTP ${res.status}`);
  return body;
}

// Decode a JWT payload without verifying the signature (provider already verified it over HTTPS)
function jwtPayload(token) {
  const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
}

// ── Password login ────────────────────────────────────────────────────────────

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session error' });
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────

router.get('/google', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(404).end();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  await saveSession(req);
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${baseUrl(req)}/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/google/callback', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(404).end();
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) return res.redirect('/?login_error=state');
  delete req.session.oauthState;
  try {
    const tokens = await exchangeCode('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${baseUrl(req)}/auth/google/callback`,
      grant_type:    'authorization_code',
    });
    const { email } = jwtPayload(tokens.id_token);
    if (!isPermitted(email)) return res.redirect('/?login_error=forbidden');
    req.session.authenticated = true;
    await saveSession(req);
    res.redirect('/');
  } catch (e) {
    console.error('Google OAuth error:', e.message);
    res.redirect('/?login_error=auth');
  }
});

// ── Microsoft OAuth ───────────────────────────────────────────────────────────

router.get('/microsoft', async (req, res) => {
  if (!process.env.MICROSOFT_CLIENT_ID) return res.status(404).end();
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  await saveSession(req);
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    redirect_uri:  `${baseUrl(req)}/auth/microsoft/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    state,
    response_mode: 'query',
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

router.get('/microsoft/callback', async (req, res) => {
  if (!process.env.MICROSOFT_CLIENT_ID) return res.status(404).end();
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) return res.redirect('/?login_error=state');
  delete req.session.oauthState;
  try {
    const tokens = await exchangeCode('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      code,
      client_id:     process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      redirect_uri:  `${baseUrl(req)}/auth/microsoft/callback`,
      grant_type:    'authorization_code',
      scope:         'openid email profile',
    });
    const payload = jwtPayload(tokens.id_token);
    const email = payload.email || payload.preferred_username;
    if (!isPermitted(email)) return res.redirect('/?login_error=forbidden');
    req.session.authenticated = true;
    await saveSession(req);
    res.redirect('/');
  } catch (e) {
    console.error('Microsoft OAuth error:', e.message);
    res.redirect('/?login_error=auth');
  }
});

module.exports = router;
