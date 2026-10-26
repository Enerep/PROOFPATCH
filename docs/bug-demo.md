# Catch a bug that unit checks miss

The notes example has two acceptance criteria: users can add a note, and blank notes are rejected. This walkthrough runs the same criteria and browser assertions against a buggy app and a fixed app.

The configuration is supplied with the repository. ProofPatch does not generate it or contact an AI model. For your own project, use your existing coding assistant to read the original acceptance criteria, record the requirements before writing tests, and choose assertions against the real app. See [working with coding assistants](assistants.md).

## Run the buggy app

From the repository root, install the dependencies and Chromium once:

```sh
npm ci
npx playwright install chromium
```

Then run:

```sh
npm run demo:broken
```

This command starts the intentionally buggy app in `examples/buggy-notes`, verifies it, and stops it afterward. An exit code of `1` is expected:

| Check or requirement | Expected result |
| --- | --- |
| Note validation command | Passed |
| `add-note` requirement | Passed |
| `reject-blank` requirement | Failed |
| Overall result | `FAILED`, exit code `1` |

The unit check tests the normalization helper, which still works. The browser code bypasses that helper and uses the untrimmed input value. Spaces are a nonempty string, so submitting them creates a blank-looking `<li>` in the notes list.

## Inspect the evidence

The blank-note scenario is linked to `reject-blank` and uses these steps:

```json
[
  { "action": "fill", "selector": "input[name=note]", "value": "   " },
  { "action": "click", "selector": "button[type=submit]" },
  { "action": "expectCount", "selector": "#notes li", "count": 0, "forMs": 250 }
]
```

Each scenario starts in a fresh browser context. This one expects zero note elements, including hidden elements, and observes that condition for 250 milliseconds within the action timeout. The buggy app has one matching element, so the failure reports an expected count of `0` and a found count of `1`.

Open the report path printed by the command, under `examples/buggy-notes/.proofpatch/<run-id>/report.md`. It links the failed requirement to the scenario, its assertion evidence, and a screenshot. `report.json` contains the structured results. The screenshot helps inspect the page, while the DOM count captures the blank list item that may be hard to see.

This example updates the DOM synchronously when the form is submitted. For asynchronous apps, wait for an actual completion signal before asserting that something is absent. A finite observation window can catch delayed changes within that window; it cannot guarantee that nothing changes afterward.

## Fix the application and rerun

In `examples/buggy-notes/server.js`, replace the browser handler's untrimmed input:

```js
const text = input.value;
```

with:

```js
const text = normalizeNote(input.value);
```

Keep the existing `if (!text) return;` guard, requirements, links, and assertions. Rerun the same command:

```sh
npm run demo:broken
```

With the application fixed, the same checks should pass with exit code `0`. The command name selects the example directory; the report reflects the code currently in it.

To compare with the fixed app already included in the repository, run:

```sh
npm run demo
```

The fixed app in `examples/demo` uses the same requirements and assertions, with the server location changed. It should pass both requirements and exit with code `0`. Its report is saved under `examples/demo/.proofpatch/<run-id>/report.md`.

Keep failures meaningful: fix the behavior, and rerun the same plan. Do not remove a requirement, its link, or an assertion to turn the report green. Passing this plan provides evidence for these two behaviors; it does not prove the app is bug-free.
