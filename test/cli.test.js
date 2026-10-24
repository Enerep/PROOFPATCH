import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proofpatch.js', import.meta.url));

async function fixture(t, config) {
  const cwd = await mkdtemp(join(tmpdir(), 'proofpatch-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (config) await writeFile(join(cwd, 'proofpatch.config.json'), JSON.stringify(config));
  return cwd;
}

function run(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      cwd, timeout: 15000, env: { ...process.env, PROOFPATCH_RUNNING: '', ...env },
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

test('CLI runs every check, returns failure and writes matching JSON/Markdown evidence', async (t) => {
  const cwd = await fixture(t, { checks: [
    { name: 'Broken', command: 'node broken.cjs' },
    { name: 'Working', command: 'node working.cjs' },
  ] });
  await writeFile(join(cwd, 'broken.cjs'), 'console.error("regression found"); process.exitCode = 3;');
  await writeFile(join(cwd, 'working.cjs'), 'console.log("all assertions passed");');
  const output = await run(cwd, ['verify', '--json']);
  assert.equal(output.code, 1);
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, 'failed');
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.checks.find((check) => check.name === 'Broken').exitCode, 3);
  assert.match(output.stderr, /RUN\s+Working/);
  const saved = JSON.parse(await readFile(join(cwd, report.reportDirectory, 'report.json'), 'utf8'));
  assert.deepEqual(saved, report);
  const markdown = await readFile(join(cwd, report.reportDirectory, 'report.md'), 'utf8');
  assert.match(markdown, /FAILED/);
  assert.match(markdown, /Broken/);
  const log = await readFile(join(cwd, report.reportDirectory, 'check-1.stderr.log'), 'utf8');
  assert.match(log, /regression found/);
});

test('auto-discovers project scripts, lists omitted checks, and succeeds', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.cjs' } }));
  await writeFile(join(cwd, 'test.cjs'), 'console.log("passed");');
  const output = await run(cwd, ['verify', '--json']);
  assert.equal(output.code, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.configSource, 'package.json');
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.skipped, 4);
  assert.equal(report.checks.find((check) => check.name === 'test').command, 'npm run test');
});

test('empty projects produce an actionable setup error instead of a passing report', async (t) => {
  const cwd = await fixture(t);
  const output = await run(cwd, ['verify']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /No checks found/);
});

test('init creates real discovered checks and never overwrites configuration', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  const first = await run(cwd, ['init']);
  assert.equal(first.code, 0, first.stderr);
  const original = await readFile(join(cwd, 'proofpatch.config.json'), 'utf8');
  assert.equal(JSON.parse(original).checks[0].command, 'npm run test');
  const second = await run(cwd, ['init']);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(await readFile(join(cwd, 'proofpatch.config.json'), 'utf8'), original);
});

test('unknown CLI options and recursive execution fail clearly', async (t) => {
  const cwd = await fixture(t);
  const unknown = await run(cwd, ['verify', '--typo']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option/);
  const recursive = await run(cwd, ['verify'], { PROOFPATCH_RUNNING: '1' });
  assert.equal(recursive.code, 2);
  assert.match(recursive.stderr, /recursively/);
});

test('--cwd verifies another project', async (t) => {
  const cwd = await fixture(t, { checks: [{ name: 'Pass', command: 'node pass.cjs' }] });
  await writeFile(join(cwd, 'pass.cjs'), 'process.exitCode = 0;');
  const output = await run(tmpdir(), ['verify', '--cwd', cwd, '--json']);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).summary.passed, 1);
});

test('interrupted CLI saves a failed partial report and exits 130', { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const cwd = await fixture(t, { checks: [
    { name: 'Waiting', command: 'node wait.cjs' },
    { name: 'Later', command: 'node wait.cjs' },
  ] });
  await writeFile(join(cwd, 'wait.cjs'), 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [cli, 'verify', '--json'], {
    cwd, env: { ...process.env, PROOFPATCH_RUNNING: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let signaled = false;
  let signalTimer;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    if (!signaled && chunk.toString().includes('RUN')) {
      signaled = true;
      signalTimer = setTimeout(() => child.kill('SIGINT'), 150);
    }
  });
  t.after(() => clearTimeout(signalTimer));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 130);
  const report = JSON.parse(stdout);
  assert.equal(report.interrupted, true);
  assert.equal(report.summary.status, 'failed');
  assert.equal(report.checks.find((check) => check.name === 'Later').status, 'skipped');
  assert.match(await readFile(join(cwd, report.reportDirectory, 'report.md'), 'utf8'), /FAILED/);
});
