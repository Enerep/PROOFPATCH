import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBrowserChecks } from '../src/browser.js';

const browserEnabled = Boolean(process.env.PROOFPATCH_BROWSER_TESTS || process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH);

async function fixture(t, routes) {
  const cwd = await mkdtemp(join(tmpdir(), 'proofpatch-browser-assertions-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Assertion fixture</title><body>${routes[request.url] ?? '<h1>Ready</h1>'}</body>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    options: { cwd, runDir: join(cwd, 'reports') },
  };
}

function scenario(name, path, steps) {
  return { name, path, steps };
}

async function verify(fixture, scenarios) {
  const results = await runBrowserChecks({
    baseUrl: fixture.baseUrl, startupTimeoutMs: 2_000, timeoutMs: 2_000, scenarios,
  }, fixture.options);
  assert.equal(results.length, scenarios.length, JSON.stringify(results));
  return Object.fromEntries(results.map((result) => [result.name.replace(/^Browser: /, ''), result]));
}

function assertPassed(result) {
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.details.completedSteps, result.details.steps.length);
}

test('real Chromium checks exact DOM counts and resets the requested stability window after a mismatch', {
  skip: !browserEnabled,
}, async (t) => {
  const app = await fixture(t, {
    '/delayed': `
      <button id="begin" onclick="setTimeout(() => document.querySelector('ul').innerHTML = '<li class=result>Visible</li><li class=result hidden>Hidden</li>', 80)">Load</button>
      <ul></ul>`,
    '/empty': '<h1>No results</h1>',
    '/late-insert': `
      <button id="begin" onclick="setTimeout(() => document.querySelector('main').innerHTML = '<p class=result>Unexpected result</p>', 80)">Begin</button>
      <main></main>`,
    '/two': '<p class="result">One</p><p class="result" hidden>Two</p>',
    '/transient': `
      <button id="begin" onclick="
        window.ready = false;
        setTimeout(() => document.querySelector('main').innerHTML = '<p class=result>Transient</p>', 100);
        setTimeout(() => { document.querySelector('main').replaceChildren(); setTimeout(() => window.ready = true, 250); }, 180);
      ">Begin</button>
      <button id="capture" onclick="document.querySelector('output').textContent = window.ready ? 'Reset respected' : 'Returned too early'">Capture</button>
      <main></main><output></output>`,
    '/finite': `
      <button id="begin" onclick="setTimeout(() => document.querySelector('main').innerHTML = '<p class=result>Arrived later</p>', 500)">Begin</button>
      <main></main>`,
  });
  const results = await verify(app, [
    scenario('Delayed results include hidden DOM nodes', '/delayed', [
      { action: 'click', selector: '#begin' },
      { action: 'expectCount', selector: '.result', count: 2 },
    ]),
    scenario('Absent results', '/empty', [{ action: 'expectCount', selector: '.result', count: 0 }]),
    scenario('Sustained absence catches delayed insertion', '/late-insert', [
      { action: 'click', selector: '#begin' },
      { action: 'expectCount', selector: '.result', count: 0, forMs: 250 },
    ]),
    scenario('Exact count mismatch', '/two', [{ action: 'expectCount', selector: '.result', count: 1 }]),
    scenario('Transient match resets count stability', '/transient', [
      { action: 'click', selector: '#begin' },
      { action: 'expectCount', selector: '.result', count: 0, forMs: 250 },
      { action: 'click', selector: '#capture' },
      { action: 'expectText', selector: 'output', text: 'Reset respected' },
    ]),
    scenario('A finite absence window permits a later insertion', '/finite', [
      { action: 'click', selector: '#begin' },
      { action: 'expectCount', selector: '.result', count: 0, forMs: 150 },
      { action: 'expectCount', selector: '.result', count: 1 },
    ]),
  ]);
  const delayed = results['Delayed results include hidden DOM nodes'];
  assertPassed(delayed);
  assert.deepEqual(delayed.details.steps[1], { action: 'expectCount', selector: '.result', count: 2, forMs: 0 });
  assertPassed(results['Absent results']);
  const insertion = results['Sustained absence catches delayed insertion'];
  assert.equal(insertion.status, 'failed');
  assert.match(insertion.reason, /Expected 0 elements.*\.result.*250ms.*2000ms; found 1/);
  assert.deepEqual(insertion.details.steps[1], { action: 'expectCount', selector: '.result', count: 0, forMs: 250 });
  const mismatch = results['Exact count mismatch'];
  assert.equal(mismatch.status, 'failed');
  assert.match(mismatch.reason, /Expected 1 elements.*\.result.*0ms.*2000ms; found 2/);
  assertPassed(results['Transient match resets count stability']);
  assertPassed(results['A finite absence window permits a later insertion']);
});

test('real Chromium waits for hidden or detached elements with strict selectors and Playwright visibility semantics', {
  skip: !browserEnabled,
}, async (t) => {
  const app = await fixture(t, {
    '/absent': '<h1>No notice</h1>',
    '/hide': `
      <button id="begin" onclick="setTimeout(() => document.querySelector('#notice').style.visibility = 'hidden', 80)">Hide</button>
      <p id="notice">Notice</p>`,
    '/visible': '<p id="notice">Visible notice</p>',
    '/transparent': '<p id="notice" style="opacity:0">Transparent notice</p>',
    '/multiple': '<p class="notice" hidden>First</p><p class="notice" hidden>Second</p>',
    '/transient': `
      <button id="begin" onclick="
        window.ready = false;
        document.querySelector('#notice').hidden = true;
        setTimeout(() => document.querySelector('#notice').hidden = false, 100);
        setTimeout(() => { document.querySelector('#notice').hidden = true; setTimeout(() => window.ready = true, 250); }, 180);
      ">Begin</button>
      <button id="capture" onclick="document.querySelector('output').textContent = window.ready ? 'Reset respected' : 'Returned too early'">Capture</button>
      <p id="notice">Notice</p><output></output>`,
  });
  const results = await verify(app, [
    scenario('Detached is hidden', '/absent', [{ action: 'expectHidden', selector: '#notice' }]),
    scenario('Delayed hiding', '/hide', [
      { action: 'click', selector: '#begin' },
      { action: 'expectHidden', selector: '#notice' },
    ]),
    scenario('Visible notice fails', '/visible', [{ action: 'expectHidden', selector: '#notice' }]),
    scenario('Opacity zero remains visible to Playwright', '/transparent', [{ action: 'expectHidden', selector: '#notice' }]),
    scenario('Hidden selectors remain strict', '/multiple', [{ action: 'expectHidden', selector: '.notice' }]),
    scenario('Transient hiding resets stability', '/transient', [
      { action: 'click', selector: '#begin' },
      { action: 'expectHidden', selector: '#notice', forMs: 250 },
      { action: 'click', selector: '#capture' },
      { action: 'expectText', selector: 'output', text: 'Reset respected' },
    ]),
  ]);
  const absent = results['Detached is hidden'];
  assertPassed(absent);
  assert.deepEqual(absent.details.steps[0], { action: 'expectHidden', selector: '#notice', forMs: 0 });
  assertPassed(results['Delayed hiding']);
  for (const name of ['Visible notice fails', 'Opacity zero remains visible to Playwright']) {
    assert.equal(results[name].status, 'failed');
    assert.match(results[name].reason, /Expected "#notice".*hidden or detached.*0ms.*2000ms; last state was visible/);
  }
  assert.equal(results['Hidden selectors remain strict'].status, 'failed');
  assert.match(results['Hidden selectors remain strict'].reason, /strict mode violation/);
  const transient = results['Transient hiding resets stability'];
  assertPassed(transient);
  assert.deepEqual(transient.details.steps[1], { action: 'expectHidden', selector: '#notice', forMs: 250 });
});
