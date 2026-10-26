import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOG_LIMIT = 128 * 1024;
const ERROR_LIMIT = 8 * 1024;

function errorText(error) {
  return String(error?.message ?? error).slice(0, ERROR_LIMIT);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Browser verification was interrupted.');
}

async function untilAborted(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  let onAbort;
  const interrupted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new Error('Browser verification was interrupted.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, interrupted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function probe(url, signal) {
  throwIfAborted(signal);
  try {
    const timeout = AbortSignal.timeout(1_000);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual',
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  const kill = (signal) => {
    try { child.kill(signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  await delay(250);
  kill('SIGKILL');
}

function startServer(command, cwd, logPath) {
  const log = createWriteStream(logPath, { flags: 'wx' });
  let bytes = 0;
  let logError;
  log.on('error', (error) => { logError = error; });
  const child = spawn(command, {
    cwd, shell: true, detached: false,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { exited: false, error: null, code: null, tail: '' };
  const append = (chunk) => {
    state.tail = (state.tail + chunk.toString()).slice(-4_096);
    const remaining = LOG_LIMIT - bytes;
    if (remaining <= 0 || logError) return;
    const part = chunk.subarray(0, remaining);
    bytes += part.length;
    log.write(part);
    if (bytes === LOG_LIMIT) log.write('\n[ProofPatch stopped recording after 128 KiB.]\n');
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', (error) => { state.error = error; state.exited = true; });
  child.once('close', (code) => { state.exited = true; state.code = code; });
  return {
    child, state,
    async close() {
      await stopServer(child);
      await new Promise((resolve) => {
        if (log.closed || logError) return resolve();
        log.end(resolve);
      });
    },
    checkLog() { if (logError) throw logError; },
  };
}

async function waitForServer(config, server, signal) {
  const deadline = Date.now() + config.startupTimeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    server?.checkLog();
    if (server?.state.exited) {
      const { error, code, tail } = server.state;
      throw new Error(`Browser server stopped before it was ready (${error ? errorText(error) : `exit ${code}`}).${tail ? `\n${tail}` : ''}`);
    }
    lastStatus = await probe(config.baseUrl, signal);
    if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(150, remaining), undefined, { signal });
  }
  throw new Error(`Browser server was not ready at ${config.baseUrl} within ${config.startupTimeoutMs}ms${lastStatus ? ` (HTTP ${lastStatus})` : ''}.${server?.state.tail ? `\n${server.state.tail}` : ''}`);
}

function scenarioUrl(baseUrl, scenarioPath) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('browser.baseUrl must be an HTTP(S) URL without credentials.');
  }
  if (typeof scenarioPath !== 'string' || !scenarioPath.startsWith('/') || scenarioPath.startsWith('//')) {
    throw new Error('Browser scenario paths must start with a single slash.');
  }
  const url = new URL(scenarioPath, base);
  if (url.origin !== base.origin) throw new Error('Browser scenario paths must stay on browser.baseUrl’s origin.');
  return url.href;
}

async function expectStable({ observe, matches, forMs, timeout, signal, failure }) {
  const deadline = performance.now() + timeout;
  const timedOut = Symbol('observation timed out');
  let matchingSince;
  let actual;
  while (performance.now() < deadline) {
    throwIfAborted(signal);
    let timer;
    let observed;
    try {
      observed = await untilAborted(Promise.race([
        observe(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timedOut), Math.max(0, deadline - performance.now()));
        }),
      ]), signal);
    } finally {
      clearTimeout(timer);
    }
    if (observed === timedOut) break;
    actual = observed;
    const now = performance.now();
    if (now > deadline) break;
    if (matches(actual)) {
      matchingSince ??= now;
      if (now - matchingSince >= forMs) return;
    } else {
      matchingSince = undefined;
    }
    await delay(Math.min(25, Math.max(0, deadline - performance.now())), undefined, { signal });
  }
  throw new Error(failure(actual));
}

async function runStep(page, step, timeout, signal) {
  switch (step.action) {
    case 'click':
      await page.locator(step.selector).click({ timeout });
      break;
    case 'fill':
      await page.locator(step.selector).fill(step.value, { timeout });
      break;
    case 'expectVisible':
      await page.locator(step.selector).waitFor({ state: 'visible', timeout });
      break;
    case 'expectCount': {
      const locator = page.locator(step.selector);
      const forMs = step.forMs ?? 0;
      await expectStable({
        observe: () => locator.count(), matches: (count) => count === step.count,
        forMs, timeout, signal,
        failure: (actual) => `Expected ${step.count} elements matching ${JSON.stringify(step.selector)} for ${forMs}ms within ${timeout}ms; found ${actual ?? 'an unknown count'}.`,
      });
      break;
    }
    case 'expectHidden': {
      const locator = page.locator(step.selector);
      const forMs = step.forMs ?? 0;
      await expectStable({
        observe: () => locator.isHidden(), matches: (hidden) => hidden,
        forMs, timeout, signal,
        failure: (actual) => `Expected ${JSON.stringify(step.selector)} to be hidden or detached for ${forMs}ms within ${timeout}ms; last state was ${actual === undefined ? 'unknown' : actual ? 'hidden or detached' : 'visible'}.`,
      });
      break;
    }
    case 'expectText': {
      const scope = step.selector ? page.locator(step.selector) : page.locator('body');
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = await scope.evaluateAll((elements, expected) => elements.some((element) => {
          if (!(element instanceof HTMLElement) || !element.isConnected) return false;
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === 'none' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
          }
          // innerText includes transparent descendants. Collect rendered text nodes
          // instead, excluding hidden subtrees and preserving block boundaries.
          const collect = (current) => {
            if (current.nodeType === Node.TEXT_NODE) {
              if (getComputedStyle(current.parentElement).visibility !== 'visible') return '';
              const range = document.createRange();
              range.selectNodeContents(current);
              if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) return '';
              const text = current.textContent;
              const transform = getComputedStyle(current.parentElement).textTransform;
              if (transform === 'uppercase') return text.toUpperCase();
              if (transform === 'lowercase') return text.toLowerCase();
              if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
              return text;
            }
            if (!(current instanceof Element) || !current.isConnected) return '';
            const style = getComputedStyle(current);
            if (style.display === 'none' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return '';
            if (current.tagName === 'BR') return '\n';
            const text = [...current.childNodes].map(collect).join('');
            const block = style.display !== 'inline' && style.display !== 'contents' && !style.display.startsWith('inline-');
            return block ? `\n${text}\n` : text;
          };
          const rendered = collect(element).replace(/\s+/g, ' ').trim();
          return rendered.includes(expected.replace(/\s+/g, ' ').trim());
        }), step.text);
        if (found) return;
        await delay(Math.min(50, Math.max(0, deadline - Date.now())));
      }
      throw new Error(`Visible text was not found within ${timeout}ms: ${step.text}`);
    }
    default:
      throw new Error(`Unsupported browser action: ${step.action}`);
  }
}

/** Run browser scenarios against a local server or an explicitly configured URL. */
async function runBrowserChecks(config, { cwd, runDir, signal, onProgress = () => {} }) {
  if (!config) return [];
  const started = performance.now();
  const results = [];
  let server;
  let browser;
  let abortListener;
  const serverArtifacts = config.startCommand ? ['browser-server.log'] : [];
  try {
    throwIfAborted(signal);
    const urls = config.scenarios.map((scenario) => scenarioUrl(config.baseUrl, scenario.path));
    await mkdir(runDir, { recursive: true });
    if (config.startCommand) {
      if (await probe(config.baseUrl, signal) !== null) {
        throw new Error(`A server is already responding at ${config.baseUrl}. Stop it before using browser.startCommand, or remove startCommand to verify the existing server.`);
      }
      onProgress('Starting browser server');
      server = startServer(config.startCommand, cwd, path.join(runDir, 'browser-server.log'));
    }
    await waitForServer(config, server, signal);
    throwIfAborted(signal);
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch (error) {
      throw new Error(`Browser checks require Playwright. Install ProofPatch with its optional dependencies, then run npx playwright install chromium. (${errorText(error)})`);
    }
    const executablePath = process.env.PROOFPATCH_CHROMIUM_EXECUTABLE_PATH;
    try {
      const launchPromise = chromium.launch({
        headless: true, timeout: config.timeoutMs,
        ...(executablePath ? { executablePath } : {}),
      });
      // If interrupted during launch, close a browser that finishes launching later.
      launchPromise.then((launched) => {
        if (signal?.aborted) return launched.close();
      }).catch(() => {});
      browser = await untilAborted(launchPromise, signal);
    } catch (error) {
      throw new Error(`Could not launch Chromium. Run npx playwright install chromium, or set PROOFPATCH_CHROMIUM_EXECUTABLE_PATH to an installed Chromium executable.\n${errorText(error)}`);
    }
    abortListener = () => { browser.close().catch(() => {}); };
    signal?.addEventListener('abort', abortListener, { once: true });
    throwIfAborted(signal);
    await mkdir(path.join(runDir, 'screenshots'), { recursive: true });
    for (const [index, scenario] of config.scenarios.entries()) {
      throwIfAborted(signal);
      onProgress(`Browser: ${scenario.name}`);
      const scenarioStarted = performance.now();
      const details = {
        url: urls[index],
        steps: scenario.steps.map((step) => ({
          action: step.action,
          ...(step.selector !== undefined ? { selector: step.selector } : {}),
          ...(step.text !== undefined ? { text: step.text } : {}),
          ...(step.count !== undefined ? { count: step.count } : {}),
          ...(['expectCount', 'expectHidden'].includes(step.action) ? { forMs: step.forMs ?? 0 } : {}),
          ...(step.action === 'fill' ? { value: '[redacted]' } : {}),
        })),
        completedSteps: 0, pageErrors: [], consoleErrors: [], requestFailures: [], httpErrors: [],
      };
      const artifacts = [...serverArtifacts];
      let context;
      let page;
      let reason;
      const record = (list, value) => { if (list.length < 20) list.push(String(value).slice(0, 2_048)); };
      try {
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        page = await context.newPage();
        page.setDefaultTimeout(config.timeoutMs);
        page.on('pageerror', (error) => record(details.pageErrors, error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') record(details.consoleErrors, message.text());
        });
        page.on('requestfailed', (request) => record(details.requestFailures, `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`));
        page.on('response', (response) => {
          if (response.status() >= 400) record(details.httpErrors, `HTTP ${response.status()} ${response.url()}`);
        });
        const response = await page.goto(urls[index], { waitUntil: 'load', timeout: config.timeoutMs });
        if (!response || response.status() >= 400) {
          throw new Error(`Navigation failed${response ? ` with HTTP ${response.status()}` : ' without an HTTP response'}.`);
        }
        for (const step of scenario.steps) {
          throwIfAborted(signal);
          await runStep(page, step, config.timeoutMs, signal);
          details.completedSteps++;
        }
        if (new URL(page.url()).origin !== new URL(config.baseUrl).origin) {
          throw new Error(`Scenario navigated outside browser.baseUrl’s origin: ${page.url()}`);
        }
      } catch (error) {
        reason = errorText(error);
      } finally {
        if (page && !page.isClosed()) {
          const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'scenario';
          const screenshot = `screenshots/${String(index + 1).padStart(2, '0')}-${slug}.png`;
          try {
            await page.screenshot({ path: path.join(runDir, screenshot), fullPage: true, timeout: config.timeoutMs });
            artifacts.push(screenshot);
          } catch (error) {
            details.screenshotError = errorText(error);
            reason ??= `Could not capture screenshot: ${errorText(error)}`;
          }
        }
        await context?.close().catch(() => {});
      }
      if (!reason && (details.pageErrors.length || details.consoleErrors.length || details.requestFailures.length || details.httpErrors.length)) {
        reason = 'The page reported browser errors. See the recorded error details.';
      }
      results.push({
        name: `Browser: ${scenario.name}`, kind: 'browser', status: reason ? 'failed' : 'passed',
        durationMs: Math.round(performance.now() - scenarioStarted), exitCode: null,
        ...(reason ? { reason } : {}), details, artifacts,
      });
    }
  } catch (error) {
    results.push({
      name: 'Browser setup', kind: 'browser', status: 'failed',
      durationMs: Math.round(performance.now() - started), exitCode: null,
      reason: signal?.aborted ? 'Browser verification was interrupted.' : errorText(error),
      artifacts: server ? serverArtifacts : [],
    });
  } finally {
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    await browser?.close().catch(() => {});
    await server?.close();
  }
  return results;
}

// Playwright launches Chromium in a separate process group. Let its TERM handler
// close/force-kill that group and reap the child before this worker exits. Its
// synchronous exit hook supplies a final kill before the supervisor's fallback.
let exitTimer;
process.on('SIGTERM', () => {
  exitTimer ??= setTimeout(() => process.exit(143), 250);
});
process.on('disconnect', () => process.exit(1));
const controller = new AbortController();
let running = false;
function send(message) {
  if (process.connected) process.send(message, () => {});
}
process.on('message', async (message) => {
  if (message?.type === 'abort') {
    controller.abort();
    return;
  }
  if (message?.type !== 'run' || running) return;
  running = true;
  try {
    const results = await runBrowserChecks(message.config, {
      cwd: message.cwd, runDir: message.runDir, signal: controller.signal,
      onProgress: (text) => send({ type: 'progress', text }),
    });
    send({ type: 'results', results });
  } catch (error) {
    send({ type: 'results', results: [{
      name: 'Browser setup', kind: 'browser', status: 'failed', durationMs: 0,
      exitCode: null, reason: errorText(error), artifacts: [],
    }] });
  }
  // Keep IPC and the worker alive until its supervisor kills all owned processes.
});
