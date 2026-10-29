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

If `checks` is omitted, package scripts are discovered. To run only browser scenarios, set `"checks": []` and configure `browser`. A configuration needs at least one command, browser scenario, or declared requirement. Requirements without executable checks produce an `INCOMPLETE` result.

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
| `expectCount` | `selector`, `count`; optional `forMs` | Wait for exactly `count` matching DOM nodes, including hidden nodes. |
| `expectHidden` | `selector`; optional `forMs` | Wait for the element to be hidden or detached. |

Selectors use Playwright locator syntax. Each scenario gets a fresh browser context. Browser scenarios run in headless Chromium; every action and navigation uses `timeoutMs` (default 15 seconds). `startupTimeoutMs` defaults to 30 seconds. Each timeout must be an integer from 1 to 3,600,000 milliseconds.

`count` must be a nonnegative integer. `expectHidden` uses Playwright's visibility rules: detached elements, an empty bounding box, and `visibility: hidden` count as hidden; `opacity: 0` alone does not. Use `expectCount` with `count: 0` when no matching DOM node should exist.

For `expectCount` and `expectHidden`, `forMs` is an optional observation window in milliseconds. It defaults to `0` and must be a nonnegative integer strictly less than `browser.timeoutMs`. The condition must be observed matching across that interval within the action timeout. ProofPatch polls roughly every 25 milliseconds; a detected mismatch restarts observation while the original action deadline still applies. Brief changes entirely between polls can go unseen.

For example, this checks that submitting whitespace creates no note:

```json
[
  { "action": "fill", "selector": "input[name=note]", "value": "   " },
  { "action": "click", "selector": "button[type=submit]" },
  { "action": "expectCount", "selector": "#notes li", "count": 0, "forMs": 250 }
]
```

For asynchronous behavior, first wait for an actual completion signal, such as the response's rendered result, before checking that an error or unwanted element is absent. A finite `forMs` window can catch delayed changes during that window; it cannot prove that a condition will hold forever. See the [bug walkthrough](bug-demo.md) for a complete example.

Paths must begin with `/` and stay on the configured origin. A scenario with no steps checks navigation and browser errors only. Add explicit assertions to test actual user behavior. For asynchronous flows, include an assertion that waits for the result you care about. Errors occurring after the scenario finishes cannot be detected.

HTTP errors, uncaught page errors, console errors, and failed requests observed during a scenario fail it. Screenshots are captured on both success and failure. Configuration mistakes, a missing browser, and a server that does not start also produce failures. A server already occupying the URL is rejected when `startCommand` is set, to avoid checking the wrong app.

Browser checks need ProofPatch's optional Playwright dependency and `npx playwright install chromium`. Command checks work without it. For an existing Chromium installation, set `PROOFPATCH_CHROMIUM_EXECUTABLE_PATH` to its executable path. Chromium may need system libraries on Linux; see Playwright's installation instructions or run `npx playwright install --with-deps chromium` on a suitable machine.

## Link acceptance criteria to checks

Declare the requested behavior with stable IDs in the top-level `requirements` array. Each command check or browser scenario can reference those IDs in its own `requirements` array:

```json
{
  "requirements": [
    { "id": "add-note", "description": "Users can add a note" },
    { "id": "reject-blank", "description": "Blank notes are rejected" }
  ],
  "checks": [],
  "browser": {
    "baseUrl": "http://127.0.0.1:4173",
    "startCommand": "node server.js",
    "scenarios": [
      {
        "name": "Add a note",
        "requirements": ["add-note"],
        "path": "/",
        "steps": [
          { "action": "fill", "selector": "input[name=note]", "value": "Ship it" },
          { "action": "click", "selector": "button[type=submit]" },
          { "action": "expectText", "selector": "#notes", "text": "Ship it" }
        ]
      }
    ]
  }
}
```

This configuration matches the notes demo's server and selectors. If the browser scenario passes, `add-note` is `passed`. `reject-blank` has no linked check, so it is `unverified`. The overall result is `INCOMPLETE` with exit code `1`, even though the executed check passed.

To link a command instead, add `"requirements": ["requirement-id"]` to its check entry. Link it only when that command's assertions meaningfully test the described behavior. A passing unit test for trimming text does not establish that the app lets a user add a note.

| Requirement status | Meaning |
| --- | --- |
| `passed` | At least one result is linked, and every linked result passed. |
| `failed` | At least one linked result failed. |
| `unverified` | No result is linked, or a linked result was skipped and none failed. |

Failed checks make the overall result `FAILED`. If no check failed but a declared requirement is unverified, the result is `INCOMPLETE`. A requirements-only plan is valid: use `"checks": []` and list the requirements to record an incomplete plan before writing tests. Configurations without requirement declarations keep the existing check-based behavior.

ProofPatch records the links you provide. It does not compare requirements to source code, generate tests, or judge whether an assertion is strong enough. Preserve the acceptance criteria and report missing coverage explicitly. See [working with coding assistants](assistants.md) for a practical workflow.

## Reports and CI

```sh
proofpatch verify --json
```

This prints the full JSON report to stdout and progress to stderr. Every run also saves `.proofpatch/<run-id>/report.json` and `report.md`, together with logs and screenshots. JSON includes the tool version, platform, Git commit and working-tree state when available, check results, requirement results when declared, durations, reasons, and artifact paths. Browser evidence records actions, expected text, and how many steps completed. Filled values are redacted in the step list; screenshots can still show them. Artifact paths are relative to the run directory. Reports are local evidence, without signing or tamper protection.

JSON reports use `schemaVersion: 2`. The `requirements` array records each declaration's status, reason, and linked check evidence; `requirementSummary` contains the `passed`, `failed`, and `unverified` totals. `summary.status` can now be `incomplete` as well as `passed` or `failed`. Plans without declared requirements have an empty `requirements` array and zero requirement totals.

| Exit code | Meaning |
| --- | --- |
| `0` | `PASSED`: executed checks passed and any declared requirements have passing linked results. Unlinked skipped checks remain unverified. |
| `1` | `FAILED`: a check failed; or `INCOMPLETE`: a declared requirement has missing or skipped evidence. |
| `2` | Invalid arguments, configuration, or a setup/write error. |
| `130` | Run interrupted; a partial report is saved when possible. |

For GitHub Actions, opt in to a job summary and step outputs:

```sh
proofpatch verify --github
```

The flag requires the runner-provided `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` files. It appends a concise summary of the result, check counts, requirements, and checks, and emits these outputs for the current run:

| Step output | Value |
| --- | --- |
| `report-directory` | Absolute path to this run's evidence directory. |
| `report-json` | Absolute path to this run's `report.json`. |
| `result` | `passed`, `failed`, or `incomplete`. |

Local evidence files and verification exit codes are unchanged. Missing runner files are a setup error (`2`). When runner metadata files are available, a setup failure appends an error summary, but produces no artifact output if no report was created. If publishing GitHub metadata fails after an otherwise passing run, the command exits with `2`; an existing failed or interrupted verification keeps its exit code.

The flag does not upload evidence or call GitHub's API. A workflow must upload the exact `report-directory` output and add the artifact link after upload. See [GitHub Actions](github-actions.md) for the workflow, retention, and pull request navigation.

Keep `.proofpatch/` in your application's `.gitignore`. Reports are kept per run; remove old run directories when no longer needed. Reports, logs, and screenshots can contain application data, so review their contents before sharing them or uploading them from public repository CI.

The configuration schema is [proofpatch.schema.json](../proofpatch.schema.json). Unknown fields are rejected to catch typos.
