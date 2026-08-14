const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveStaticPath } = require('../server');

const publicRoot = path.resolve(__dirname, '..', 'public');

test('static file paths remain inside the public directory', () => {
  assert.equal(
    resolveStaticPath('/'),
    path.join(publicRoot, 'index.html')
  );

  assert.equal(
    resolveStaticPath('/main.js'),
    path.join(publicRoot, 'main.js')
  );

  const traversalAttempts = [
    '/../server.js',
    '/../../etc/passwd',
    '/foo/../../../etc/passwd',

    // URL-encoded traversal
    '/%2e%2e/server.js',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2fetc%2fpasswd',

    // Windows-style traversal
    '/..%5c..%5cWindows%5cwin.ini',

    // NUL and malformed URL encoding
    '/foo%00bar',
    '/%E0%A4%A',
  ];

  for (const attempt of traversalAttempts) {
    assert.equal(
      resolveStaticPath(attempt),
      null,
      `${attempt} should have been rejected`
    );
  }
});
