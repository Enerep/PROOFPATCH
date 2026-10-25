import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRequirements, summarizeRequirements } from '../src/requirements.js';

const definitions = [
  { id: 'R1', description: 'Save a note' },
  { id: 'R2', description: 'Show saved notes' },
  { id: 'R3', description: 'Recover after a failed save' },
];

test('requirements pass only when all linked checks pass and retain evidence', () => {
  const checks = [
    { name: 'Unit tests', kind: 'command', status: 'passed', requirements: ['R1', 'R2'], artifacts: ['check-1.stdout.log'] },
    { name: 'Browser: save', kind: 'browser', status: 'passed', requirements: ['R1'], artifacts: ['screenshots/save.png'] },
    { name: 'Unrelated check', kind: 'command', status: 'failed' },
  ];
  const results = assessRequirements(definitions, checks);
  assert.deepEqual(results[0], {
    id: 'R1', description: 'Save a note', status: 'passed', reason: 'All 2 linked checks passed.',
    checks: [
      { name: 'Unit tests', kind: 'command', status: 'passed', artifacts: ['check-1.stdout.log'] },
      { name: 'Browser: save', kind: 'browser', status: 'passed', artifacts: ['screenshots/save.png'] },
    ],
  });
  assert.equal(results[1].status, 'passed');
  assert.equal(results[2].status, 'unverified');
  assert.deepEqual(results[2].checks, []);
  assert.match(results[2].reason, /No check results are linked/);
  assert.deepEqual(summarizeRequirements(results), { passed: 2, failed: 0, unverified: 1 });
});

test('a linked failure takes priority over passed and skipped results', () => {
  const results = assessRequirements(definitions.slice(0, 1), [
    { name: 'Unit tests', kind: 'command', status: 'passed', requirements: ['R1'] },
    { name: 'Browser: save', kind: 'browser', status: 'failed', requirements: ['R1'], artifacts: ['screenshots/failure.png'] },
    { name: 'Browser: retry', kind: 'browser', status: 'skipped', requirements: ['R1'] },
  ]);
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].reason, '1 linked check failed.');
  assert.deepEqual(results[0].checks[0].artifacts, []);
  assert.deepEqual(summarizeRequirements(results), { passed: 0, failed: 1, unverified: 0 });
});

test('skipped linked checks leave a requirement unverified even when another check passes', () => {
  const results = assessRequirements(definitions.slice(0, 1), [
    { name: 'Unit tests', kind: 'command', status: 'passed', requirements: ['R1'] },
    { name: 'Browser: save', kind: 'browser', status: 'skipped', requirements: ['R1'] },
  ]);
  assert.equal(results[0].status, 'unverified');
  assert.match(results[0].reason, /did not run to a passing result/);
  assert.equal(results[0].checks.length, 2);
});

test('requirements without linked results are unverified and never inferred from other results', () => {
  const results = assessRequirements(definitions, [
    { name: 'Unit tests', kind: 'command', status: 'passed', requirements: ['R12'] },
    { name: 'Browser: save', kind: 'browser', status: 'passed' },
  ]);
  assert.ok(results.every((result) => result.status === 'unverified'));
  assert.deepEqual(summarizeRequirements(results), { passed: 0, failed: 0, unverified: 3 });
});

test('assessment does not mutate definitions or execution results', () => {
  const checks = [{ name: 'Unit tests', kind: 'command', status: 'passed', requirements: ['R1'], artifacts: ['original.log'] }];
  const before = structuredClone({ definitions, checks });
  const results = assessRequirements(definitions, checks);
  results[0].checks[0].artifacts.push('new.log');
  assert.deepEqual({ definitions, checks }, before);
  assert.deepEqual(summarizeRequirements([]), { passed: 0, failed: 0, unverified: 0 });
});
