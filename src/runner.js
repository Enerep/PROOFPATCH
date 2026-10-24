import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_LIMIT = 1024 * 1024;

function capture() {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    add(chunk) {
      const buffer = Buffer.from(chunk);
      const remaining = LOG_LIMIT - bytes;
      if (buffer.length > remaining) truncated = true;
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        bytes += Math.min(buffer.length, remaining);
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[Output truncated at 1 MiB]\n' : '');
    },
  };
}

function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', () => child.kill(signal));
    } else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill(signal);
  }
}

export async function runCommand(check, { cwd, runDir, index, signal }) {
  const started = performance.now();
  const stdout = capture();
  const stderr = capture();
  let reason;
  let forcedKill;
  const child = spawn(check.command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI ?? '1', PROOFPATCH_RUNNING: '1' },
  });
  child.stdout.on('data', (chunk) => stdout.add(chunk));
  child.stderr.on('data', (chunk) => stderr.add(chunk));
  const stop = (message) => {
    if (reason) return;
    reason = message;
    killTree(child, 'SIGTERM');
    forcedKill = new Promise((resolve) => setTimeout(() => {
      killTree(child, 'SIGKILL');
      resolve();
    }, 300));
  };
  const onAbort = () => stop('Interrupted before the check finished.');
  const timeout = setTimeout(() => stop(`Timed out after ${check.timeoutMs} ms.`), check.timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let outcome;
  try {
    outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ exitCode: null, reason: error.message }));
      child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    if (forcedKill) await forcedKill;
    else {
      // A script can exit while leaving a detached-from-stdio child in its group.
      killTree(child, 'SIGTERM');
      if (process.platform !== 'win32') {
        await new Promise((resolve) => setTimeout(resolve, 150));
        killTree(child, 'SIGKILL');
      }
    }
  }
  reason ??= outcome.reason;
  if (!reason && outcome.exitCode !== 0) {
    reason = outcome.exitSignal ? `Stopped by ${outcome.exitSignal}.` : `Command exited with code ${outcome.exitCode}.`;
  }
  const stdoutFile = `check-${index + 1}.stdout.log`;
  const stderrFile = `check-${index + 1}.stderr.log`;
  await Promise.all([
    writeFile(join(runDir, stdoutFile), stdout.text(), { mode: 0o600 }),
    writeFile(join(runDir, stderrFile), stderr.text(), { mode: 0o600 }),
  ]);
  return {
    name: check.name,
    kind: 'command',
    status: reason ? 'failed' : 'passed',
    command: check.command,
    exitCode: outcome.exitCode,
    durationMs: Math.round(performance.now() - started),
    ...(reason ? { reason } : {}),
    artifacts: [stdoutFile, stderrFile],
  };
}
