const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBexioUrl, validId } = require('../server');

test('builds fixed-origin Bexio URLs for supported dynamic resource paths', () => {
  const projectId = encodeURIComponent(String(368));
  const contactId = encodeURIComponent(String(42));
  const timesheetId = encodeURIComponent(String(14336));

  assert.equal(buildBexioUrl('2.0', `/pr_project/${projectId}`).href,
    'https://api.bexio.com/2.0/pr_project/368');
  assert.equal(buildBexioUrl('2.0', `/contact/${contactId}`).href,
    'https://api.bexio.com/2.0/contact/42');
  assert.equal(buildBexioUrl('2.0', `/timesheet/${timesheetId}`).href,
    'https://api.bexio.com/2.0/timesheet/14336');
  assert.equal(buildBexioUrl('3.0', `/projects/${projectId}/packages`).href,
    'https://api.bexio.com/3.0/projects/368/packages');
});

test('strict ID validation rejects path and origin manipulation values', () => {
  const maliciousIds = [
    '../oauth/token',
    '../../something',
    '//example.com',
    'https://example.com',
    '\\example.com',
    '%2e%2e',
    '@example.com',
    `123\0example.com`,
  ];
  for (const value of maliciousIds) assert.equal(validId(value), false, value);
  assert.equal(validId('368'), true);
  assert.equal(validId(368), true);
});

test('URL builder rejects unsupported origins, traversal, and encoded separators', () => {
  const maliciousEndpoints = [
    '../oauth/token',
    '//example.com',
    '/https://example.com',
    '/\\example.com',
    '/projects/../oauth',
    '/projects/%2e%2e/oauth',
    '/projects/%2F%2Fexample.com',
    '/@example.com',
    `/projects/123\0suffix`,
  ];
  for (const endpoint of maliciousEndpoints) {
    assert.throws(() => buildBexioUrl('2.0', endpoint), /Bexio API/);
  }
  assert.throws(() => buildBexioUrl('4.0', '/projects'), /Unsupported Bexio API version/);
});

test('search text is confined to an encoded query parameter', () => {
  const query = '//example.com/../../oauth?next=https://attacker.example';
  const url = buildBexioUrl('2.0', '/pr_project', { search_term: query });
  assert.equal(url.origin, 'https://api.bexio.com');
  assert.equal(url.pathname, '/2.0/pr_project');
  assert.equal(url.searchParams.get('search_term'), query);
  assert.match(url.search, /%2F%2Fexample\.com%2F\.\.\%2F\.\./);
});
