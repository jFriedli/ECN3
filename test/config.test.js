const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { loadConfig, cookieAttributes, DEFAULT_BEXIO_SCOPES } = require('../server');

test('OAuth defaults and example use the documented project read scope', () => {
  const legacyScope = ['pr', 'project', 'show'].join('_');
  const example = fs.readFileSync(require.resolve('../.env.example'), 'utf8');
  assert.match(DEFAULT_BEXIO_SCOPES, /(?:^| )project_show(?: |$)/);
  assert.doesNotMatch(DEFAULT_BEXIO_SCOPES, new RegExp(legacyScope));
  assert.match(example, /BEXIO_SCOPES=.*(?:^| )project_show(?: |$)/m);
  assert.doesNotMatch(example, new RegExp(legacyScope));
  assert.doesNotMatch(example, /(?:^| )project_edit(?: |$)/m);
});

test('HTTPS APP_BASE_URL produces Secure session cookies', () => {
  const config = loadConfig({ APP_BASE_URL: 'https://localhost:8443' });
  assert.match(cookieAttributes(60, config.secureCookies), /; Secure$/);
});

test('HTTP APP_BASE_URL does not produce Secure session cookies', () => {
  const config = loadConfig({ APP_BASE_URL: 'http://127.0.0.1:3000' });
  assert.doesNotMatch(cookieAttributes(60, config.secureCookies), /; Secure/);
});

test('malformed APP_BASE_URL causes startup failure', () => {
  assert.throws(() => loadConfig({ APP_BASE_URL: 'not a URL' }), /APP_BASE_URL/);
});

test('production Node defaults to 127.0.0.1', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://localhost:8443',
  });
  assert.equal(config.host, '127.0.0.1');
});

test('OAuth redirect URI uses the externally visible Caddy URL', () => {
  const config = loadConfig({ APP_BASE_URL: 'https://localhost:8443' });
  assert.equal(config.oauthRedirectUri, 'https://localhost:8443/auth/callback');
});
