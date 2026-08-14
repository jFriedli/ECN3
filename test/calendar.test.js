const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const { fetchTimesheetsInRange, filterActiveProjects } = require('../server');

function record(date, id = date) {
  return { id, date, tracking: { type: 'duration', date, duration: '01:00' } };
}

test('paginates newest-first and stops after passing the requested range', async () => {
  const pages = [
    [record('2026-08-20'), record('2026-08-14'), record('2026-08-13')],
    [record('2026-08-12'), record('2026-08-10'), record('2026-08-09')],
    [record('2026-08-07'), record('2026-08-06')],
  ];
  const requests = [];
  const result = await fetchTimesheetsInRange((params) => {
    requests.push(params);
    return pages[requests.length - 1];
  }, '2026-08-09', '2026-08-15', 3);

  assert.deepEqual(result.map(({ date }) => date), [
    '2026-08-14', '2026-08-13', '2026-08-12', '2026-08-10', '2026-08-09',
  ]);
  assert.deepEqual(requests, [
    { order_by: 'date_desc', limit: 3, offset: 0 },
    { order_by: 'date_desc', limit: 3, offset: 3 },
    { order_by: 'date_desc', limit: 3, offset: 6 },
  ]);
});

test('handles an empty first page', async () => {
  let requests = 0;
  const result = await fetchTimesheetsInRange(async () => {
    requests += 1;
    return [];
  }, '2026-08-09', '2026-08-15', 3);
  assert.deepEqual(result, []);
  assert.equal(requests, 1);
});

test('stops when Bexio returns fewer than a full page', async () => {
  let requests = 0;
  const result = await fetchTimesheetsInRange(async () => {
    requests += 1;
    return [record('2026-08-14')];
  }, '2026-08-09', '2026-08-15', 3);
  assert.equal(result.length, 1);
  assert.equal(requests, 1);
});

test('returns no records when none fall in the requested period', async () => {
  const result = await fetchTimesheetsInRange(async () => [
    record('2026-08-08'), record('2026-08-07'),
  ], '2026-08-09', '2026-08-15', 3);
  assert.deepEqual(result, []);
});

test('ignores malformed records and includes both date boundaries', async () => {
  const result = await fetchTimesheetsInRange(async () => [
    record('2026-08-15', 'end'),
    { id: 'malformed', tracking: {} },
    record('2026-08-09', 'start'),
  ], '2026-08-09', '2026-08-15', 4);
  assert.deepEqual(result.map(({ id }) => id), ['end', 'start']);
});

function loadFrontendFunctions() {
  const source = fs.readFileSync(require.resolve('../public/main.js'), 'utf8');
  const context = {
    console: { error() {}, warn() {} },
    document: { addEventListener() {}, getElementById() { return null; } },
    EventCalendar: {},
    setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.frontend = { formatLocalDate, parseDurationHours, timesheetToEvent, ` +
    `normalizeBexioText, getEventColor, buildEventPresentation };`,
    context,
  );
  return context.frontend;
}

test('normalizes Bexio HTML entities and line breaks as plain text', () => {
  const { normalizeBexioText } = loadFrontendFunctions();
  assert.equal(normalizeBexioText('A&nbsp;B'), 'A B');
  assert.equal(normalizeBexioText('A&amp;B'), 'A&B');
  assert.equal(normalizeBexioText('Gr&uuml;&szlig;e'), 'Grüße');
  assert.equal(normalizeBexioText('A<br>B'), 'A\nB');
  assert.equal(normalizeBexioText('A<br/>B'), 'A\nB');
  assert.equal(normalizeBexioText('A<br />B'), 'A\nB');
  assert.equal(normalizeBexioText('A</br>B'), 'A\nB');
  assert.equal(normalizeBexioText('A<br>B', { singleLine: true }), 'A B');
});

test('script-like Bexio content remains inert plain text', () => {
  const { normalizeBexioText } = loadFrontendFunctions();
  const normalized = normalizeBexioText('&lt;script&gt;globalThis.compromised=true&lt;/script&gt;');
  const plainTextElement = { textContent: '' };
  plainTextElement.textContent = normalized;
  assert.equal(plainTextElement.textContent, '<script>globalThis.compromised=true</script>');
  assert.equal(globalThis.compromised, undefined);
});

test('project and internal colors are stable and deterministic', () => {
  const { getEventColor } = loadFrontendFunctions();
  assert.deepEqual(getEventColor(123), getEventColor(123));
  assert.deepEqual(getEventColor(456), getEventColor(456));
  assert.notDeepEqual(getEventColor(123), getEventColor(456));
  assert.deepEqual(getEventColor(null, 'internal'), getEventColor(null, 'internal'));
  assert.notDeepEqual(getEventColor(null, 'internal'), getEventColor(123, 'project'));
});

test('event labels distinguish project work from internal work', () => {
  const { buildEventPresentation } = loadFrontendFunctions();
  const references = {
    projects: [{ id: 10, name: 'Project&nbsp;Alpha' }],
    activities: [
      { id: 20, name: 'Projekt Durchführung' },
      { id: 30, name: 'Knowledge Transfer Vorbereitung' },
    ],
    packageMap: {},
  };

  const project = buildEventPresentation(
    { pr_project_id: 10, client_service_id: 20, text: 'Vertec Authentifizierung' }, references);
  assert.equal(project.classification, 'project');
  assert.equal(project.title, 'Project Alpha\nVertec Authentifizierung');

  const internal = buildEventPresentation(
    { client_service_id: 30, text: '' }, references);
  assert.equal(internal.classification, 'internal');
  assert.equal(internal.title, 'Intern · Knowledge Transfer Vorbereitung');

  const projectActivity = buildEventPresentation(
    { client_service_id: 20, text: '' }, references);
  assert.equal(projectActivity.classification, 'project');
  assert.equal(projectActivity.title, 'Projektarbeit · Projekt Durchführung');
});

test('active project search excludes inactive projects by Bexio pr_state_id', () => {
  const states = [{ id: 7, name: 'Active' }, { id: 8, name: 'Completed' }];
  const active = { id: 101, name: 'Current', pr_state_id: 7 };
  const inactive = { id: 102, name: 'Historical', pr_state_id: 8 };
  assert.deepEqual(filterActiveProjects([active, inactive], states), [active]);
});

test('historical inactive projects remain resolvable for calendar display', () => {
  const { timesheetToEvent } = loadFrontendFunctions();
  const inactive = { id: 102, name: 'Historical Project', pr_state_id: 8 };
  const event = timesheetToEvent({
    id: 1,
    pr_project_id: 102,
    client_service_id: 20,
    text: 'Earlier work',
    tracking: { date: '2026-08-09T08:00:00Z', duration: '01:00' },
  }, {
    projects: [inactive],
    activities: [{ id: 20, name: 'Projekt Durchführung' }],
    packageMap: {},
  });
  assert.equal(event.title, 'Historical Project\nEarlier work');
  assert.equal(event.extendedProps.project_id, 102);
});

test('formats calendar query dates from local components', () => {
  const { formatLocalDate } = loadFrontendFunctions();
  assert.equal(formatLocalDate(new Date(2026, 7, 9)), '2026-08-09');
});

test('parses Bexio HH:MM durations when creating event end times', () => {
  const { parseDurationHours, timesheetToEvent } = loadFrontendFunctions();
  assert.equal(parseDurationHours('1:30'), 1.5);
  const event = timesheetToEvent({
    id: 1,
    tracking: { date: '2026-08-09T08:00:00Z', duration: '1:30' },
  });
  assert.equal(event.end, '2026-08-09T09:30:00.000Z');
});
