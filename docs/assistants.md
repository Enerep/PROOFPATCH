# Working with coding assistants

Use your existing Codex, Cursor, or Claude Code session to prepare checks, then run `proofpatch verify`. ProofPatch runs commands and browser scenarios locally. It does not contact an AI model or require an API key.

## A simple workflow

1. Read the user's original request and acceptance criteria. Record the requested behaviors in `proofpatch.config.json` as requirements with stable IDs, before writing tests. Ask about ambiguous criteria instead of silently narrowing them.
2. Inspect the actual implementation, test commands, and browser selectors. Choose assertions that exercise each requested behavior and fail when it breaks.
3. Link command checks and browser scenarios to the requirement IDs they test. Leave unsupported behavior unlinked so the report shows the gap.
4. Run `proofpatch verify`, inspect the report and evidence, and fix failures when appropriate. Rerun after changes.
5. Report what passed, what failed, and what remains unverified. Include the report path. A passing command does not, by itself, show that every user requirement was covered.

Keep the original requirements when checks fail or are missing. Never delete, weaken, or unlink a requirement just to make a report pass. If the user changes the requested behavior, update the plan to reflect that change explicitly.

## Prompt to paste into your assistant

```text
Read my original request and acceptance criteria. Before writing tests, record
each requested behavior as a requirement with a stable ID in
proofpatch.config.json. Inspect the actual app and selectors, then add meaningful
command checks or browser assertions and link them to the requirements they test.
Run proofpatch verify and inspect its report. Report the evidence and any failed
or unverified requirements. Do not delete or weaken requirements to get a pass.
```

## Example: one behavior still needs evidence

Suppose the user requested both adding a note and rejecting blank notes. This configuration tests the first behavior:

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

The server command and selectors match the included notes demo; adapt them for another app. If this scenario passes, the requirement results are:

| Requirement | Result | Evidence |
| --- | --- | --- |
| `add-note` | `passed` | The linked browser scenario adds a note and checks its rendered text. |
| `reject-blank` | `unverified` | No linked check tests this behavior. |

The overall result is `INCOMPLETE`, and the process exits with code `1`. Add an executable check for blank-note rejection before claiming that requirement is verified. A small unit test for text normalization can support that work, but does not cover the complete user interaction on its own.

Each requirement is `passed` when all its linked results pass, `failed` when any linked result fails, and `unverified` when results are missing or skipped. Failed checks produce `FAILED`; otherwise, any unverified requirement produces `INCOMPLETE`. `PASSED` exits with `0`; both `FAILED` and `INCOMPLETE` exit with `1`. Without declared requirements, the existing check-based behavior applies.

These links are an explicit coverage plan. ProofPatch cannot tell whether the assistant copied all the user's criteria or wrote adequate assertions. Review the plan and evidence along with the code.

## Optional AGENTS.md guidance for your project

Add this to the `AGENTS.md` in the application you are building:

```markdown
## Verification

Before writing tests, preserve the user's acceptance criteria as stable
requirements in proofpatch.config.json. Link checks only to behavior their
assertions exercise. Inspect real app selectors before adding browser scenarios.
Run proofpatch verify after changes, inspect the evidence, and report the result
and report path, including failed or unverified requirements. Never delete or
weaken requirements to obtain a passing report.
```

See [configuration](configuration.md) for fields, browser actions, and all exit codes.
