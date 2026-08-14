const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig, cookieAttributes } = require('../server');

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
