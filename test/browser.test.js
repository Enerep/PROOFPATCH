import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserChecks } from '../src/browser.js';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'proofpatch-browser-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, runDir: path.join(cwd, 'reports') };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function config(baseUrl, extra = {}) {
  return {
    baseUrl, timeoutMs: 2_000, startupTimeoutMs: 500,
    scenarios: [{ name: 'Home', path: '/', steps: [] }], ...extra,
  };
}

test('rejects paths that could navigate to a different origin', async (t) => {
  const options = await fixture(t);
  for (const scenarioPath of ['//example.com/', '/\\example.com/', 'https://example.com']) {
    const results = await runBrowserChecks(config('http://127.0.0.1:3000', {
      scenarios: [{ name: 'Escape', path: scenarioPath, steps: [] }],
    }), options);
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /origin|single slash/);
  }
});

test('does not start a command when an existing server occupies the configured URL', async (t) => {
  const options = await fixture(t);
  const baseUrl = await listen(t, (_request, response) => response.end('existing server'));
  const results = await runBrowserChecks(config(baseUrl, {
    startCommand: 'this-command-must-not-run',
  }), options);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /already responding/);
  assert.equal(await (await fetch(baseUrl)).text(), 'existing server');
});

test('reports a server that exits early and records its output', async (t) => {
  const options = await fixture(t);
  const script = path.join(options.cwd, 'server.cjs');
  await writeFile(script, 'console.error("fixture startup failed"); process.exit(7);');
  const baseUrl = `http://127.0.0.1:${await availablePort()}`;
  const results = await runBrowserChecks(config(baseUrl, {
    startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  }), options);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /exit 7/);
  assert.match(await readFile(path.join(options.runDir, 'browser-server.log'), 'utf8'), /fixture startup failed/);
});

test('stops its server when startup never becomes healthy', async (t) => {
  const options = await fixture(t);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const script = path.join(options.cwd, 'server.cjs');
  await writeFile(script, `require('node:http').createServer((req, res) => { res.writeHead(503); res.end('not ready'); }).listen(${port}, '127.0.0.1');`);
  const results = await runBrowserChecks(config(baseUrl, {
    startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  }), options);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /not ready/);
  await assert.rejects(fetch(baseUrl));
});

test('stops its server when startup is interrupted', async (t) => {
  const options = await fixture(t);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const script = path.join(options.cwd, 'server.cjs');
  await writeFile(script, `require('node:http').createServer((req, res) => { res.writeHead(503); res.end(); }).listen(${port}, '127.0.0.1');`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  t.after(() => clearTimeout(timer));
  const results = await runBrowserChecks(config(baseUrl, {
    startupTimeoutMs: 5_000,
    startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  }), { ...options, signal: controller.signal });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /interrupted/);
  await assert.rejects(fetch(baseUrl));
});

const browserEnabled = Boolean(process.env.PROOFPATCH_BROWSER_TESTS || process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH);

test('real Chromium exercises interactions and records page errors and failed assertions', { skip: !browserEnabled }, async (t) => {
  const options = await fixture(t);
  const baseUrl = await listen(t, (request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/error') {
      response.end('<h1>Broken page</h1><script>throw new Error("fixture page crash")</script>');
      return;
    }
    if (request.url === '/console-error') {
      response.end('<h1>Console error</h1><script>console.error("fixture console failure")</script>');
      return;
    }
    if (request.url === '/http-error') {
      response.writeHead(500);
      response.end('<h1>Server error</h1>');
      return;
    }
    if (request.url === '/hidden') {
      response.end('<h1>Visible heading</h1><p style="display: none">Secret hidden proof</p><p style="visibility: hidden">Invisible proof</p><section style="opacity: 0"><p>Transparent proof</p></section>');
      return;
    }
    if (request.url === '/resource-error') {
      response.end('<h1>Failed resource</h1><img src="/broken.svg">');
      return;
    }
    if (request.url === '/broken.svg') {
      response.writeHead(503);
      response.end('resource unavailable');
      return;
    }
    response.end('<input aria-label="Name"><button onclick="setTimeout(() => document.querySelector(\'p\').textContent = \'Hello \' + document.querySelector(\'input\').value, 100)">Greet</button><p></p>');
  });
  const results = await runBrowserChecks(config(baseUrl, {
    scenarios: [
      { name: 'Greeting', path: '/', steps: [
        { action: 'fill', selector: 'input', value: 'ProofPatch' },
        { action: 'click', selector: 'button' },
        { action: 'expectVisible', selector: 'p' },
        { action: 'expectText', selector: 'p', text: 'Hello ProofPatch' },
      ] },
      { name: 'Runtime error', path: '/error', steps: [] },
      { name: 'Console error', path: '/console-error', steps: [] },
      { name: 'HTTP error', path: '/http-error', steps: [] },
      { name: 'Missing text', path: '/', steps: [{ action: 'expectText', text: 'This does not exist' }] },
      { name: 'Hidden text', path: '/hidden', steps: [{ action: 'expectText', text: 'Secret hidden proof' }] },
      { name: 'Resource error', path: '/resource-error', steps: [] },
      { name: 'Invisible text', path: '/hidden', steps: [{ action: 'expectText', text: 'Invisible proof' }] },
      { name: 'Transparent text', path: '/hidden', steps: [{ action: 'expectText', text: 'Transparent proof' }] },
    ],
  }), options);
  assert.equal(results.length, 9);
  assert.equal(results[0].status, 'passed', JSON.stringify(results[0]));
  assert.equal(results[0].details.completedSteps, 4);
  assert.deepEqual(results[0].details.steps, [
    { action: 'fill', selector: 'input', value: '[redacted]' },
    { action: 'click', selector: 'button' },
    { action: 'expectVisible', selector: 'p' },
    { action: 'expectText', selector: 'p', text: 'Hello ProofPatch' },
  ]);
  assert.equal(results[1].status, 'failed');
  assert.match(results[1].details.pageErrors.join('\n'), /fixture page crash/);
  assert.equal(results[2].status, 'failed');
  assert.match(results[2].details.consoleErrors.join('\n'), /fixture console failure/);
  assert.equal(results[3].status, 'failed');
  assert.match(results[3].reason, /HTTP 500/);
  assert.equal(results[4].status, 'failed');
  assert.equal(results[5].status, 'failed');
  assert.match(results[5].reason, /Visible text was not found/);
  assert.equal(results[6].status, 'failed');
  assert.match(results[6].details.httpErrors.join('\n'), /HTTP 503 .*broken\.svg/);
  for (const result of results.slice(7)) {
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /Visible text was not found/);
  }
  for (const result of results) {
    const screenshot = result.artifacts.find((artifact) => artifact.endsWith('.png'));
    assert.ok(screenshot, JSON.stringify(result));
    assert.ok((await readFile(path.join(options.runDir, screenshot))).length > 100);
  }
});

test('interrupting Chromium launch lets the whole host exit promptly and stops owned processes', {
  skip: !browserEnabled || process.platform === 'win32',
}, async (t) => {
  const options = await fixture(t);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const script = path.join(options.cwd, 'server.cjs');
  await writeFile(script, `require('node:http').createServer((req, res) => res.end('healthy')).listen(${port}, '127.0.0.1');`);
  const actualExecutable = process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH || (await import('playwright')).chromium.executablePath();
  const wrapper = path.join(options.cwd, 'slow-chromium.sh');
  const pidFile = path.join(options.cwd, 'chromium.pid');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nsleep 6\nexec ${quote(actualExecutable)} "$@"\n`);
  await chmod(wrapper, 0o755);
  const browserConfig = config(baseUrl, {
    startupTimeoutMs: 2_000, timeoutMs: 10_000,
    startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  });
  const hostScript = path.join(options.cwd, 'host.mjs');
  await writeFile(hostScript, `
    import { runBrowserChecks } from ${JSON.stringify(new URL('../src/browser.js', import.meta.url).href)};
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    const results = await runBrowserChecks(${JSON.stringify(browserConfig)}, {
      ...${JSON.stringify(options)}, signal: controller.signal,
    });
    console.log(JSON.stringify(results));
    process.exitCode = 130;
  `);
  const host = spawn(process.execPath, [hostScript], {
    env: { ...process.env, PROOFPATCH_CHROMIUM_EXECUTABLE_PATH: wrapper },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (host.exitCode === null) host.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  host.stdout.on('data', (chunk) => { stdout += chunk; });
  host.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    host.once('error', reject);
    host.once('close', (code, signal) => resolve({ code, signal }));
  });
  let pid;
  const launchDeadline = Date.now() + 3_000;
  while (Date.now() < launchDeadline) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(25); }
  }
  assert.ok(pid, 'the delayed Chromium executable must have started');
  const interruptedAt = performance.now();
  host.kill('SIGINT');
  let exitTimer;
  const exit = await Promise.race([
    exited,
    new Promise((_resolve, reject) => {
      exitTimer = setTimeout(() => reject(new Error('the whole host must exit within two seconds of interruption')), 2_000);
    }),
  ]).finally(() => clearTimeout(exitTimer));
  assert.ok(performance.now() - interruptedAt < 2_000);
  assert.equal(exit.code, 130, stderr);
  const results = JSON.parse(stdout);
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].reason, /interrupted/);
  await assert.rejects(fetch(baseUrl));
  const closeDeadline = Date.now() + 1_000;
  let closed = false;
  while (Date.now() < closeDeadline) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') { closed = true; break; }
      throw error;
    }
    await delay(50);
  }
  assert.ok(closed, 'the interrupted browser executable must be stopped');
});
