import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export { version };

export async function gitContext(cwd) {
  try {
    const options = { cwd, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true };
    const [head, branch, status] = await Promise.all([
      execute('git', ['rev-parse', 'HEAD'], options),
      execute('git', ['branch', '--show-current'], options),
      execute('git', ['status', '--porcelain=v1', '--untracked-files=normal'], options),
    ]);
    return { commit: head.stdout.trim(), branch: branch.stdout.trim() || null, dirty: Boolean(status.stdout.trim()), changes: status.stdout.trimEnd().split('\n').filter(Boolean) };
  } catch {
    return null;
  }
}

export function summarize(checks) {
  const summary = { passed: 0, failed: 0, skipped: 0 };
  for (const check of checks) summary[check.status]++;
  return { ...summary, status: summary.failed > 0 || summary.passed === 0 ? 'failed' : 'passed' };
}

function cell(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', '<br>');
}

export function toMarkdown(report) {
  const lines = [
    '# ProofPatch verification',
    '',
    `Result: **${report.summary.status.toUpperCase()}** — ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`,
    '',
    `Started: ${report.startedAt}`,
    `Duration: ${report.durationMs} ms`,
    `ProofPatch: ${report.tool.version} · Node: ${report.environment.node} · ${report.environment.platform}`,
    `Configuration: ${cell(report.configSource)}`,
    ...(report.git ? [`Commit: ${report.git.commit}`, `Working tree: ${report.git.dirty ? 'uncommitted changes' : 'clean'}`] : ['Git context: unavailable']),
    '',
    '| Check | Result | Duration | Evidence / reason |',
    '| --- | --- | --- | --- |',
    ...report.checks.map((check) => `| ${cell(check.name)} | ${check.status} | ${check.durationMs ?? 0} ms | ${cell(check.reason ?? check.command ?? 'Browser scenario completed.')} |`),
    '',
    '## Evidence',
    '',
    '[Complete machine-readable report](report.json)',
    '',
  ];
  for (const check of report.checks) {
    if (check.artifacts?.length) lines.push(`- ${cell(check.name)}: ${check.artifacts.map((path) => `[${cell(path)}](${encodeURI(path).replaceAll('(', '%28').replaceAll(')', '%29')})`).join(', ')}`);
  }
  for (const check of report.checks) {
    if (check.details?.steps?.length) {
      lines.push('', `## ${cell(check.name)} — steps`, '', `URL: ${cell(check.details.url)}`, '', '| Step | Action | Target | Expected text | Result |', '| --- | --- | --- | --- | --- |');
      for (const [index, step] of check.details.steps.entries()) {
        lines.push(`| ${index + 1} | ${cell(step.action)} | ${cell(step.selector ?? 'page body')} | ${cell(step.text ?? '')} | ${index < check.details.completedSteps ? 'completed' : 'not completed'} |`);
      }
    }
    if (check.details && check.status === 'failed') {
      lines.push('', `## ${cell(check.name)} — failure details`, '', '```json', JSON.stringify(check.details, null, 2).replaceAll('`', '\\u0060'), '```');
    }
  }
  if (report.git?.changes.length) lines.push('', '## Working tree at start', '', '```text', ...report.git.changes.map((line) => line.replaceAll('`', '\\u0060')), '```');
  lines.push('', 'A passing result means the configured checks passed in this run. It does not prove the application is bug-free. Skipped checks were not verified.', 'Reports and logs may contain application data. Review them before sharing.', '');
  return lines.join('\n');
}

export async function writeReports(report, runDir) {
  await Promise.all([
    writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(runDir, 'report.md'), toMarkdown(report), { mode: 0o600 }),
  ]);
}
