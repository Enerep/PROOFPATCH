# Working on ProofPatch

Keep ProofPatch simple: run real checks and make the evidence easy to inspect.

## Project layout

- `bin/proofpatch.js` is the CLI entry point.
- `src/` contains configuration, check execution, browser checks, and reporting.
- `test/` uses the built-in Node.js test runner.
- `examples/` contains configuration examples.

Use Node.js 22 or newer. Run `npm ci`, `npm run check`, and `npm test` when setting up the repository.

## Making changes

- Prefer plain JavaScript and small modules. Add a dependency only when it solves a concrete problem.
- Keep the CLI help, README, configuration schema, and examples consistent with the implementation.
- Test behavior that matters: failing commands, timeouts, invalid configuration, browser failures, and report contents.
- A skipped or unavailable check is not a pass. Reports must say what ran and what did not.
- Never claim that a passing report proves a project is bug-free.
- Clean up child processes and browser sessions, including on failure or interruption.
- Keep generated reports, screenshots, logs, credentials, and personal information out of commits. Review any evidence before sharing it publicly.
- Use a normal contributor voice in public documentation. Describe the project and its behavior without personal chat history.

Run `npm run check` and `npm test` before handing off a code change. Mention checks that could not run and why.

Do not commit, push, publish, or create a release unless the maintainer explicitly asks. Leave changes available for review.
