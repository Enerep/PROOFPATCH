# Evidence in GitHub Actions

ProofPatch can add verification results to a GitHub Actions job summary and expose the current run's evidence directory for upload. It uses the runner's existing files; there is no API integration, extra account, AI service, or new key to configure.

## Add the workflow

Copy [examples/github-actions.yml](../examples/github-actions.yml) to `.github/workflows/proofpatch.yml` in your application repository. The example is for an npm web app on Node.js 22. It checks out the app and ProofPatch into sibling directories, installs both, installs Chromium, and runs this from the application directory:

```sh
node ../proofpatch/bin/proofpatch.js verify --github
```

The ProofPatch checkout is pinned to a reviewed source commit. The npm package is not published yet, so this workflow uses the source checkout. Review and update that pin when adopting a later version.

Commit a `proofpatch.config.json` in your application. For example, adapt this plan to your server command, URL, scripts, and rendered text:

```json
{
  "requirements": [
    { "id": "homepage", "description": "The homepage shows a welcome message" }
  ],
  "checks": [
    { "name": "Tests", "command": "npm test" }
  ],
  "browser": {
    "baseUrl": "http://127.0.0.1:3000",
    "startCommand": "npm run dev -- --host 127.0.0.1",
    "scenarios": [
      {
        "name": "Homepage",
        "requirements": ["homepage"],
        "path": "/",
        "steps": [{ "action": "expectText", "text": "Welcome" }]
      }
    ]
  }
}
```

Use actual acceptance criteria and assertions for your app. Change the application install command if you use pnpm, Yarn, or Bun. For command-only checks, omit `browser` and the workflow's Chromium install step. See [configuration](configuration.md) for the available actions and requirement links.

The workflow uses ordinary `pull_request` events and `contents: read` permissions, including for fork pull requests. It does not need `pull_request_target`, write permissions, or a service connection.

## Keep the evidence when verification fails

The verification step has ID `proofpatch`. With `--github`, it appends a concise job summary and exposes three step outputs:

| Output | Value |
| --- | --- |
| `steps.proofpatch.outputs.report-directory` | Absolute path to this run's report directory, including logs and screenshots. |
| `steps.proofpatch.outputs.report-json` | Absolute path to this run's `report.json`. |
| `steps.proofpatch.outputs.result` | `passed`, `failed`, or `incomplete`. |

The example uploads only that directory, even when verification fails:

```yaml
- name: Upload ProofPatch evidence
  id: evidence
  if: ${{ always() && steps.proofpatch.outputs.report-directory != '' }}
  uses: actions/upload-artifact@v4
  with:
    name: proofpatch-${{ github.run_id }}-${{ github.run_attempt }}
    path: ${{ steps.proofpatch.outputs.report-directory }}
    include-hidden-files: true
    if-no-files-found: error
    retention-days: 7
```

`include-hidden-files: true` is needed because evidence lives under `.proofpatch`. Using the exact output avoids uploading older runs. The artifact expires after seven days; adjust retention if your project needs a different period. Reports, command logs, and screenshots can contain application data, so review what your checks capture before enabling uploads in public repository CI.

After the upload, the example appends the artifact's download link to the job summary using `steps.evidence.outputs.artifact-url`. Uploading an artifact does not change a failed verification into a successful job.

## Find evidence from a pull request

1. Open the pull request's **Checks** tab and follow the ProofPatch workflow run.
2. Open the run's summary to see the overall result, check counts, requirement statuses, and checks.
3. Follow the evidence download link, or select `proofpatch-<run-id>-<attempt>` in the run's **Artifacts** list.
4. Unzip the artifact and open `report.md` or `report.json`. The report links to logs and screenshots inside that directory.

Screenshots are evidence files in the downloaded ZIP. This integration does not post inline screenshots or comments on the pull request. ProofPatch's own CI exercises the fixed notes demo so its job summary and artifact show the same flow.

## Results and setup errors

The flag preserves normal verification results: `PASSED` exits with `0`; `FAILED` and `INCOMPLETE` exit with `1`; invalid configuration or setup exits with `2`; interruption exits with `130`.

GitHub Actions supplies `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` as writable runner files. Running `--github` without those files is a setup error. Use `proofpatch verify` for an ordinary local run.

Setup failures append an error summary when possible. If no report was created, there is no report-directory output, so the upload step is skipped. If publishing metadata fails after verification otherwise passed, ProofPatch exits with `2`. An already failed or interrupted verification keeps its exit code, and its local evidence remains available when it was written successfully.
