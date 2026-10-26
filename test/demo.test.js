import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proofpatch.js', import.meta.url));
const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const browserEnabled = Boolean(process.env.PROOFPATCH_BROWSER_TESTS || process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH);

async function readPlan(directory) {
  return JSON.parse(await readFile(join(directory, 'proofpatch.config.json'), 'utf8'));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, name) {
  const directory = await mkdtemp(join(tmpdir(), 'proofpatch-notes-demo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    demo: ['server.js', 'notes.js', 'checks.js', 'package.json', 'proofpatch.config.json'],
    'buggy-notes': ['server.js', 'package.json', 'proofpatch.config.json'],
  };
  for (const [example, filenames] of Object.entries(files)) {
    const destination = join(directory, example);
    await mkdir(destination);
    await Promise.all(filenames.map((filename) => copyFile(join(examples, example, filename), join(destination, filename))));
  }
  const cwd = join(directory, name);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = join(cwd, 'proofpatch.config.json');
  const config = await readPlan(cwd);
  config.browser.baseUrl = baseUrl;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { cwd, port, baseUrl, configPath };
}

function verify(t, { cwd, port }) {
  const child = spawn(process.execPath, [cli, 'verify', '--json'], {
    cwd, windowsHide: true,
    env: { ...process.env, PROOFPATCH_DEMO_PORT: String(port), PROOFPATCH_RUNNING: '' },
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
  const clearTimers = () => {
    clearTimeout(timeout);
    clearTimeout(forceTimer);
  };
  t.after(() => {
    clearTimers();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  return new Promise((resolve, reject) => {
    child.once('error', (error) => { clearTimers(); reject(error); });
    child.once('close', (code) => {
      clearTimers();
      if (timedOut) return reject(new Error(`Demo verification timed out. ${stderr}`));
      resolve({ code, stdout, stderr });
    });
  });
}

function requirementStatuses(report) {
  return Object.fromEntries(report.requirements.map(({ id, status }) => [id, status]));
}

async function assertScreenshot(cwd, report, scenario) {
  const artifact = scenario.artifacts.find((path) => path.endsWith('.png'));
  assert.ok(artifact, 'browser result must include screenshot evidence');
  const png = await readFile(join(cwd, report.reportDirectory, artifact));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return artifact;
}

test('working and buggy notes demos keep the same acceptance checks', async () => {
  const fixed = await readPlan(join(examples, 'demo'));
  const buggy = await readPlan(join(examples, 'buggy-notes'));
  assert.notEqual(fixed.browser.baseUrl, buggy.browser.baseUrl);
  assert.deepEqual({ ...fixed, browser: { ...fixed.browser, baseUrl: 'http://127.0.0.1:0' } }, {
    ...buggy, browser: { ...buggy.browser, baseUrl: 'http://127.0.0.1:0' },
  });
});

test('the buggy UI fails blank-note acceptance while its helper tests pass, then passes the unchanged plan after repair', {
  skip: !browserEnabled,
}, async (t) => {
  const project = await fixture(t, 'buggy-notes');
  const originalPlan = await readFile(project.configPath, 'utf8');
  const broken = await verify(t, project);
  assert.equal(broken.code, 1, broken.stderr);
  const failedReport = JSON.parse(broken.stdout);
  assert.equal(failedReport.summary.status, 'failed');
  assert.deepEqual(requirementStatuses(failedReport), { 'add-note': 'passed', 'reject-blank': 'failed' });
  const unit = failedReport.checks.find(({ name }) => name === 'Note validation');
  assert.equal(unit.status, 'passed');
  assert.equal(unit.exitCode, 0);
  const unitLog = unit.artifacts.find((path) => path.endsWith('.stdout.log'));
  assert.match(await readFile(join(project.cwd, failedReport.reportDirectory, unitLog), 'utf8'), /rejects blank notes/);
  const blank = failedReport.checks.find(({ name }) => name === 'Browser: Reject a blank note');
  assert.equal(blank.status, 'failed');
  assert.match(blank.reason, /expected[^\n]*\b0\b/i);
  assert.match(blank.reason, /(?:actual|observed|found|received|got)[^\n]*\b1\b/i);
  const screenshot = await assertScreenshot(project.cwd, failedReport, blank);
  assert.ok(failedReport.requirements.find(({ id }) => id === 'reject-blank').checks.some((check) => check.artifacts.includes(screenshot)));
  await assert.rejects(fetch(project.baseUrl), 'verification must stop its managed demo server');

  const serverPath = join(project.cwd, 'server.js');
  const brokenSource = await readFile(serverPath, 'utf8');
  assert.equal(brokenSource.split('const text = input.value;').length, 2, 'fixture must contain the intentional UI bug');
  await writeFile(serverPath, brokenSource.replace('const text = input.value;', 'const text = normalizeNote(input.value);'));
  assert.equal(await readFile(project.configPath, 'utf8'), originalPlan, 'repair must preserve the acceptance plan');
  const repaired = await verify(t, project);
  assert.equal(repaired.code, 0, repaired.stderr);
  const repairedReport = JSON.parse(repaired.stdout);
  assert.equal(repairedReport.summary.status, 'passed');
  assert.deepEqual(requirementStatuses(repairedReport), { 'add-note': 'passed', 'reject-blank': 'passed' });
  assert.equal(await readFile(project.configPath, 'utf8'), originalPlan);
  await assert.rejects(fetch(project.baseUrl), 'verification must stop its managed demo server after repair');
});

test('the working notes example passes the same blank-note and add-note acceptance checks', {
  skip: !browserEnabled,
}, async (t) => {
  const project = await fixture(t, 'demo');
  const output = await verify(t, project);
  assert.equal(output.code, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, 'passed');
  assert.deepEqual(requirementStatuses(report), { 'add-note': 'passed', 'reject-blank': 'passed' });
  assert.equal(report.checks.find(({ name }) => name === 'Note validation').status, 'passed');
  await assertScreenshot(project.cwd, report, report.checks.find(({ name }) => name === 'Browser: Reject a blank note'));
  await assert.rejects(fetch(project.baseUrl), 'verification must stop its managed demo server');
});
