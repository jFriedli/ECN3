const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  server,
  sessions,
  createSession,
  signedSessionCookie,
  resolveBexioUser,
  resolveTimesheetUserId,
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

function validTimesheetBody(overrides = {}) {
  return JSON.stringify({
    client_service_id: 1,
    status_id: 1,
    tracking: { type: 'range', start: '2026-01-01T08:00:00.000Z', end: '2026-01-01T09:00:00.000Z' },
    ...overrides,
  });
}

test('resolveBexioUser: identity resolution', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  await t.test('resolves the numeric id from GET /3.0/users/me', async () => {
    global.fetch = async (url) => {
      assert.equal(String(url), 'https://api.bexio.com/3.0/users/me');
      return new Response(JSON.stringify({ id: 111, email: 'dev@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const resolved = await resolveBexioUser('token');
    assert.deepEqual(resolved, { userId: 111, email: 'dev@example.com' });
  });

  await t.test('a second, independently valid user resolves to their own id', async () => {
    global.fetch = async () => new Response(JSON.stringify({ id: 222, email: 'coworker@example.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const resolved = await resolveBexioUser('token');
    assert.deepEqual(resolved, { userId: 222, email: 'coworker@example.com' });
  });

  await t.test('email casing has no bearing on id resolution (no email-based lookup exists)', async () => {
    global.fetch = async () => new Response(JSON.stringify({ id: 333, email: 'MiXeD.CaSe@Example.COM' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const resolved = await resolveBexioUser('token');
    assert.equal(resolved.userId, 333);
  });

  await t.test('a non-numeric identity (e.g. a UUID sub/login_id) is never treated as a valid user id', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ id: '9f1c2e5a-...-uuid', sub: '9f1c2e5a-...-uuid' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const resolved = await resolveBexioUser('token');
    assert.equal(resolved, null);
  });

  await t.test('missing id field resolves to null instead of guessing', async () => {
    global.fetch = async () => new Response(JSON.stringify({ email: 'noid@example.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(await resolveBexioUser('token'), null);
  });

  await t.test('Bexio API lookup failure (non-2xx) resolves to null, not a thrown secret-carrying error', async () => {
    global.fetch = async () => new Response('{"error":"forbidden"}', { status: 403, statusText: 'Forbidden' });
    assert.equal(await resolveBexioUser('token'), null);
  });

  await t.test('Bexio API network failure resolves to null', async () => {
    global.fetch = async () => { throw new Error('network unreachable'); };
    assert.equal(await resolveBexioUser('token'), null);
  });
});

test('resolveTimesheetUserId: session-derived identity, never a cross-user fallback', async (t) => {
  await t.test('unknown ECN3 user (no session) is rejected, not defaulted', () => {
    const req = { headers: {} };
    assert.throws(() => resolveTimesheetUserId(req), /No Bexio user is configured/);
  });

  await t.test('a session whose Bexio user could not be resolved fails loudly (statusCode 409)', () => {
    const sessionId = createSession({ access_token: 'a', expires_at: Date.now() + 60_000, user_id: null });
    t.after(() => { delete sessions[sessionId]; });
    const req = { headers: { cookie: `session_id=${signedSessionCookie(sessionId)}` } };
    try {
      resolveTimesheetUserId(req);
      assert.fail('expected resolveTimesheetUserId to throw');
    } catch (err) {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /could not be linked/);
    }
  });

  await t.test('a resolved session returns exactly its own bexio user id', () => {
    const sessionId = createSession({ access_token: 'a', expires_at: Date.now() + 60_000, user_id: 444 });
    t.after(() => { delete sessions[sessionId]; });
    const req = { headers: { cookie: `session_id=${signedSessionCookie(sessionId)}` } };
    assert.equal(resolveTimesheetUserId(req), 444);
  });
});

test('POST /api/timesheets: identity mapping end to end', async (t) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  t.after(() => { global.fetch = originalFetch; console.error = originalConsoleError; });

  await t.test('primary user: outgoing Bexio payload carries the session-resolved user_id', async () => {
    const sessionId = createSession({ access_token: 'a', expires_at: Date.now() + 60_000, user_id: 111 });
    t.after(() => { delete sessions[sessionId]; });
    let sentBody = null;
    global.fetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${signedSessionCookie(sessionId)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: validTimesheetBody(),
    });
    assert.equal(res.status, 201);
    assert.equal(sentBody.user_id, 111);
  });

  await t.test('second valid user: gets their own id, not the first user\'s', async () => {
    const sessionId = createSession({ access_token: 'b', expires_at: Date.now() + 60_000, user_id: 222 });
    t.after(() => { delete sessions[sessionId]; });
    let sentBody = null;
    global.fetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 2 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${signedSessionCookie(sessionId)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: validTimesheetBody(),
    });
    assert.equal(res.status, 201);
    assert.equal(sentBody.user_id, 222);
  });

  await t.test('no accidental fallback: a client-forged user_id is ignored in favor of the session identity', async () => {
    const sessionId = createSession({ access_token: 'c', expires_at: Date.now() + 60_000, user_id: 222 });
    t.after(() => { delete sessions[sessionId]; });
    let sentBody = null;
    global.fetch = async (url, options) => {
      sentBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 3 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${signedSessionCookie(sessionId)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: validTimesheetBody({ user_id: 111 }),
    });
    assert.equal(res.status, 201);
    assert.equal(sentBody.user_id, 222, 'must never submit hours as another user, even if the client requests it');
  });

  await t.test('unresolved Bexio user: request is rejected before ever reaching Bexio', async () => {
    const sessionId = createSession({ access_token: 'd', expires_at: Date.now() + 60_000, user_id: null });
    t.after(() => { delete sessions[sessionId]; });
    let bexioWasCalled = false;
    global.fetch = async () => { bexioWasCalled = true; return new Response('[]', { status: 200 }); };
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${signedSessionCookie(sessionId)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: validTimesheetBody(),
    });
    assert.equal(res.status, 409);
    assert.match(JSON.parse(res.body).error, /could not be linked/);
    assert.equal(bexioWasCalled, false);
  });

  await t.test('invalid/stale Bexio user id: Bexio 422 is surfaced with a safe diagnostic log', async () => {
    const sessionId = createSession({ access_token: 'e', expires_at: Date.now() + 60_000, user_id: 999999 });
    t.after(() => { delete sessions[sessionId]; });
    global.fetch = async () => new Response(
      JSON.stringify({
        error_code: 422,
        message: 'The form could not be saved due to the following errors:',
        errors: ['user_id: Diese Eingabe ist nicht korrekt.'],
      }),
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    const diagnostics = [];
    console.error = (...args) => { diagnostics.push(args.map(String).join(' ')); };
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${signedSessionCookie(sessionId)}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: validTimesheetBody(),
    });
    assert.equal(res.status, 502);
    const diagnosticText = diagnostics.join('\n');
    assert.match(diagnosticText, /Timesheet submission failed:/);
    assert.match(diagnosticText, /resolved_bexio_user_id=999999/);
    assert.match(diagnosticText, /bexio_error=.*422/);
    assert.doesNotMatch(diagnosticText, /access_token|refresh_token|client_secret/);
  });

  await t.test('unknown ECN3 user (no session at all) cannot create a timesheet', async () => {
    const res = await request(port, '/api/timesheets', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: validTimesheetBody(),
    });
    assert.equal(res.status, 401);
  });
});
