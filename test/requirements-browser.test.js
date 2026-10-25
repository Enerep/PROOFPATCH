import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proofpatch.js', import.meta.url));
const browserEnabled = Boolean(process.env.PROOFPATCH_BROWSER_TESTS || process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH);

async function fixture(t, config) {
  const cwd = await mkdtemp(join(tmpdir(), 'proofpatch-requirements-browser-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'proofpatch.config.json'), JSON.stringify(config));
  return cwd;
}

async function server(t, { status = 200, body = '<h1>Welcome to ProofPatch</h1>' } = {}) {
  const http = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(status, { 'content-type': 'text/html' });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    http.closeAllConnections();
    http.close(resolve);
  }));
  return `http://127.0.0.1:${http.address().port}`;
}

function verify(t, cwd) {
  const child = spawn(process.execPath, [cli, 'verify', '--json'], {
    cwd, windowsHide: true, env: { ...process.env, PROOFPATCH_RUNNING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let forceTimer;
  let timedOut = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
  }, 20_000);
  t.after(() => {
    clearTimeout(timeout);
    clearTimeout(forceTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      if (timedOut) return reject(new Error(`Verification timed out. ${stderr}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function browser(baseUrl, scenario, extra = {}) {
  return { baseUrl, startupTimeoutMs: 2_000, timeoutMs: 2_000, scenarios: [scenario], ...extra };
}

async function assertScreenshot(cwd, report, check) {
  const artifact = check.artifacts.find((entry) => entry.endsWith('.png'));
  assert.ok(artifact, 'browser evidence must link to its screenshot');
  const png = await readFile(join(cwd, report.reportDirectory, artifact));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return artifact;
}

test('real browser evidence passes its linked requirement while an unlinked requirement makes verification incomplete', {
  skip: !browserEnabled,
}, async (t) => {
  const baseUrl = await server(t);
  const cwd = await fixture(t, {
    requirements: [
      { id: 'welcome', description: 'The homepage welcomes a visitor.' },
      { id: 'checkout', description: 'A visitor can complete checkout.' },
    ],
    checks: [],
    browser: browser(baseUrl, {
      name: 'Homepage', path: '/', requirements: ['welcome'],
      steps: [{ action: 'expectText', selector: 'h1', text: 'Welcome to ProofPatch' }],
    }),
  });
  const output = await verify(t, cwd);
  assert.equal(output.code, 1, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, 'incomplete');
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, 1);
  assert.deepEqual(report.requirementSummary, { passed: 1, failed: 0, unverified: 1 });
  const welcome = report.requirements.find(({ id }) => id === 'welcome');
  assert.equal(welcome.status, 'passed');
  assert.equal(welcome.description, 'The homepage welcomes a visitor.');
  assert.equal(welcome.checks.length, 1);
  assert.equal(welcome.checks[0].name, 'Browser: Homepage');
  assert.equal(welcome.checks[0].kind, 'browser');
  assert.equal(welcome.checks[0].status, 'passed');
  const screenshot = await assertScreenshot(cwd, report, welcome.checks[0]);
  const scenario = report.checks.find(({ name }) => name === 'Browser: Homepage');
  assert.ok(scenario.artifacts.includes(screenshot));
  const checkout = report.requirements.find(({ id }) => id === 'checkout');
  assert.equal(checkout.status, 'unverified');
  assert.equal(checkout.checks.length, 0);
  assert.ok(checkout.reason);
  const saved = JSON.parse(await readFile(join(cwd, report.reportDirectory, 'report.json'), 'utf8'));
  assert.deepEqual(saved.requirements, report.requirements);
  assert.match(await readFile(join(cwd, report.reportDirectory, 'report.md'), 'utf8'), /INCOMPLETE/);
  assert.equal((await fetch(baseUrl)).status, 200, 'verification must leave an externally owned server running');
});

test('a failed visible-text assertion fails its linked requirement and preserves browser evidence', {
  skip: !browserEnabled,
}, async (t) => {
  const baseUrl = await server(t, { body: '<h1>Welcome</h1><p style="display:none">Order confirmed</p>' });
  const cwd = await fixture(t, {
    requirements: [{ id: 'confirmation', description: 'The customer sees an order confirmation.' }],
    checks: [],
    browser: browser(baseUrl, {
      name: 'Confirmation', path: '/', requirements: ['confirmation'],
      steps: [{ action: 'expectText', text: 'Order confirmed' }],
    }),
  });
  const output = await verify(t, cwd);
  assert.equal(output.code, 1, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, 'failed');
  assert.deepEqual(report.requirementSummary, { passed: 0, failed: 1, unverified: 0 });
  const requirement = report.requirements[0];
  assert.equal(requirement.status, 'failed');
  assert.ok(requirement.reason);
  assert.equal(requirement.checks[0].name, 'Browser: Confirmation');
  assert.equal(requirement.checks[0].status, 'failed');
  const scenario = report.checks.find(({ name }) => name === 'Browser: Confirmation');
  assert.match(scenario.reason, /Visible text was not found/);
  await assertScreenshot(cwd, report, requirement.checks[0]);
  assert.equal((await fetch(baseUrl)).status, 200);
});

test('browser setup failure leaves its planned requirement unverified and its external server running', {
  skip: !browserEnabled,
}, async (t) => {
  const baseUrl = await server(t, { status: 503, body: 'External application is not ready.' });
  const cwd = await fixture(t, {
    requirements: [{ id: 'homepage', description: 'A visitor can open the homepage.' }],
    checks: [],
    browser: browser(baseUrl, {
      name: 'Unreachable homepage', path: '/', requirements: ['homepage'],
      steps: [{ action: 'expectVisible', selector: 'h1' }],
    }, { startupTimeoutMs: 300 }),
  });
  const output = await verify(t, cwd);
  assert.equal(output.code, 1, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, 'failed');
  assert.deepEqual(report.requirementSummary, { passed: 0, failed: 0, unverified: 1 });
  const setup = report.checks.find(({ name }) => name === 'Browser setup');
  assert.equal(setup.status, 'failed');
  assert.match(setup.reason, /not ready/);
  const planned = report.checks.find(({ name }) => name === 'Browser: Unreachable homepage');
  assert.equal(planned.status, 'skipped');
  assert.ok(planned.reason);
  const requirement = report.requirements[0];
  assert.equal(requirement.status, 'unverified');
  assert.ok(requirement.reason);
  assert.equal(requirement.checks.length, 1);
  assert.equal(requirement.checks[0].name, planned.name);
  assert.equal(requirement.checks[0].status, 'skipped');
  assert.deepEqual(requirement.checks[0].artifacts, []);
  const response = await fetch(baseUrl);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'External application is not ready.');
});
