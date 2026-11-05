import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readlink, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/proofpatch.js', import.meta.url));
const reviewedCommit = '6a9faf310c95ba13cc4e6d9f1be4fdd6e1cf8f8a';

async function fixture(t, { scripts = { test: 'node side-effect.cjs' }, config } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proofpatch-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'application with spaces');
  const caller = join(directory, 'caller');
  await Promise.all([mkdir(cwd), mkdir(caller)]);
  await writeFile(join(cwd, 'side-effect.cjs'), 'require("node:fs").writeFileSync("command-ran", "unexpected"); process.exitCode = 97;');
  const manifest = {
    name: 'init-fixture', version: '1.0.0',
    scripts: { ...scripts, preinstall: 'node side-effect.cjs', postinstall: 'node side-effect.cjs' },
  };
  await writeFile(join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version } },
  }));
  if (config !== undefined) await writeFile(join(cwd, 'proofpatch.config.json'), config);
  return { cwd, caller, configFile: join(cwd, 'proofpatch.config.json'), workflow: join(cwd, '.github', 'workflows', 'proofpatch.yml') };
}

function run(cwd, args, overrides = {}) {
  const env = { ...process.env, PROOFPATCH_RUNNING: '' };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_OUTPUT;
  Object.assign(env, overrides);
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cli, ...args], { cwd, env, timeout: 15_000 }, (error, stdout, stderr) => {
      resolveResult({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

async function unchangedProject(f) {
  await absent(join(f.cwd, 'command-ran'));
  await absent(join(f.cwd, '.proofpatch'));
  await absent(join(f.cwd, 'node_modules'));
  await absent(join(f.cwd, '.git'));
}

async function noGeneratedFiles(f) {
  await absent(f.configFile);
  await absent(f.workflow);
  await unchangedProject(f);
}

function checkWorkflow(workflow) {
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(workflow, /pull_request_target|contents:\s*write/);
  assert.match(workflow, /working-directory:\s*app/);
  assert.match(workflow, /path:\s*app\s*\n/);
  assert.match(workflow, /repository:\s*Enerep\/PROOFPATCH/);
  assert.match(workflow, new RegExp(`ref:\\s*${reviewedCommit}\\s*\\n`));
  assert.match(workflow, /path:\s*proofpatch\s*\n/);
  assert.match(workflow, /node \.\.\/proofpatch\/bin\/proofpatch\.js verify --github/);
  assert.match(workflow, /if:.*always\(\).*steps\.proofpatch\.outputs\.report-directory/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@/);
  assert.match(workflow, /path:\s*\$\{\{\s*steps\.proofpatch\.outputs\.report-directory\s*\}\}/);
  assert.match(workflow, /include-hidden-files:\s*true/);
}

test('init --github creates a usable local plan and workflow from another cwd without running tools', async (t) => {
  const f = await fixture(t, { scripts: { build: 'node side-effect.cjs', test: 'node side-effect.cjs' } });
  const manifestBefore = await readFile(join(f.cwd, 'package.json'), 'utf8');
  const lockBefore = await readFile(join(f.cwd, 'package-lock.json'), 'utf8');
  const env = {};
  const toolMarker = join(f.cwd, 'external-tool-ran');
  if (process.platform !== 'win32') {
    const tools = join(f.cwd, 'unused tools');
    await mkdir(tools);
    const quotedMarker = `'${toolMarker.replaceAll("'", "'\\''")}'`;
    for (const name of ['npm', 'npx', 'git', 'curl', 'wget', 'pnpm', 'yarn', 'bun']) {
      await writeFile(join(tools, name), `#!/bin/sh\n: > ${quotedMarker}\nexit 97\n`, { mode: 0o755 });
    }
    env.PATH = tools;
  }
  const output = await run(f.caller, ['init', '--github', '--cwd', f.cwd], env);
  assert.equal(output.code, 0, output.stderr);
  const config = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.deepEqual(config.checks.map(({ name, command }) => ({ name, command })), [
    { name: 'test', command: 'npm run test' }, { name: 'build', command: 'npm run build' },
  ]);
  const workflow = await readFile(f.workflow, 'utf8');
  checkWorkflow(workflow);
  assert.match(workflow, /cache-dependency-path:\s*app\/package-lock\.json/);
  assert.doesNotMatch(workflow, /install --with-deps chromium/);
  assert.equal(await readFile(join(f.cwd, 'package.json'), 'utf8'), manifestBefore);
  assert.equal(await readFile(join(f.cwd, 'package-lock.json'), 'utf8'), lockBefore);
  await absent(join(f.caller, 'proofpatch.config.json'));
  await absent(join(f.caller, '.github'));
  await absent(toolMarker);
  await unchangedProject(f);
});

test('npm-shrinkwrap projects get the matching dependency cache path', async (t) => {
  const f = await fixture(t);
  const lock = await readFile(join(f.cwd, 'package-lock.json'), 'utf8');
  await rm(join(f.cwd, 'package-lock.json'));
  await writeFile(join(f.cwd, 'npm-shrinkwrap.json'), lock);
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 0, output.stderr);
  const workflow = await readFile(f.workflow, 'utf8');
  assert.match(workflow, /cache-dependency-path:\s*app\/npm-shrinkwrap\.json/);
  assert.doesNotMatch(workflow, /app\/package-lock\.json/);
  assert.equal(await readFile(join(f.cwd, 'npm-shrinkwrap.json'), 'utf8'), lock);
  await unchangedProject(f);
});

test('existing browser and requirement configuration is preserved byte for byte', async (t) => {
  const config = `${JSON.stringify({
    requirements: [{ id: 'reject-blank', description: 'Blank notes are rejected.' }],
    checks: [{ name: 'Validation', command: 'node side-effect.cjs', requirements: ['reject-blank'] }],
    browser: {
      baseUrl: 'http://127.0.0.1:3000', startCommand: 'node side-effect.cjs',
      scenarios: [{ name: 'Blank notes', requirements: ['reject-blank'], steps: [{ action: 'expectCount', selector: '.note', count: 0, forMs: 100 }] }],
    },
  }, null, 4).replaceAll('\n', '\r\n')}\r\n\r\n`;
  const f = await fixture(t, { config });
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(await readFile(f.configFile, 'utf8'), config);
  const workflow = await readFile(f.workflow, 'utf8');
  checkWorkflow(workflow);
  assert.match(workflow, /playwright\/cli\.js install --with-deps chromium/);
  await unchangedProject(f);
});

test('an existing command-only config stays intact and needs no Chromium installation', async (t) => {
  const config = ' { "requirements": [{"id":"validate", "description":"Validate notes."}], "checks": [{"name":"Custom", "command":"node side-effect.cjs", "requirements":["validate"]}], "browser": null }\n';
  const f = await fixture(t, { config });
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(await readFile(f.configFile, 'utf8'), config);
  assert.doesNotMatch(await readFile(f.workflow, 'utf8'), /install --with-deps chromium/);
  await unchangedProject(f);
});

for (const extension of ['yml', 'yaml']) {
  test(`an existing proofpatch.${extension} is refused before generating configuration`, async (t) => {
    const f = await fixture(t);
    const existing = join(f.cwd, '.github', 'workflows', `proofpatch.${extension}`);
    await mkdir(join(f.cwd, '.github', 'workflows'), { recursive: true });
    const original = '# Maintainer workflow\nname: Preserve me\n';
    await writeFile(existing, original);
    const output = await run(f.cwd, ['init', '--github']);
    assert.equal(output.code, 2);
    assert.match(output.stderr, /already exists|existing workflow/i);
    assert.equal(await readFile(existing, 'utf8'), original);
    await absent(f.configFile);
    if (extension === 'yaml') await absent(f.workflow);
    await unchangedProject(f);
  });
}

test('rerunning setup preserves the generated configuration and workflow', async (t) => {
  const f = await fixture(t);
  const first = await run(f.cwd, ['init', '--github']);
  assert.equal(first.code, 0, first.stderr);
  const originalConfig = await readFile(f.configFile, 'utf8');
  const originalWorkflow = await readFile(f.workflow, 'utf8');
  const second = await run(f.cwd, ['init', '--github']);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists|existing workflow/i);
  assert.equal(await readFile(f.configFile, 'utf8'), originalConfig);
  assert.equal(await readFile(f.workflow, 'utf8'), originalWorkflow);
  await unchangedProject(f);
});

test('invalid configuration fails before creating a workflow or writing GitHub runner metadata', async (t) => {
  const config = '{ invalid JSON';
  const f = await fixture(t, { config });
  const summaryFile = join(f.caller, 'summary.md');
  const outputFile = join(f.caller, 'output.txt');
  await writeFile(summaryFile, 'Earlier summary.\n');
  await writeFile(outputFile, 'earlier=unchanged\n');
  const output = await run(f.cwd, ['init', '--github'], { GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile });
  assert.equal(output.code, 2);
  assert.match(output.stderr, /Invalid JSON.*proofpatch\.config\.json/);
  assert.equal(await readFile(f.configFile, 'utf8'), config);
  await absent(f.workflow);
  assert.equal(await readFile(summaryFile, 'utf8'), 'Earlier summary.\n');
  assert.equal(await readFile(outputFile, 'utf8'), 'earlier=unchanged\n');
  await unchangedProject(f);
});

test('projects without discoverable checks get an actionable error without generated files', async (t) => {
  const f = await fixture(t, { scripts: { start: 'node side-effect.cjs' } });
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /No checks found|add.*check/i);
  await noGeneratedFiles(f);
});

test('an npm lockfile is required before workflow generation', async (t) => {
  const f = await fixture(t);
  await rm(join(f.cwd, 'package-lock.json'));
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /package-lock\.json|npm-shrinkwrap\.json/);
  await noGeneratedFiles(f);
});

test('a package manifest is required before workflow generation', async (t) => {
  const f = await fixture(t);
  await rm(join(f.cwd, 'package.json'));
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /package\.json/);
  await noGeneratedFiles(f);
});

for (const [manager, lockfile] of [['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock']]) {
  test(`${manager} projects are refused before npm workflow files are written`, async (t) => {
    const f = await fixture(t);
    const manifest = JSON.parse(await readFile(join(f.cwd, 'package.json'), 'utf8'));
    manifest.packageManager = `${manager}@1.0.0`;
    await writeFile(join(f.cwd, 'package.json'), JSON.stringify(manifest));
    await rm(join(f.cwd, 'package-lock.json'));
    await writeFile(join(f.cwd, lockfile), '');
    const output = await run(f.cwd, ['init', '--github']);
    assert.equal(output.code, 2);
    assert.match(output.stderr, /npm/);
    assert.match(output.stderr, new RegExp(manager));
    await noGeneratedFiles(f);
  });
}

test('an explicit configuration cannot bypass conflicting package-manager lockfiles', async (t) => {
  const config = '{"checks":[{"name":"Custom","command":"node side-effect.cjs"}]}\n';
  const f = await fixture(t, { config });
  await writeFile(join(f.cwd, 'pnpm-lock.yaml'), '');
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /conflicting.*lockfiles/i);
  assert.equal(await readFile(f.configFile, 'utf8'), config);
  await absent(f.workflow);
  await unchangedProject(f);
});

test('dangling workflow symlinks are preserved and block setup', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.github', 'workflows'), { recursive: true });
  const missingTarget = join(f.cwd, 'missing-workflow.yml');
  await symlink(missingTarget, f.workflow);
  const output = await run(f.cwd, ['init', '--github']);
  assert.equal(output.code, 2);
  assert.match(output.stderr, /already exists|existing workflow/i);
  assert.equal(await readlink(f.workflow), missingTarget);
  await absent(missingTarget);
  await absent(f.configFile);
  await unchangedProject(f);
});

for (const linkedDirectory of ['.github', '.github/workflows']) {
  test(`a ${linkedDirectory} directory symlink cannot send generated files outside the project`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const f = await fixture(t);
    const outside = join(f.caller, 'maintainer directory');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'Maintainer content.\n');
    if (linkedDirectory === '.github/workflows') {
      await mkdir(join(f.cwd, '.github'));
      await writeFile(join(f.cwd, '.github', 'keep.txt'), 'Existing GitHub configuration.\n');
    }
    const linkPath = join(f.cwd, linkedDirectory);
    await symlink(outside, linkPath, 'dir');
    const projectEntries = (await readdir(f.cwd)).sort();
    const githubEntries = linkedDirectory === '.github/workflows'
      ? (await readdir(join(f.cwd, '.github'))).sort()
      : null;
    const output = await run(f.cwd, ['init', '--github']);
    assert.equal(output.code, 2);
    assert.match(output.stderr, /symlink|symbolic link/i);
    assert.equal(await readlink(linkPath), outside);
    assert.deepEqual((await readdir(outside)).sort(), ['keep.txt']);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'Maintainer content.\n');
    assert.deepEqual((await readdir(f.cwd)).sort(), projectEntries);
    if (githubEntries) {
      assert.deepEqual((await readdir(join(f.cwd, '.github'))).sort(), githubEntries);
      assert.equal(await readFile(join(f.cwd, '.github', 'keep.txt'), 'utf8'), 'Existing GitHub configuration.\n');
    }
    await noGeneratedFiles(f);
  });
}
