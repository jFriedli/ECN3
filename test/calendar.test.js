const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const { fetchTimesheetsInRange } = require('../server');

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
    `${source}\nthis.frontend = { formatLocalDate, parseDurationHours, timesheetToEvent };`,
    context,
  );
  return context.frontend;
}

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
