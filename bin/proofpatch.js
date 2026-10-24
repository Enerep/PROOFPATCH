#!/usr/bin/env node
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { runCommand } from '../src/runner.js';
import { runBrowserChecks } from '../src/browser.js';
import { gitContext, summarize, writeReports, version } from '../src/report.js';

const help = `ProofPatch ${version}

Usage:
  proofpatch verify [--cwd <directory>] [--json]
  proofpatch init [--cwd <directory>]
  proofpatch --help
  proofpatch --version

verify   Run checks and save reports in .proofpatch/<run-id>/.
init     Create proofpatch.config.json from existing package scripts.
--json   Print the complete report as JSON; send progress to stderr.

Exit codes: 0 passed, 1 checks failed, 2 setup/configuration error, 130 interrupted.
`;

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return { command: 'version' };
  const command = args.shift();
  if (!command) return { command: 'help' };
  if (!['verify', 'init'].includes(command)) throw new Error(`Unknown command: ${command}. Run proofpatch --help.`);
  let cwd = process.cwd();
  let json = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--cwd') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('--cwd needs a directory.');
      cwd = resolve(value);
    } else if (option === '--json' && command === 'verify') json = true;
    else if (['--help', '-h'].includes(option)) return { command: 'help' };
    else throw new Error(`Unknown option: ${option}. Run proofpatch --help.`);
  }
  return { command, cwd, json };
}

async function init(cwd) {
  const path = join(cwd, 'proofpatch.config.json');
  try {
    await access(path);
    throw new Error('proofpatch.config.json already exists. Edit it to change your checks.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = await loadConfig(cwd);
  await writeFile(path, `${JSON.stringify({ checks: config.checks.map(({ name, command, timeoutMs }) => ({ name, command, timeoutMs })) }, null, 2)}\n`, { flag: 'wx' });
  console.log('Created proofpatch.config.json. Edit the checks, then run proofpatch verify.');
}

async function verify({ cwd, json }) {
  if (process.env.PROOFPATCH_RUNNING === '1') throw new Error('A check tried to run ProofPatch recursively. Remove proofpatch verify from the checks it runs.');
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const config = await loadConfig(cwd);
  const git = await gitContext(cwd);
  const runId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = join(cwd, '.proofpatch', runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const progress = (text) => (json ? console.error : console.log)(text);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const checks = config.skipped.map(({ name, reason }) => ({ name, kind: 'command', status: 'skipped', durationMs: 0, reason }));
  try {
    progress(`ProofPatch ${version}\n`);
    for (let index = 0; index < config.checks.length; index++) {
      const check = config.checks[index];
      if (controller.signal.aborted) {
        checks.push({ name: check.name, kind: 'command', status: 'skipped', durationMs: 0, reason: 'Run interrupted.' });
        continue;
      }
      progress(`RUN   ${check.name}`);
      const result = await runCommand(check, { cwd, runDir, index, signal: controller.signal });
      checks.push(result);
      progress(`${result.status === 'passed' ? 'PASS' : 'FAIL'}  ${result.name} (${result.durationMs} ms)${result.reason ? ` — ${result.reason}` : ''}`);
    }
    if (config.browser) {
      if (controller.signal.aborted) checks.push({ name: 'Browser scenarios', kind: 'browser', status: 'skipped', reason: 'Run interrupted.', durationMs: 0 });
      else {
        const browserChecks = await runBrowserChecks(config.browser, { cwd, runDir, signal: controller.signal, onProgress: progress });
        checks.push(...browserChecks);
        for (const result of browserChecks) {
          progress(`${result.status === 'passed' ? 'PASS' : 'FAIL'}  ${result.name} (${result.durationMs} ms)${result.reason ? ` — ${result.reason}` : ''}`);
        }
      }
    } else {
      checks.push({ name: 'Browser scenarios', kind: 'browser', status: 'skipped', reason: 'No browser scenarios configured.', durationMs: 0 });
    }
    const summary = summarize(checks);
    if (controller.signal.aborted) summary.status = 'failed';
    const report = {
      schemaVersion: 1,
      tool: { name: 'proofpatch', version },
      startedAt,
      durationMs: Math.round(performance.now() - started),
      configSource: config.source,
      environment: { node: process.version, platform: process.platform },
      git,
      interrupted: controller.signal.aborted,
      summary,
      checks,
      reportDirectory: relative(cwd, runDir).split('\\').join('/'),
    };
    await writeReports(report, runDir);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const check of checks.filter((item) => item.status === 'skipped')) progress(`SKIP  ${check.name} — ${check.reason}`);
      progress(`\n${summary.status.toUpperCase()}: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`);
      progress(`Report: ${join(report.reportDirectory, 'report.md')}`);
      progress('Only the checks listed above were verified.');
    }
    process.exitCode = controller.signal.aborted ? 130 : summary.status === 'passed' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') console.log(help);
  else if (options.command === 'version') console.log(version);
  else if (options.command === 'init') await init(options.cwd);
  else await verify(options);
} catch (error) {
  console.error(`ProofPatch: ${error.message}`);
  process.exitCode = 2;
}
