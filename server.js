/*
 * Simple Node.js server for the Bexio calendar UI.
 *
 * This server serves the static HTML/JS files from the `public` directory and
 * provides a thin API proxy to the Bexio REST API.  The proxy functions
 * handle authentication (Bearer token) and avoid exposing secrets to the
 * browser.  To use the server, set the following environment variables:
 *
 *   BEXIO_TOKEN   – access token obtained via OAuth 2.0 (see README.md)
 *   PORT          – optional; defaults to 3000
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const host = env.HOST || '127.0.0.1';
  const portText = env.PORT || '3000';
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(portText);

  if (env.TRUST_PROXY && !['true', 'false'].includes(env.TRUST_PROXY)) {
    throw new Error('TRUST_PROXY must be either true or false');
  }
  const trustProxy = env.TRUST_PROXY === 'true';
  if (trustProxy && host !== '127.0.0.1') {
    throw new Error('TRUST_PROXY=true requires HOST=127.0.0.1');
  }

  if (isProduction && !env.APP_BASE_URL) {
    throw new Error('APP_BASE_URL is required in production');
  }
  const appBaseUrlText = env.APP_BASE_URL || `http://${host}:${port}`;
  let appBaseUrl;
  try {
    appBaseUrl = new URL(appBaseUrlText);
  } catch (_) {
    throw new Error('APP_BASE_URL must be a valid absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(appBaseUrl.protocol) || appBaseUrl.username ||
      appBaseUrl.password || appBaseUrl.search || appBaseUrl.hash ||
      !appBaseUrl.hostname || !['', '/'].includes(appBaseUrl.pathname)) {
    throw new Error('APP_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  if (isProduction && appBaseUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use HTTPS in production');
  }

  const idleText = env.SESSION_IDLE_TIMEOUT_MS || '1800000';
  const absoluteText = env.SESSION_ABSOLUTE_TIMEOUT_MS || '43200000';
  if (!/^\d+$/.test(idleText) || !/^\d+$/.test(absoluteText)) {
    throw new Error('Session timeouts must be positive integer milliseconds');
  }
  const sessionIdleMs = Number(idleText);
  const sessionAbsoluteMs = Number(absoluteText);
  if (!Number.isSafeInteger(sessionIdleMs) || sessionIdleMs <= 0 ||
      !Number.isSafeInteger(sessionAbsoluteMs) || sessionAbsoluteMs <= sessionIdleMs) {
    throw new Error('SESSION_ABSOLUTE_TIMEOUT_MS must exceed a positive SESSION_IDLE_TIMEOUT_MS');
  }

  return Object.freeze({
    nodeEnv,
    isProduction,
    host,
    port,
    appBaseUrl: appBaseUrl.origin,
    oauthRedirectUri: new URL('/auth/callback', appBaseUrl.origin).href,
    secureCookies: appBaseUrl.protocol === 'https:',
    trustProxy,
    sessionIdleMs,
    sessionAbsoluteMs,
  });
}

const CONFIG = loadConfig();

// OAuth2.0 configuration. To use personal API tokens for trusted local
// development, set BEXIO_TOKEN. Otherwise supply OAuth client configuration.

const BEXIO_TOKEN = process.env.BEXIO_TOKEN || '';
const BEXIO_CLIENT_ID = process.env.BEXIO_CLIENT_ID || '';
const BEXIO_CLIENT_SECRET = process.env.BEXIO_CLIENT_SECRET || '';
const BEXIO_REDIRECT_URI = CONFIG.oauthRedirectUri;

// Scopes requested during OAuth login.  Can be overridden via env.
const BEXIO_SCOPES = process.env.BEXIO_SCOPES ||
  'openid offline_access pr_project_show timesheet_show timesheet_edit client_service_show timesheet_status_show';

// Optional: default user ID for timesheet creation.  Set BEXIO_USER_ID in
// .env to automatically assign the current user when creating timesheets.
const BEXIO_USER_ID = process.env.BEXIO_USER_ID || '';
const IS_PRODUCTION = CONFIG.isProduction;
const SESSION_IDLE_MS = CONFIG.sessionIdleMs;
const SESSION_ABSOLUTE_MS = CONFIG.sessionAbsoluteMs;
const configuredSessionSecret = process.env.SESSION_SECRET || '';

if (IS_PRODUCTION && configuredSessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production');
}
if (IS_PRODUCTION && BEXIO_TOKEN) {
  throw new Error('BEXIO_TOKEN shared-auth mode is not permitted in production; configure OAuth');
}
// Development may use an ephemeral signing key. Production must provide a
// stable high-entropy secret so cookie signatures survive process restarts.
const SESSION_SECRET = configuredSessionSecret || crypto.randomBytes(32).toString('hex');

// In‑memory storage for access/refresh tokens and expiry for a single user.
// This object previously stored the globally authenticated user's tokens.
// To enforce per‑user sessions, we avoid updating this object during
// OAuth login.  It remains here only for compatibility with the personal
// API token (BEXIO_TOKEN) and as an optional fallback when explicitly
// configured.  Do NOT store access tokens for authenticated users here.
const oauthTokens = {
  access_token: null,
  refresh_token: null,
  expires_at: 0, // epoch ms
  user_id: null,
};

// Session store for multiple authenticated users.  Each session is keyed by a
// random session ID string and holds the access token, refresh token,
// expiry timestamp and user_id for that user.  When a user logs in via
// /auth/callback, a new session is created and stored here.  Subsequent
// API requests identify the session via a `session_id` cookie.  In a
// production environment, consider using a persistent store.
const sessions = Object.create(null);
const loginAttempts = new Map();

const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (now >= session.absolute_expires_at || now - session.last_seen_at >= SESSION_IDLE_MS) {
      delete sessions[sessionId];
    }
  }
}, Math.min(SESSION_IDLE_MS, 5 * 60 * 1000));
sessionCleanupTimer.unref();

function allowLoginAttempt(req, now = Date.now()) {
  const key = req.socket.remoteAddress || 'unknown';
  const windowMs = 15 * 60 * 1000;
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    loginAttempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 20;
}

// Parse cookies from the request headers.  Returns an object mapping
// cookie names to values.  If no cookies are present, returns {}.
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts[0].trim();
    const val = parts.slice(1).join('=').trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(val);
      } catch (_) {
        // Ignore malformed cookie values.
      }
    }
  });
  return cookies;
}

function signValue(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function signedSessionCookie(sessionId) {
  return `${sessionId}.${signValue(sessionId)}`;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readSessionId(req) {
  const value = parseCookies(req.headers.cookie || '').session_id;
  if (!value) return null;
  const separator = value.lastIndexOf('.');
  if (separator < 1) return null;
  const sessionId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signValue(sessionId);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return sessionId;
}

function cookieAttributes(maxAgeSeconds, secure = CONFIG.secureCookies) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function createSession(values, now = Date.now()) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  sessions[sessionId] = {
    ...values,
    created_at: now,
    last_seen_at: now,
    absolute_expires_at: now + SESSION_ABSOLUTE_MS,
  };
  return sessionId;
}

function destroySession(req) {
  const sessionId = readSessionId(req);
  if (sessionId) delete sessions[sessionId];
  return sessionId;
}

// Get the session object associated with the request.  Looks for a
// `session_id` cookie and returns the corresponding session from
// `sessions`.  If no session exists, returns null.  Does not create
// sessions.
function getSession(req) {
  const sid = readSessionId(req);
  const session = sid && sessions[sid];
  if (!session) return null;
  const now = Date.now();
  if (now >= session.absolute_expires_at || now - session.last_seen_at >= SESSION_IDLE_MS) {
    delete sessions[sid];
    return null;
  }
  session.last_seen_at = now;
  return session;
}

function isAuthenticated(req) {
  // Personal-token mode is retained for trusted local development only and
  // is prohibited by the production startup checks above.
  return Boolean(BEXIO_TOKEN || getSession(req));
}

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  const forwardedHttps = CONFIG.trustProxy && req.headers['x-forwarded-proto'] === 'https';
  if (IS_PRODUCTION && (req.socket.encrypted || forwardedHttps)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function isSameOriginRequest(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients; browsers send Origin for these requests.
  const forwardedProto = CONFIG.trustProxy ? req.headers['x-forwarded-proto'] : null;
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return origin === `${protocol}://${req.headers.host}`;
}

// Obtain an access token for the current request.  This checks for a
// personal token first, then for a session token associated with the
// request.  If the session token is expired and a refresh token is
// available, attempts to refresh it.  If no valid token can be found,
// throws an error.  This function does not support global oauthTokens
// except as a fallback when no session exists.
async function getAccessTokenFromSession(req) {
  // Use personal token if provided
  if (BEXIO_TOKEN) return BEXIO_TOKEN;
  // Use session token if available
  const session = getSession(req);
  if (session) {
    // If not expired, return access token
    if (Date.now() < session.expires_at) {
      return session.access_token;
    }
    // Attempt to refresh using the session's refresh token
    if (session.refresh_token && BEXIO_CLIENT_ID && BEXIO_CLIENT_SECRET) {
      await refreshAccessTokenForSession(session);
      return session.access_token;
    }
  }
  // Do not fall back to global oauthTokens here.  If no valid session
  // exists and no personal token is provided, the user must log in.
  throw new Error('Not authenticated. Please login via /auth/login');
}

// Refresh the session's access token using its refresh token.  Updates the
// session object with the new access token, refresh token and expiry.
async function refreshAccessTokenForSession(session) {
  if (!session || !session.refresh_token) {
    throw new Error('No refresh token available');
  }
  const params = new URLSearchParams();
  params.append('client_id', BEXIO_CLIENT_ID);
  params.append('client_secret', BEXIO_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', session.refresh_token);
  const response = await fetch(
    'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token refresh error: ${response.status} ${response.statusText} – ${text}`,
    );
  }
  const json = await response.json();
  session.access_token = json.access_token;
  session.refresh_token = json.refresh_token || session.refresh_token;
  session.expires_at = Date.now() + (json.expires_in || 3600) * 1000 - 5 * 60 * 1000;
}

/**
 * Returns the current access token.  If the personal token is set, that
 * takes precedence.  Otherwise uses the OAuth token if available and not
 * expired.  If expired, attempts to refresh it using the refresh token.
 */
async function getAccessToken() {
  // Prefer personal token if provided.
  if (BEXIO_TOKEN) return BEXIO_TOKEN;
  // Check if token exists.
  if (oauthTokens.access_token) {
    // If not expired, return.
    if (Date.now() < oauthTokens.expires_at) {
      return oauthTokens.access_token;
    }
    // Try to refresh if refresh token exists
    if (oauthTokens.refresh_token && BEXIO_CLIENT_ID && BEXIO_CLIENT_SECRET) {
      try {
        await refreshAccessToken();
        return oauthTokens.access_token;
      } catch (err) {
        console.error('Failed to refresh token:', err.message);
      }
    }
  }
  throw new Error('Not authenticated. Please login via /auth/login');
}

/**
 * Refreshes the access token using the stored refresh token.
 */
async function refreshAccessToken() {
  if (!oauthTokens.refresh_token) {
    throw new Error('No refresh token available');
  }
  const params = new URLSearchParams();
  params.append('client_id', BEXIO_CLIENT_ID);
  params.append('client_secret', BEXIO_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', oauthTokens.refresh_token);
  const response = await fetch(
    'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Token refresh error: ${response.status} ${response.statusText} – ${text}`,
    );
  }
  const json = await response.json();
  oauthTokens.access_token = json.access_token;
  oauthTokens.refresh_token = json.refresh_token || oauthTokens.refresh_token;
  // Set expiry a bit earlier than actual expiry to avoid edge cases
  oauthTokens.expires_at = Date.now() + (json.expires_in || 3600) * 1000 - 5 * 60 * 1000;
}

// Read static files into memory on startup for faster responses.
const STATIC_ROOT = path.join(__dirname, 'public');
const cache = {};

function serveStatic(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  if (cache[filePath]) {
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(cache[filePath]);
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    cache[filePath] = data;
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Helper to perform API requests to Bexio.
async function bexioRequest(method, endpoint, queryParams = {}, body = null, req = null) {
  // Determine which access token to use (personal, session or OAuth).  When
  // a request object is provided, attempt to use the session token for that
  // request.  Otherwise fall back to a global or personal token.  This
  // ensures per‑user sessions are respected.
  let token;
  try {
    token = req ? await getAccessTokenFromSession(req) : await getAccessToken();
  } catch (err) {
    // If session retrieval fails, fall back to global token
    token = await getAccessToken();
  }
  const baseUrl = 'https://api.bexio.com/2.0';
  // Build query string.
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `${baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Bexio API error: ${response.status} ${response.statusText} – ${text}`,
    );
  }
  return response.json();
}

// Helper for API version 3.0 requests.  Some endpoints (e.g. project packages)
// exist only in v3.0.  This function bypasses the default v2.0 base URL and
// constructs the full URL manually.  It accepts a path relative to the v3
// base (e.g. '/projects/{id}/packages') and query parameters.  It uses the
// same bearer token as bexioRequest.  Errors are thrown on non‑OK responses.
async function bexioRequestV3(method, endpoint, queryParams = {}, body = null, req = null) {
  // Use a session token when available for v3 requests.  Fall back to a global token
  // if session retrieval fails.
  let token;
  try {
    token = req ? await getAccessTokenFromSession(req) : await getAccessToken();
  } catch (err) {
    token = await getAccessToken();
  }
  const baseUrl = 'https://api.bexio.com/3.0';
  const queryString = new URLSearchParams(queryParams).toString();
  const url = `${baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Bexio API v3 error: ${response.status} ${response.statusText} – ${text}`,
    );
  }
  return response.json();
}

// Parse JSON body of request.
function parseBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let received = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBytes) {
        tooLarge = true;
        const error = new Error('Request body too large');
        error.statusCode = 413;
        reject(error);
        req.resume();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) {
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (e) {
        const error = new Error('Malformed JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
  });
}

function validId(value, optional = false) {
  if (optional && (value === '' || value === null || value === undefined)) return true;
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value));
}

function validateTimesheetBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Request body must be a JSON object');
    error.statusCode = 400;
    throw error;
  }
  for (const field of ['client_service_id', 'status_id']) {
    if (!validId(body[field])) {
      const error = new Error(`${field} must be a positive numeric ID`);
      error.statusCode = 400;
      throw error;
    }
  }
  for (const field of ['pr_project_id', 'pr_package_id', 'contact_id', 'sub_contact_id', 'user_id']) {
    if (!validId(body[field], true)) {
      const error = new Error(`${field} must be a numeric ID or empty`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (body.text !== undefined && (typeof body.text !== 'string' || body.text.length > 2000)) {
    const error = new Error('text must be a string of at most 2000 characters');
    error.statusCode = 400;
    throw error;
  }
  const tracking = body.tracking;
  if (!tracking || typeof tracking !== 'object' || Array.isArray(tracking) || tracking.type !== 'range' ||
      typeof tracking.start !== 'string' || typeof tracking.end !== 'string' ||
      !Number.isFinite(Date.parse(tracking.start)) || !Number.isFinite(Date.parse(tracking.end)) ||
      Date.parse(tracking.end) <= Date.parse(tracking.start)) {
    const error = new Error('tracking must contain a valid range with start before end');
    error.statusCode = 400;
    throw error;
  }
  return {
    pr_project_id: body.pr_project_id || null,
    client_service_id: body.client_service_id,
    pr_package_id: body.pr_package_id || null,
    status_id: body.status_id,
    text: body.text || '',
    tracking: { type: 'range', start: tracking.start, end: tracking.end },
    contact_id: body.contact_id || null,
    sub_contact_id: body.sub_contact_id || null,
    ...(body.user_id ? { user_id: body.user_id } : {}),
    ...(typeof body.allowable_bill === 'boolean' ? { allowable_bill: body.allowable_bill } : {}),
  };
}

const TIMESHEET_PAGE_SIZE = 500;

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

// Bexio orders timesheets by their top-level date. Tracking data is retained
// as a fallback for older/mixed records, but records without a usable date are
// ignored rather than allowed to break range filtering or pagination.
function getTimesheetDate(timesheet) {
  const value = timesheet?.date || timesheet?.tracking?.date || timesheet?.tracking?.start;
  if (typeof value !== 'string') return null;
  const dateOnly = value.slice(0, 10);
  return isValidDateOnly(dateOnly) ? dateOnly : null;
}

async function fetchTimesheetsInRange(requestPage, startDate, endDate, pageSize = TIMESHEET_PAGE_SIZE) {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate) || startDate > endDate) {
    throw new TypeError('Invalid timesheet date range');
  }

  const result = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await requestPage({
      order_by: 'date_desc',
      limit: pageSize,
      offset,
    });
    if (!Array.isArray(page)) {
      throw new TypeError('Expected Bexio /timesheet to return an array');
    }
    if (page.length === 0) break;

    let passedRequestedRange = false;
    for (const timesheet of page) {
      const date = getTimesheetDate(timesheet);
      if (!date) continue;
      if (date < startDate) {
        passedRequestedRange = true;
        continue;
      }
      if (date <= endDate) result.push(timesheet);
    }

    if (passedRequestedRange || page.length < pageSize) break;
  }
  return result;
}

const server = http.createServer(async (req, res) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
  applySecurityHeaders(req, res);
  const requestUrl = new URL(req.url, 'http://localhost');
  const pathname = requestUrl.pathname;
  const parsedUrl = { query: Object.fromEntries(requestUrl.searchParams) };

  // OAuth login route.  Redirects the user to the Bexio auth page.  Only
  // enabled when client credentials are supplied.
  if (pathname === '/auth/login' && req.method === 'GET') {
    if (!allowLoginAttempt(req)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '900' });
      res.end('Too many authentication attempts');
      return;
    }
    if (!BEXIO_CLIENT_ID || !BEXIO_CLIENT_SECRET) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('OAuth configuration missing. Please set BEXIO_CLIENT_ID and BEXIO_CLIENT_SECRET.');
      return;
    }
    // Build authorization URL
    const params = new URLSearchParams();
    params.append('client_id', BEXIO_CLIENT_ID);
    params.append('response_type', 'code');
    params.append('redirect_uri', BEXIO_REDIRECT_URI);
    params.append('scope', BEXIO_SCOPES);
    const state = crypto.randomBytes(32).toString('base64url');
    params.append('state', state);
    const authUrl = `https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth?${params.toString()}`;
    // Redirect user to Bexio login
    res.writeHead(302, {
      Location: authUrl,
      'Set-Cookie': `oauth_state=${state}.${signValue(state)}; ${cookieAttributes(600)}`,
    });
    res.end();
    return;
  }

  // OAuth callback route.  Handles the authorization code and exchanges it for tokens.
  if (pathname === '/auth/callback' && req.method === 'GET') {
    if (!allowLoginAttempt(req)) {
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '900' });
      res.end('Too many authentication attempts');
      return;
    }
    const { code, state } = parsedUrl.query;
    const stateCookie = parseCookies(req.headers.cookie || '').oauth_state || '';
    const separator = stateCookie.lastIndexOf('.');
    const cookieState = separator > 0 ? stateCookie.slice(0, separator) : '';
    const cookieSignature = separator > 0 ? stateCookie.slice(separator + 1) : '';
    const validState = safeEqual(state, cookieState) && safeEqual(cookieSignature, signValue(cookieState));
    if (!code || !validState) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid authentication response');
      return;
    }
    try {
      // Exchange code for token
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('client_id', BEXIO_CLIENT_ID);
      params.append('client_secret', BEXIO_CLIENT_SECRET);
      params.append('code', code);
      params.append('redirect_uri', BEXIO_REDIRECT_URI);
      const tokenRes = await fetch(
        'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        },
      );
      if (!tokenRes.ok) {
        throw new Error(`Token exchange failed with status ${tokenRes.status}`);
      }
      const json = await tokenRes.json();
      if (!json || typeof json.access_token !== 'string' || json.access_token.length === 0) {
        throw new Error('Token response did not contain an access token');
      }
      // Create a new session for this user.  Generate a simple random
      // identifier and store the tokens, expiry and user_id in the sessions
      // object.  Also update the global oauthTokens as a fallback for
      // environments where sessions are not used.
      destroySession(req);
      const newSessionId = createSession({
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in || 3600) * 1000 - 5 * 60 * 1000,
        user_id: null,
      });
      // Do not update global oauthTokens here.  Per‑user sessions should be
      // independent, and storing the token globally would cause all users
      // to share the same credentials.  The oauthTokens object is only
      // updated when a personal API token is used or when explicitly
      // configured via environment variables.
      // Attempt to fetch user info to determine the current user ID.  This is optional
      // and may fail silently.  The user info endpoint returns the subject (sub)
      // identifier or id for the authenticated user.  The user_id is stored on
      // oauthTokens.user_id and later used when creating timesheets.
      try {
        const userInfoRes = await fetch(
          'https://auth.bexio.com/realms/bexio/protocol/openid-connect/userinfo',
          {
            headers: { Authorization: `Bearer ${json.access_token}` },
          },
        );
        if (userInfoRes.ok) {
          const userInfo = await userInfoRes.json();
          // Prefer explicit id if available, otherwise use sub
          const uid = userInfo.id || userInfo.sub || null;
      // Store the user_id in the session.  We do not update the global
      // oauthTokens.user_id to avoid leaking the user identity across
      // sessions.
      sessions[newSessionId].user_id = uid;
        }
      } catch (userErr) {
        console.warn('Failed to fetch user info:', userErr.message);
      }
      // Set a cookie with the new session id.  HttpOnly prevents client side
      // JavaScript from reading the cookie.  The cookie lasts for the same
      // duration as the access token (approx) but could be adjusted.
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          `session_id=${signedSessionCookie(newSessionId)}; ${cookieAttributes(Math.floor(SESSION_ABSOLUTE_MS / 1000))}`,
          `oauth_state=; ${cookieAttributes(0)}`,
        ],
      });
      console.info('Authentication succeeded');
      res.end();
      return;
    } catch (err) {
      console.warn('Authentication failed');
      res.writeHead(502, {
        'Content-Type': 'text/plain',
        'Set-Cookie': `oauth_state=; ${cookieAttributes(0)}`,
      });
      res.end('Authentication failed');
      return;
    }
  }

  if (pathname === '/logout' && req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-site request rejected' }));
      return;
    }
    const destroyed = destroySession(req);
    res.writeHead(204, {
      'Set-Cookie': `session_id=; ${cookieAttributes(0)}`,
      'Cache-Control': 'no-store',
    });
    if (destroyed) console.info('Session logged out');
    res.end();
    return;
  }

  // Auth status route.  Returns JSON with authentication state.
  if (pathname === '/api/authStatus' && req.method === 'GET') {
    // Determine if this request has a valid session or global token.  A
    // session is considered authenticated if the session cookie exists and
    // the access token is not expired.  If using a personal token or the
    // global oauthTokens is still valid, authenticate as well.  The
    // response indicates whether the current request is authenticated.
    const authenticated = isAuthenticated(req);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ authenticated }));
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (!isAuthenticated(req)) {
      console.warn('Unauthenticated API request rejected');
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isSameOriginRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cross-site request rejected' }));
      return;
    }
  }

  try {
    // API routes
    if (pathname === '/api/projects' && req.method === 'GET') {
      // Search projects; optional `q` parameter for search term.
      const q = parsedUrl.query.q || '';
      if (typeof q !== 'string' || q.length > 100) {
        const error = new Error('q must be at most 100 characters');
        error.statusCode = 400;
        throw error;
      }
      const data = await bexioRequest('GET', '/pr_project', q ? { search_term: q } : {}, null, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } else if (pathname === '/api/activities' && req.method === 'GET') {
      const data = await bexioRequest('GET', '/client_service', {}, null, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } else if (pathname === '/api/statuses' && req.method === 'GET') {
      const data = await bexioRequest('GET', '/timesheet_status', {}, null, req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } else if (pathname.startsWith('/api/projects/') && req.method === 'GET') {
      // Fetch details for a single project by ID.  Extract the numeric ID from
      // the path (/api/projects/{id}).  Use the v2.0 endpoint /pr_project/{id}
      // which returns the contact_id and contact_sub_id.  If the project is
      // not found or the user lacks permissions, propagate the error.
      const parts = pathname.split('/');
      const id = parts[3];
      if (!validId(id)) {
        res.writeHead(400);
        res.end('Missing project id');
        return;
      }
      try {
        const data = await bexioRequest('GET', `/pr_project/${id}`, {}, null, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        throw err;
      }
      return;
    } else if (pathname.startsWith('/api/contacts/') && req.method === 'GET') {
      // Fetch details for a single contact by ID (v2.0).  This requires the
      // contact_show scope.  Return the contact object directly.  If the
      // request is forbidden (403), propagate the error to the client.
      const parts = pathname.split('/');
      const id = parts[3];
      if (!validId(id)) {
        res.writeHead(400);
        res.end('Missing contact id');
        return;
      }
      try {
        const data = await bexioRequest('GET', `/contact/${id}`, {}, null, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        throw err;
      }
      return;
    } else if (pathname === '/api/packages' && req.method === 'GET') {
      // Get work packages; requires project_id query param.  If the Bexio API
      // returns 404 Not Found for this project, treat as no packages and
      // return an empty array instead of propagating the error.  Otherwise
      // propagate the error as usual.
      const projectId = parsedUrl.query.project_id;
      if (!validId(projectId)) {
        res.writeHead(400);
        res.end('Missing project_id');
        return;
      }
      try {
        // Try the v3.0 project packages endpoint first.  This returns
        // packages for the given project.  If it fails (e.g. not found),
        // fall back to the v2.0 pr_package endpoint.  Also ensure that
        // duplicates are removed.  Log the packages for debugging.
        let data = [];
        try {
          data = await bexioRequestV3('GET', `/projects/${projectId}/packages`, {}, null, req);
        } catch (errV3) {
          // Fall back to v2.0 if v3.0 endpoint fails (e.g. 404 or not available)
          try {
            const params = { project_id: projectId, pr_project_id: projectId };
            data = await bexioRequest('GET', '/pr_package', params, null, req);
          } catch (errV2) {
            const msg = errV2 && errV2.message ? errV2.message : '';
            if (msg.includes('404')) {
              data = [];
            } else {
              throw errV2;
            }
          }
        }
        // Remove duplicate packages by id
        const unique = Object.create(null);
        data.forEach((pkg) => {
          unique[pkg.id] = pkg;
        });
        const result = Object.values(unique);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = err && err.message ? err.message : '';
        if (msg.includes('404')) {
          // No packages found for this project – return empty array
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        } else {
          throw err;
        }
      }
      return;
    } else if (pathname === '/api/timesheets' && req.method === 'GET') {
      // Bexio's GET /timesheet does not support date filters. Fetch newest
      // records first and stop paging once the requested range has been passed.
      const { start_date, end_date, user_id, project_id } = parsedUrl.query;
      let data;
      if (start_date || end_date) {
        if (!start_date || !end_date || !isValidDateOnly(start_date) ||
            !isValidDateOnly(end_date) || start_date > end_date) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'start_date and end_date must be a valid YYYY-MM-DD range' }));
          return;
        }
        data = await fetchTimesheetsInRange(
          (params) => bexioRequest('GET', '/timesheet', params, null, req),
          start_date,
          end_date,
        );
      } else {
        // Preserve the existing unbounded behavior for callers that omit a range.
        const params = {};
        if (user_id) params.user_id = user_id;
        if (project_id) params.project_id = project_id;
        data = await bexioRequest('GET', '/timesheet', params, null, req);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    } else if (pathname === '/api/timesheets' && req.method === 'POST') {
      const body = validateTimesheetBody(await parseBody(req));
      // If user_id not provided, use default from environment.  Some Bexio
      // installations require user_id and allowable_bill fields to be set when
      // creating timesheets.  Provide reasonable defaults if missing.
      // Determine user id from OAuth token or environment.  Use in order of precedence:
      // 1. Provided in request body
      // 2. oauthTokens.user_id captured during OAuth flow
      // 3. BEXIO_USER_ID environment variable
      if (!body.user_id) {
        // Use the user_id from the current session if available
        const session = getSession(req);
        if (session && session.user_id) {
          body.user_id = session.user_id;
        } else if (oauthTokens.user_id) {
          // Fall back to the user_id captured from the first OAuth login only if
          // no session user_id exists.  Note: oauthTokens.user_id is no longer
          // updated on subsequent logins.
          body.user_id = oauthTokens.user_id;
        } else if (BEXIO_USER_ID) {
          body.user_id = BEXIO_USER_ID;
        }
      }
      // Convert user_id to a number if it's a numeric string.  Bexio API
      // expects user_id to be an integer.  If user_id is non-numeric, leave
      // as-is.  This prevents errors like "user_id: Diese Eingabe ist nicht korrekt".
      if (typeof body.user_id === 'string' && /^\d+$/.test(body.user_id)) {
        body.user_id = parseInt(body.user_id, 10);
      }
      if (body.allowable_bill === undefined) {
        body.allowable_bill = true;
      }
      try {
        const data = await bexioRequest('POST', '/timesheet', {}, body, req);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        // Forward error details to client
        throw err;
      }
      return;
    } else if (pathname.startsWith('/api/timesheets/') && (req.method === 'PUT' || req.method === 'POST')) {
      const id = pathname.split('/')[3];
      if (!validId(id)) {
        const error = new Error('Invalid timesheet id');
        error.statusCode = 400;
        throw error;
      }
      const body = validateTimesheetBody(await parseBody(req));
      // Provide default user_id and allowable_bill if missing
      // Determine user id from request body or OAuth token or env
      if (!body.user_id) {
        // Use the user_id from the current session if available
        const session = getSession(req);
        if (session && session.user_id) {
          body.user_id = session.user_id;
        } else if (oauthTokens.user_id) {
          // Fall back to the user_id captured from the first OAuth login only
          body.user_id = oauthTokens.user_id;
        } else if (BEXIO_USER_ID) {
          body.user_id = BEXIO_USER_ID;
        }
      }
      // Convert user_id to a number if it's a numeric string.  Bexio API
      // expects user_id to be an integer.  Leave non-numeric values unchanged.
      if (typeof body.user_id === 'string' && /^\d+$/.test(body.user_id)) {
        body.user_id = parseInt(body.user_id, 10);
      }
      if (body.allowable_bill === undefined) {
        body.allowable_bill = true;
      }
      try {
        // Use POST to update an existing timesheet.  Bexio's API expects
        // timesheet updates via a POST request to /timesheet/{id}, not PUT.
        const data = await bexioRequest('POST', `/timesheet/${id}`, {}, body, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        throw err;
      }
      return;
    } else if (pathname.startsWith('/api/timesheets/') && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      if (!validId(id)) {
        const error = new Error('Invalid timesheet id');
        error.statusCode = 400;
        throw error;
      }
      const data = await bexioRequest('DELETE', `/timesheet/${id}`, {}, null, req);
      res.writeHead(204);
      res.end();
      return;
    }
  } catch (error) {
    const status = error.statusCode || (error.message === 'Not authenticated. Please login via /auth/login' ? 401 : 502);
    if (status >= 500) console.error('Request failed');
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: status >= 500 ? 'Upstream service request failed' : error.message }));
    return;
  }

  // Serve static files
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }
  let filePath = pathname;
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }
  try {
    filePath = decodeURIComponent(filePath);
  } catch (_) {
    res.writeHead(400);
    res.end('Invalid path');
    return;
  }
  filePath = path.resolve(STATIC_ROOT, `.${filePath}`);
  if (filePath !== STATIC_ROOT && !filePath.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  serveStatic(filePath, res);
});

const PORT = CONFIG.port;
const HOST = CONFIG.host;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  CONFIG,
  loadConfig,
  server,
  sessions,
  createSession,
  signedSessionCookie,
  cookieAttributes,
  fetchTimesheetsInRange,
  getTimesheetDate,
  isValidDateOnly,
};
