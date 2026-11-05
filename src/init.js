import { lstat, stat, mkdir, open, readFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, loadPackageManifest, detectPackageManager } from './config.js';

const CONFIG_NAME = 'proofpatch.config.json';
const WORKFLOW_NAME = 'proofpatch.yml';
const CHROMIUM_STEP = '      - name: Install Chromium\n        run: node ../proofpatch/node_modules/playwright/cli.js install --with-deps chromium\n';

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function discoveredConfig(config) {
  return `${JSON.stringify({ checks: config.checks.map(({ name, command, timeoutMs }) => ({ name, command, timeoutMs })) }, null, 2)}\n`;
}

async function writeExclusive(path, contents, createdFiles) {
  const file = await open(path, 'wx');
  createdFiles.push(path);
  try {
    await file.writeFile(contents, 'utf8');
  } finally {
    await file.close();
  }
}

async function assertNoWorkflow(directory) {
  for (const name of [WORKFLOW_NAME, 'proofpatch.yaml']) {
    if (await exists(join(directory, name))) {
      throw new Error(`.github/workflows/${name} already exists. Review or edit the existing workflow; setup will not overwrite it.`);
    }
  }
}

async function assertWorkflowDirectories(cwd) {
  for (const name of ['.github', join('.github', 'workflows')]) {
    let entry;
    try {
      entry = await lstat(join(cwd, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`${name} is a symbolic link. Use a real directory inside this project so GitHub can discover the workflow.`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${name} must be a directory before GitHub workflow setup can create a workflow.`);
    }
  }
}

async function workflowContents(browser, lockfile) {
  let workflow = (await readFile(new URL('../examples/github-actions.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  if (!browser) {
    if (!workflow.includes(CHROMIUM_STEP)) {
      throw new Error('The bundled GitHub workflow template is missing its expected Chromium step. Reinstall ProofPatch before running setup.');
    }
    workflow = workflow.replace(CHROMIUM_STEP, '');
  }
  if (lockfile === 'npm-shrinkwrap.json') {
    const cachePath = 'cache-dependency-path: app/package-lock.json';
    if (!workflow.includes(cachePath)) {
      throw new Error('The bundled GitHub workflow template is missing its npm cache path. Reinstall ProofPatch before running setup.');
    }
    workflow = workflow.replace(cachePath, 'cache-dependency-path: app/npm-shrinkwrap.json');
  }
  return workflow;
}

async function rollback(createdFiles, directory, firstCreatedDirectory) {
  const errors = [];
  for (const path of createdFiles.reverse()) {
    try { await unlink(path); } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error.message);
    }
  }
  if (firstCreatedDirectory) {
    const directories = [directory];
    const githubDirectory = resolve(directory, '..');
    if (resolve(firstCreatedDirectory) === githubDirectory) directories.push(githubDirectory);
    for (const path of directories) {
      try { await rmdir(path); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) errors.push(error.message);
      }
    }
  }
  return errors;
}

/** Create a local plan, or an npm GitHub starter while preserving an existing plan. */
export async function initialize(cwd, { github = false } = {}) {
  const configPath = join(cwd, CONFIG_NAME);
  const configExists = await exists(configPath);
  if (!github && configExists) {
    throw new Error(`${CONFIG_NAME} already exists. Edit it to change your checks.`);
  }
  if (!github) {
    const config = await loadConfig(cwd);
    const createdFiles = [];
    try {
      await writeExclusive(configPath, discoveredConfig(config), createdFiles);
    } catch (error) {
      const cleanupErrors = await rollback(createdFiles);
      if (cleanupErrors.length) throw new Error(`${error.message} Could not clean up incomplete setup: ${cleanupErrors.join('; ')}`, { cause: error });
      throw error;
    }
    return { configCreated: true, workflowCreated: false, browserConfigured: false };
  }

  const workflowsDirectory = join(cwd, '.github', 'workflows');
  await assertWorkflowDirectories(cwd);
  await assertNoWorkflow(workflowsDirectory);
  const manifest = await loadPackageManifest(cwd, { required: true });
  const manager = await detectPackageManager(cwd, manifest);
  if (manager !== 'npm') {
    throw new Error(`GitHub workflow setup currently supports npm projects; this project uses ${manager}. Create a workflow for your package manager manually.`);
  }
  const shrinkwrap = await isFile(join(cwd, 'npm-shrinkwrap.json'));
  const packageLock = await isFile(join(cwd, 'package-lock.json'));
  if (!shrinkwrap && !packageLock) {
    throw new Error('GitHub workflow setup requires package-lock.json or npm-shrinkwrap.json for npm ci. Generate and review an npm lockfile, then run proofpatch init --github again.');
  }
  const config = await loadConfig(cwd);
  if (configExists && config.source !== CONFIG_NAME) {
    throw new Error(`Cannot read the existing ${CONFIG_NAME}. Replace its broken symbolic link before running setup.`);
  }
  const workflow = await workflowContents(config.browser, shrinkwrap ? 'npm-shrinkwrap.json' : 'package-lock.json');
  const createdFiles = [];
  let firstCreatedDirectory;
  try {
    firstCreatedDirectory = await mkdir(workflowsDirectory, { recursive: true });
    await assertWorkflowDirectories(cwd);
    await assertNoWorkflow(workflowsDirectory);
    await writeExclusive(join(workflowsDirectory, WORKFLOW_NAME), workflow, createdFiles);
    if (!configExists) await writeExclusive(configPath, discoveredConfig(config), createdFiles);
  } catch (error) {
    const cleanupErrors = await rollback(createdFiles, workflowsDirectory, firstCreatedDirectory);
    if (cleanupErrors.length) throw new Error(`${error.message} Could not clean up incomplete setup: ${cleanupErrors.join('; ')}`, { cause: error });
    throw error;
  }
  return { configCreated: !configExists, workflowCreated: true, browserConfigured: Boolean(config.browser) };
}
