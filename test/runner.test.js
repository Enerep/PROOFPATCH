import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/runner.js';

async function fixture(t, source) {
  const cwd = await mkdtemp(join(tmpdir(), 'proofpatch-runner-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'check.cjs'), source);
  const runDir = join(cwd, 'evidence');
  await mkdir(runDir);
  return { cwd, runDir, index: 0 };
}

test('captures actual command evidence and nonzero exit codes', async (t) => {
  const options = await fixture(t, 'console.log("test output"); console.error("real failure"); process.exitCode = 7;');
  const result = await runCommand({ name: 'Tests', command: 'node check.cjs', timeoutMs: 5000 }, options);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.match(await readFile(join(options.runDir, result.artifacts[0]), 'utf8'), /test output/);
  assert.match(await readFile(join(options.runDir, result.artifacts[1]), 'utf8'), /real failure/);
});

test('successful commands pass', async (t) => {
  const options = await fixture(t, 'console.log("OK");');
  const result = await runCommand({ name: 'Tests', command: 'node check.cjs', timeoutMs: 5000 }, options);
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
});

test('times out a hung process and its descendants', { skip: process.platform === 'win32' }, async (t) => {
  const options = await fixture(t, `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    writeFileSync('child.pid', String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const result = await runCommand({ name: 'Hung', command: 'node check.cjs', timeoutMs: 1000 }, options);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Timed out/);
  assert.ok(result.durationMs < 5000);
  const pid = Number(await readFile(join(options.cwd, 'child.pid'), 'utf8'));
  // A killed process can briefly remain as a zombie before the container reaps it.
  let running = false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    running = !/^\d+ \(.+\) Z /.test(stat);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { process.kill(pid, 0); running = true; } catch { /* Already stopped. */ }
    }
  }
  assert.equal(running, false, 'descendant should no longer be running');
});

test('abort stops an active command and records interruption', async (t) => {
  const options = await fixture(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  t.after(() => clearTimeout(timer));
  const result = await runCommand({ name: 'Interrupted', command: 'node check.cjs', timeoutMs: 5000 }, { ...options, signal: controller.signal });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Interrupted/);
});

test('cleans up background descendants even when the command succeeds', { skip: process.platform === 'win32' }, async (t) => {
  const options = await fixture(t, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync('background.pid', String(child.pid));
    child.unref();
  `);
  const result = await runCommand({ name: 'Background', command: 'node check.cjs', timeoutMs: 5000 }, options);
  assert.equal(result.status, 'passed');
  const pid = Number(await readFile(join(options.cwd, 'background.pid'), 'utf8'));
  let running = false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    running = !/^\d+ \(.+\) Z /.test(stat);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try { process.kill(pid, 0); running = true; } catch { /* Already stopped. */ }
    }
  }
  assert.equal(running, false, 'background process should be stopped after a successful check');
});

test('large command output is bounded and marked as truncated', async (t) => {
  const options = await fixture(t, 'process.stdout.write("x".repeat(2 * 1024 * 1024));');
  const result = await runCommand({ name: 'Noisy', command: 'node check.cjs', timeoutMs: 5000 }, options);
  const log = await readFile(join(options.runDir, result.artifacts[0]), 'utf8');
  assert.equal(result.status, 'passed');
  assert.ok(log.length < 1024 * 1024 + 100);
  assert.match(log, /Output truncated/);
});
