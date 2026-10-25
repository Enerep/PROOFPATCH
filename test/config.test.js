import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

async function project(t, files = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'proofpatch-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(path.join(directory, filename), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return directory;
}

const browser = {
  baseUrl: 'http://127.0.0.1:3000',
  scenarios: [{ name: 'Homepage' }],
};

test('discovers real scripts in a stable order and records missing scripts', async (t) => {
  const cwd = await project(t, {
    'package.json': { scripts: { build: 'node build.js', test: 'node --test', start: 'node server.js' } },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.checks, [
    { name: 'test', command: 'npm run test', timeoutMs: 120_000, requirements: [] },
    { name: 'build', command: 'npm run build', timeoutMs: 120_000, requirements: [] },
  ]);
  assert.deepEqual(config.skipped.map(({ name }) => name), ['lint', 'typecheck']);
  assert.equal(config.browser, null);
  assert.equal(config.source, 'package.json');
  assert.deepEqual(config.requirements, []);
});

test('uses a declared package manager and recognizes its matching lockfile', async (t) => {
  const cwd = await project(t, {
    'package.json': { packageManager: 'pnpm@10.0.0', scripts: { test: 'vitest run' } },
    'pnpm-lock.yaml': '',
  });
  assert.equal((await loadConfig(cwd)).checks[0].command, 'pnpm run test');
});

for (const [lockfile, manager] of [['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['npm-shrinkwrap.json', 'npm']]) {
  test(`detects ${manager} from ${lockfile}`, async (t) => {
    const cwd = await project(t, {
      'package.json': { scripts: { test: 'node --test' } },
      [lockfile]: '',
    });
    assert.equal((await loadConfig(cwd)).checks[0].command, `${manager} run test`);
  });
}

test('rejects conflicting lockfiles and conflicting package manager declarations', async (t) => {
  const cwd = await project(t, {
    'package.json': { scripts: { test: 'node --test' } },
    'package-lock.json': '',
    'yarn.lock': '',
  });
  await assert.rejects(loadConfig(cwd), /Conflicting package manager lockfiles/);
  await rm(path.join(cwd, 'yarn.lock'));
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ packageManager: 'bun@1.0.0', scripts: { test: 'node --test' } }));
  await assert.rejects(loadConfig(cwd), /selects bun, but the lockfile selects npm/);
});

test('fails with an actionable message when there is nothing to verify', async (t) => {
  const cwd = await project(t);
  await assert.rejects(loadConfig(cwd), (error) => {
    assert.match(error.message, /No checks found.*create proofpatch\.config\.json with a command check or browser scenario/);
    assert.doesNotMatch(error.message, /proofpatch init/);
    return true;
  });
  await writeFile(path.join(cwd, 'proofpatch.config.json'), JSON.stringify({ checks: [] }));
  await assert.rejects(loadConfig(cwd), /No checks found/);
});

test('explicit checks support non-Node projects and bypass package script discovery', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': { checks: [{ name: 'Python tests', command: 'python -m unittest', timeoutMs: 5000 }] },
    'package.json': 'invalid JSON that is irrelevant to explicit commands',
  });
  assert.deepEqual(await loadConfig(cwd), {
    checks: [{ name: 'Python tests', command: 'python -m unittest', timeoutMs: 5000, requirements: [] }],
    skipped: [],
    browser: null,
    requirements: [],
    source: 'proofpatch.config.json',
  });
});

test('browser-only configuration supplies defaults and validates each supported step', async (t) => {
  const steps = [
    { action: 'fill', selector: '#name', value: '' },
    { action: 'click', selector: 'button' },
    { action: 'expectVisible', selector: '#result' },
    { action: 'expectText', text: 'Hello', selector: '#result' },
    { action: 'expectText', text: 'Welcome' },
  ];
  const cwd = await project(t, {
    'proofpatch.config.json': { checks: [], browser: { ...browser, startCommand: 'npm start', scenarios: [{ name: 'Homepage', steps }] } },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.browser, {
    baseUrl: 'http://127.0.0.1:3000/',
    startupTimeoutMs: 30_000,
    timeoutMs: 15_000,
    startCommand: 'npm start',
    scenarios: [{ name: 'Homepage', path: '/', steps, requirements: [] }],
  });
  assert.deepEqual(config.checks, []);
  assert.deepEqual(config.skipped, []);
});

test('browser configuration can supplement discovered scripts', async (t) => {
  const cwd = await project(t, {
    'package.json': { scripts: { test: 'node --test' } },
    'proofpatch.config.json': { browser },
  });
  const config = await loadConfig(cwd);
  assert.equal(config.checks.length, 1);
  assert.equal(config.browser.scenarios[0].name, 'Homepage');
});

test('identifies malformed config and package JSON by filename', async (t) => {
  const cwd = await project(t, { 'proofpatch.config.json': '{oops' });
  await assert.rejects(loadConfig(cwd), /Invalid JSON in proofpatch\.config\.json/);
  await rm(path.join(cwd, 'proofpatch.config.json'));
  await writeFile(path.join(cwd, 'package.json'), '{oops');
  await assert.rejects(loadConfig(cwd), /Invalid JSON in package\.json/);
});

const invalidConfigurations = [
  ['null config', null, /must be an object/],
  ['typo in config', { check: [] }, /Unknown field.*check/],
  ['typo in check', { checks: [{ name: 'Tests', command: 'node --test', timoutMs: 20 }] }, /Unknown field.*timoutMs/],
  ['empty command', { checks: [{ name: 'Tests', command: ' ' }] }, /command must be a non-empty string/],
  ['empty name', { checks: [{ name: ' ', command: 'node --test' }] }, /name must be a non-empty string/],
  ['duplicate checks', { checks: [{ name: ' Tests ', command: 'true' }, { name: 'Tests', command: 'true' }] }, /duplicate name/],
  ['negative timeout', { checks: [{ name: 'Tests', command: 'true', timeoutMs: -1 }] }, /integer between/],
  ['oversized timeout', { checks: [{ name: 'Tests', command: 'true', timeoutMs: 3_600_001 }] }, /integer between/],
  ['fractional timeout', { checks: [{ name: 'Tests', command: 'true', timeoutMs: 0.5 }] }, /integer between/],
  ['unsupported browser field', { browser: { ...browser, retries: 3 } }, /Unknown field.*retries/],
  ['empty scenario list', { browser: { ...browser, scenarios: [] } }, /at least one scenario/],
  ['non-http URL', { browser: { ...browser, baseUrl: 'file:///tmp/index.html' } }, /HTTP or HTTPS/],
  ['credentials in URL', { browser: { ...browser, baseUrl: 'https://user:pass@example.com' } }, /without credentials/],
  ['fragment in base URL', { browser: { ...browser, baseUrl: 'https://example.com/#home' } }, /query string or fragment/],
  ['empty query in base URL', { browser: { ...browser, baseUrl: 'https://example.com/?' } }, /query string or fragment/],
  ['URL without an authority delimiter', { browser: { ...browser, baseUrl: 'https:example.com' } }, /absolute HTTP or HTTPS/],
  ['whitespace in base URL', { browser: { ...browser, baseUrl: ' https://example.com' } }, /absolute HTTP or HTTPS/],
  ['absolute scenario URL', { browser: { ...browser, scenarios: [{ name: 'Home', path: 'https://example.com/' }] } }, /single \/.*origin/],
  ['protocol-relative scenario URL', { browser: { ...browser, scenarios: [{ name: 'Home', path: '//example.com/' }] } }, /single \/.*origin/],
  ['backslash in scenario URL', { browser: { ...browser, scenarios: [{ name: 'Home', path: '/\\example.com/' }] } }, /single \/.*origin/],
  ['control character in scenario URL', { browser: { ...browser, scenarios: [{ name: 'Home', path: '/\n/example.com/' }] } }, /single \/.*origin/],
  ['duplicate scenarios', { browser: { ...browser, scenarios: [{ name: 'Home' }, { name: 'Home' }] } }, /duplicate name/],
  ['unsupported action', { browser: { ...browser, scenarios: [{ name: 'Home', steps: [{ action: 'wait' }] }] } }, /action must be/],
  ['missing selector', { browser: { ...browser, scenarios: [{ name: 'Home', steps: [{ action: 'click' }] }] } }, /selector must be/],
  ['missing fill value', { browser: { ...browser, scenarios: [{ name: 'Home', steps: [{ action: 'fill', selector: 'input' }] }] } }, /value must be a string/],
  ['typo in step', { browser: { ...browser, scenarios: [{ name: 'Home', steps: [{ action: 'click', selector: 'button', selctor: 'button' }] }] } }, /Unknown field.*selctor/],
];

test('accepts a case-insensitive HTTP scheme and normalizes the URL', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': { checks: [], browser: { ...browser, baseUrl: 'HTTP://localhost:3000' } },
  });
  assert.equal((await loadConfig(cwd)).browser.baseUrl, 'http://localhost:3000/');
});

for (const [name, config, expected] of invalidConfigurations) {
  test(`rejects ${name}`, async (t) => {
    const cwd = await project(t, { 'proofpatch.config.json': JSON.stringify(config) });
    await assert.rejects(loadConfig(cwd), expected);
  });
}

test('rejects unusable script and package manager declarations', async (t) => {
  const cwd = await project(t, { 'package.json': { scripts: { test: false } } });
  await assert.rejects(loadConfig(cwd), /scripts.test must be a non-empty string/);
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ packageManager: 'deno@2.0.0', scripts: { test: 'deno test' } }));
  await assert.rejects(loadConfig(cwd), /must name npm, pnpm, yarn, or bun/);
});

const requirements = [
  { id: 'signup', description: 'Visitors can create an account.' },
  { id: 'welcome-email', description: 'New accounts receive a welcome email.' },
];

test('normalizes declarations and preserves multiple command and scenario references', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': {
      requirements: requirements.map((requirement) => ({ ...requirement, description: `  ${requirement.description}\n` })),
      checks: [{ name: 'Signup tests', command: 'npm test', requirements: ['signup', 'welcome-email'] }],
      browser: { ...browser, scenarios: [{ name: 'Signup flow', requirements: ['signup'] }] },
    },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements, requirements);
  assert.deepEqual(config.checks[0].requirements, ['signup', 'welcome-email']);
  assert.deepEqual(config.browser.scenarios[0].requirements, ['signup']);
});

test('allows declared requirements without executable checks', async (t) => {
  const cwd = await project(t, { 'proofpatch.config.json': { requirements, checks: [] } });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements, requirements);
  assert.deepEqual(config.checks, []);
  assert.deepEqual(config.skipped, []);
  assert.equal(config.browser, null);
});

test('requirement-only plans can omit checks and discover none', async (t) => {
  const cwd = await project(t, { 'proofpatch.config.json': { requirements } });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements, requirements);
  assert.deepEqual(config.checks, []);
  assert.deepEqual(config.skipped.map(({ name }) => name), ['test', 'lint', 'typecheck', 'build']);
});

test('declared requirements do not implicitly map discovered scripts', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': { requirements },
    'package.json': { scripts: { test: 'node --test' } },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements, requirements);
  assert.deepEqual(config.checks[0].requirements, []);
});

test('legacy configurations receive empty requirement arrays at every supported level', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': { checks: [{ name: 'Tests', command: 'npm test' }], browser },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements, []);
  assert.deepEqual(config.checks[0].requirements, []);
  assert.deepEqual(config.browser.scenarios[0].requirements, []);
});

test('accepts requirement IDs at the one-character and 64-character boundaries', async (t) => {
  const ids = ['a', `a${'9'.repeat(63)}`];
  const cwd = await project(t, {
    'proofpatch.config.json': { requirements: ids.map((id) => ({ id, description: 'A requirement.' })), checks: [{ name: 'Tests', command: 'npm test', requirements: ids }] },
  });
  const config = await loadConfig(cwd);
  assert.deepEqual(config.requirements.map(({ id }) => id), ids);
  assert.deepEqual(config.checks[0].requirements, ids);
});

const invalidRequirements = [
  ['null declaration list', null, /requirements must be an array/],
  ['non-array declaration list', {}, /requirements must be an array/],
  ['null declaration', [null], /requirements\[0\] must be an object/],
  ['missing ID', [{ description: 'Some behavior.' }], /requirements\[0\]\.id must be a lowercase slug/],
  ['empty ID', [{ id: '', description: 'Some behavior.' }], /must be a lowercase slug/],
  ['uppercase ID', [{ id: 'Signup', description: 'Some behavior.' }], /must be a lowercase slug/],
  ['digit-leading ID', [{ id: '1-signup', description: 'Some behavior.' }], /must be a lowercase slug/],
  ['underscore in ID', [{ id: 'welcome_email', description: 'Some behavior.' }], /must be a lowercase slug/],
  ['oversized ID', [{ id: `a${'b'.repeat(64)}`, description: 'Some behavior.' }], /must be a lowercase slug/],
  ['whitespace in ID', [{ id: 'signup\n', description: 'Some behavior.' }], /must be a lowercase slug/],
  ['duplicate IDs', [requirements[0], requirements[0]], /duplicate ID "signup"/],
  ['missing description', [{ id: 'signup' }], /description must be a non-empty string/],
  ['blank description', [{ id: 'signup', description: ' \n ' }], /description must be a non-empty string/],
  ['non-string description', [{ id: 'signup', description: 7 }], /description must be a non-empty string/],
  ['unknown declaration field', [{ ...requirements[0], priority: 'high' }], /Unknown field requirements\[0\]\.priority/],
];

for (const [name, invalid, expected] of invalidRequirements) {
  test(`rejects ${name}`, async (t) => {
    const cwd = await project(t, {
      'proofpatch.config.json': { requirements: invalid, checks: [{ name: 'Tests', command: 'npm test' }] },
    });
    await assert.rejects(loadConfig(cwd), expected);
  });
}

const invalidReferences = [
  ['null reference list', null, /must be an array of requirement IDs/],
  ['non-array reference list', 'signup', /must be an array of requirement IDs/],
  ['empty reference', [''], /must be a lowercase slug/],
  ['non-string reference', [null], /must be a lowercase slug/],
  ['malformed reference', ['SignUp'], /must be a lowercase slug/],
  ['unknown reference', ['unknown'], /refers to undeclared requirement "unknown"/],
  ['duplicate references', ['signup', 'signup'], /duplicate requirement ID "signup"/],
];

for (const [name, references, expected] of invalidReferences) {
  for (const kind of ['command', 'scenario']) {
    test(`rejects ${name} in a ${kind}`, async (t) => {
      const config = kind === 'command'
        ? { requirements, checks: [{ name: 'Tests', command: 'npm test', requirements: references }] }
        : { requirements, checks: [], browser: { ...browser, scenarios: [{ name: 'Homepage', requirements: references }] } };
      const cwd = await project(t, { 'proofpatch.config.json': config });
      await assert.rejects(loadConfig(cwd), expected);
    });
  }
}

test('references cannot be used without a declaration', async (t) => {
  const cwd = await project(t, {
    'proofpatch.config.json': { checks: [{ name: 'Tests', command: 'npm test', requirements: ['signup'] }] },
  });
  await assert.rejects(loadConfig(cwd), /refers to undeclared requirement "signup"/);
});

test('an empty requirements list does not make an empty plan valid', async (t) => {
  const cwd = await project(t, { 'proofpatch.config.json': { requirements: [], checks: [] } });
  await assert.rejects(loadConfig(cwd), /No checks found/);
});
