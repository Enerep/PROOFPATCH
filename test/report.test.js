import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, toMarkdown } from '../src/report.js';

test('an empty or entirely skipped run never passes', () => {
  assert.equal(summarize([]).status, 'failed');
  assert.equal(summarize([{ status: 'skipped' }]).status, 'failed');
  assert.deepEqual(summarize([{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }]), {
    passed: 1, failed: 1, skipped: 1, status: 'failed',
  });
});

test('Markdown records scope and links failure evidence', () => {
  const checks = [{ name: 'Tests | unit', status: 'failed', command: 'npm test', durationMs: 32, reason: 'Real failure', artifacts: ['check-1.stderr.log'] }];
  const markdown = toMarkdown({
    summary: summarize(checks), checks, tool: { version: '0.1.0' }, environment: { node: 'v22', platform: 'linux' },
    startedAt: '2026-01-01T00:00:00.000Z', durationMs: 32, configSource: 'package.json', git: null,
  });
  assert.match(markdown, /FAILED/);
  assert.match(markdown, /\[check-1.stderr.log\]\(check-1.stderr.log\)/);
  assert.match(markdown, /Skipped checks were not verified/);
  assert.match(markdown, /Tests \\\| unit/);
});

test('browser reports expose the assertions and completion state', () => {
  const checks = [{
    name: 'Browser: Save a note', kind: 'browser', status: 'failed', durationMs: 100,
    reason: 'Expected text missing', details: {
      url: 'http://127.0.0.1:3000/', completedSteps: 1,
      steps: [{ action: 'click', selector: 'button' }, { action: 'expectText', text: 'Saved' }],
      pageErrors: ['Unable to save'],
    },
  }];
  const markdown = toMarkdown({
    summary: summarize(checks), checks, tool: { version: '0.1.0' }, environment: { node: 'v22', platform: 'linux' },
    startedAt: '2026-01-01T00:00:00.000Z', durationMs: 100, configSource: 'proofpatch.config.json', git: null,
  });
  assert.match(markdown, /expectText \| page body \| Saved \| not completed/);
  assert.match(markdown, /click \| button \|  \| completed/);
  assert.match(markdown, /Unable to save/);
  assert.match(markdown, /\[Complete machine-readable report\]\(report.json\)/);
});
