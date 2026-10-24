# Configuration

Run ProofPatch inside the project to verify, or pass `--cwd /path/to/project`.

Without configuration, ProofPatch runs existing `test`, `lint`, `typecheck`, and `build` package scripts in that order. It chooses the package manager from `packageManager` in `package.json`, then lockfiles, then npm. Conflicting lockfiles produce an error.

## Choose command checks

To save the discovered scripts as editable configuration:

```sh
proofpatch init
```

This never overwrites an existing file. If your project has no supported package scripts, create `proofpatch.config.json` yourself:

```json
{
  "checks": [
    { "name": "Tests", "command": "npm test", "timeoutMs": 120000 },
    { "name": "Build", "command": "npm run build" }
  ]
}
```

Commands use your system shell from the project directory. Custom commands can verify non-JavaScript projects too. They must exit on completion and use a nonzero exit code on failure. ProofPatch continues after failures so the report includes all checks.

Commands default to a two-minute timeout. Output is limited to 1 MiB each for stdout and stderr, with a truncation marker. The runner sets `CI=1` unless you already set it, to discourage interactive prompts and watch mode. Background processes in a command's process group are stopped on Unix. On Windows, cleanup uses `taskkill`; commands should not leave background processes after exiting.

If `checks` is omitted, package scripts are discovered. To run only browser scenarios, set `"checks": []` and configure `browser`. At least one command or browser scenario is required.

## Browser actions

```json
{
  "checks": [],
  "browser": {
    "baseUrl": "http://127.0.0.1:3000",
    "startCommand": "npm run dev -- --host 127.0.0.1",
    "startupTimeoutMs": 30000,
    "timeoutMs": 15000,
    "scenarios": [
      {
        "name": "Add a note",
        "path": "/",
        "steps": [
          { "action": "fill", "selector": "input[name=note]", "value": "Ship it" },
          { "action": "click", "selector": "button[type=submit]" },
          { "action": "expectText", "selector": "#notes", "text": "Ship it" },
          { "action": "expectVisible", "selector": "#notes li" }
        ]
      }
    ]
  }
}
```

| Action | Required fields | Behavior |
| --- | --- | --- |
| `fill` | `selector`, `value` | Fill a form field. |
| `click` | `selector` | Click a matching element. |
| `expectText` | `text`; optional `selector` | Wait for rendered text, within the selector or page body. |
| `expectVisible` | `selector` | Wait for a visible element. |

Selectors use Playwright locator syntax. Each scenario gets a fresh browser context. Browser scenarios run in headless Chromium; every action and navigation uses `timeoutMs` (default 15 seconds). `startupTimeoutMs` defaults to 30 seconds. Each timeout must be an integer from 1 to 3,600,000 milliseconds.

Paths must begin with `/` and stay on the configured origin. A scenario with no steps checks navigation and browser errors only. Add explicit assertions to test actual user behavior. For asynchronous flows, include an assertion that waits for the result you care about. Errors occurring after the scenario finishes cannot be detected.

HTTP errors, uncaught page errors, console errors, and failed requests observed during a scenario fail it. Screenshots are captured on both success and failure. Configuration mistakes, a missing browser, and a server that does not start also produce failures. A server already occupying the URL is rejected when `startCommand` is set, to avoid checking the wrong app.

Browser checks need ProofPatch's optional Playwright dependency and `npx playwright install chromium`. Command checks work without it. For an existing Chromium installation, set `PROOFPATCH_CHROMIUM_EXECUTABLE_PATH` to its executable path. Chromium may need system libraries on Linux; see Playwright's installation instructions or run `npx playwright install --with-deps chromium` on a suitable machine.

## Reports and CI

```sh
proofpatch verify --json
```

This prints the full JSON report to stdout and progress to stderr. Every run also saves `.proofpatch/<run-id>/report.json` and `report.md`, together with logs and screenshots. JSON includes the tool version, platform, Git commit and working-tree state when available, check results, durations, reasons, and artifact paths. Browser evidence records actions, expected text, and how many steps completed. Filled values are redacted in the step list; screenshots can still show them. Artifact paths are relative to the run directory. Reports are local evidence, without signing or tamper protection.

| Exit code | Meaning |
| --- | --- |
| `0` | Every executed check passed; skipped checks remain unverified. |
| `1` | A command or browser check failed. |
| `2` | Invalid arguments, configuration, or a setup/write error. |
| `130` | Run interrupted; a partial report is saved when possible. |

Keep `.proofpatch/` in your application's `.gitignore`. Upload it as a CI artifact if you need the evidence, after reviewing its contents. Reports are kept per run; remove old run directories when no longer needed.

The configuration schema is [proofpatch.schema.json](../proofpatch.schema.json). Unknown fields are rejected to catch typos.
