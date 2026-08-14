const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  server,
  sessions,
  createSession,
  signedSessionCookie,
  cookieAttributes,
} = require('../server');

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('security controls protect authentication, logout, CSRF, input, and headers', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const unauthenticated = await request(port, '/api/projects');
  assert.equal(unauthenticated.status, 401);

  const invalidAuthResponse = await request(port, '/auth/callback?code=attacker-code&state=attacker-state');
  assert.equal(invalidAuthResponse.status, 400);

  const sessionId = createSession({
    access_token: 'test-access-token',
    refresh_token: null,
    expires_at: Date.now() + 60_000,
    user_id: 1,
  });
  const cookie = `session_id=${signedSessionCookie(sessionId)}`;
  const authenticated = await request(port, '/api/authStatus', { headers: { Cookie: cookie } });
  assert.equal(authenticated.status, 200);
  assert.equal(JSON.parse(authenticated.body).authenticated, true);

  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => new Response('[]', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const authenticatedApi = await request(port, '/api/activities', { headers: { Cookie: cookie } });
  assert.equal(authenticatedApi.status, 200);
  assert.deepEqual(JSON.parse(authenticatedApi.body), []);

  const crossSite = await request(port, '/api/timesheets/1', {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  const malformed = await request(port, '/api/timesheets', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(malformed.status, 400);

  const oversized = await request(port, '/api/timesheets', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(oversized.status, 413);

  const logout = await request(port, '/logout', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: origin },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers['set-cookie'][0], /session_id=;/);
  assert.match(logout.headers['set-cookie'][0], /HttpOnly/);
  assert.match(logout.headers['set-cookie'][0], /SameSite=Lax/);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal(sessions[sessionId], undefined);

  const oldSession = await request(port, '/api/authStatus', { headers: { Cookie: cookie } });
  assert.equal(JSON.parse(oldSession.body).authenticated, false);
  const protectedAfterLogout = await request(port, '/api/projects', { headers: { Cookie: cookie } });
  assert.equal(protectedAfterLogout.status, 401);

  assert.equal(unauthenticated.headers['x-content-type-options'], 'nosniff');
  assert.equal(unauthenticated.headers['x-frame-options'], 'DENY');
  assert.match(unauthenticated.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(unauthenticated.headers['access-control-allow-origin'], undefined);

  const traversal = await request(port, '/..%2fserver.js');
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(traversal.body, /BEXIO_CLIENT_SECRET/);

  const first = createSession({ access_token: 'a', expires_at: Date.now() + 60_000 });
  const second = createSession({ access_token: 'b', expires_at: Date.now() + 60_000 });
  assert.notEqual(first, second);
  delete sessions[first];
  delete sessions[second];

  assert.match(cookieAttributes(60), /HttpOnly; SameSite=Lax; Max-Age=60/);
});
