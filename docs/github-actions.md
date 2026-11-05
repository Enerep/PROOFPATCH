# Evidence in GitHub Actions

ProofPatch can add verification results to a GitHub Actions job summary and expose the current run's evidence directory for upload. It uses the runner's existing files; there is no API integration, extra account, AI service, or new key to configure.

## Set up once in your app

Install ProofPatch from source and run `npm link` as described in the [README](../README.md#try-it). The npm package is not published yet.

Your npm app needs `package.json` and a committed `package-lock.json` or `npm-shrinkwrap.json`. If you want browser coverage, [prepare the browser configuration](#include-browser-checks) first. From your app's repository, run:

```sh
cd /path/to/app
proofpatch init --github
```

Without `npm link`, run this from any directory:

```sh
node /path/to/PROOFPATCH/bin/proofpatch.js init --github --cwd /path/to/your/app
```

`/path/to/PROOFPATCH` is the tool's source checkout. `--cwd /path/to/your/app` selects your application repository, where the new files belong.

This local setup command creates `.github/workflows/proofpatch.yml`. It preserves a valid existing `proofpatch.config.json` exactly; if none exists, it creates a configuration from discovered package scripts. It refuses to overwrite an existing `proofpatch.yml` or `proofpatch.yaml` in `.github/workflows/`.

The command writes setup files only. It does not install dependencies, execute checks, contact GitHub's API, commit, or push. It does not need `GITHUB_STEP_SUMMARY` or `GITHUB_OUTPUT` on your machine.

Review the configuration and workflow, then commit and push them in your application repository:

```sh
git add proofpatch.config.json .github/workflows/proofpatch.yml
git commit -m "Add ProofPatch verification"
git push
```

The push triggers GitHub Actions. The generated workflow uses Node.js 22, checks out your app and a reviewed, pinned ProofPatch source commit, installs dependencies, and runs `verify --github`. Keep the npm lockfile committed so the runner can use `npm ci`. Review and update the ProofPatch pin when adopting a later version.

| Command | Where it runs | What it does |
| --- | --- | --- |
| `proofpatch verify` | Your machine | Runs checks and saves local evidence. |
| `proofpatch init --github` | Your machine, once | Writes configuration if needed and the workflow. |
| `proofpatch verify --github` | GitHub Actions runner | Runs checks, saves evidence, and publishes job-summary metadata. |

## Include browser checks

The generator does not invent requirements or browser scenarios. Create or edit `proofpatch.config.json` before running `init --github` if you want browser coverage. For example, adapt this plan to your server command, URL, scripts, and rendered text:

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

Use actual acceptance criteria and assertions for your app. When this browser configuration exists, the generated workflow includes Chromium installation. For a configuration with only command checks, it skips that installation. If you add browser scenarios after setting up the workflow, add the Chromium install step from the manual example; the generator will not overwrite the existing workflow. See [configuration](configuration.md) for actions and requirement links.

## Manual setup

For pnpm, Yarn, Bun, or a customized workflow, copy [examples/github-actions.yml](../examples/github-actions.yml) to `.github/workflows/proofpatch.yml` and adapt it. The example targets an npm web app; change its application install command and cache settings for another package manager. Omit the Chromium install step for command-only checks.

Both workflows check out the app and ProofPatch into sibling directories. They run this from the application directory:

```sh
node ../proofpatch/bin/proofpatch.js verify --github
```

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

GitHub Actions supplies `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` as writable runner files. Running `verify --github` without those files is a setup error. `init --github` creates files locally and does not require them. Use `proofpatch verify` for an ordinary local run.

Setup failures append an error summary when possible. If no report was created, there is no report-directory output, so the upload step is skipped. If publishing metadata fails after verification otherwise passed, ProofPatch exits with `2`. An already failed or interrupted verification keeps its exit code, and its local evidence remains available when it was written successfully.
