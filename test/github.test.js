import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { githubSummary, publishGithubError, publishGithubReport, validateGithubEnvironment } from '../src/github.js';

function report(status = 'passed') {
  return {
    schemaVersion: 2,
    interrupted: false,
    summary: { status, passed: 1, failed: status === 'failed' ? 1 : 0, skipped: 1 },
    checks: [
      {
        name: 'Unit tests', kind: 'command', status: 'passed', command: 'DO_NOT_PUBLISH_THIS_COMMAND',
        artifacts: ['check-1.stdout.log'], details: { output: 'PRIVATE_BROWSER_DETAIL' },
      },
      { name: 'Browser: Save', kind: 'browser', status: 'skipped', reason: 'Server never became ready.', artifacts: ['screenshots/private.png'] },
    ],
    requirements: [],
    requirementSummary: { passed: 0, failed: 0, unverified: 0 },
    reportDirectory: '.proofpatch/private-run',
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'proofpatch-github-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { GITHUB_STEP_SUMMARY: join(directory, 'summary.md'), GITHUB_OUTPUT: join(directory, 'outputs.txt') };
  return { directory, env };
}

function parseOutputs(contents) {
  const lines = contents.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]) continue;
    const multiline = /^([a-zA-Z0-9_-]+)<<(.+)$/.exec(lines[index]);
    if (multiline) {
      const [, name, delimiter] = multiline;
      const values = [];
      for (index++; index < lines.length && lines[index] !== delimiter; index++) values.push(lines[index]);
      assert.ok(index < lines.length, `missing output delimiter for ${name}`);
      entries.push([name, values.join('\n')]);
    } else {
      const separator = lines[index].indexOf('=');
      assert.ok(separator > 0, `invalid GitHub output record: ${lines[index]}`);
      entries.push([lines[index].slice(0, separator), lines[index].slice(separator + 1)]);
    }
  }
  return entries;
}

test('GitHub summaries distinguish passed, failed, incomplete, and interrupted runs', () => {
  for (const status of ['passed', 'failed', 'incomplete']) {
    const summary = githubSummary(report(status));
    assert.match(summary, /ProofPatch/);
    assert.ok(summary.includes(status.toUpperCase()));
    assert.match(summary, /1 passed/);
    assert.match(summary, /1 skipped/);
  }
  const interrupted = githubSummary({ ...report('passed'), interrupted: true });
  assert.match(interrupted, /INTERRUPTED/);
  assert.doesNotMatch(interrupted, /^Result:[^\n]*PASSED/im);
});

test('GitHub summaries show requirement gaps and the causes of failed checks', () => {
  const input = report('incomplete');
  input.requirements = [
    { id: 'save-note', description: 'A user can save a note.', status: 'passed', reason: 'Its linked browser check passed.', checks: [] },
    { id: 'reject-blank', description: 'Blank notes are rejected.', status: 'unverified', reason: 'No checks are linked.', checks: [] },
  ];
  input.requirementSummary = { passed: 1, failed: 0, unverified: 1 };
  const summary = githubSummary(input);
  for (const text of ['save-note', 'A user can save a note.', 'reject-blank', 'Blank notes are rejected.', 'unverified', 'No checks are linked.']) {
    assert.ok(summary.includes(text), `missing requirement evidence: ${text}`);
  }
  const failed = report('failed');
  failed.checks.push({ name: 'Browser: Reject blank', kind: 'browser', status: 'failed', reason: 'Expected 0 notes, found 1.' });
  const failedSummary = githubSummary(failed);
  assert.ok(failedSummary.includes('Expected 0 notes, found 1.'));
  assert.ok(failedSummary.includes('Browser: Reject blank'));
});

test('legacy reports still show check results without publishing commands, logs, or artifact links', () => {
  const input = report();
  delete input.requirements;
  delete input.requirementSummary;
  const summary = githubSummary(input);
  assert.ok(summary.includes('Unit tests'));
  assert.ok(summary.includes('Browser: Save'));
  assert.ok(summary.includes('Server never became ready.'));
  for (const privateText of ['DO_NOT_PUBLISH_THIS_COMMAND', 'PRIVATE_BROWSER_DETAIL', 'check-1.stdout.log', 'screenshots/private.png', '.proofpatch/private-run']) {
    assert.ok(!summary.includes(privateText), `summary must not include ${privateText}`);
  }
});

test('untrusted summary fields cannot inject Markdown, HTML, table columns, or controls', () => {
  const malicious = 'Label | next\n## Attack [click](https://evil.invalid) <img src=x onerror=alert(1)> `code` \u001b[31m\u0000\u007f\u202e\u2066';
  const input = report('failed');
  input.checks = [{ name: malicious, kind: 'command', status: 'failed', reason: malicious }];
  input.requirements = [{ id: 'safe-id', description: malicious, status: 'failed', reason: malicious, checks: [] }];
  input.requirementSummary = { passed: 0, failed: 1, unverified: 0 };
  const summary = githubSummary(input);
  assert.ok(summary.includes('Label'));
  assert.ok(summary.includes('Attack'));
  assert.doesNotMatch(summary, /Label \| next/);
  assert.doesNotMatch(summary, /\n## Attack/);
  assert.doesNotMatch(summary, /\[click\]\(https:\/\/evil\.invalid\)/);
  assert.doesNotMatch(summary, /<img|<script/i);
  assert.doesNotMatch(summary, /`code`/);
  assert.doesNotMatch(summary, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
});

test('large summaries bound row counts and text lengths and announce truncation', () => {
  const input = report('incomplete');
  input.requirements = Array.from({ length: 1_000 }, (_, index) => ({
    id: `r${index}`, description: `RQMARK${index} ${'x'.repeat(4_000)}`, status: 'unverified',
    reason: 'No linked check has verified the requirement.', checks: [],
  }));
  input.requirementSummary = { passed: 0, failed: 0, unverified: 1_000 };
  input.checks = Array.from({ length: 1_000 }, (_, index) => ({ name: `CKMARK${index}`, kind: 'command', status: 'skipped', reason: 'y'.repeat(4_000) }));
  const summary = githubSummary(input);
  assert.ok(Buffer.byteLength(summary, 'utf8') < 1024 * 1024);
  assert.ok(summary.includes('RQMARK0'));
  assert.ok(summary.includes('CKMARK0'));
  assert.ok((summary.match(/RQMARK/g) ?? []).length <= 100);
  assert.ok((summary.match(/CKMARK/g) ?? []).length <= 100);
  assert.ok(!summary.includes('RQMARK999'));
  assert.ok(!summary.includes('CKMARK999'));
  assert.ok(!summary.includes('x'.repeat(501)));
  assert.ok(!summary.includes('y'.repeat(501)));
  assert.match(summary, /truncat|omitted|not shown|first \d+/i);
});

test('truncation keeps failures and requirement gaps first while retaining full totals and exact omission counts', () => {
  const input = report('failed');
  input.requirements = Array.from({ length: 200 }, (_, index) => ({
    id: `r${index}`,
    description: index === 199 ? 'REQUIREMENTFAILURE' : index >= 149 ? `GAPMARK${index}` : `PASSEDLOWPRIORITY${index}`,
    status: index === 199 ? 'failed' : index >= 149 ? 'unverified' : 'passed',
    reason: index === 199 ? 'The linked browser check failed.' : index >= 149 ? 'No linked checks ran.' : 'The linked check passed.',
    checks: [],
  }));
  input.requirementSummary = { passed: 149, failed: 1, unverified: 50 };
  input.checks = Array.from({ length: 200 }, (_, index) => ({
    name: index === 199 ? 'CHECKFAILURE' : `CHECKPASS${index}`, kind: 'command',
    status: index === 199 ? 'failed' : 'passed', reason: index === 199 ? 'Expected blank notes to be rejected.' : '',
  }));
  input.summary = { status: 'failed', passed: 199, failed: 1, skipped: 0 };
  const summary = githubSummary(input);
  assert.ok(summary.includes('REQUIREMENTFAILURE'));
  assert.ok(summary.includes('GAPMARK'));
  assert.ok(!summary.includes('PASSEDLOWPRIORITY'));
  assert.ok(summary.includes('CHECKFAILURE'));
  assert.match(summary, /149 passed/);
  assert.match(summary, /50 unverified/);
  assert.match(summary, /199 passed/);
  for (const category of ['requirements', 'checks']) {
    const counts = new RegExp(`(\\d+) of 200 ${category} shown; (\\d+) omitted\\.`, 'i').exec(summary);
    assert.ok(counts, `missing exact ${category} omission count`);
    assert.ok(Number(counts[1]) <= 100);
    assert.ok(Number(counts[2]) > 0);
    assert.equal(Number(counts[1]) + Number(counts[2]), 200);
  }
});

test('environment validation only validates strings and performs no filesystem operations', async (t) => {
  const { directory } = await fixture(t);
  const env = {
    GITHUB_STEP_SUMMARY: join(directory, 'missing-parent', 'summary.md'),
    GITHUB_OUTPUT: join(directory, 'missing-parent', 'outputs.txt'),
  };
  assert.doesNotThrow(() => validateGithubEnvironment(env));
  assert.deepEqual(await readdir(directory), []);
});

test('missing or invalid environment values reject before existing evidence is changed', async (t) => {
  const { directory, env } = await fixture(t);
  const summaryBefore = 'existing summary\n';
  const outputsBefore = 'existing-output=keep\n';
  await writeFile(env.GITHUB_STEP_SUMMARY, summaryBefore);
  await writeFile(env.GITHUB_OUTPUT, outputsBefore);
  for (const name of ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) {
    for (const value of [undefined, null, '', ' \t\n ', 42, {}, [], 'bad\u0000path']) {
      const invalid = { ...env, [name]: value };
      assert.throws(() => validateGithubEnvironment(invalid), /GITHUB_(?:STEP_SUMMARY|OUTPUT)/);
      await assert.rejects(publishGithubReport(report(), join(directory, 'run'), invalid));
      await assert.rejects(publishGithubError(new Error('Setup failed'), invalid));
      assert.equal(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), summaryBefore);
      assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), outputsBefore);
    }
  }
  assert.deepEqual((await readdir(directory)).sort(), ['outputs.txt', 'summary.md']);
});

test('publishing appends summaries and exactly three report outputs on every run', async (t) => {
  const { directory, env } = await fixture(t);
  await writeFile(env.GITHUB_STEP_SUMMARY, 'existing summary\n');
  await writeFile(env.GITHUB_OUTPUT, 'existing-output=keep\n');
  const runDir = join(directory, 'run');
  await publishGithubReport(report('passed'), runDir, env);
  await publishGithubReport(report('incomplete'), runDir, env);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.startsWith('existing summary\n'));
  assert.match(summary, /PASSED/);
  assert.match(summary, /INCOMPLETE/);
  assert.equal((summary.match(/ProofPatch/g) ?? []).length, 2);
  const outputText = await readFile(env.GITHUB_OUTPUT, 'utf8');
  assert.ok(outputText.startsWith('existing-output=keep\n'));
  const entries = parseOutputs(outputText);
  assert.equal(entries.length, 7);
  const first = Object.fromEntries(entries.slice(1, 4));
  const second = Object.fromEntries(entries.slice(4));
  assert.deepEqual(first, { 'report-directory': resolve(runDir), 'report-json': join(resolve(runDir), 'report.json'), result: 'passed' });
  assert.deepEqual(second, { ...first, result: 'incomplete' });
});

test('report output paths safely retain embedded newlines without injecting output records', async (t) => {
  const { directory, env } = await fixture(t);
  const runDir = join(directory, 'evidence\nresult=forged\nFAKE_DELIMITER');
  await publishGithubReport(report('failed'), runDir, env);
  const entries = parseOutputs(await readFile(env.GITHUB_OUTPUT, 'utf8'));
  assert.equal(entries.length, 3);
  assert.deepEqual(Object.fromEntries(entries), {
    'report-directory': resolve(runDir), 'report-json': join(resolve(runDir), 'report.json'), result: 'failed',
  });
});

test('setup errors append a concise escaped explanation and leave outputs untouched', async (t) => {
  const { env } = await fixture(t);
  await writeFile(env.GITHUB_STEP_SUMMARY, 'existing summary\n');
  await writeFile(env.GITHUB_OUTPUT, 'existing-output=keep\n');
  await publishGithubError(new Error('Bad config\n# Forged <script>alert(1)</script> [click](https://evil.invalid)\u0000'), env);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(summary.startsWith('existing summary\n'));
  assert.match(summary, /Bad config/);
  assert.match(summary, /No verification report was produced\./);
  assert.doesNotMatch(summary, /<script|\n# Forged|\[click\]\(https:\/\/evil\.invalid\)|\u0000/);
  assert.doesNotMatch(summary, /at TestContext/);
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'existing-output=keep\n');
});

test('filesystem publication failures propagate to the caller', async (t) => {
  const { directory, env } = await fixture(t);
  const invalidSummary = { ...env, GITHUB_STEP_SUMMARY: directory };
  await assert.rejects(publishGithubReport(report(), join(directory, 'run'), invalidSummary));
  await assert.rejects(publishGithubError(new Error('Setup failed'), invalidSummary));
  const invalidOutput = { ...env, GITHUB_OUTPUT: join(directory, 'outputs-directory') };
  await mkdir(invalidOutput.GITHUB_OUTPUT);
  await assert.rejects(publishGithubReport(report(), join(directory, 'run'), invalidOutput));
  const missingParent = { ...env, GITHUB_STEP_SUMMARY: join(directory, 'missing', 'summary.md') };
  await assert.rejects(publishGithubReport(report(), join(directory, 'run'), missingParent), { code: 'ENOENT' });
});
