const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findSelectableProjectStateIds,
  filterActiveProjects,
} = require('../server');

test('Aktiv and Offen projects are selectable, Archiviert is not', () => {
  const states = [
    { id: 1, name: 'Offen' },
    { id: 2, name: 'Aktiv' },
    { id: 3, name: 'Archiviert' },
  ];

  assert.deepEqual(
    findSelectableProjectStateIds(states),
    [1, 2]
  );

  const projects = [
    { id: 10, name: 'Open project', pr_state_id: 1 },
    { id: 20, name: 'Active project', pr_state_id: 2 },
    { id: 30, name: 'Archived project', pr_state_id: 3 },
  ];

  assert.deepEqual(
    filterActiveProjects(projects, states).map((p) => p.id),
    [10, 20]
  );
});

test('English Active and Open are also recognized', () => {
  const states = [
    { id: 10, name: 'Open' },
    { id: 20, name: 'Active' },
    { id: 30, name: 'Archived' },
  ];

  assert.deepEqual(
    findSelectableProjectStateIds(states),
    [10, 20]
  );

  const projects = [
    { id: 10, pr_state_id: 10 },
    { id: 20, pr_state_id: 20 },
    { id: 30, pr_state_id: 30 },
  ];
  assert.deepEqual(
    filterActiveProjects(projects, states).map((project) => project.id),
    [10, 20]
  );
});
