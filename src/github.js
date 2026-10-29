import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const MAX_ROWS = 50;
const MAX_TEXT = 400;

/** Validate the runner's file-command destinations without touching the files. */
export function validateGithubEnvironment(env = process.env) {
  for (const name of ['GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) {
    if (typeof env[name] !== 'string' || !env[name].trim() || env[name].includes('\0')) {
      throw new Error(`--github requires ${name} to be a non-empty file path supplied by GitHub Actions.`);
    }
  }
  return { summaryPath: env.GITHUB_STEP_SUMMARY, outputPath: env.GITHUB_OUTPUT };
}

function escapedText(value, state, limit = MAX_TEXT) {
  let text = String(value ?? '');
  const truncated = text.length > limit;
  if (truncated) {
    state.truncated = true;
    text = text.slice(0, limit);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) text = text.slice(0, -1);
  }
  text = text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escaped = text.replace(/[&<>"'\\`*_\[\]()#!|~@]/g, (character) => entities[character] ?? `&#${character.charCodeAt(0)};`);
  return escaped + (truncated ? '…' : '');
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function prioritized(entries, priorities) {
  return [...entries].sort((left, right) => (priorities[left.status] ?? 3) - (priorities[right.status] ?? 3));
}

function appendTable(lines, entries, label, headings, priorities, row) {
  lines.push(`### ${label}`, '', headings, headings.replace(/[^|]+/g, ' --- '));
  for (const entry of prioritized(entries, priorities).slice(0, MAX_ROWS)) lines.push(row(entry));
  lines.push('');
  if (entries.length > MAX_ROWS) {
    lines.push(`${MAX_ROWS} of ${entries.length} ${label.toLowerCase()} shown; ${entries.length - MAX_ROWS} omitted.`, '');
  }
}

/** A bounded overview suitable for GitHub's job summary, without local links. */
export function githubSummary(report) {
  const state = { truncated: false };
  const text = (value, limit) => escapedText(value, state, limit);
  const result = report.interrupted ? 'INTERRUPTED' : ({ passed: 'PASSED', failed: 'FAILED', incomplete: 'INCOMPLETE' }[report.summary.status] ?? 'FAILED');
  const lines = [
    '## ProofPatch verification',
    '',
    `Result: **${result}**`,
    '',
    `Checks: ${count(report.summary.passed)} passed, ${count(report.summary.failed)} failed, ${count(report.summary.skipped)} skipped.`,
    '',
  ];
  const requirements = Array.isArray(report.requirements) ? report.requirements : [];
  if (requirements.length) {
    const totals = { passed: 0, failed: 0, unverified: 0 };
    for (const requirement of requirements) {
      if (Object.hasOwn(totals, requirement.status)) totals[requirement.status]++;
    }
    lines.push(`Requirements: ${totals.passed} passed, ${totals.failed} failed, ${totals.unverified} unverified.`, '');
    appendTable(lines, requirements, 'Requirements', '| ID | Requirement | Result | Reason |', { failed: 0, unverified: 1, passed: 2 },
      (requirement) => `| ${text(requirement.id, 64)} | ${text(requirement.description)} | ${text(requirement.status, 32)} | ${text(requirement.reason)} |`);
    lines.push('Requirement associations are supplied by the plan author. Passing linked checks does not prove that the checks adequately cover a requirement.', '');
  }
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length) {
    appendTable(lines, checks, 'Checks', '| Check | Result | Reason |', { failed: 0, skipped: 1, passed: 2 },
      (check) => `| ${text(check.name, 160)} | ${text(check.status, 32)} | ${text(check.reason)} |`);
  }
  if (state.truncated) lines.push('Some summary text was truncated. The verification report contains the complete details.', '');
  lines.push('A passing result means the executed checks passed; it does not prove the application is bug-free. Skipped checks and unverified requirements remain gaps.', '');
  return lines.join('\n');
}

function outputValue(name, value) {
  let delimiter;
  do { delimiter = `proofpatch_${randomUUID()}`; } while (value.includes(delimiter));
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/** Append the completed report overview and exact artifact paths to runner files. */
export async function publishGithubReport(report, runDir, env = process.env) {
  const { summaryPath, outputPath } = validateGithubEnvironment(env);
  const directory = resolve(runDir);
  const outputs = [
    outputValue('report-directory', directory),
    outputValue('report-json', join(directory, 'report.json')),
    outputValue('result', report.summary.status),
  ].join('');
  const summary = githubSummary(report);
  await appendFile(summaryPath, `\n${summary}`, { encoding: 'utf8', mode: 0o600 });
  await appendFile(outputPath, `\n${outputs}`, { encoding: 'utf8', mode: 0o600 });
}

/** Setup failures have no report paths to publish. */
export async function publishGithubError(error, env = process.env) {
  const { summaryPath } = validateGithubEnvironment(env);
  const state = { truncated: false };
  const message = escapedText(error?.message ?? error, state);
  await appendFile(summaryPath, [
    '',
    '## ProofPatch verification',
    '',
    'Result: **SETUP ERROR**',
    '',
    `Setup/configuration error: ${message}`,
    '',
    'No verification report was produced.',
    ...(state.truncated ? ['', 'The error text was truncated.'] : []),
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
}
