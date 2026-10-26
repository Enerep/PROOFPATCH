import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, toMarkdown } from '../src/report.js';
import { assessRequirements, summarizeRequirements } from '../src/requirements.js';

test('an empty or entirely skipped run never passes', () => {
  assert.equal(summarize([]).status, 'failed');
  assert.equal(summarize([{ status: 'skipped' }]).status, 'failed');
  assert.deepEqual(summarize([{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }]), {
    passed: 1, failed: 1, skipped: 1, status: 'failed',
  });
});

test('unverified requirements make an otherwise passing run incomplete', () => {
  const checks = [{ name: 'Tests', kind: 'command', status: 'passed', requirements: ['R1'] }];
  const requirements = assessRequirements([
    { id: 'R1', description: 'Save notes' },
    { id: 'R2', description: 'Recover saved notes' },
  ], checks);
  assert.deepEqual(summarize(checks, requirements), { passed: 1, failed: 0, skipped: 0, status: 'incomplete' });
  assert.equal(summarize([], assessRequirements([{ id: 'R1', description: 'Save notes' }], [])).status, 'incomplete');
});

test('check and requirement failures take priority over incomplete requirements', () => {
  const requirements = [
    { status: 'failed' },
    { status: 'unverified' },
  ];
  assert.equal(summarize([{ status: 'passed' }], requirements).status, 'failed');
  assert.equal(summarize([{ status: 'failed' }], [{ status: 'unverified' }]).status, 'failed');
});

test('summary preserves existing behavior when no requirements are declared', () => {
  const checks = [{ status: 'passed' }, { status: 'skipped' }];
  assert.deepEqual(summarize(checks), { passed: 1, failed: 0, skipped: 1, status: 'passed' });
  assert.deepEqual(summarize(checks, []), summarize(checks));
  assert.equal(summarize([{ status: 'passed' }], [{ status: 'passed' }]).status, 'passed');
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

test('Markdown requirements show author-supplied associations, outcomes, and escaped evidence', () => {
  const checks = [{
    name: 'Tests | [unit]', kind: 'command', status: 'passed', requirements: ['R1'],
    artifacts: ['screenshots/save [note](1).png'],
  }];
  const requirements = assessRequirements([
    { id: 'R1', description: 'Save <notes> & show | confirmation\nwhen ready' },
    { id: 'R2', description: '[Unlinked](https://example.com)' },
  ], checks);
  const base = {
    checks, tool: { version: '0.1.0' }, environment: { node: 'v22', platform: 'linux' },
    startedAt: '2026-01-01T00:00:00.000Z', durationMs: 32, configSource: 'proofpatch.config.json', git: null,
  };
  const markdown = toMarkdown({
    ...base, summary: summarize(checks, requirements), requirements,
    requirementSummary: summarizeRequirements(requirements),
  });
  assert.match(markdown, /Result: \*\*INCOMPLETE\*\*/);
  assert.match(markdown, /1 passed, 0 failed, 1 unverified/);
  assert.match(markdown, /associations are supplied by the plan author/);
  assert.match(markdown, /does not prove those checks are adequate or cover the requirement/);
  assert.match(markdown, /Save &lt;notes&gt; &amp; show \\\| confirmation<br>when ready/);
  assert.match(markdown, /Tests \\\| \\\[unit\\\]/);
  assert.match(markdown.split('## Checks')[0], /screenshots\/save%20%5Bnote%5D%281%29.png/);
  assert.match(markdown, /No linked checks/);
  assert.ok(markdown.indexOf('## Requirements') < markdown.indexOf('| Check | Result'));
  assert.doesNotMatch(toMarkdown({ ...base, summary: summarize(checks) }), /## Requirements/);
  assert.doesNotMatch(markdown, /coverage\s*[:=]?\s*\d+%|\b\d+%\s*(?:coverage|covered)/i);
});

test('browser reports show count and hidden expectations with observation windows', () => {
  const checks = [{
    name: 'Browser: Reject blank notes', kind: 'browser', status: 'failed', durationMs: 500,
    reason: 'Expected 0 elements, found 1', details: {
      url: 'http://127.0.0.1:3000/', completedSteps: 1,
      steps: [
        { action: 'expectHidden', selector: '#error', forMs: 100 },
        { action: 'expectCount', selector: '#notes li', count: 0, forMs: 250 },
      ],
    },
  }];
  const markdown = toMarkdown({
    summary: summarize(checks), checks, tool: { version: '0.1.0' }, environment: { node: 'v22', platform: 'linux' },
    startedAt: '2026-01-01T00:00:00.000Z', durationMs: 500, configSource: 'proofpatch.config.json', git: null,
  });
  assert.match(markdown, /expectHidden \| #error \| hidden or absent for 100 ms \| completed/);
  assert.match(markdown, /expectCount \| #notes li \| 0 matching elements for 250 ms \| not completed/);
  assert.match(markdown, /Expected 0 elements, found 1/);
});
