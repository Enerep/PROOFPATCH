import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proofpatch.js', import.meta.url));
const passingConfig = { checks: [{ name: 'Command check', command: 'node check.cjs' }] };
const incompleteConfig = {
  checks: [], requirements: [{ id: 'save-note', description: 'Users can save a note.' }],
};

async function fixture(t, config = passingConfig) {
  const cwd = await mkdtemp(join(tmpdir(), 'proofpatch github cli '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'proofpatch.config.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'check.cjs'), 'console.log("check completed");');
  const summaryFile = join(cwd, 'step summary.md');
  const outputFile = join(cwd, 'step output.txt');
  await writeFile(summaryFile, 'Earlier step summary.\n');
  await writeFile(outputFile, 'earlier=unchanged\n');
  return { cwd, summaryFile, outputFile, env: { GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile } };
}

function environment(overrides = {}) {
  const env = { ...process.env, PROOFPATCH_RUNNING: '' };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_OUTPUT;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

function run(cwd, args = ['verify', '--github', '--json'], env = {}) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cli, ...args], {
      cwd, env: environment(env), timeout: 15_000,
    }, (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr }));
  });
}

// GitHub supports both single-line values and delimiter blocks in GITHUB_OUTPUT.
function parseOutputs(contents) {
  const values = {};
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    const block = /^([^=]+)<<(.+)$/.exec(line);
    if (block) {
      const value = [];
      while (++index < lines.length && lines[index] !== block[2]) value.push(lines[index]);
      assert.ok(index < lines.length, `Output ${block[1]} has a closing delimiter.`);
      values[block[1]] = value.join('\n');
    } else {
      const separator = line.indexOf('=');
      assert.ok(separator > 0, `Valid GitHub output line: ${line}`);
      values[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return values;
}

async function assertEvidence(f, output, status) {
  const report = JSON.parse(output.stdout);
  assert.equal(report.summary.status, status);
  const runDirectory = resolve(f.cwd, report.reportDirectory);
  const reportFile = join(runDirectory, 'report.json');
  assert.deepEqual(JSON.parse(await readFile(reportFile, 'utf8')), report);
  const outputs = parseOutputs(await readFile(f.outputFile, 'utf8'));
  assert.deepEqual(outputs, {
    earlier: 'unchanged', 'report-directory': runDirectory, 'report-json': reportFile, result: status,
  });
  assert.ok(isAbsolute(outputs['report-directory']));
  assert.ok(isAbsolute(outputs['report-json']));
  const summary = await readFile(f.summaryFile, 'utf8');
  assert.ok(summary.startsWith('Earlier step summary.\n'));
  assert.match(summary, /ProofPatch/);
  assert.match(summary, new RegExp(status, 'i'));
  return { report, summary, outputs };
}

test('--github appends exact current-run paths and preserves JSON stdout with spaces and stale evidence', async (t) => {
  const f = await fixture(t);
  const staleDirectory = join(f.cwd, '.proofpatch', 'zzzz-stale-run');
  await mkdir(staleDirectory, { recursive: true });
  const stale = '{"stale":true}\n';
  await writeFile(join(staleDirectory, 'report.json'), stale);
  const output = await run(f.cwd, undefined, f.env);
  assert.equal(output.code, 0, output.stderr);
  const { outputs } = await assertEvidence(f, output, 'passed');
  assert.notEqual(outputs['report-directory'], staleDirectory);
  assert.equal(await readFile(join(staleDirectory, 'report.json'), 'utf8'), stale);
  assert.match(output.stderr, /RUN\s+Command check/);
});

test('--github also writes metadata in the normal human-readable CLI mode', async (t) => {
  const f = await fixture(t);
  const output = await run(f.cwd, ['verify', '--github'], f.env);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /PASSED/);
  const outputs = parseOutputs(await readFile(f.outputFile, 'utf8'));
  assert.equal(outputs.result, 'passed');
  assert.ok(isAbsolute(outputs['report-directory']));
  assert.equal(outputs['report-json'], join(outputs['report-directory'], 'report.json'));
  assert.equal(JSON.parse(await readFile(outputs['report-json'], 'utf8')).summary.status, 'passed');
  assert.match(await readFile(f.summaryFile, 'utf8'), /passed/i);
});

for (const failed of [false, true]) {
  test(`without --github a ${failed ? 'failed' : 'passing'} run never writes runner metadata`, async (t) => {
    const f = await fixture(t);
    if (failed) await writeFile(join(f.cwd, 'check.cjs'), 'process.exitCode = 4;');
    const output = await run(f.cwd, ['verify', '--json'], f.env);
    assert.equal(output.code, failed ? 1 : 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).summary.status, failed ? 'failed' : 'passed');
    assert.equal(await readFile(f.summaryFile, 'utf8'), 'Earlier step summary.\n');
    assert.equal(await readFile(f.outputFile, 'utf8'), 'earlier=unchanged\n');
  });
}

for (const missing of ['both', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) {
  test(`--github rejects missing ${missing} runner environment before executing checks`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.cwd, 'check.cjs'), 'require("node:fs").writeFileSync("command-ran", "yes");');
    const env = missing === 'both' ? {} : { ...f.env, [missing]: undefined };
    const output = await run(f.cwd, undefined, env);
    assert.equal(output.code, 2, output.stderr);
    assert.match(output.stderr, /GITHUB_STEP_SUMMARY|GITHUB_OUTPUT/);
    if (missing !== 'both') assert.match(output.stderr, new RegExp(missing));
    assert.match(output.stderr, /GitHub|runner|--github/i);
    await assert.rejects(readFile(join(f.cwd, 'command-ran')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(f.cwd, '.proofpatch')), { code: 'ENOENT' });
    assert.equal(await readFile(f.outputFile, 'utf8'), 'earlier=unchanged\n');
  });
}

test('configuration errors append an error summary without outputs or an evidence directory', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'proofpatch.config.json'), '{bad JSON');
  const output = await run(f.cwd, undefined, f.env);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /Invalid JSON/);
  const summary = await readFile(f.summaryFile, 'utf8');
  assert.ok(summary.startsWith('Earlier step summary.\n'));
  assert.match(summary, /ProofPatch/);
  assert.match(summary, /error/i);
  assert.match(summary, /JSON/);
  assert.equal(await readFile(f.outputFile, 'utf8'), 'earlier=unchanged\n');
  await assert.rejects(readFile(join(f.cwd, '.proofpatch')), { code: 'ENOENT' });
  assert.equal(output.stdout.trim(), '');
});

test('--github preserves a failed verification exit and publishes failed evidence', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'check.cjs'), 'console.error("regression found"); process.exitCode = 7;');
  const output = await run(f.cwd, undefined, f.env);
  assert.equal(output.code, 1);
  const { report, summary } = await assertEvidence(f, output, 'failed');
  assert.equal(report.checks.find(({ name }) => name === 'Command check').exitCode, 7);
  assert.match(summary, /Command check/);
});

test('--github publishes incomplete evidence without turning requirement gaps into a pass', async (t) => {
  const f = await fixture(t, incompleteConfig);
  const output = await run(f.cwd, undefined, f.env);
  assert.equal(output.code, 1);
  const { report, summary } = await assertEvidence(f, output, 'incomplete');
  assert.equal(report.requirements[0].status, 'unverified');
  assert.match(summary, /save-note/);
});

for (const file of ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) {
  test(`a ${file} write failure makes a passing verification exit 2 and retains its report`, async (t) => {
    const f = await fixture(t);
    const output = await run(f.cwd, undefined, { ...f.env, [file]: f.cwd });
    assert.equal(output.code, 2);
    assert.match(output.stderr, /GitHub|metadata|summary|output/i);
    const report = JSON.parse(output.stdout);
    assert.equal(report.summary.status, 'passed');
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, report.reportDirectory, 'report.json'), 'utf8')), report);
  });
}

for (const status of ['failed', 'incomplete']) {
  test(`metadata write failures preserve ${status} verification exit 1`, async (t) => {
    const f = await fixture(t, status === 'incomplete' ? incompleteConfig : passingConfig);
    if (status === 'failed') await writeFile(join(f.cwd, 'check.cjs'), 'process.exitCode = 1;');
    const output = await run(f.cwd, undefined, { ...f.env, GITHUB_OUTPUT: f.cwd });
    assert.equal(output.code, 1);
    assert.match(output.stderr, /GitHub|metadata|summary|output/i);
    const report = JSON.parse(output.stdout);
    assert.equal(report.summary.status, status);
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, report.reportDirectory, 'report.json'), 'utf8')), report);
  });
}

async function interruptRun(t, f, env) {
  await writeFile(join(f.cwd, 'check.cjs'), 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [cli, 'verify', '--github', '--json'], {
    cwd: f.cwd, env: environment(env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timer;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (!timer && stderr.includes('RUN')) timer = setTimeout(() => child.kill('SIGINT'), 150);
  });
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const code = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', resolveResult);
  });
  return { code, stdout, stderr };
}

test('--github saves and publishes an interrupted partial report with exit 130', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const output = await interruptRun(t, f, f.env);
  assert.equal(output.code, 130, output.stderr);
  const { report } = await assertEvidence(f, output, 'failed');
  assert.equal(report.interrupted, true);
});

test('metadata write failures preserve an interrupted exit 130', {
  skip: process.platform === 'win32', timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const output = await interruptRun(t, f, { ...f.env, GITHUB_OUTPUT: f.cwd });
  assert.equal(output.code, 130, output.stderr);
  assert.match(output.stderr, /GitHub|metadata|summary|output/i);
  const report = JSON.parse(output.stdout);
  assert.equal(report.interrupted, true);
  assert.equal(report.summary.status, 'failed');
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, report.reportDirectory, 'report.json'), 'utf8')), report);
});
