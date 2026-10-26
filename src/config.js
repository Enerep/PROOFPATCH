import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const SCRIPT_NAMES = ['test', 'lint', 'typecheck', 'build'];
const MAX_TIMEOUT_MS = 3_600_000;
const REQUIREMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const LOCKFILES = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};

async function readJson(filename, optional = false) {
  let contents;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${path.basename(filename)}: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.basename(filename)}: ${error.message}`);
  }
}

function object(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object.`);
  }
}

function fields(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown field ${location}.${key}.`);
  }
}

function string(value, location, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new Error(`${location} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`);
  }
  return value;
}

function timeout(value, fallback, location) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${location} must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return value;
}

function uniqueNames(items, location) {
  const names = new Set();
  for (const item of items) {
    if (names.has(item.name)) throw new Error(`${location} contains duplicate name "${item.name}".`);
    names.add(item.name);
  }
}

function requirementId(value, location) {
  if (typeof value !== 'string' || value.trim() !== value || !REQUIREMENT_ID.test(value)) {
    throw new Error(`${location} must be a lowercase slug starting with a letter, containing only letters, numbers, or hyphens, and at most 64 characters.`);
  }
  return value;
}

function validateRequirements(requirements = []) {
  if (!Array.isArray(requirements)) throw new Error('requirements must be an array.');
  const ids = new Set();
  return requirements.map((requirement, index) => {
    const location = `requirements[${index}]`;
    object(requirement, location);
    fields(requirement, ['id', 'description'], location);
    const id = requirementId(requirement.id, `${location}.id`);
    if (ids.has(id)) throw new Error(`requirements contains duplicate ID "${id}".`);
    ids.add(id);
    return { id, description: string(requirement.description, `${location}.description`).trim() };
  });
}

function validateRequirementReferences(references = [], ids, location) {
  if (!Array.isArray(references)) throw new Error(`${location} must be an array of requirement IDs.`);
  const seen = new Set();
  return references.map((reference, index) => {
    const id = requirementId(reference, `${location}[${index}]`);
    if (seen.has(id)) throw new Error(`${location} contains duplicate requirement ID "${id}".`);
    if (!ids.has(id)) throw new Error(`${location}[${index}] refers to undeclared requirement "${id}".`);
    seen.add(id);
    return id;
  });
}

function validateChecks(checks, requirementIds) {
  if (!Array.isArray(checks)) throw new Error('checks must be an array.');
  const result = checks.map((check, index) => {
    const location = `checks[${index}]`;
    object(check, location);
    fields(check, ['name', 'command', 'timeoutMs', 'requirements'], location);
    return {
      name: string(check.name, `${location}.name`).trim(),
      command: string(check.command, `${location}.command`),
      timeoutMs: timeout(check.timeoutMs, 120_000, `${location}.timeoutMs`),
      requirements: validateRequirementReferences(check.requirements, requirementIds, `${location}.requirements`),
    };
  });
  uniqueNames(result, 'checks');
  return result;
}

function observationWindow(value, browserTimeoutMs, location) {
  const duration = value === undefined ? 0 : value;
  if (!Number.isInteger(duration) || duration < 0 || duration > MAX_TIMEOUT_MS) {
    throw new Error(`${location} must be an integer between 0 and ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  if (duration >= browserTimeoutMs) {
    throw new Error(`${location} must be strictly less than browser.timeoutMs (${browserTimeoutMs} milliseconds).`);
  }
  return duration;
}

function validateStep(step, location, browserTimeoutMs) {
  object(step, location);
  const action = string(step.action, `${location}.action`);
  switch (action) {
    case 'click':
    case 'expectVisible':
      fields(step, ['action', 'selector'], location);
      return { action, selector: string(step.selector, `${location}.selector`) };
    case 'fill':
      fields(step, ['action', 'selector', 'value'], location);
      return {
        action,
        selector: string(step.selector, `${location}.selector`),
        value: string(step.value, `${location}.value`, true),
      };
    case 'expectText': {
      fields(step, ['action', 'text', 'selector'], location);
      const result = { action, text: string(step.text, `${location}.text`) };
      if (step.selector !== undefined) result.selector = string(step.selector, `${location}.selector`);
      return result;
    }
    case 'expectCount': {
      fields(step, ['action', 'selector', 'count', 'forMs'], location);
      if (!Number.isSafeInteger(step.count) || step.count < 0) {
        throw new Error(`${location}.count must be a non-negative safe integer (at most ${Number.MAX_SAFE_INTEGER}).`);
      }
      return {
        action,
        selector: string(step.selector, `${location}.selector`),
        count: step.count,
        forMs: observationWindow(step.forMs, browserTimeoutMs, `${location}.forMs`),
      };
    }
    case 'expectHidden':
      fields(step, ['action', 'selector', 'forMs'], location);
      return {
        action,
        selector: string(step.selector, `${location}.selector`),
        forMs: observationWindow(step.forMs, browserTimeoutMs, `${location}.forMs`),
      };
    default:
      throw new Error(`${location}.action must be click, fill, expectVisible, expectText, expectCount, or expectHidden.`);
  }
}

function validateBrowser(browser, requirementIds) {
  if (browser === undefined || browser === null) return null;
  object(browser, 'browser');
  fields(browser, ['baseUrl', 'startCommand', 'startupTimeoutMs', 'timeoutMs', 'scenarios'], 'browser');
  string(browser.baseUrl, 'browser.baseUrl');
  if (!/^https?:\/\//i.test(browser.baseUrl)) {
    throw new Error('browser.baseUrl must be an absolute HTTP or HTTPS URL.');
  }
  if (/[?#]/.test(browser.baseUrl)) {
    throw new Error('browser.baseUrl cannot contain a query string or fragment; put them in a scenario path.');
  }
  if (/\s|\\/.test(browser.baseUrl)) {
    throw new Error('browser.baseUrl cannot contain whitespace or backslashes; URL-encode spaces in paths.');
  }
  let baseUrl;
  try {
    baseUrl = new URL(browser.baseUrl);
  } catch {
    throw new Error('browser.baseUrl must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('browser.baseUrl must be an HTTP or HTTPS URL without credentials.');
  }
  if (!Array.isArray(browser.scenarios) || browser.scenarios.length === 0) {
    throw new Error('browser.scenarios must contain at least one scenario.');
  }
  const timeoutMs = timeout(browser.timeoutMs, 15_000, 'browser.timeoutMs');
  const scenarios = browser.scenarios.map((scenario, index) => {
    const location = `browser.scenarios[${index}]`;
    object(scenario, location);
    fields(scenario, ['name', 'path', 'steps', 'requirements'], location);
    const scenarioPath = scenario.path === undefined ? '/' : string(scenario.path, `${location}.path`);
    if (!scenarioPath.startsWith('/') || scenarioPath.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(scenarioPath)) {
      throw new Error(`${location}.path must start with a single / and stay on browser.baseUrl's origin.`);
    }
    if (new URL(scenarioPath, baseUrl).origin !== baseUrl.origin) {
      throw new Error(`${location}.path must stay on browser.baseUrl's origin.`);
    }
    const steps = scenario.steps === undefined ? [] : scenario.steps;
    if (!Array.isArray(steps)) throw new Error(`${location}.steps must be an array.`);
    return {
      name: string(scenario.name, `${location}.name`).trim(),
      path: scenarioPath,
      steps: steps.map((step, stepIndex) => validateStep(step, `${location}.steps[${stepIndex}]`, timeoutMs)),
      requirements: validateRequirementReferences(scenario.requirements, requirementIds, `${location}.requirements`),
    };
  });
  uniqueNames(scenarios, 'browser.scenarios');
  const result = {
    baseUrl: baseUrl.href,
    startupTimeoutMs: timeout(browser.startupTimeoutMs, 30_000, 'browser.startupTimeoutMs'),
    timeoutMs,
    scenarios,
  };
  if (browser.startCommand !== undefined) result.startCommand = string(browser.startCommand, 'browser.startCommand');
  return result;
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`Cannot inspect ${path.basename(filename)}: ${error.message}`);
  }
}

async function detectPackageManager(cwd, manifest) {
  const matches = await Promise.all(Object.entries(LOCKFILES).map(async ([manager, filenames]) => {
    const present = await Promise.all(filenames.map((filename) => fileExists(path.join(cwd, filename))));
    return present.some(Boolean) ? manager : null;
  }));
  const managers = matches.filter(Boolean);
  if (managers.length > 1) {
    throw new Error(`Conflicting package manager lockfiles found (${managers.join(', ')}). Keep the lockfile for the package manager this project uses.`);
  }
  if (manifest?.packageManager !== undefined) {
    const declaration = string(manifest.packageManager, 'package.json.packageManager');
    const match = /^(npm|pnpm|yarn|bun)@\S+$/.exec(declaration);
    if (!match) throw new Error('package.json.packageManager must name npm, pnpm, yarn, or bun with a version (for example pnpm@10.0.0).');
    if (managers.length && managers[0] !== match[1]) {
      throw new Error(`package.json.packageManager selects ${match[1]}, but the lockfile selects ${managers[0]}. Use a consistent package manager.`);
    }
    return match[1];
  }
  return managers[0] || 'npm';
}

async function discoverChecks(cwd) {
  const manifest = await readJson(path.join(cwd, 'package.json'), true);
  if (manifest !== undefined) object(manifest, 'package.json');
  if (manifest?.scripts !== undefined) object(manifest.scripts, 'package.json.scripts');
  const manager = await detectPackageManager(cwd, manifest);
  const checks = [];
  const skipped = [];
  for (const name of SCRIPT_NAMES) {
    const script = manifest?.scripts?.[name];
    if (script === undefined) {
      skipped.push({ name, reason: `No "${name}" script in package.json.` });
      continue;
    }
    string(script, `package.json.scripts.${name}`);
    checks.push({ name, command: `${manager} run ${name}`, timeoutMs: 120_000, requirements: [] });
  }
  return { checks, skipped };
}

/** Load strict user configuration, or discover existing package.json checks. */
export async function loadConfig(cwd) {
  const config = await readJson(path.join(cwd, 'proofpatch.config.json'), true);
  if (config !== undefined) {
    object(config, 'proofpatch.config.json');
    fields(config, ['$schema', 'checks', 'browser', 'requirements'], 'proofpatch.config.json');
    if (config.$schema !== undefined) string(config.$schema, '$schema');
  }
  const requirements = validateRequirements(config?.requirements);
  const requirementIds = new Set(requirements.map(({ id }) => id));
  const browser = validateBrowser(config?.browser, requirementIds);
  const discovered = config?.checks === undefined
    ? await discoverChecks(cwd)
    : { checks: validateChecks(config.checks, requirementIds), skipped: [] };
  if (!discovered.checks.length && !browser && !requirements.length) {
    throw new Error('No checks found. Add test, lint, typecheck, or build scripts to package.json, or create proofpatch.config.json with a command check or browser scenario.');
  }
  return {
    ...discovered,
    browser,
    requirements,
    source: config === undefined ? 'package.json' : 'proofpatch.config.json',
  };
}
