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
const url = require('url');

// OAuth2.0 configuration.  To use personal API tokens instead of OAuth, set
// BEXIO_TOKEN.  Otherwise supply the client credentials and redirect URI.
// Load environment variables from a .env file if present.  We avoid requiring
// an external dependency such as 'dotenv' by reading the file manually.  If
// 'dotenv' is installed, we still prefer to use it; otherwise fallback.
try {
  // Attempt to load dotenv if available (install via `npm install dotenv`)
  const dotenv = require('dotenv');
  dotenv.config();
} catch (err) {
  // Fallback: simple .env parser.  Reads key=value pairs line by line.
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) {
        const key = m[1];
        let val = m[2].trim();
        // Remove surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val;
      }
    });
  }
}

const BEXIO_TOKEN = process.env.BEXIO_TOKEN || '';
const BEXIO_CLIENT_ID = process.env.BEXIO_CLIENT_ID || '';
const BEXIO_CLIENT_SECRET = process.env.BEXIO_CLIENT_SECRET || '';
const BEXIO_REDIRECT_URI = process.env.BEXIO_REDIRECT_URI || '';

// Scopes requested during OAuth login.  Can be overridden via env.
const BEXIO_SCOPES = process.env.BEXIO_SCOPES ||
  'openid offline_access pr_project_show timesheet_show timesheet_edit client_service_show timesheet_status_show';

// Optional: default user ID for timesheet creation.  Set BEXIO_USER_ID in
// .env to automatically assign the current user when creating timesheets.
const BEXIO_USER_ID = process.env.BEXIO_USER_ID || '';

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
const sessions = {};

// Parse cookies from the request headers.  Returns an object mapping
// cookie names to values.  If no cookies are present, returns {}.
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts[0].trim();
    const val = parts.slice(1).join('=').trim();
    if (name) cookies[name] = decodeURIComponent(val);
  });
  return cookies;
}

// Get the session object associated with the request.  Looks for a
// `session_id` cookie and returns the corresponding session from
// `sessions`.  If no session exists, returns null.  Does not create
// sessions.
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies.session_id;
  if (sid && sessions[sid]) {
    return sessions[sid];
  }
  return null;
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
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) {
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
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

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // OAuth login route.  Redirects the user to the Bexio auth page.  Only
  // enabled when client credentials are supplied.
  if (pathname === '/auth/login' && req.method === 'GET') {
    if (!BEXIO_CLIENT_ID || !BEXIO_CLIENT_SECRET || !BEXIO_REDIRECT_URI) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('OAuth configuration missing. Please set BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET and BEXIO_REDIRECT_URI.');
      return;
    }
    // Build authorization URL
    const params = new URLSearchParams();
    params.append('client_id', BEXIO_CLIENT_ID);
    params.append('response_type', 'code');
    params.append('redirect_uri', BEXIO_REDIRECT_URI);
    params.append('scope', BEXIO_SCOPES);
    // Set a simple state parameter (could be improved).
    const state = Math.random().toString(36).substring(2);
    params.append('state', state);
    const authUrl = `https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth?${params.toString()}`;
    // Redirect user to Bexio login
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // OAuth callback route.  Handles the authorization code and exchanges it for tokens.
  if (pathname === '/auth/callback' && req.method === 'GET') {
    const { code } = parsedUrl.query;
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing authorization code');
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
        const text = await tokenRes.text();
        throw new Error(
          `Token exchange failed: ${tokenRes.status} ${tokenRes.statusText} – ${text}`,
        );
      }
      const json = await tokenRes.json();
      // Create a new session for this user.  Generate a simple random
      // identifier and store the tokens, expiry and user_id in the sessions
      // object.  Also update the global oauthTokens as a fallback for
      // environments where sessions are not used.
      const newSessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessions[newSessionId] = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: Date.now() + (json.expires_in || 3600) * 1000 - 5 * 60 * 1000,
        user_id: null,
      };
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
      const expires = new Date(sessions[newSessionId].expires_at).toUTCString();
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `session_id=${newSessionId}; Path=/; HttpOnly; Expires=${expires}`,
      });
      res.end();
      return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Authentication failed: ' + err.message);
      return;
    }
  }

  // Auth status route.  Returns JSON with authentication state.
  if (pathname === '/api/authStatus' && req.method === 'GET') {
    // Determine if this request has a valid session or global token.  A
    // session is considered authenticated if the session cookie exists and
    // the access token is not expired.  If using a personal token or the
    // global oauthTokens is still valid, authenticate as well.  The
    // response indicates whether the current request is authenticated.
    const session = getSession(req);
    const authenticated = !!(
      BEXIO_TOKEN ||
      (session && session.access_token && Date.now() < session.expires_at) ||
      (oauthTokens.access_token && Date.now() < oauthTokens.expires_at)
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated }));
    return;
  }

  // Enable CORS for API endpoints.
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  try {
    // API routes
    if (pathname === '/api/projects' && req.method === 'GET') {
      // Search projects; optional `q` parameter for search term.
      const q = parsedUrl.query.q || '';
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
      if (!id) {
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
      if (!id) {
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
      if (!projectId) {
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
        const unique = {};
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
      const body = await parseBody(req);
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
      const body = await parseBody(req);
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
      const data = await bexioRequest('DELETE', `/timesheet/${id}`, {}, null, req);
      res.writeHead(204);
      res.end();
      return;
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
    return;
  }

  // Serve static files
  let filePath = pathname;
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }
  filePath = path.join(STATIC_ROOT, filePath);
  serveStatic(filePath, res);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = { fetchTimesheetsInRange, getTimesheetDate, isValidDateOnly };
