import { fork, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function stopWorker(child) {
  if (!child.pid) return;
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
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  kill('SIGTERM');
  await delay(100);
  // Playwright treats a second close request as a force kill of its detached
  // browser process group. Allow its child-close event to reap the launcher.
  kill('SIGTERM');
  await delay(200);
  kill('SIGKILL');
}

/** Run browser verification in a supervised worker, including browser startup. */
export async function runBrowserChecks(config, { cwd, runDir, signal, onProgress = () => {} }) {
  if (!config) return [];
  const started = performance.now();
  let stderr = '';
  const failure = (reason) => [{
    name: 'Browser setup', kind: 'browser', status: 'failed',
    durationMs: Math.round(performance.now() - started), exitCode: null,
    reason, ...(stderr ? { details: { workerStderr: stderr } } : {}), artifacts: [],
  }];
  if (signal?.aborted) return failure('Browser verification was interrupted.');
  let worker;
  try {
    worker = fork(new URL('./browser-worker.js', import.meta.url), [], {
      cwd, detached: process.platform !== 'win32', windowsHide: true,
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
  } catch (error) {
    return failure(`Could not start browser worker: ${error.message}`);
  }
  return new Promise((resolve) => {
    let finishing = false;
    let abortTimer;
    const closed = new Promise((done) => worker.once('close', done));
    worker.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8_192); });
    const finish = async (results) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(abortTimer);
      signal?.removeEventListener('abort', onAbort);
      try {
        await stopWorker(worker);
        await closed;
      } catch (error) {
        results.push(...failure(`Could not clean up browser worker: ${error.message}`));
      }
      resolve(results);
    };
    const send = (message) => {
      if (!worker.connected) return;
      worker.send(message, (error) => {
        if (error) finish(failure(`Browser worker IPC failed: ${error.message}`));
      });
    };
    const onAbort = () => {
      send({ type: 'abort' });
      abortTimer = setTimeout(() => finish(failure('Browser verification was interrupted.')), 400);
    };
    worker.on('message', (message) => {
      if (finishing) return;
      if (message?.type === 'progress') {
        try { onProgress(message.text); } catch (error) { finish(failure(error.message)); }
      } else if (message?.type === 'results' && Array.isArray(message.results)) {
        finish(message.results);
      }
    });
    worker.once('error', (error) => finish(failure(`Browser worker failed: ${error.message}`)));
    worker.once('exit', (code, exitSignal) => {
      if (!finishing) finish(failure(signal?.aborted
        ? 'Browser verification was interrupted.'
        : `Browser worker stopped unexpectedly (${exitSignal ?? `exit ${code}`}).`));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    send({ type: 'run', config, cwd, runDir });
    if (signal?.aborted) onAbort();
  });
}
