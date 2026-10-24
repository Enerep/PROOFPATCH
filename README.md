# ProofPatch

**Don't trust the agent. Test the result.**

ProofPatch runs your project's checks and browser scenarios, then saves the evidence in a readable report. Use it after coding with Claude Code, Codex, Cursor, or any other tool.

This is the first working version: a local CLI for web projects. It runs actual commands and Chromium scenarios. It does not use an AI model to decide whether code works.

## Try it

Requires **Node.js 22+** and Git.

```sh
git clone https://github.com/Enerep/PROOFPATCH.git
cd PROOFPATCH
npm ci
node bin/proofpatch.js verify --cwd /path/to/your/project
```

ProofPatch finds the `test`, `lint`, `typecheck`, and `build` scripts in that project's `package.json`. It runs the scripts that exist and lists the others as skipped. npm, pnpm, Yarn, and Bun projects are supported; the matching package manager must be installed.

For the shorter command, run `npm link` in this repository. Then, from your project:

```sh
proofpatch verify
```

(**The npm package has not been published yet.** maybe later? after publication, the intended command is `npx proofpatch verify`. Use the local instructions above for this version.)

## What it looks like

Example output for a project with tests, a build, and a browser scenario:

```text
ProofPatch 0.1.0

RUN   Tests
PASS  Tests (482 ms)
RUN   Build
PASS  Build (1230 ms)
Browser: Add a note
PASS  Browser: Add a note (380 ms)

PASSED: 3 passed, 0 failed, 0 skipped.
Report: .proofpatch/<run-id>/report.md
Only the checks listed above were verified.
```

Each run saves `report.md`, `report.json`, command logs, and browser screenshots when configured. Failed checks make the command exit with a nonzero status, which also works in CI.

## Add browser scenarios

Install Chromium once:

```sh
npx playwright install chromium
```

Create `proofpatch.config.json` in your application:

```json
{
  "browser": {
    "baseUrl": "http://127.0.0.1:3000",
    "startCommand": "npm run dev -- --host 127.0.0.1",
    "scenarios": [
      {
        "name": "Homepage",
        "path": "/",
        "steps": [{ "action": "expectText", "text": "Welcome" }]
      }
    ]
  }
}
```

Change the server command, URL, and expected text to match your application. Existing package scripts still run. ProofPatch starts the server, waits for it, runs the scenarios, and stops the server afterward. Omit `startCommand` to check an already running app.

To try the included demo:

```sh
npm run demo
```

The demo tests a small notes app, including typing a note and clicking Add. See [configuration](docs/configuration.md) for more examples and options.

## Keep the result in perspective

A pass means the configured checks passed during this run. Test quality and scenario coverage determine what that tells you. Missing checks appear as skipped; an empty project cannot pass. ProofPatch does not generate tests, audit security, or prove that an application is bug-free.

Commands run with your local permissions, and browser scenarios can interact with the configured application. Run configurations you trust. Evidence stays in `.proofpatch/`; review logs and screenshots before sharing them.

## Development

```sh
npm run check
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and [AGENTS.md](AGENTS.md) for repository guidance.

## License

[MIT](LICENSE).
